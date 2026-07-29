import { execFileSync, execSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
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
  configDir?: string
  credentials: ClaudeCredentials
}

export const PRIMARY_SERVICE = "Claude Code-credentials"

export function parseCredentials(raw: string): ClaudeCredentials | null {
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
    expiresAt: Math.trunc(creds.expiresAt),
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
      return null
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
      maxBuffer: 1024 * 1024 * 10, // 10 MB
      encoding: "utf-8",
    })

    const services: string[] = []
    const seen = new Set<string>()

    // Any-length hex suffix so legacy entries stay discoverable. The
    // suffix-to-config-dir mapping below still only applies to the
    // 8-char hashes the Claude CLI generates.
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
  } catch (err) {
    log("keychain_list", {
      error: "Failed to list keychain services",
      message: err instanceof Error ? err.message : String(err),
    })
    return [PRIMARY_SERVICE]
  }
}

function readEmailFromConfigDir(configDir: string): string | null {
  const primaryConfigDir = join(homedir(), ".claude")
  const candidates = [
    join(configDir, ".claude.json"),
    ...(configDir === primaryConfigDir
      ? [join(homedir(), ".claude.json")]
      : []),
  ]

  for (const path of candidates) {
    try {
      const raw = readFileSync(path, "utf-8")
      const data = JSON.parse(raw) as {
        oauthAccount?: { emailAddress?: string }
      }
      const email = data.oauthAccount?.emailAddress
      if (email) return email
    } catch {
      // try next candidate
    }
  }

  return null
}

export function readCredentialsFile(
  configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
): ClaudeCredentials | null {
  try {
    const credPath = join(configDir, ".credentials.json")
    const raw = readFileSync(credPath, "utf-8")
    const creds = parseCredentials(raw)
    log("credentials_file_read", { success: creds !== null, configDir })
    return creds
  } catch {
    log("credentials_file_read", { success: false, configDir })
    return null
  }
}

export function keychainSuffixForDir(dir: string): string {
  return createHash("sha256").update(dir).digest("hex").slice(0, 8)
}

let suffixToDirCache: Map<string, string> | null = null

function buildSuffixToDirCache(needed: Set<string>): Map<string, string> {
  const hasAllNeeded = (cache: Map<string, string>) =>
    [...needed].every((suffix) => cache.has(suffix))

  if (suffixToDirCache && hasAllNeeded(suffixToDirCache))
    return suffixToDirCache

  const cache = suffixToDirCache ?? new Map<string, string>()

  const tryDir = (dir: string) => {
    const suffix = keychainSuffixForDir(dir)
    if (needed.has(suffix) && !cache.has(suffix)) cache.set(suffix, dir)
  }

  if (process.env.CLAUDE_CONFIG_DIR) {
    tryDir(process.env.CLAUDE_CONFIG_DIR)
  }

  const home = homedir()
  try {
    const entries = readdirSync(home, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(".")) continue
      const dir = join(home, entry.name)
      if (!existsSync(join(dir, ".claude.json"))) continue
      tryDir(dir)
      if (hasAllNeeded(cache)) break
    }
  } catch {
    //
  }

  suffixToDirCache = cache
  return cache
}

export function clearSuffixToDirCache(): void {
  suffixToDirCache = null
}

function discoverConfigDirsForKeychain(
  keychainSuffixes: Set<string>,
): Map<string, string> {
  const cache = buildSuffixToDirCache(keychainSuffixes)
  const result = new Map<string, string>()
  for (const suffix of keychainSuffixes) {
    const dir = cache.get(suffix)
    if (dir) result.set(suffix, dir)
  }
  return result
}

export function buildAccountLabels(
  credsList: ClaudeCredentials[],
  emails?: (string | null)[],
  sources?: (string | null)[],
): string[] {
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
  return baseLabels.map((base, i) => {
    let label: string
    if ((counts.get(base) ?? 0) <= 1) {
      label = base
    } else {
      const n = (seen.get(base) ?? 0) + 1
      seen.set(base, n)
      label = `${base} ${n}`
    }
    const email = emails?.[i]
    if (email) return `${label}: ${email}`
    const source = sources?.[i]
    return source ? `${label}: ${source}` : label
  })
}

