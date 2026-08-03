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
import {
  classifyRefreshFailure,
  clearRefreshOutcome,
  getRefreshCooldownUntil,
  getRefreshFailureKind,
  isRefreshCooldownActive,
  noteRefreshTerminal,
  noteRefreshTransient,
  type RefreshFailureKind,
} from "./refresh-backoff.ts"
import { acquireRefreshLock } from "./refresh-lock.ts"

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
    // eslint-disable-next-line @typescript-eslint/naming-convention
    expires_at?: number
    error?: string
  }
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }

  if (!data.access_token) return null

  // Prefer an absolute `expires_at` (ms) when the endpoint provides one, but
  // only if it is a future millisecond timestamp — a seconds-precision value
  // would land in 1970 and read as already-expired, so fall back to the
  // relative `expires_in` (or a conservative default) in that case.
  const expiresAt =
    typeof data.expires_at === "number" && data.expires_at > now
      ? Math.trunc(data.expires_at)
      : Math.trunc(now + (data.expires_in ?? 36_000) * 1000)

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? currentRefreshToken,
    expiresAt,
  }
}

/**
 * Extract the non-secret failure reason from an OAuth token-endpoint error
 * body so a refresh failure is diagnosable from the debug log. Handles both the
 * OAuth shape (`{ error, error_description }`) and Anthropic's API error
 * envelope (`{ error: { type, message } }`). Values are truncated and never
 * include tokens; the logger additionally redacts anything JWT-shaped.
 */
export function extractOAuthError(raw: string): {
  oauthError?: string
  oauthErrorDescription?: string
} {
  let data: {
    error?: unknown
    // eslint-disable-next-line @typescript-eslint/naming-convention
    error_description?: unknown
  }
  try {
    data = JSON.parse(raw)
  } catch {
    return {}
  }

  // JSON.parse succeeds for primitives and arrays too (`null`, `123`, `"str"`,
  // `[...]`); dereferencing `data.error` on those would throw and, worse,
  // escape into refreshViaOAuthDetailed's outer catch — erasing the HTTP status
  // this function exists to preserve. Only object bodies carry an error shape.
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return {}
  }

  const out: { oauthError?: string; oauthErrorDescription?: string } = {}
  if (typeof data.error === "string") {
    out.oauthError = data.error.slice(0, 200)
  } else if (data.error && typeof data.error === "object") {
    const nested = data.error as { type?: unknown; message?: unknown }
    if (typeof nested.type === "string")
      out.oauthError = nested.type.slice(0, 200)
    if (typeof nested.message === "string") {
      out.oauthErrorDescription = nested.message.slice(0, 500)
    }
  }
  // The flat OAuth-standard `error_description` is canonical, so it deliberately
  // wins over a nested-envelope `message` when a response carries both.
  if (typeof data.error_description === "string") {
    out.oauthErrorDescription = data.error_description.slice(0, 500)
  }
  return out
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
/**
 * Classified result of an OAuth refresh. A `transient` outcome (429/5xx/network
 * /`rate_limit_error`) means the refresh token is still good and the caller
 * should back off and retry rather than surface a hard error; a `terminal`
 * outcome (`invalid_grant`, ...) means the refresh token is dead.
 */
export type RefreshOutcome =
  | { kind: "ok"; creds: ClaudeCredentials }
  | {
      kind: "transient"
      status: number
      oauthError?: string
      retryAfterMs?: number
    }
  | { kind: "terminal"; status: number; oauthError?: string }

function parseRetryAfterMs(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined
  const seconds = Number.parseInt(headerValue, 10)
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined
}

/**
 * Exchange a refresh token for fresh credentials and classify the result.
 * See {@link RefreshOutcome}. Uses the runtime's own fetch (no subprocess).
 */
