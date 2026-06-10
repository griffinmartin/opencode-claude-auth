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
  description?: string
}

interface KeychainEntry {
  service: string
  label?: string
  comment?: string
  description?: string
  account?: string
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

export function parseKeychainDump(dump: string): KeychainEntry[] {
  const entries: KeychainEntry[] = []
  // Each item block begins with `class: "genp"` (or other class).
  const blocks = dump.split(/^class:\s*"genp"\s*$/m).slice(1)
  for (const block of blocks) {
    // Stop at the next `class:` or `keychain:` boundary.
    const end = block.search(/^(?:class:|keychain:)/m)
    const body = end === -1 ? block : block.slice(0, end)

    const read = (re: RegExp): string | undefined => {
      const m = re.exec(body)
      if (!m) return undefined
      const v = m[1]
      return v === "<NULL>" ? undefined : v
    }

    const service = read(/^\s*"svce"<blob>="([^"]*)"\s*$/m)
    if (!service) continue

    entries.push({
      service,
      label: read(/^\s*0x00000007 <blob>="([^"]*)"\s*$/m),
      comment: read(/^\s*"icmt"<blob>="([^"]*)"\s*$/m),
      description: read(/^\s*"desc"<blob>="([^"]*)"\s*$/m),
      account: read(/^\s*"acct"<blob>="([^"]*)"\s*$/m),
    })
  }
  return entries
}

export function deriveKeychainDescription(
  entry: KeychainEntry,
): string | undefined {
  const comment = entry.comment?.trim()
  return comment ? comment : undefined
}

function listClaudeKeychainEntries(): KeychainEntry[] {
  try {
    const dump = execSync("security dump-keychain", {
      timeout: 5000,
      maxBuffer: 1024 * 1024 * 10, // 10 MB
      encoding: "utf-8",
    })

    const all = parseKeychainDump(dump)
    const claude = all.filter((e) => e.service.startsWith(PRIMARY_SERVICE))

    // Dedup by service while preserving order, primary first.
    const byService = new Map<string, KeychainEntry>()
    for (const e of claude) {
      if (!byService.has(e.service)) byService.set(e.service, e)
    }

    const ordered: KeychainEntry[] = []
    const primary = byService.get(PRIMARY_SERVICE)
    if (primary) ordered.push(primary)
    for (const [svc, e] of byService) {
      if (svc !== PRIMARY_SERVICE) ordered.push(e)
    }

    log("keychain_list", {
      servicesFound: ordered.map((e) => e.service),
      withDescription: ordered
        .filter((e) => deriveKeychainDescription(e))
        .map((e) => e.service),
    })
    return ordered
  } catch (err) {
    log("keychain_list", {
      error: "Failed to list keychain services",
      message: err instanceof Error ? err.message : String(err),
    })
    return [{ service: PRIMARY_SERVICE }]
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

  const entries = listClaudeKeychainEntries()
  const rawAccounts: Array<{
    source: string
    credentials: ClaudeCredentials
    description?: string
  }> = []

  for (const entry of entries) {
    const raw = readKeychainService(entry.service)
    if (!raw) continue
    const creds = parseCredentials(raw)
    if (!creds) continue
    rawAccounts.push({
      source: entry.service,
      credentials: creds,
      description: deriveKeychainDescription(entry),
    })
  }

  if (rawAccounts.length === 0) {
    const creds = readCredentialsFile()
    if (creds) rawAccounts.push({ source: "file", credentials: creds })
  }

  // Build base labels (e.g. "Claude Pro") without disambiguating numbers.
  const baseLabels = rawAccounts.map((a) => {
    const sub = a.credentials.subscriptionType
    if (sub) return `Claude ${sub.charAt(0).toUpperCase() + sub.slice(1)}`
    return "Claude"
  })

  // Only fall back to numeric suffixes for entries without a Keychain comment.
  const numberedLabels = buildAccountLabels(
    rawAccounts.map((a) => a.credentials),
  )

  return rawAccounts.map((a, i) => ({
    // Append the user-set Keychain comment after the plan so the UI shows
    // e.g. "Claude Pro - Claude Sub Duncan". Without a comment, fall back to
    // the disambiguated label (e.g. "Claude Max 2").
    label: a.description
      ? `${baseLabels[i]} - ${a.description}`
      : numberedLabels[i],
    source: a.source,
    credentials: a.credentials,
    description: a.description,
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