export function readAllClaudeAccounts(): ClaudeAccount[] {
  if (process.platform !== "darwin") {
    const configDir =
      process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")
    const creds = readCredentialsFile(configDir)
    if (!creds) return []
    const email = readEmailFromConfigDir(configDir)
    const [label] = buildAccountLabels([creds], [email])
    return [{ label, source: "file", configDir, credentials: creds }]
  }

  const services = listClaudeKeychainServices()
  const keychainAccounts: Array<{
    source: string
    suffix: string | null
    credentials: ClaudeCredentials
  }> = []

  for (const svc of services) {
    const raw = readKeychainService(svc)
    if (!raw) continue
    const creds = parseCredentials(raw)
    if (!creds) continue
    const suffixMatch = svc.match(/-([0-9a-f]{8})$/)
    keychainAccounts.push({
      source: svc,
      suffix: suffixMatch ? suffixMatch[1] : null,
      credentials: creds,
    })
  }

  if (keychainAccounts.length === 0) {
    const configDir =
      process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")
    const creds = readCredentialsFile(configDir)
    if (!creds) return []
    const email = readEmailFromConfigDir(configDir)
    const [label] = buildAccountLabels([creds], [email])
    return [{ label, source: "file", configDir, credentials: creds }]
  }

  const suffixToDir = discoverConfigDirsForKeychain(
    new Set(
      keychainAccounts
        .map((a) => a.suffix)
        .filter((s): s is string => s !== null),
    ),
  )

  const resolved = keychainAccounts.map((a) => {
    const configDir =
      a.suffix === null ? join(homedir(), ".claude") : suffixToDir.get(a.suffix)
    const email = configDir ? readEmailFromConfigDir(configDir) : null
    log("account_config_dir", {
      source: a.source,
      configDir: configDir ?? null,
    })
    return {
      source: a.source,
      credentials: a.credentials,
      configDir,
      email,
    }
  })

  const labels = buildAccountLabels(
    resolved.map((a) => a.credentials),
    resolved.map((a) => a.email),
    resolved.map((a) => a.source),
  )

  return resolved.map((a, i) => {
    const account: ClaudeAccount = {
      label: labels[i],
      source: a.source,
      credentials: a.credentials,
    }
    if (a.configDir) account.configDir = a.configDir
    return account
  })
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

/**
 * A short, non-reversible tag for an access token, so write-back decisions
 * can be correlated across log lines (and against another account's) without
 * putting token material in the log.
 */
function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 8)
}

/**
 * Whether a stored credential blob still carries the access token we expect.
 *
 * Guards write-back against an external switch landing between the read that
 * produced the token being refreshed and the write of its replacement. An
 * unparseable blob returns false: a write into state we cannot identify is
 * exactly what this is meant to prevent.
 *
 * Deliberately stricter than the write it guards: this validates through
 * parseCredentials (field types, mcpOAuth-only rejection) while
 * updateCredentialBlob rewrites anything JSON.parse accepts. So a blob the
 * write path would happily update can still be refused here. That gap is
 * intentional — reaching this guard means an earlier parseCredentials
 * succeeded, so a blob that no longer parses changed shape after we read it
 * (a truncated non-atomic external write, or a hand edit), and declining to
 * write over it is correct. Anyone tightening parseCredentials should know it
 * narrows write-back too, not just reads.
 */
export function credentialBlobMatches(
  raw: string,
  expectedAccessToken: string,
): boolean {
  const parsed = parseCredentials(raw)
  return parsed?.accessToken === expectedAccessToken
}

export function writeBackCredentials(
  source: string,
  creds: ClaudeCredentials,
  configDir?: string,
  expectedPriorAccessToken?: string,
): boolean {
  const newCreds = {
    accessToken: creds.accessToken,
    refreshToken: creds.refreshToken,
    expiresAt: creds.expiresAt,
  }

  if (source === "file") {
    try {
      const dir =
        configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude")
      const credPath = join(dir, ".credentials.json")
      const raw = readFileSync(credPath, "utf-8")
      if (
        expectedPriorAccessToken !== undefined &&
        !credentialBlobMatches(raw, expectedPriorAccessToken)
      ) {
        // Two operationally opposite causes: another account legitimately
        // holds the slot (benign, no action) versus a blob we cannot read at
        // all (corruption, needs a human). Same refusal, different events.
        const stored = parseCredentials(raw)
        if (stored === null) {
          log("writeback_skipped_unparseable", { source, configDir: dir })
        } else {
          log("writeback_skipped_stale", {
            source,
            configDir: dir,
            expected: tokenFingerprint(expectedPriorAccessToken),
            stored: tokenFingerprint(stored.accessToken),
          })
        }
        return false
      }
      const updated = updateCredentialBlob(raw, newCreds)
      if (!updated) return false
      writeFileSync(credPath, updated, { encoding: "utf-8", mode: 0o600 })
      if (process.platform !== "win32") {
        chmodSync(credPath, 0o600)
      }
      log("writeback_success", { source, configDir: dir })
      return true
    } catch {
      log("writeback_failed", { source, configDir: configDir ?? null })
      return false
    }
  }

  if (process.platform === "darwin") {
    try {
      const raw = readKeychainService(source)
      if (!raw) return false
      if (
        expectedPriorAccessToken !== undefined &&
        !credentialBlobMatches(raw, expectedPriorAccessToken)
      ) {
        // See the file branch: a mismatch is expected, an unreadable blob is not.
        const stored = parseCredentials(raw)
        if (stored === null) {
          log("writeback_skipped_unparseable", { source })
        } else {
          log("writeback_skipped_stale", {
            source,
            expected: tokenFingerprint(expectedPriorAccessToken),
            stored: tokenFingerprint(stored.accessToken),
          })
        }
        return false
      }
      const updated = updateCredentialBlob(raw, newCreds)
      if (!updated) return false
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

export function refreshAccount(
  source: string,
  configDir?: string,
): ClaudeCredentials | null {
  if (source === "file") {
    return readCredentialsFile(configDir)
  }
  const raw = readKeychainService(source)
  if (!raw) return null
  return parseCredentials(raw)
}