export async function refreshViaOAuthDetailed(
  refreshToken: string,
  timeoutMs = OAUTH_TIMEOUT_MS,
): Promise<RefreshOutcome> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: OAUTH_CLIENT_ID,
    refresh_token: refreshToken,
  })

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    log("refresh_started", { source: "oauth" })
    const response = await fetchWithRetry(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: controller.signal,
    })

    if (!response.ok) {
      // Capture the token endpoint's own failure reason (invalid_grant,
      // invalid_client, rate_limit_error, ...) so a persistent 401 is
      // diagnosable rather than an opaque "HTTP 400".
      const detail = extractOAuthError(await response.text().catch(() => ""))
      const kind = classifyRefreshFailure(response.status, detail.oauthError)
      const retryAfterMs = parseRetryAfterMs(
        response.headers.get("retry-after"),
      )
      log("refresh_failed", {
        source: "oauth",
        error: `HTTP ${response.status}`,
        kind,
        ...detail,
      })
      return kind === "terminal"
        ? { kind, status: response.status, oauthError: detail.oauthError }
        : {
            kind,
            status: response.status,
            oauthError: detail.oauthError,
            retryAfterMs,
          }
    }

    const creds = parseOAuthResponse(await response.text(), refreshToken)
    if (!creds) {
      // A 200 we cannot parse is an endpoint hiccup, not a dead token — treat
      // it as transient so a retry can recover.
      log("refresh_failed", {
        source: "oauth",
        error: "no access_token in response",
        kind: "transient",
      })
      return { kind: "transient", status: response.status }
    }

    log("refresh_success", { source: "oauth" })
    return { kind: "ok", creds }
  } catch (err) {
    // Network error / abort: transient by nature.
    log("refresh_failed", {
      source: "oauth",
      error: err instanceof Error ? err.message : String(err),
      kind: "transient",
    })
    return { kind: "transient", status: 0 }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Backward-compatible wrapper: returns credentials on success, else null.
 * Prefer {@link refreshViaOAuthDetailed} when the transient/terminal
 * distinction matters (cooldown, CLI-fallback gating).
 */
export async function refreshViaOAuth(
  refreshToken: string,
  timeoutMs = OAUTH_TIMEOUT_MS,
): Promise<ClaudeCredentials | null> {
  const outcome = await refreshViaOAuthDetailed(refreshToken, timeoutMs)
  return outcome.kind === "ok" ? outcome.creds : null
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

  // Pick up credentials replaced externally — cswap switching accounts, the
  // claude CLI in another terminal, or a second OpenCode instance. This was
  // once limited to file sources, on the false assumption that a keychain
  // entry is only ever mutated by our own writeBackCredentials. Bounded by
  // getCachedCredentials's 30s TTL, so it fires at most ~2x/min under load.
  //
  // A keychain read shells out to `security`, which throws when the keychain
  // is locked, access is denied, or the call times out. Degrade to the
  // in-memory credentials rather than take down the request path.
  //
  // Adopt a usable stored blob always; an unusable one only when what we
  // already hold is unusable too. Do not simplify this to an unconditional
  // adopt: performRefresh ignores writeBackCredentials's return value, and
  // that write can fail while the read before it succeeded (malformed blob,
  // or an ACL allowing read but not add-generic-password), leaving memory
  // freshly refreshed and the store holding the orphaned pre-refresh blob.
  // On the reactive path that blob has under 60s left — that window is the
  // only reason we refreshed — so adopting it re-enters performRefresh with
  // a refresh token our own refresh just rotated dead: OAuth fails and we
  // fall through to two 60s claude spawns, on every cache miss, forever.
  //
  // Two accepted residuals. An external switch installing an already-expired
  // token while ours is usable is ignored until ours expires; cswap freshens
  // a target before activating it, so that is rare. And the proactive timer
  // refreshes an hour ahead (index.ts), where a failed write-back orphans a
  // blob that is still usable — so it IS adopted, costing wasted background
  // refreshes rather than failed requests until it drops under 60s and the
  // CLI fallback recovers. No guard here closes that one: the re-read cannot
  // tell "stale because our write failed" from "changed because cswap
  // switched", as both present as store-disagrees-with-memory-and-usable.
  // Only the return value performRefresh discards carries the distinction.
  try {
    const stored = refreshAccount(target.source, target.configDir)
    const now = Date.now()
    if (
      stored &&
      (stored.expiresAt > now + 60_000 ||
        target.credentials.expiresAt <= now + 60_000)
    ) {
      target.credentials = stored
      // Read from this account's own source, so what it returned is this
      // account's own credentials — it is no longer running on a lender's.
      borrowedCredentialAccounts.delete(target)
    }
  } catch (err) {
    log("source_reread_failed", {
      source: target.source,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  const creds = target.credentials
  if (creds.expiresAt > Date.now() + thresholdMs) return creds

  // If a recent refresh was rate-limited, don't re-hit the endpoint until the
  // cooldown clears — adopt a sibling instance's / the CLI's fresh token if one
  // has appeared, else defer. This is what stops N OpenCode instances from
  // turning a single transient 429 into a sustained storm. Borrowed accounts
  // are exempt: their recovery (refreshBorrowedAccount) is a distinct path.
  if (
    !borrowedCredentialAccounts.has(target) &&
    isRefreshCooldownActive(target.source)
  ) {
    const adopted = adoptFreshFromSource(target, creds.accessToken)
    if (adopted) return adopted
    log("refresh_cooldown_skip", {
      source: target.source,
      until: getRefreshCooldownUntil(target.source),
    })
    return null
  }

  // The proactive sync timer calls this directly while the request path
  // arrives via getCachedCredentials(). A rotation invalidates the refresh
  // token it was issued against, so two concurrent refreshes would leave
  // one caller holding an already-dead token. Share one attempt instead.
  const inFlight = inFlightRefreshes.get(target.source)
  if (inFlight) {
    log("refresh_joined", { source: target.source })
    return inFlight
  }

  // Cross-process single-flight: only one OpenCode instance / the CLI should
  // hit the token endpoint at a time. If another holds the lock, wait briefly
  // and adopt its result rather than piling onto an already-strained endpoint.
  const lock = acquireRefreshLock(target.source)
  if (!lock) {
    log("refresh_lock_busy", { source: target.source })
    const adopted = await waitForAdopt(target, creds.accessToken)
    if (adopted) return adopted
    // The holder produced nothing within the window (likely crashed; its lock
    // ages out by TTL). Defer rather than refresh lock-free, so we don't
    // recreate the burst the lock exists to prevent — the request-level wait
    // loop and the lock TTL drive eventual progress.
    return null
  }

  const pending = (async () => {
    try {
      return await performRefresh(target, creds)
    } finally {
      lock.release()
    }
  })()
  inFlightRefreshes.set(target.source, pending)
  try {
    return await pending
  } finally {
    inFlightRefreshes.delete(target.source)
  }
}

/**
 * Re-read the account's own source and adopt a token another OpenCode instance
 * or the `claude` CLI has just written. Returns the adopted credentials when
 * the store now holds a distinct, still-valid token, else null.
 */
function adoptFreshFromSource(
  target: ClaudeAccount,
  rejectedAccessToken?: string,
): ClaudeCredentials | null {
  let stored: ClaudeCredentials | null = null
  try {
    stored = refreshAccount(target.source, target.configDir)
  } catch {
    return null
  }
  if (
    stored &&
    stored.accessToken !== rejectedAccessToken &&
    stored.expiresAt > Date.now() + 60_000
  ) {
    target.credentials = stored
    borrowedCredentialAccounts.delete(target)
    clearRefreshOutcome(target.source)
    log("refresh_adopted_from_source", { source: target.source })
    return stored
  }
  return null
}

const LOCK_ADOPT_WAIT_MS = 5_000
const LOCK_ADOPT_POLL_MS = 250

interface AdoptWaitOptions {
  maxMs?: number
  pollMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

/**
 * Another instance holds the refresh lock and is presumably refreshing. Poll
 * the shared store for the token it is about to write, up to a short budget,
 * before giving up.
 */
async function waitForAdopt(
  target: ClaudeAccount,
  rejectedAccessToken: string,
  opts: AdoptWaitOptions = {},
): Promise<ClaudeCredentials | null> {
  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? ((ms: number) => sleepAbortable(ms))
  const maxMs = opts.maxMs ?? LOCK_ADOPT_WAIT_MS
  const pollMs = opts.pollMs ?? LOCK_ADOPT_POLL_MS

  const immediate = adoptFreshFromSource(target, rejectedAccessToken)
  if (immediate) return immediate

  const deadline = now() + maxMs
  while (now() < deadline) {
    await sleep(pollMs)
    const adopted = adoptFreshFromSource(target, rejectedAccessToken)
    if (adopted) return adopted
  }
  return null
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
    const outcome = await refreshViaOAuthDetailed(creds.refreshToken)

    if (
      outcome.kind === "ok" &&
      outcome.creds.expiresAt > Date.now() + 60_000
    ) {
      clearRefreshOutcome(target.source)
      target.credentials = outcome.creds
      if (
        !writeBackCredentials(
          target.source,
          outcome.creds,
          target.configDir,
          creds.accessToken,
        )
      ) {
        // Mirrors force_refresh_writeback_failed on the forced path. The
        // session continues from memory either way, so this stays a log
        // rather than a control-flow change: acting on the two causes
        // (I/O failure vs. CAS mismatch) differs, and the proactive-path
        // consequence — a still-usable orphaned blob being re-adopted by
        // the validated re-read — is tracked as a follow-up.
        log("refresh_writeback_failed", { source: target.source })
      }
      return outcome.creds
    }

    if (outcome.kind === "transient") {
      // A rate-limit / 5xx / network blip: the refresh token is still valid.
      // Back off so we (and our sibling OpenCode instances) stop hammering the
      // endpoint, adopt a token another instance/CLI may have just written,
      // and — crucially — do NOT spawn the claude CLI, which hits the same
      // rate-limited endpoint and only deepens the limit.
      const cooldownMs = noteRefreshTransient(target.source, {
        retryAfterMs: outcome.retryAfterMs,
      })
      log("refresh_transient", {
        source: target.source,
        status: outcome.status,
        oauthError: outcome.oauthError,
        cooldownMs,
      })
      const adopted = adoptFreshFromSource(target, creds.accessToken)
      if (adopted) return adopted
      // Keep serving still-usable credentials on the proactive path.
      if (creds.expiresAt > Date.now() + CLI_FALLBACK_THRESHOLD_MS) return creds
      // Borrow a sibling account's still-valid token rather than spawning the
      // claude CLI, which hits the same rate-limited endpoint.
      const borrowed = tryFallbackAccount(target.source)
      if (borrowed) {
        target.credentials = borrowed
        borrowedCredentialAccounts.add(target)
        return borrowed
      }
      return null
    }

    if (outcome.kind === "terminal") {
      // The refresh token itself is dead (invalid_grant, ...). Fall through to
      // the CLI fallback / borrowed-account recovery below.
      noteRefreshTerminal(target.source)
      log("refresh_terminal", {
        source: target.source,
        status: outcome.status,
        oauthError: outcome.oauthError,
      })
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
  // credentials to the shared store during the OAuth round trip — far
  // cheaper to re-read than to spawn the CLI.
  //
  // The file-source exclusion below is a leftover from when refreshIfNeeded
  // re-read file sources only. That rationale is gone and the exclusion now
  // has none: a sibling process can write a file source mid-round-trip
  // exactly as it can a keychain entry. Left in place only to keep this
  // change off the file path; removing it is tracked as a follow-up.
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
      writeBackCredentials(
        target.source,
        oauthCreds,
        target.configDir,
        own.accessToken,
      )
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
 * keychain service read or credentials file) and update them in place,
 * so an externally refreshed token is picked up without a full
 * multi-account keychain rescan.
 *
 * Currently has no call sites: the 401 path uses
 * reloadCredentialsFromSource, which additionally validates the result
 * and refreshes the cache. Wiring this up or deleting it is tracked as a
 * follow-up; until then it must stay consistent with the read paths that
 * are live, hence the configDir below.
 */
export function reloadActiveAccount(): void {
  const account = getActiveAccount()
  if (!account) return
  try {
    const fresh = refreshAccount(account.source, account.configDir)
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

  const priorAccessToken = account.credentials.accessToken
  const oauthCreds = await refresh(account.credentials.refreshToken)
  if (oauthCreds && oauthCreds.expiresAt > Date.now() + 60_000) {
    account.credentials = oauthCreds
    if (
      !writeBackCredentials(
        account.source,
        oauthCreds,
        account.configDir,
        priorAccessToken,
      )
    ) {
      // Session continues from memory/cache either way, but the two causes
      // diverge on a later source re-read. An I/O failure leaves our own
      // rejected token in the store, so the re-read resurrects it and
      // triggers another refresh. A CAS mismatch means the store now holds
      // another account's token, so the re-read adopts that instead and this
      // account stops using the credentials it just refreshed.
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

/** Max time a single request will wait through a transient refresh rate-limit. */
const REFRESH_WAIT_MS = (() => {
  const raw = process.env.OPENCODE_CLAUDE_AUTH_REFRESH_WAIT_MS
  const parsed = raw ? Number.parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 45_000
})()

const REFRESH_POLL_MS = 2_500

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener("abort", done, { once: true })
  })
}

export interface CredentialWaitOptions {
  maxWaitMs?: number
  pollMs?: number
  signal?: AbortSignal
  now?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  rng?: () => number
}

/**
 * Resolve credentials, waiting through a transient refresh rate-limit rather
 * than failing hard. Returns as soon as a token is available — ours refreshed
 * once the cooldown clears, or a sibling OpenCode instance / the `claude` CLI
 * wrote a fresh one to the shared store. Returns null promptly on a terminal
 * failure (dead refresh token) or when the wait budget is exhausted, so the
 * caller can decide between a retryable response and a hard error.
 */
export async function getCredentialsWithBackoff(
  opts: CredentialWaitOptions = {},
): Promise<ClaudeCredentials | null> {
  const first = await getCachedCredentials()
  if (first) return first

  const source = getActiveAccount()?.source
  // No active account means no in-progress refresh could ever produce a token,
  // so waiting is pointless — fail fast instead of spinning the wait budget.
  if (!source) return null
  // A dead refresh token will not fix itself by waiting.
  if (getRefreshFailureKind(source) === "terminal") return null

  const now = opts.now ?? Date.now
  const sleep = opts.sleep ?? sleepAbortable
  const rng = opts.rng ?? Math.random
  const maxWaitMs = opts.maxWaitMs ?? REFRESH_WAIT_MS
  const pollMs = opts.pollMs ?? REFRESH_POLL_MS
  const deadline = now() + maxWaitMs

  log("fetch_credentials_wait", { source: source ?? null, maxWaitMs })

  while (now() < deadline) {
    if (opts.signal?.aborted) return null
    // Jittered poll so sibling instances desynchronize their re-reads.
    await sleep(Math.round(pollMs * (0.5 + rng() * 0.5)), opts.signal)
    if (opts.signal?.aborted) return null
    const creds = await getCachedCredentials()
    if (creds) return creds
    if (source && getRefreshFailureKind(source) === "terminal") return null
  }
  return null
}

/**
 * Whether the active account's most recent refresh failure was transient
 * (rate-limited/retryable) or terminal (dead refresh token), for callers
 * deciding between a retryable response and a hard "re-authenticate" error.
 * An active cooldown implies a transient failure.
 */
export function getActiveRefreshFailureKind(): RefreshFailureKind | null {
  const source = getActiveAccount()?.source
  if (!source) return null
  const kind = getRefreshFailureKind(source)
  if (kind === "transient" || isRefreshCooldownActive(source))
    return "transient"
  return kind
}

export function reloadCredentialsFromSource(): ClaudeCredentials | null {
  const account = getActiveAccount()
  if (!account) return null

  let reloaded: ClaudeCredentials | null
  try {
    // Same configDir the write path resolves, so the compare-and-swap in
    // writeBackCredentials compares against the file this read came from.
    reloaded = refreshAccount(account.source, account.configDir)
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
  // Read from this account's own source, so what it returned is this
  // account's own credentials — it is no longer running on a lender's.
  // Same invariant as refreshIfNeeded's up-front re-read: leaving the flag
  // set here makes forceRefreshActiveAccount decline to exchange a token
  // that is legitimately this account's, which strands the 401 recovery
  // loop's second attempt on a credential it could have refreshed.
  borrowedCredentialAccounts.delete(account)
  accountCacheMap.set(account.source, { creds: reloaded, cachedAt: now })
  log("credentials_source_reload", {
    source: account.source,
    success: true,
  })
  return reloaded
}
