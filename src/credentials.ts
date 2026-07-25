import { execFileSync, execSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"
import {
  PRIMARY_SERVICE,
  readAllClaudeAccounts,
  refreshAccount,
  writeBackCredentials,
  type ClaudeAccount,
  type ClaudeCredentials,
} from "./keychain.ts"
import { resetExcludedBetas } from "./betas.ts"
import { log } from "./logger.ts"

export type { ClaudeAccount } from "./keychain.ts"
export type { ClaudeCredentials } from "./keychain.ts"

const CREDENTIAL_CACHE_TTL_MS = 30_000

const accountCacheMap = new Map<
  string,
  { creds: ClaudeCredentials; cachedAt: number }
>()
let activeAccountSource: string | null = null
let allAccounts: ClaudeAccount[] = []

export function initAccounts(accounts: ClaudeAccount[]): void {
  allAccounts = accounts
}

export function setActiveAccountSource(source: string): void {
  const previous = activeAccountSource
  activeAccountSource = source
  accountCacheMap.delete(source)
  resetExcludedBetas()
  if (previous && previous !== source) {
    log("account_switch", { newSource: source, previousSource: previous })
  }
}

export function refreshAccountsList(): ClaudeAccount[] {
  const fresh = readAllClaudeAccounts()
  if (fresh.length === 0 && allAccounts.length > 0) {
    // Transient empty read (e.g. keychain race while the claude CLI rewrites
    // credentials) must not clobber a working session.
    log("accounts_reload_empty", { keptAccounts: allAccounts.length })
    return allAccounts
  }
  allAccounts = fresh
  return allAccounts
}

function getActiveAccount(): ClaudeAccount | null {
  if (allAccounts.length === 0) return null
  if (activeAccountSource) {
    const found = allAccounts.find((a) => a.source === activeAccountSource)
    if (found) return found
  }
  return allAccounts[0]
}

function getAccountStateFile(): string {
  return join(
    homedir(),
    ".local",
    "share",
    "opencode",
    "claude-account-source.txt",
  )
}

export function loadPersistedAccountSource(): string | null {
  try {
    const path = getAccountStateFile()
    if (existsSync(path)) {
      return readFileSync(path, "utf-8").trim() || null
    }
  } catch {
    // ignore
  }
  return null
}

export function saveAccountSource(source: string): void {
  try {
    const path = getAccountStateFile()
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(path, source, "utf-8")
  } catch {
    // Non-fatal
  }
}

function getAuthJsonPaths(): string[] {
  const xdgPath = join(homedir(), ".local", "share", "opencode", "auth.json")
  if (process.platform === "win32") {
    const appData =
      process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")
    const localAppDataPath = join(appData, "opencode", "auth.json")
    return [xdgPath, localAppDataPath]
  }
  return [xdgPath]
}

function syncToPath(authPath: string, creds: ClaudeCredentials): void {
  let auth: Record<string, unknown> = {}
  if (existsSync(authPath)) {
    const raw = readFileSync(authPath, "utf-8").trim()
    if (raw) {
      try {
        auth = JSON.parse(raw)
      } catch {
        // Malformed file, start fresh
      }
    }
  }
  auth.anthropic = {
    type: "oauth",
    access: creds.accessToken,
    refresh: creds.refreshToken,
    expires: creds.expiresAt,
  }
  const dir = dirname(authPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  writeFileSync(authPath, JSON.stringify(auth, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  })
  if (process.platform !== "win32") {
    chmodSync(authPath, 0o600)
  }
}

export function syncAuthJson(creds: ClaudeCredentials): void {
  for (const authPath of getAuthJsonPaths()) {
    try {
      syncToPath(authPath, creds)
      log("sync_auth_json", { path: authPath, success: true })
    } catch (err) {
      log("sync_auth_json", {
        path: authPath,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  }
}

export const OAUTH_TOKEN_URL = "https://claude.ai/v1/oauth/token"
export const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"

export function parseOAuthResponse(
  raw: string,
  currentRefreshToken: string,
  now: number = Date.now(),
): ClaudeCredentials | null {
  let data: {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    error?: string
  }
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }

  if (!data.access_token) return null

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? currentRefreshToken,
    expiresAt: Math.trunc(now + (data.expires_in ?? 36_000) * 1000),
  }
}

export function refreshViaOAuth(
  refreshToken: string,
): ClaudeCredentials | null {
  const script = `
    process.stdin.resume();
    let input = '';
    process.stdin.on('data', c => input += c);
    process.stdin.on('end', () => {
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: '${OAUTH_CLIENT_ID}',
        refresh_token: input.trim()
      });
      fetch('${OAUTH_TOKEN_URL}', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      })
      .then(r => { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then(d => { process.stdout.write(JSON.stringify(d)); })
      .catch(e => { process.stdout.write(JSON.stringify({ error: String(e) })); process.exit(1); });
    });
  `

  try {
    log("refresh_started", { source: "oauth" })
    const result = execFileSync(process.execPath, ["-e", script], {
      input: refreshToken,
      timeout: 15_000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "ignore"],
    })

    const creds = parseOAuthResponse(result, refreshToken)
    if (!creds) {
      log("refresh_failed", {
        source: "oauth",
        error: "no access_token in response",
      })
      return null
    }

    log("refresh_success", { source: "oauth" })
    return creds
  } catch (err) {
    log("refresh_failed", {
      source: "oauth",
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

function refreshViaCli(configDir?: string, requireConfigDir = false): boolean {
  if (requireConfigDir && !configDir) {
    log("refresh_cli_skipped", {
      source: "cli",
      reason: "configDir unknown for suffixed account",
    })
    return false
  }

  const env = {
    ...process.env,
    TERM: "dumb",
    ...(configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}),
  }

  const maxAttempts = 2
  for (let i = 0; i < maxAttempts; i++) {
    log("refresh_started", { source: "cli", attempt: i + 1, configDir })
    try {
      execSync("claude -p . --model haiku", {
        timeout: 60_000,
        encoding: "utf-8",
        env,
        stdio: "ignore",
        cwd: tmpdir(),
      })
      log("refresh_success", { source: "cli" })
      return true
    } catch (err) {
      log("refresh_failed", {
        source: "cli",
        attempt: i + 1,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  log("refresh_cli_exhausted", { source: "cli", configDir })
  return false
}

export function refreshIfNeeded(
  account?: ClaudeAccount,
): ClaudeCredentials | null {
  const target = account ?? getActiveAccount()
  if (!target) return null

  // Pick up external updates to .credentials.json (e.g. switch_claude_account
  // on Windows). Bounded by getCachedCredentials's 30s TTL: fires at most
  // ~2x/min under load. macOS keychain sources stay on the in-memory path;
  // their state is mutated only by our own writeBackCredentials, so no
  // external-update vector exists for them.
  if (target.source === "file") {
    const onDisk = refreshAccount(target.source)
    if (onDisk) target.credentials = onDisk
  }

  const creds = target.credentials
  if (creds.expiresAt > Date.now() + 60_000) return creds

  log("refresh_needed", {
    source: target.source,
    expiresAt: creds.expiresAt,
    expiresIn: creds.expiresAt - Date.now(),
  })

  if (creds.refreshToken) {
    const oauthCreds = refreshViaOAuth(creds.refreshToken)
    if (oauthCreds && oauthCreds.expiresAt > Date.now() + 60_000) {
      target.credentials = oauthCreds
      writeBackCredentials(target.source, oauthCreds, target.configDir)
      return oauthCreds
    }
  }

  log("refresh_fallback_cli", { source: target.source })
  const isSuffixedAccount =
    target.source !== PRIMARY_SERVICE &&
    target.source.startsWith(PRIMARY_SERVICE + "-")
  const cliSucceeded = refreshViaCli(target.configDir, isSuffixedAccount)
  if (!cliSucceeded) {
    const fallback = tryFallbackAccount(target.source)
    if (fallback) {
      target.credentials = fallback
      return fallback
    }

    log("refresh_exhausted", {
      source: target.source,
      hadCredentials: false,
      expiresAt: undefined,
    })
    return null
  }

  let refreshed = refreshAccount(target.source, target.configDir)
  if (
    (!refreshed || refreshed.expiresAt <= Date.now() + 60_000) &&
    isSuffixedAccount
  ) {
    const primaryRefreshed = refreshAccount(PRIMARY_SERVICE)
    if (primaryRefreshed && primaryRefreshed.expiresAt > Date.now() + 60_000) {
      refreshed = primaryRefreshed
    }
  }

  if (refreshed && refreshed.expiresAt > Date.now() + 60_000) {
    target.credentials = refreshed
    return refreshed
  }

  log("refresh_exhausted", {
    source: target.source,
    hadCredentials: !!refreshed,
    expiresAt: refreshed?.expiresAt,
  })
  return null
}

function tryFallbackAccount(excludeSource: string): ClaudeCredentials | null {
  const now = Date.now()
  const candidates = allAccounts.filter((a) => a.source !== excludeSource)

  // Accounts whose in-memory credentials are still valid can be borrowed
  // directly — no keychain read needed. A 401 on a borrowed token is
  // handled by the existing reload-and-retry fetch path.
  for (const account of candidates) {
    if (account.credentials.expiresAt > now + 60_000) {
      log("refresh_fallback_account", {
        failedSource: excludeSource,
        usedSource: account.source,
      })
      return account.credentials
    }
  }

  // Last resort: live-read the stale-looking ones too — another process
  // (e.g. the Claude CLI in a different terminal) may have refreshed their
  // keychain entry since we last read it.
  for (const account of candidates) {
    let fresh: ClaudeCredentials | null = null
    try {
      fresh = refreshAccount(account.source, account.configDir)
    } catch {
      continue
    }
    if (fresh && fresh.expiresAt > now + 60_000) {
      account.credentials = fresh
      log("refresh_fallback_account", {
        failedSource: excludeSource,
        usedSource: account.source,
      })
      return fresh
    }
  }
  return null
}

export function getCredentialsForSync(): ClaudeCredentials | null {
  const account = getActiveAccount()
  if (!account) return null

  const creds = account.credentials
  if (creds.expiresAt > Date.now() + 60_000) {
    return creds
  }

  return null
}

/**
 * Re-read only the active account's credentials from its source (single
 * keychain service read or credentials file) and update them in place.
 * Used on 401 so an externally refreshed token is picked up without a
 * full multi-account keychain rescan.
 */
export function reloadActiveAccount(): void {
  const account = getActiveAccount()
  if (!account) return
  try {
    const fresh = refreshAccount(account.source)
    if (fresh) account.credentials = fresh
  } catch (err) {
    log("account_reload_failed", {
      source: account.source,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Refresh the active account's credentials via OAuth even though they
 * still look valid locally. Used on 401 when the source still holds the
 * rejected token (revoked, the claude CLI hasn't refreshed it yet).
 * On success the account, its source, and the cache are all updated.
 * The refresh function is injectable for tests.
 */
export function forceRefreshActiveAccount(
  refresh: (refreshToken: string) => ClaudeCredentials | null = refreshViaOAuth,
): ClaudeCredentials | null {
  const account = getActiveAccount()
  if (!account?.credentials.refreshToken) return null

  const oauthCreds = refresh(account.credentials.refreshToken)
  if (oauthCreds && oauthCreds.expiresAt > Date.now() + 60_000) {
    account.credentials = oauthCreds
    if (!writeBackCredentials(account.source, oauthCreds)) {
      // Session continues from memory/cache; a later source re-read may
      // resurrect the rejected token and trigger another refresh.
      log("force_refresh_writeback_failed", { source: account.source })
    }
    accountCacheMap.set(account.source, {
      creds: oauthCreds,
      cachedAt: Date.now(),
    })
    return oauthCreds
  }

  log("force_refresh_failed", { source: account.source })
  return null
}

/**
 * Drop the active account's cached credentials so the next
 * getCachedCredentials() call re-reads from the source, bypassing the
 * 30s TTL. Used when the API rejects a token (401) that still looks
 * valid locally.
 */
export function invalidateCredentialCache(): void {
  const account = getActiveAccount()
  if (account) {
    accountCacheMap.delete(account.source)
    log("cache_invalidated", { source: account.source })
  }
}

export function getCachedCredentials(): ClaudeCredentials | null {
  const account = getActiveAccount()
  if (!account) return null

  const now = Date.now()
  const cached = accountCacheMap.get(account.source)
  if (
    cached &&
    now - cached.cachedAt < CREDENTIAL_CACHE_TTL_MS &&
    cached.creds.expiresAt > now + 60_000
  ) {
    log("cache_hit", {
      source: account.source,
      ttlRemaining: CREDENTIAL_CACHE_TTL_MS - (now - cached.cachedAt),
    })
    return cached.creds
  }

  log("cache_miss", {
    source: account.source,
    reason: cached ? "stale or expiring" : "empty",
  })

  const fresh = refreshIfNeeded(account)
  if (!fresh) {
    log("credentials_unavailable", { source: account.source })
    accountCacheMap.delete(account.source)
    return null
  }

  accountCacheMap.set(account.source, { creds: fresh, cachedAt: now })
  return fresh
}

export function reloadCredentialsFromSource(): ClaudeCredentials | null {
  const account = getActiveAccount()
  if (!account) return null

  let reloaded: ClaudeCredentials | null
  try {
    reloaded = refreshAccount(account.source)
  } catch {
    accountCacheMap.delete(account.source)
    log("credentials_source_reload", {
      source: account.source,
      success: false,
      reason: "read_error",
    })
    return null
  }
  const now = Date.now()
  if (
    !reloaded ||
    !reloaded.accessToken.trim() ||
    reloaded.expiresAt <= now + 60_000
  ) {
    accountCacheMap.delete(account.source)
    log("credentials_source_reload", {
      source: account.source,
      success: false,
      reason: !reloaded
        ? "unavailable"
        : !reloaded.accessToken.trim()
          ? "invalid"
          : "expiring",
    })
    return null
  }

  account.credentials = reloaded
  accountCacheMap.set(account.source, { creds: reloaded, cachedAt: now })
  log("credentials_source_reload", {
    source: account.source,
    success: true,
  })
  return reloaded
}
