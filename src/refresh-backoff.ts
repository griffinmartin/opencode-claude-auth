import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/**
 * Transient-vs-terminal classification and per-account backoff for OAuth token
 * refreshes.
 *
 * The token endpoint (`platform.claude.com/v1/oauth/token`) rate-limits refresh requests
 * with HTTP 429 `rate_limit_error`. That is transient — the refresh token is
 * still valid — but the plugin previously treated every non-OK refresh as a
 * hard failure, surfacing "credentials unavailable. Run `claude`" and then
 * hammering the same endpoint (and the `claude` CLI, which hits it too). This
 * module lets callers tell a transient rate-limit apart from a genuinely dead
 * refresh token (`invalid_grant`), and imposes a cooldown so a rate-limited
 * account is not re-hit until the window has plausibly cleared.
 */

export type RefreshFailureKind = "transient" | "terminal"

/** Base cooldown after the first transient failure (env-overridable). */
export const BASE_COOLDOWN_MS = (() => {
  const raw = process.env.OPENCODE_CLAUDE_AUTH_REFRESH_COOLDOWN_MS
  const parsed = raw ? Number.parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 15_000
})()

/** Hard ceiling for a single cooldown, regardless of consecutive failures. */
export const MAX_COOLDOWN_MS = 60_000
export const CLI_FALLBACK_COOLDOWN_MS = 60_000

/**
 * OAuth token-endpoint error codes that mean the refresh token itself is no
 * longer usable. Everything else — rate limits, 5xx, network errors, unknown
 * codes — is treated as transient so a recoverable blip never surfaces as a
 * hard "re-authenticate" error.
 */
const TERMINAL_OAUTH_ERRORS = new Set([
  "invalid_grant",
  "invalid_client",
  "unauthorized_client",
  "unsupported_grant_type",
  // Sending a scope wider than the original grant fails identically on every
  // retry, so treating it as transient would loop the cooldown forever.
  "invalid_scope",
])

export function classifyRefreshFailure(
  _status: number,
  oauthError?: string,
): RefreshFailureKind {
  return oauthError && TERMINAL_OAUTH_ERRORS.has(oauthError)
    ? "terminal"
    : "transient"
}

interface BackoffOptions {
  retryAfterMs?: number
  now?: number
  rng?: () => number
}

/**
 * Delay before the next refresh attempt. An explicit `retry-after` from the
 * endpoint wins (still clamped to `MAX_COOLDOWN_MS`); otherwise an exponential
 * schedule (base · 2^(n-1),
 * capped) with jitter in the [50%, 100%] band to desynchronize the several
 * OpenCode instances / CLI invocations that all refresh the same account.
 */
export function computeBackoffMs(
  consecutive: number,
  opts: BackoffOptions = {},
): number {
  if (opts.retryAfterMs !== undefined && opts.retryAfterMs > 0) {
    // Honor the server's hint, but keep it under the documented cap so a large
    // `Retry-After` (e.g. an hour-long quota reset) can't pin every request to
    // the full wait budget for that whole window.
    return Math.min(MAX_COOLDOWN_MS, opts.retryAfterMs)
  }
  const rng = opts.rng ?? Math.random
  const exponent = Math.max(0, consecutive - 1)
  const scheduled = Math.min(MAX_COOLDOWN_MS, BASE_COOLDOWN_MS * 2 ** exponent)
  const jitterFactor = 0.5 + rng() * 0.5
  return Math.min(MAX_COOLDOWN_MS, Math.round(scheduled * jitterFactor))
}

interface RefreshState {
  kind: RefreshFailureKind
  consecutive: number
  until?: number
  cliAttemptedAt?: number
}

const touchedPaths = new Set<string>()
const volatileStates = new Map<string, RefreshState>()

function statePath(source: string): string {
  const dir =
    process.env.OPENCODE_CLAUDE_AUTH_REFRESH_STATE_DIR ??
    process.env.OPENCODE_CLAUDE_AUTH_REFRESH_LOCK_DIR ??
    join(homedir(), ".local", "share", "opencode")
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 16)
  return join(dir, `claude-auth-refresh-${digest}.json`)
}

