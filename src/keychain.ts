import { execFileSync, execSync } from "node:child_process"
import { chmodSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { log } from "./logger.ts"

export interface ClaudeCredentials {
  accessToken: string
  refreshToken: string
  expiresAt: number
  subscriptionType?: string
}

export interface ClaudeAccount {
  label: string
  source: string
  credentials: ClaudeCredentials
}

const PRIMARY_SERVICE = "Claude Code-credentials"

function parseCredentials(raw: string): ClaudeCredentials | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  const data = (parsed as { claudeAiOauth?: unknown }).claudeAiOauth ?? parsed
  const creds = data as {
    accessToken?: unknown
    refreshToken?: unknown
    expiresAt?: unknown
    subscriptionType?: unknown
    mcpOAuth?: unknown
  }

  // Entries that only contain mcpOAuth are MCP server credentials, not user accounts
  if ((parsed as { mcpOAuth?: unknown }).mcpOAuth && !creds.accessToken) {
    return null
  }

  if (
    typeof creds.accessToken !== "string" ||
    typeof creds.refreshToken !== "string" ||
    typeof creds.expiresAt !== "number"
  ) {
    log("credentials_parsed", {
      hasAccessToken: typeof creds.accessToken === "string",
      hasRefreshToken: typeof creds.refreshToken === "string",
      hasExpiry: typeof creds.expiresAt === "number",
      isMcpOnly: false,
    })
    return null
  }

  log("credentials_parsed", {
    hasAccessToken: true,
    hasRefreshToken: true,
    hasExpiry: true,
    isMcpOnly: false,
  })

  return {
    accessToken: creds.accessToken,
    refreshToken: creds.refreshToken,
    expiresAt: creds.expiresAt,
    subscriptionType:
      typeof creds.subscriptionType === "string"
        ? creds.subscriptionType
        : undefined,
  }
}

function readKeychainService(serviceName: string): string | null {
  try {
    const result = execSync(
      `security find-generic-password -s "${serviceName}" -w`,
      {
        timeout: 2000,
        encoding: "utf-8",
      },
    ).trim()
    log("keychain_read", { service: serviceName, success: true })
    return result
  } catch (err: unknown) {
    const error = err as { status?: number; code?: string; killed?: boolean }

    if (error.killed || error.code === "ETIMEDOUT") {
      log("keychain_read_error", {
        service: serviceName,
        errorType: "timeout",
      })
      throw new Error(
        "Keychain read timed out. This can happen on macOS Tahoe. Try restarting Keychain Access.",
        { cause: err },
      )
    }
    if (error.status === 36) {
      log("keychain_read_error", {
        service: serviceName,
        errorType: "locked",
      })
      throw new Error(
        "macOS Keychain is locked. Please unlock it or run: security unlock-keychain ~/Library/Keychains/login.keychain-db",
        { cause: err },
      )
    }
    if (error.status === 128) {
      log("keychain_read_error", {
        service: serviceName,
        errorType: "denied",
      })
      throw new Error(
        "Keychain access was denied. Please grant access when prompted by macOS.",
        { cause: err },
      )
    }
    if (error.status === 44) {
      log("keychain_read_error", {
        service: serviceName,
        errorType: "not_found",
      })
      return null // item not found
    }
    log("keychain_read_error", {
      service: serviceName,
      errorType: `exit_${error.status ?? "unknown"}`,
    })
    throw new Error(
      `Failed to read Keychain entry "${serviceName}" (exit ${error.status ?? "unknown"}). Try re-authenticating with Claude Code.`,
      { cause: err },
    )
  }
}

function listClaudeKeychainServices(): string[] {
  try {
    const dump = execSync("security dump-keychain", {
      timeout: 5000,
      encoding: "utf-8",
    })

    const services: string[] = []
    const seen = new Set<string>()

    const re = /"Claude Code-credentials(?:-[0-9a-f]+)?"/g
    let m = re.exec(dump)
    while (m !== null) {
      const svc = m[0].slice(1, -1)
      if (!seen.has(svc)) {
        seen.add(svc)
        services.push(svc)
      }
      m = re.exec(dump)
    }

    const ordered: string[] = []
    if (seen.has(PRIMARY_SERVICE)) ordered.push(PRIMARY_SERVICE)
    for (const svc of services) {
      if (svc !== PRIMARY_SERVICE) ordered.push(svc)
    }
    log("keychain_list", { servicesFound: ordered })
    return ordered
  } catch {
    return [PRIMARY_SERVICE]
  }
}

function readCredentialsFile(): ClaudeCredentials | null {
  try {
    const credPath = join(homedir(), ".claude", ".credentials.json")
    const raw = readFileSync(credPath, "utf-8")
    const creds = parseCredentials(raw)
    log("credentials_file_read", { success: creds !== null })
    return creds
  } catch {
    log("credentials_file_read", { success: false })
    return null
  }
}

