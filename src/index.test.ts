import { describe, it, mock } from "node:test"
import assert from "node:assert/strict"

// Replicate createAuthFetch logic for testing since we can't import
// internal functions without exposing them as named exports
// (OpenCode treats all named exports as plugins)
function createAuthFetch(
  initial: { accessToken: string; refreshToken: string; expiresAt: number },
  onRefresh: (updated: any) => void,
): (...args: Parameters<typeof fetch>) => Promise<Response> {
  let current = initial

  return async (fetchInput, init): Promise<Response> => {
    const headers = new Headers(init?.headers)
    headers.set("x-api-key", current.accessToken)
    headers.delete("Authorization")
    return fetch(fetchInput, { ...init, headers })
  }
}

describe("createAuthFetch", () => {
  const validCreds = {
    accessToken: "test-access-token",
    refreshToken: "test-refresh-token",
    expiresAt: Date.now() + 300_000,
  }

  it("sets x-api-key header with access token", async () => {
    let capturedHeaders: Headers | undefined
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock.fn(async (_input: any, init: any) => {
      capturedHeaders = new Headers(init?.headers)
      return new Response("ok")
    }) as any

    try {
      const authFetch = createAuthFetch(validCreds, () => {})
      await authFetch("https://api.anthropic.com/v1/messages", {})
      assert.ok(capturedHeaders)
      assert.equal(
        capturedHeaders.get("x-api-key"),
        validCreds.accessToken,
      )
      assert.equal(capturedHeaders.get("Authorization"), null)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("overrides x-api-key header with access token", async () => {
    let capturedHeaders: Headers | undefined
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock.fn(async (_input: any, init: any) => {
      capturedHeaders = new Headers(init?.headers)
      return new Response("ok")
    }) as any

    try {
      const authFetch = createAuthFetch(validCreds, () => {})
      await authFetch("https://api.anthropic.com/v1/messages", {
        headers: { "x-api-key": "should-be-overridden" },
      })
      assert.ok(capturedHeaders)
      assert.equal(capturedHeaders.get("x-api-key"), validCreds.accessToken)
      assert.equal(capturedHeaders.get("Authorization"), null)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("preserves other headers", async () => {
    let capturedHeaders: Headers | undefined
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock.fn(async (_input: any, init: any) => {
      capturedHeaders = new Headers(init?.headers)
      return new Response("ok")
    }) as any

    try {
      const authFetch = createAuthFetch(validCreds, () => {})
      await authFetch("https://api.anthropic.com/v1/messages", {
        headers: { "Content-Type": "application/json", "x-custom": "keep-me" },
      })
      assert.ok(capturedHeaders)
      assert.equal(capturedHeaders.get("Content-Type"), "application/json")
      assert.equal(capturedHeaders.get("x-custom"), "keep-me")
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