function parseState(path: string): RefreshState | null {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return null
  }
  if (!value || typeof value !== "object") return null
  const { kind, consecutive, until, cliAttemptedAt } =
    value as Partial<RefreshState>
  if (kind !== "transient" && kind !== "terminal") return null
  if (
    typeof consecutive !== "number" ||
    !Number.isInteger(consecutive) ||
    consecutive < 0
  ) {
    return null
  }
  if (
    until !== undefined &&
    (typeof until !== "number" || !Number.isFinite(until))
  ) {
    return null
  }
  if (
    cliAttemptedAt !== undefined &&
    (typeof cliAttemptedAt !== "number" || !Number.isFinite(cliAttemptedAt))
  ) {
    return null
  }
  return { kind, consecutive, until, cliAttemptedAt }
}

/**
 * Prefer the shared file, so a cooldown one process recorded is visible to the
 * others. An unreadable or malformed file falls back to what this process last
 * wrote, rather than dropping a cooldown it knows about.
 */
function readState(source: string): RefreshState | null {
  const path = statePath(source)
  touchedPaths.add(path)
  const persisted = parseState(path)
  if (persisted) {
    volatileStates.delete(source)
    return persisted
  }
  return volatileStates.get(source) ?? null
}

function writeState(source: string, state: RefreshState): void {
  const path = statePath(source)
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  touchedPaths.add(path)
  volatileStates.set(source, state)
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(temp, JSON.stringify(state), {
      encoding: "utf8",
      mode: 0o600,
    })
    renameSync(temp, path)
    volatileStates.delete(source)
  } catch {
    try {
      unlinkSync(temp)
    } catch {
      // best effort
    }
  }
}

function deleteState(source: string): void {
  const path = statePath(source)
  touchedPaths.add(path)
  volatileStates.delete(source)
  try {
    unlinkSync(path)
  } catch {
    // already absent
  }
}

/**
 * Record a transient refresh failure for `source` and return the cooldown
 * duration applied. The cooldown escalates with consecutive transient
 * failures and is exposed via {@link isRefreshCooldownActive}.
 */
export function noteRefreshTransient(
  source: string,
  opts: BackoffOptions = {},
): number {
  const now = opts.now ?? Date.now()
  const previous = readState(source)
  const consecutive =
    (previous?.kind === "transient" ? previous.consecutive : 0) + 1
  const ms = computeBackoffMs(consecutive, opts)
  writeState(source, {
    kind: "transient",
    until: now + ms,
    consecutive,
    cliAttemptedAt: previous?.cliAttemptedAt,
  })
  return ms
}

/** Record a terminal refresh failure (dead refresh token). No cooldown. */
export function noteRefreshTerminal(source: string): void {
  writeState(source, {
    kind: "terminal",
    consecutive: 0,
    cliAttemptedAt: readState(source)?.cliAttemptedAt,
  })
}

export function noteCliFallbackAttempt(
  source: string,
  now: number = Date.now(),
): void {
  const previous = readState(source)
  writeState(source, {
    kind: previous?.kind ?? "transient",
    consecutive: previous?.consecutive ?? 0,
    until: previous?.until,
    cliAttemptedAt: now,
  })
}

export function isCliFallbackCooldownActive(
  source: string,
  now: number = Date.now(),
): boolean {
  const attemptedAt = readState(source)?.cliAttemptedAt
  return (
    attemptedAt !== undefined && attemptedAt + CLI_FALLBACK_COOLDOWN_MS > now
  )
}

/** Clear all backoff state for `source` after a successful refresh/adopt. */
export function clearRefreshOutcome(source: string): void {
  deleteState(source)
}

export function isRefreshCooldownActive(
  source: string,
  now: number = Date.now(),
): boolean {
  const state = readState(source)
  return state?.kind === "transient" && (state.until ?? 0) > now
}

export function getRefreshCooldownUntil(source: string): number | null {
  const state = readState(source)
  return state?.kind === "transient" ? (state.until ?? null) : null
}

export function getRefreshFailureKind(
  source: string,
): RefreshFailureKind | null {
  return readState(source)?.kind ?? null
}

/** Test seam: remove refresh state touched by this module instance. */
export function resetRefreshBackoffState(): void {
  for (const path of touchedPaths) {
    try {
      unlinkSync(path)
    } catch {
      // already absent
    }
  }
  touchedPaths.clear()
  volatileStates.clear()
}
