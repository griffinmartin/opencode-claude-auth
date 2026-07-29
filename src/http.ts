import { log } from "./logger.ts"

export type FetchFn = typeof fetch

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
 */
function sleepUnlessAborted(
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
): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    const res = await fetchImpl(input, init)
    if ((res.status === 429 || res.status === 529) && i < retries - 1) {
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
      await sleepUnlessAborted(delay, init?.signal)
      if (init?.signal?.aborted) {
        // The caller's deadline passed while we were backing off. Surface the
        // rate-limit response rather than issuing a request that can only fail.
        log("fetch_retry_aborted", { status: res.status })
        return res
      }
      continue
    }
    return res
  }
  // Only reachable when retries < 1; still issue the request once.
  return fetchImpl(input, init)
}
