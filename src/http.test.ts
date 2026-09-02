import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { fetchWithRetry, type FetchFn } from "./http.ts"

function rateLimited(headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ error: "rate_limit_error" }), {
    status: 429,
    headers,
  })
}

function ok(): Response {
  return new Response(JSON.stringify({ ok: true }), { status: 200 })
}

/** Counts calls and replays the given responses in order. */
function scripted(responses: Response[]): {
  fetch: FetchFn
  calls: () => number
} {
  let calls = 0
  const fetchImpl = (async () => {
    const res = responses[Math.min(calls, responses.length - 1)]!
    calls += 1
    return res.clone()
  }) as FetchFn
  return { fetch: fetchImpl, calls: () => calls }
}

describe("fetchWithRetry", () => {
  it("retries a 429 that carries a retry-after hint", async () => {
    const { fetch: impl, calls } = scripted([
      rateLimited({ "retry-after": "0" }),
      ok(),
    ])

    const res = await fetchWithRetry("https://example.test", {}, 3, impl, {
      onlyRetryWithHint: true,
    })

    assert.equal(res.status, 200)
    assert.equal(calls(), 2, "the server asked us to wait, so we retried")
  })

  it("does not retry a 429 with no hint when told to require one", async () => {
    // The real incident: the OAuth token endpoint answers rate_limit_error
    // with no retry-after and a window of minutes, so a guessed two-second
    // retry cannot succeed and only sustains the limit. One POST, then the
    // caller's cooldown takes over.
    const { fetch: impl, calls } = scripted([rateLimited(), ok()])

    const res = await fetchWithRetry("https://example.test", {}, 3, impl, {
      onlyRetryWithHint: true,
    })

    assert.equal(
      res.status,
      429,
      "the rate limit is surfaced, not retried past",
    )
    assert.equal(calls(), 1, "exactly one request")
  })

  it("still guesses a backoff for callers that did not opt in", async () => {
    // The API request path keeps its previous behaviour: a rate limit there
    // clears in seconds, so retrying without a hint is reasonable.
    const { fetch: impl, calls } = scripted([
      rateLimited({ "retry-after": "0" }),
      ok(),
    ])

    const res = await fetchWithRetry("https://example.test", {}, 3, impl)

    assert.equal(res.status, 200)
    assert.equal(calls(), 2)
  })

  it("returns a success untouched without retrying", async () => {
    const { fetch: impl, calls } = scripted([ok()])

    const res = await fetchWithRetry("https://example.test", {}, 3, impl, {
      onlyRetryWithHint: true,
    })

    assert.equal(res.status, 200)
    assert.equal(calls(), 1)
  })
})