export function buildAccountLabels(credsList: ClaudeCredentials[]): string[] {
  const baseLabels = credsList.map((c) => {
    if (c.subscriptionType) {
      const tier =
        c.subscriptionType.charAt(0).toUpperCase() + c.subscriptionType.slice(1)
      return `Claude ${tier}`
    }
    return "Claude"
  })

  const counts = new Map<string, number>()
  for (const l of baseLabels) counts.set(l, (counts.get(l) ?? 0) + 1)

  const seen = new Map<string, number>()
  return baseLabels.map((base) => {
    if ((counts.get(base) ?? 0) <= 1) return base
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    return `${base} ${n}`
  })
}

export function readAllClaudeAccounts(): ClaudeAccount[] {
  if (process.platform !== "darwin") {
    const creds = readCredentialsFile()
    if (!creds) return []
    const [label] = buildAccountLabels([creds])
    return [{ label, source: "file", credentials: creds }]
  }

  const services = listClaudeKeychainServices()
  const rawAccounts: Array<{ source: string; credentials: ClaudeCredentials }> =
    []

  for (const svc of services) {
    const raw = readKeychainService(svc)
    if (!raw) continue
    const creds = parseCredentials(raw)
    if (!creds) continue
    rawAccounts.push({ source: svc, credentials: creds })
  }

  if (rawAccounts.length === 0) {
    const creds = readCredentialsFile()
    if (creds) rawAccounts.push({ source: "file", credentials: creds })
  }

  const labels = buildAccountLabels(rawAccounts.map((a) => a.credentials))
  return rawAccounts.map((a, i) => ({
    label: labels[i],
    source: a.source,
    credentials: a.credentials,
  }))
}

export function updateCredentialBlob(
  existingJson: string,
  newCreds: { accessToken: string; refreshToken: string; expiresAt: number },
): string | null {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(existingJson)
  } catch {
    return null
  }

  const wrapper = parsed.claudeAiOauth as Record<string, unknown> | undefined
  const target = wrapper ?? parsed

  target.accessToken = newCreds.accessToken
  target.refreshToken = newCreds.refreshToken
  target.expiresAt = newCreds.expiresAt

  return JSON.stringify(parsed)
}

function getKeychainAccountName(serviceName: string): string | null {
  try {
    const output = execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-s", serviceName],
      { timeout: 2000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    )
    const match = /"acct"<blob>="([^"]*)"/.exec(output)
    if (match) {
      log("keychain_account_name", {
        service: serviceName,
        account: match[1],
      })
      return match[1]
    }
    return null
  } catch {
    return null
  }
}

export function writeBackCredentials(
  source: string,
  creds: ClaudeCredentials,
): boolean {
  const newCreds = {
    accessToken: creds.accessToken,
    refreshToken: creds.refreshToken,
    expiresAt: creds.expiresAt,
  }

  if (source === "file") {
    try {
      const credPath = join(homedir(), ".claude", ".credentials.json")
      const raw = readFileSync(credPath, "utf-8")
      const updated = updateCredentialBlob(raw, newCreds)
      if (!updated) return false
      writeFileSync(credPath, updated, { encoding: "utf-8", mode: 0o600 })
      if (process.platform !== "win32") {
        chmodSync(credPath, 0o600)
      }
      log("writeback_success", { source })
      return true
    } catch {
      log("writeback_failed", { source })
      return false
    }
  }

  if (process.platform === "darwin") {
    try {
      const raw = readKeychainService(source)
      if (!raw) return false
      const updated = updateCredentialBlob(raw, newCreds)
      if (!updated) return false
      // Discover the actual account name from the existing Keychain entry.
      // Claude CLI uses the macOS username (e.g. "gmartin"), not the service name.
      // Using the wrong account name creates a duplicate entry instead of updating.
      const accountName = getKeychainAccountName(source) ?? source
      execFileSync(
        "/usr/bin/security",
        [
          "add-generic-password",
          "-s",
          source,
          "-a",
          accountName,
          "-w",
          updated,
          "-U",
        ],
        { timeout: 2000, stdio: "ignore" },
      )
      log("writeback_success", { source, accountName })
      return true
    } catch {
      log("writeback_failed", { source })
      return false
    }
  }

  return false
}

export function refreshAccount(source: string): ClaudeCredentials | null {
  if (source === "file") {
    return readCredentialsFile()
  }
  const raw = readKeychainService(source)
  if (!raw) return null
  return parseCredentials(raw)
}

/** @deprecated Use readAllClaudeAccounts() instead */
export function readClaudeCredentials(): ClaudeCredentials | null {
  const accounts = readAllClaudeAccounts()
  return accounts.length > 0 ? accounts[0].credentials : null
}
