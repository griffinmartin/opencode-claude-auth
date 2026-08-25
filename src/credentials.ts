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
import { log } from "./logger.ts"
import {
  classifyRefreshFailure,
  clearRefreshOutcome,
  getRefreshCooldownUntil,
  getRefreshFailureKind,
  isCliFallbackCooldownActive,
  isRefreshCooldownActive,
  noteCliFallbackAttempt,
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

/** Per-attempt timeout for the `claude` CLI fallback. */
const CLI_ATTEMPT_TIMEOUT_MS = 60_000
const CLI_MAX_ATTEMPTS = 1

/**
 * Worst-case wall time the CLI fallback can occupy. The refresh lock's lease
 * must cover this, or siblings treat the holder as crashed mid-refresh — these
 * two numbers drifting apart is what turns one slow refresh into a rotation
 * storm, so the budget is derived rather than restated.
 */
export const CLI_REFRESH_BUDGET_MS = CLI_ATTEMPT_TIMEOUT_MS * CLI_MAX_ATTEMPTS

/** Slack added to a lease so it outlives the work it covers. */
const LEASE_MARGIN_MS = 15_000

const accountCacheMap = new Map<
  string,
  { creds: ClaudeCredentials; cachedAt: number }
>()
const inFlightRefreshes = new Map<string, Promise<ClaudeCredentials | null>>()

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
    log("active_account_missing", { source: activeAccountSource })
    return null
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

export const OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
export const OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
export const OAUTH_SCOPE = [
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
].join(" ")

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

const OAUTH_TIMEOUT_MS = 30_000

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

type RefreshFailureOutcome = Exclude<RefreshOutcome, { kind: "ok" }>

function parseRetryAfterMs(headerValue: string | null): number | undefined {
  if (!headerValue) return undefined
  const seconds = Number.parseInt(headerValue, 10)
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined
}

function recordRefreshFailure(
  source: string,
  outcome: RefreshFailureOutcome,
): void {
  if (outcome.kind === "transient") {
    const cooldownMs = noteRefreshTransient(source, {
      retryAfterMs: outcome.retryAfterMs,
    })
    log("refresh_transient", {
      source,
      status: outcome.status,
      oauthError: outcome.oauthError,
      cooldownMs,
    })
    return
  }

  noteRefreshTerminal(source)
  log("refresh_terminal", {
    source,
    status: outcome.status,
    oauthError: outcome.oauthError,
  })
}

/**
 * Exchange a refresh token for fresh credentials and classify the result.
 * See {@link RefreshOutcome}. Uses the runtime's own fetch (no subprocess).
 */
export async function refreshViaOAuthDetailed(
  refreshToken: string,
  timeoutMs = OAUTH_TIMEOUT_MS,
): Promise<RefreshOutcome> {
  const body = {
    grant_type: "refresh_token",
    client_id: OAUTH_CLIENT_ID,
    refresh_token: refreshToken,
    scope: OAUTH_SCOPE,
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    log("refresh_started", { source: "oauth" })
    const response = await fetch(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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

function refreshViaCli(configDir?: string, useConfigDir = false): boolean {
  if (useConfigDir && !configDir) {
    log("refresh_cli_skipped", {
      source: "cli",
      reason: "configDir unknown for suffixed account",
    })
    return false
  }

  const env: Record<string, string | undefined> = {
    ...process.env,
    TERM: "dumb",
  }
  if (useConfigDir && configDir) env.CLAUDE_CONFIG_DIR = configDir
  else delete env.CLAUDE_CONFIG_DIR

  for (let i = 0; i < CLI_MAX_ATTEMPTS; i++) {
    log("refresh_started", { source: "cli", attempt: i + 1, configDir })
    try {
      execSync("claude -p . --model haiku", {
        timeout: CLI_ATTEMPT_TIMEOUT_MS,
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
  // fall through to a 60s Claude spawn on every cache miss, forever.
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
    const changed = stored?.accessToken !== target.credentials.accessToken
    if (
      stored &&
      (stored.expiresAt > now + 60_000 ||
        target.credentials.expiresAt <= now + 60_000)
    ) {
      target.credentials = stored
      if (changed && stored.expiresAt > now + 60_000) {
        clearRefreshOutcome(target.source)
      }
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
  // turning a single transient 429 into a sustained storm.
  if (isRefreshCooldownActive(target.source)) {
    const adopted = adoptFreshFromSource(target, creds.accessToken)
    if (adopted) return adopted
    log("refresh_cooldown_skip", {
      source: target.source,
      until: getRefreshCooldownUntil(target.source),
    })
    if (
      creds.expiresAt > Date.now() + CLI_FALLBACK_THRESHOLD_MS ||
      isCliFallbackCooldownActive(target.source)
    ) {
      return null
    }
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
      const adopted = adoptFreshFromSource(target, creds.accessToken)
      if (adopted) return adopted
      // A cooldown that landed while we queued for the lock. Terminal state is
      // handled in performRefresh without retrying the rejected token.
      if (isRefreshCooldownActive(target.source)) {
        log("refresh_state_skip_after_lock", { source: target.source })
        if (
          creds.expiresAt > Date.now() + CLI_FALLBACK_THRESHOLD_MS ||
          isCliFallbackCooldownActive(target.source)
        ) {
          return null
        }
      }
      return await performRefresh(target, creds, (ms) => lock.extend(ms))
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
  /**
   * Extends the caller's cross-process lease before an operation that runs
   * longer than the base lock TTL. Absent on paths that hold no lock.
   */
  extendLease?: (ms: number) => void,
): Promise<ClaudeCredentials | null> {
  log("refresh_needed", {
    source: target.source,
    expiresAt: creds.expiresAt,
    expiresIn: creds.expiresAt - Date.now(),
  })

  // A refresh token already rejected as dead cannot be revived by another
  // exchange, and the CLI fallback performs that same exchange — so once a
  // terminal failure is on record, both are skipped. Read before the
  // attempt below, so a terminal failure recorded by THIS call still gets its
  // one CLI try.
  const priorTerminal = getRefreshFailureKind(target.source) === "terminal"

  if (
    creds.refreshToken &&
    !priorTerminal &&
    !isRefreshCooldownActive(target.source)
  ) {
    extendLease?.(OAUTH_TIMEOUT_MS + LEASE_MARGIN_MS)
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
      // Back off direct requests and adopt a token another process may have
      // written. If the access token is already unusable, fall through to one
      // Claude CLI attempt: its startup refresh is the same recovery users run
      // manually, and avoids leaving OpenCode stuck until another terminal does
      // it for us.
      recordRefreshFailure(target.source, outcome)
      const adopted = adoptFreshFromSource(target, creds.accessToken)
      if (adopted) return adopted
      // Keep serving still-usable credentials on the proactive path.
      if (creds.expiresAt > Date.now() + CLI_FALLBACK_THRESHOLD_MS) return creds
    }

    if (outcome.kind === "terminal") {
      // The refresh token itself is dead (invalid_grant, ...). Fall through to
      // the CLI fallback below.
      recordRefreshFailure(target.source, outcome)
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
      clearRefreshOutcome(target.source)
      target.credentials = stored
      log("refresh_adopted_external", { source: target.source })
      return stored
    }
  }

  if (priorTerminal) {
    log("refresh_cli_skipped", {
      source: target.source,
      reason: "refresh token already rejected",
    })
    return null
  }

  if (isCliFallbackCooldownActive(target.source)) {
    log("refresh_cli_skipped", {
      source: target.source,
      reason: "CLI fallback cooldown active",
    })
    return null
  }

  noteCliFallbackAttempt(target.source)
  log("refresh_fallback_cli", { source: target.source })
  const isSuffixedAccount =
    target.source !== PRIMARY_SERVICE &&
    target.source.startsWith(PRIMARY_SERVICE + "-")
  const useConfigDir = target.source === "file" || isSuffixedAccount
  // The CLI can run for CLI_REFRESH_BUDGET_MS, several times the lock's base
  // TTL. Without extending the lease first, every sibling instance declares
  // this holder crashed and refreshes concurrently — and each rotation kills
  // the refresh token the others are holding, so they fall through to their
  // own CLI spawns against an endpoint that is already rate-limiting.
  extendLease?.(CLI_REFRESH_BUDGET_MS + LEASE_MARGIN_MS)
  const cliSucceeded = refreshViaCli(target.configDir, useConfigDir)
  if (!cliSucceeded) {
    noteCliFallbackAttempt(target.source)
    if (!creds.refreshToken) noteRefreshTerminal(target.source)
    return null
  }

  let refreshed: ClaudeCredentials | null
  try {
    refreshed = refreshAccount(target.source, target.configDir)
  } catch (err) {
    noteCliFallbackAttempt(target.source)
    log("refresh_source_reread_failed", {
      source: target.source,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }

  if (refreshed && refreshed.expiresAt > Date.now() + 60_000) {
    clearRefreshOutcome(target.source)
    target.credentials = refreshed
    return refreshed
  }

  log("refresh_exhausted", {
    source: target.source,
    hadCredentials: !!refreshed,
    expiresAt: refreshed?.expiresAt,
  })
  noteCliFallbackAttempt(target.source)
  if (!creds.refreshToken) noteRefreshTerminal(target.source)
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
function storeForcedCredentials(
  account: ClaudeAccount,
  oauthCreds: ClaudeCredentials | null,
  priorAccessToken: string,
): ClaudeCredentials | null {
  if (!oauthCreds || oauthCreds.expiresAt <= Date.now() + 60_000) {
    log("force_refresh_failed", { source: account.source })
    return null
  }

  account.credentials = oauthCreds
  clearRefreshOutcome(account.source)
  if (
    !writeBackCredentials(
      account.source,
      oauthCreds,
      account.configDir,
      priorAccessToken,
    )
  ) {
    log("force_refresh_writeback_failed", { source: account.source })
  }
  accountCacheMap.set(account.source, {
    creds: oauthCreds,
    cachedAt: Date.now(),
  })
  return oauthCreds
}

export async function forceRefreshActiveAccount(
  refresh?: (refreshToken: string) => Promise<ClaudeCredentials | null>,
): Promise<ClaudeCredentials | null> {
  const account = getActiveAccount()
  if (!account?.credentials.refreshToken) return null

  const priorAccessToken = account.credentials.accessToken
  if (refresh) {
    return storeForcedCredentials(
      account,
      await refresh(account.credentials.refreshToken),
      priorAccessToken,
    )
  }

  if (
    getRefreshFailureKind(account.source) === "terminal" ||
    isRefreshCooldownActive(account.source)
  ) {
    return null
  }

  const lock = acquireRefreshLock(account.source)
  if (!lock) {
    log("refresh_lock_busy", { source: account.source })
    return waitForAdopt(account, priorAccessToken)
  }

  try {
    const adopted = adoptFreshFromSource(account, priorAccessToken)
    if (adopted) return adopted
    if (
      getRefreshFailureKind(account.source) === "terminal" ||
      isRefreshCooldownActive(account.source)
    ) {
      return null
    }

    lock.extend(OAUTH_TIMEOUT_MS + LEASE_MARGIN_MS)
    const outcome = await refreshViaOAuthDetailed(
      account.credentials.refreshToken,
    )
    if (outcome.kind === "ok") {
      return storeForcedCredentials(account, outcome.creds, priorAccessToken)
    } else {
      recordRefreshFailure(account.source, outcome)
      log("force_refresh_failed", { source: account.source })
      return null
    }
  } finally {
    lock.release()
  }
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
  accountCacheMap.set(account.source, { creds: reloaded, cachedAt: now })
  log("credentials_source_reload", {
    source: account.source,
    success: true,
  })
  return reloaded
}
