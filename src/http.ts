import { log } from "./logger.ts"
import { statSync, watch, type FSWatcher } from "node:fs"
import { basename, dirname } from "node:path"

export type FetchFn = typeof fetch

export function throwIfAborted(signal?: AbortSignal | null): void {
  if (signal?.aborted)
    throw signal.reason ?? new DOMException("Aborted", "AbortError")
}

/**
 * Distinguishes OpenCode's response-header wrapper deadline (HeaderTimeoutError
 * raised by its provider options after the default 300 s) from a
 * genuine user Stop. The first should be answered with a held 429 so
 * OpenCode's retry machinery takes over; the second must propagate as a real
 * cancellation. Detection is name/message based, not signal shape, because
 * AbortSignal.any() collapses both into one aborted flag.
 */
export function isSyntheticDeadlineAbort(signal?: AbortSignal | null): boolean {
  if (!signal?.aborted) return false
  const reason: unknown = signal.reason
  if (reason && typeof reason === "object") {
    const rec = reason as { name?: unknown }
    const name = typeof rec.name === "string" ? rec.name : ""
    if (/HeaderTimeoutError/i.test(name)) return true
  }
  const text = reason instanceof Error ? reason.message : String(reason ?? "")
  return /header\s*timeout|HeaderTimeout/i.test(text)
}

/** Only the actual network attempt has a header deadline, never a quota wait.
 * The caller's signal remains connected to the returned stream after headers. */
export async function fetchWithHeaderDeadline(
  input: RequestInfo | URL,
  init?: RequestInit,
  fetchImpl: FetchFn = fetch,
  timeoutMs = Number(process.env.OPENCODE_CLAUDE_AUTH_NETWORK_TIMEOUT_MS) ||
    120_000,
): Promise<Response> {
  const caller =
    init?.signal ?? (input instanceof Request ? input.signal : undefined)
  throwIfAborted(caller)
  const controller = new AbortController()
  const timeout = setTimeout(
    () =>
      controller.abort(
        new DOMException("Claude response headers timed out", "TimeoutError"),
      ),
    Math.max(1, timeoutMs),
  )
  const signal = caller
    ? AbortSignal.any([caller, controller.signal])
    : controller.signal
  try {
    return await fetchImpl(input, { ...init, signal })
  } finally {
    clearTimeout(timeout)
  }
}

/** Cheap local revision only; contains no file content or credentials. */
export function stateRevision(paths: string[]): string {
  return paths
    .map((path) => {
      try {
        const s = statSync(path)
        return `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`
      } catch {
        return "missing"
      }
    })
    .join("|")
}

/** One timer plus filesystem notifications. Atomic rename and file creation
 * are observed by watching parent directories. Missing watchers fall back to
 * the caller's periodic local re-evaluation. No provider polling. */
export function sleepUntilStateChange(
  ms: number,
  signal: AbortSignal | null | undefined,
  paths: string[],
  revision = stateRevision(paths),
): Promise<void> {
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    const watchers: FSWatcher[] = []
    let timer: ReturnType<typeof setTimeout> | undefined
    let done = false
    const finish = (aborted = false) => {
      if (done) return
      done = true
      clearTimeout(timer)
      for (const watcher of watchers) watcher.close()
      signal?.removeEventListener("abort", abort)
      if (aborted)
        reject(signal?.reason ?? new DOMException("Aborted", "AbortError"))
      else resolve()
    }
    const abort = () => finish(true)
    signal?.addEventListener("abort", abort, { once: true })
    const dirs = new Set(paths.map(dirname))
    for (const dir of dirs) {
      try {
        const names = new Set(
          paths.filter((p) => dirname(p) === dir).map((p) => basename(p)),
        )
        const watcher = watch(dir, (_event, name) => {
          if (name === null || names.has(String(name))) finish()
        })
        watcher.on("error", () => finish())
        watchers.push(watcher)
      } catch {
        /* parent may not exist yet; timer still rechecks local state */
      }
    }
    timer = setTimeout(() => finish(), Math.max(1, Math.min(ms, 2_147_483_647)))
    if (signal?.aborted) abort()
    else if (stateRevision(paths) !== revision) finish()
  })
}

/** API 429s belong to account rotation immediately. 529s remain bounded
 * capacity retries on the same account. OAuth uses fetchWithRetry unchanged. */
export function fetchClaudeMessages(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return fetchWithRetry(input, init, 3, fetchWithHeaderDeadline, false)
}

// Maximum delay before we give up retrying and surface the error.
// A retry-after longer than this signals a quota/usage-limit reset (hours away)
// rather than a transient rate limit — retrying would hang indefinitely.
// Override with OPENCODE_CLAUDE_AUTH_MAX_RETRY_MS for longer retry windows.
const DEFAULT_MAX_RETRY_DELAY_MS = 30_000

function getMaxRetryDelayMs(): number {
  const env = process.env.OPENCODE_CLAUDE_AUTH_MAX_RETRY_MS
  if (env) {
    const parsed = parseInt(env, 10)
    if (!Number.isNaN(parsed) && parsed > 0) return parsed
  }
  return DEFAULT_MAX_RETRY_DELAY_MS
}

/**
 * Waits `ms`, or resolves early if the caller's signal aborts. A plain
 * setTimeout would let a capped backoff outlast the timeout the caller
 * bounded the whole request with.
 *
 * Exported for the quota-wait loop in index.ts, which sleeps until a benched
 * account's reset under the same abort rule.
 */
export function sleepUnlessAborted(
  ms: number,
  signal?: AbortSignal | null,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const finish = () => {
      clearTimeout(timer)
      signal?.removeEventListener("abort", finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal?.addEventListener("abort", finish, { once: true })
  })
}

export async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  retries = 3,
  fetchImpl: FetchFn = fetch,
  retryRateLimits = true,
): Promise<Response> {
  const signal =
    init?.signal ?? (input instanceof Request ? input.signal : undefined)
  throwIfAborted(signal)
  for (let i = 0; i < retries; i++) {
    throwIfAborted(signal)
    const res = await fetchImpl(input, init)
    if (signal?.aborted) {
      void res.body?.cancel().catch(() => {})
      throwIfAborted(signal)
    }
    if (
      ((res.status === 429 && retryRateLimits) || res.status === 529) &&
      i < retries - 1
    ) {
      const retryAfter = res.headers.get("retry-after")
      const parsed = retryAfter ? parseInt(retryAfter, 10) : NaN
      const delay = Number.isNaN(parsed) ? (i + 1) * 2000 : parsed * 1000
      // If delay exceeds the cap, the server is signalling a quota/usage-limit
      // reset far in the future. Return immediately so the error surfaces to
      // the user rather than silently hanging until the reset time.
      if (delay > getMaxRetryDelayMs()) {
        log("fetch_rate_limited_quota", {
          status: res.status,
          retryAfter: retryAfter ?? "none",
          delayMs: delay,
        })
        return res
      }
      log("fetch_rate_limited", {
        status: res.status,
        attempt: i + 1,
        retryAfter: retryAfter ?? "none",
        delayMs: delay,
      })
      // Discarded responses must release their streams before another
      // attempt. Do not await cancellation of a potentially tee'd body.
      void res.body?.cancel().catch(() => {})
      await sleepUnlessAborted(delay, signal)
      throwIfAborted(signal)
      continue
    }
    return res
  }
  // Only reachable when retries < 1; still issue the request once.
  return fetchImpl(input, init)
}
