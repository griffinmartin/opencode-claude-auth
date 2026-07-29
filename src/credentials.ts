import { execSync } from "node:child_process"
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
import { fetchWithRetry } from "./http.ts"
import { log } from "./logger.ts"

export type { ClaudeAccount } from "./keychain.ts"
export type { ClaudeCredentials } from "./keychain.ts"

const CREDENTIAL_CACHE_TTL_MS = 30_000

// Only inside this window will the claude CLI actually rotate a token, so
// it is also the only window where spawning it is worth a real API request.
const CLI_FALLBACK_THRESHOLD_MS = 60_000

const accountCacheMap = new Map<
  string,
  { creds: ClaudeCredentials; cachedAt: number }
>()
const inFlightRefreshes = new Map<string, Promise<ClaudeCredentials | null>>()

// Accounts currently running on credentials borrowed from another account.
// Those tokens belong to the lender: they must never be used as this
// account's refresh source, and never written back to its store.
const borrowedCredentialAccounts = new WeakSet<ClaudeAccount>()
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

export function getActiveAccount(): ClaudeAccount | null {
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

const OAUTH_TIMEOUT_MS = 15_000

/**
 * Exchanges a refresh token for fresh credentials using the runtime's own
 * fetch.
 *
 * This previously ran the request inside a child process spawned as
 * `process.execPath -e <script>`. That assumed process.execPath is a
 * JavaScript runtime, which does not hold inside OpenCode: the plugin runs
 * in a compiled single-file executable, so process.execPath is the OpenCode
 * binary itself and `-e` is not a script to evaluate. Every refresh exited
 * non-zero with empty stdout and silently fell through to the claude CLI.
 * Node 18+ and Bun both expose a global fetch, so no subprocess is needed.
 */
export async function refreshViaOAuth(
  refreshToken: string,
  timeoutMs = OAUTH_TIMEOUT_MS,
): Promise<ClaudeCredentials | null> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: OAUTH_CLIENT_ID,
    refresh_token: refreshToken,
  })

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    log("refresh_started", { source: "oauth" })
    // The token endpoint rate-limits valid refresh requests, and several
    // OpenCode instances refreshing near expiry cluster their calls, so a
    // 429 here is transient rather than terminal. The shared helper caps
    // its own backoff, and the abort signal bounds the whole sequence.
    const response = await fetchWithRetry(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: controller.signal,
    })

    if (!response.ok) {
      log("refresh_failed", {
        source: "oauth",
        error: `HTTP ${response.status}`,
      })
      return null
    }

    const creds = parseOAuthResponse(await response.text(), refreshToken)
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
  } finally {
    clearTimeout(timer)
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

/**
 * Refreshes the given (or active) account's credentials if they are within
 * `thresholdMs` of expiry. Defaults to 60s, matching the reactive
 * per-request refresh path. Callers that want a proactive refresh further
 * ahead of expiry (e.g. a background timer) should pass a larger threshold —
 * the account resolution (via getActiveAccount()) stays correct regardless
 * of threshold, so this always operates on the currently active account
 * unless one is explicitly passed in.
 */
export async function refreshIfNeeded(
  account?: ClaudeAccount,
  thresholdMs = 60_000,
): Promise<ClaudeCredentials | null> {
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
  if (creds.expiresAt > Date.now() + thresholdMs) return creds

  // The proactive sync timer calls this directly while the request path
  // arrives via getCachedCredentials(). A rotation invalidates the refresh
  // token it was issued against, so two concurrent refreshes would leave
  // one caller holding an already-dead token. Share one attempt instead.
  const inFlight = inFlightRefreshes.get(target.source)
  if (inFlight) {
    log("refresh_joined", { source: target.source })
    return inFlight
  }

  const pending = performRefresh(target, creds)
  inFlightRefreshes.set(target.source, pending)
  try {
    return await pending
  } finally {
    inFlightRefreshes.delete(target.source)
  }
}

async function performRefresh(
  target: ClaudeAccount,
  creds: ClaudeCredentials,
): Promise<ClaudeCredentials | null> {
  if (borrowedCredentialAccounts.has(target)) {
    return refreshBorrowedAccount(target)
  }

  log("refresh_needed", {
    source: target.source,
    expiresAt: creds.expiresAt,
    expiresIn: creds.expiresAt - Date.now(),
  })

  if (creds.refreshToken) {
    const oauthCreds = await refreshViaOAuth(creds.refreshToken)
    if (oauthCreds && oauthCreds.expiresAt > Date.now() + 60_000) {
      target.credentials = oauthCreds
      writeBackCredentials(target.source, oauthCreds, target.configDir)
      return oauthCreds
    }
  }

  // The claude CLI only rotates a token that is itself close to expiry, so
  // running it while the current one is still usable spawns a real API
  // request that hands back the same token. Callers using a proactive
  // threshold (the sync timer passes an hour) would otherwise pay for that
  // request on every tick. Keep the fallback scoped to the reactive window
  // and let the caller try again later.
  if (creds.expiresAt > Date.now() + CLI_FALLBACK_THRESHOLD_MS) {
    log("refresh_cli_skipped", {
      source: target.source,
      reason: "credentials still usable",
      expiresIn: creds.expiresAt - Date.now(),
    })
    return creds
  }

  // Every OpenCode instance refreshes independently, and a rotation
  // invalidates the refresh token the others are holding. When ours is
  // rejected, the instance that won may already have written usable
  // credentials to the shared store — far cheaper to re-read than to spawn
  // the CLI. (File sources are re-read up front by refreshIfNeeded.)
  if (target.source !== "file") {
    let stored: ClaudeCredentials | null = null
    try {
      stored = refreshAccount(target.source, target.configDir)
    } catch {
      stored = null
    }
    if (
      stored &&
      stored.accessToken !== creds.accessToken &&
      stored.expiresAt > Date.now() + 60_000
    ) {
      target.credentials = stored
      log("refresh_adopted_external", { source: target.source })
      return stored
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
      borrowedCredentialAccounts.add(target)
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

/**
 * Refresh path for an account running on borrowed credentials. The tokens it
 * currently holds belong to another account, so they cannot be exchanged at
 * the OAuth endpoint on this account's behalf, and the result must never be
 * written to this account's store. Re-read our own source first — the claude
 * CLI or another process may have repaired it — and otherwise borrow again.
 */
async function refreshBorrowedAccount(
  target: ClaudeAccount,
): Promise<ClaudeCredentials | null> {
  log("refresh_borrowed", { source: target.source })

  let own: ClaudeCredentials | null = null
  try {
    own = refreshAccount(target.source, target.configDir)
  } catch {
    own = null
  }

  if (own && own.expiresAt > Date.now() + 60_000) {
    borrowedCredentialAccounts.delete(target)
    target.credentials = own
    log("refresh_borrowed_recovered", { source: target.source, via: "source" })
    return own
  }

  // A refresh token outlives its access token by weeks, so this account's
  // own stored token is likely still exchangeable even though the access
  // token it came with has expired. This is the only token we may present
  // on its behalf, and the only result we may write to its store.
  if (own?.refreshToken) {
    const oauthCreds = await refreshViaOAuth(own.refreshToken)
    if (oauthCreds && oauthCreds.expiresAt > Date.now() + 60_000) {
      borrowedCredentialAccounts.delete(target)
      target.credentials = oauthCreds
      writeBackCredentials(target.source, oauthCreds, target.configDir)
      log("refresh_borrowed_recovered", { source: target.source, via: "oauth" })
      return oauthCreds
    }
  }

  const again = tryFallbackAccount(target.source)
  if (again) {
    target.credentials = again
    return again
  }

  // Recovery failed. The account must not be left holding the lender's
  // tokens, or the next cycle would take the normal path and exchange them.
  // Restore its own credentials if we managed to read them — expired, but
  // ours to refresh — and otherwise keep the guard in place.
  if (own) {
    borrowedCredentialAccounts.delete(target)
    target.credentials = own
  }

  log("refresh_exhausted", {
    source: target.source,
    hadCredentials: !!own,
    expiresAt: own?.expiresAt,
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
export async function forceRefreshActiveAccount(
  refresh: (
    refreshToken: string,
  ) => Promise<ClaudeCredentials | null> = refreshViaOAuth,
): Promise<ClaudeCredentials | null> {
  const account = getActiveAccount()
  if (!account?.credentials.refreshToken) return null

  // These tokens belong to another account: exchanging them here would
  // rotate the lender's refresh token and persist the result to this
  // account's store. Borrowed-account recovery belongs to refreshIfNeeded.
  if (borrowedCredentialAccounts.has(account)) {
    log("force_refresh_skipped_borrowed", { source: account.source })
    return null
  }

  const oauthCreds = await refresh(account.credentials.refreshToken)
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

export async function getCachedCredentials(): Promise<ClaudeCredentials | null> {
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

  const fresh = await refreshIfNeeded(account)
  if (!fresh) {
    log("credentials_unavailable", { source: account.source })
    accountCacheMap.delete(account.source)
    return null
  }

  accountCacheMap.set(account.source, { creds: fresh, cachedAt: Date.now() })
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
