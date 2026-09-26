import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  buildRequestHeaders,
  claudeSubscriptionFetch,
  finishClaudeResponse,
  initAccounts,
  prepareClaudeRequest,
  resetExcludedBetas,
  setActiveAccountSource,
} from "./index.ts"

const messageRequest = () =>
  new Request("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      system: "You are Claude Code, Anthropic's official CLI for Claude.",
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    }),
  })

describe("Claude subscription transport", () => {
  it("uses bearer auth and removes x-api-key", () => {
    const headers = buildRequestHeaders(
      "https://api.anthropic.com/v1/messages",
      { headers: { "x-api-key": "old", "x-stainless-lang": "custom" } },
      "oauth-token",
      "claude-sonnet-4-6",
    )
    assert.equal(headers.get("authorization"), "Bearer oauth-token")
    assert.equal(headers.has("x-api-key"), false)
    assert.equal(headers.get("x-stainless-lang"), "custom")
    assert.match(headers.get("anthropic-beta") ?? "", /oauth-/)
  })

  it("transforms a complete Request and streamed tool names", async () => {
    let capturedURL = ""
    let capturedInit: RequestInit | undefined
    const transport = claudeSubscriptionFetch(
      "oauth-token",
      async (input, init) => {
        capturedURL =
          input instanceof URL
            ? input.href
            : typeof input === "string"
              ? input
              : input.url
        capturedInit = init
        return new Response(
          'data: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_Read"}}\n\n',
          {
            headers: { "content-type": "text/event-stream" },
          },
        )
      },
    )
    const request = new Request("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": "old" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        system: [
          {
            type: "text",
            text: "You are Claude Code, Anthropic's official CLI for Claude.\nStable OpenCode prompt",
          },
        ],
        messages: [
          { role: "user", content: [{ type: "text", text: "hello" }] },
        ],
        tools: [{ name: "read", input_schema: { type: "object" } }],
      }),
    })

    const response = await transport(request)
    assert.equal(new URL(capturedURL).searchParams.get("beta"), "true")
    assert.equal(capturedInit?.method, "POST")
    const headers = new Headers(capturedInit?.headers)
    assert.equal(headers.get("authorization"), "Bearer oauth-token")
    assert.equal(headers.has("x-api-key"), false)
    const body = JSON.parse(String(capturedInit?.body)) as {
      cache_control?: unknown
      system: Array<{ text: string; cache_control?: { type: string } }>
      tools: Array<{ name: string; cache_control?: { type: string } }>
      messages: Array<{
        content: Array<{
          text: string
          cache_control?: { type: string }
        }>
      }>
    }
    assert.match(body.system[0].text, /^x-anthropic-billing-header/)
    assert.equal(body.system[0].cache_control, undefined)
    assert.equal(body.system[1].cache_control, undefined)
    assert.equal(body.tools[0].name, "mcp_Read")
    assert.deepEqual(body.tools[0].cache_control, { type: "ephemeral" })
    assert.equal(body.messages[0].content[0].text, "Stable OpenCode prompt")
    assert.deepEqual(body.messages[0].content[0].cache_control, {
      type: "ephemeral",
    })
    assert.equal(body.messages[0].content[1].text, "hello")
    assert.equal(body.messages[0].content[1].cache_control, undefined)
    assert.deepEqual(body.cache_control, { type: "ephemeral" })
    assert.match(await response.text(), /"name": "read"/)
  })

  it("prepares native Anthropic HTTP requests for subscription billing", async () => {
    const request = await prepareClaudeRequest(messageRequest(), "oauth-token")
    const headers = request.headers
    assert.equal(headers.get("authorization"), "Bearer oauth-token")
    assert.equal(headers.has("x-api-key"), false)
    assert.equal(new URL(request.url).searchParams.get("beta"), "true")
    assert.match(await request.text(), /x-anthropic-billing-header/)
  })

  it("transforms the native response without sending another request", async () => {
    const request = await prepareClaudeRequest(messageRequest(), "oauth-token")
    let calls = 0
    const response = await finishClaudeResponse(
      request,
      new Response('{"name":"mcp_Read"}'),
      undefined,
      async () => {
        calls++
        return new Response()
      },
    )
    assert.equal(calls, 0)
    assert.match(await response.text(), /"name": "read"/)
  })

  it("removes a rejected beta from native request retries", async () => {
    resetExcludedBetas()
    const request = await prepareClaudeRequest(messageRequest(), "oauth-token")
    const betas: string[] = []
    await finishClaudeResponse(
      request,
      new Response("long context beta is not yet available", { status: 400 }),
      undefined,
      async (_input, init) => {
        betas.push(new Headers(init?.headers).get("anthropic-beta") ?? "")
        return betas.length === 1
          ? new Response("long context beta is not yet available", {
              status: 400,
            })
          : new Response("ok")
      },
    )
    assert.match(betas[0], /interleaved-thinking-2025-05-14/)
    assert.doesNotMatch(betas[1], /interleaved-thinking-2025-05-14/)
    resetExcludedBetas()
  })

  it("fails clearly without a subscription token", async () => {
    await assert.rejects(
      () =>
        claudeSubscriptionFetch(
          "",
          async () => new Response(),
        )("https://api.anthropic.com/v1/messages"),
      /Run \/connect/,
    )
  })
})

/**
 * OpenCode resolves one credential per connection and hands the provider that
 * credential's token and metadata. Which Claude Code account a request is
 * billed to must follow from that credential alone: the plugin also tracks a
 * process-wide "active account", and the two disagree whenever the connection
 * in use was not the one most recently imported through `/connect`.
 */
describe("multi-account token scoping", () => {
  const expiresAt = Date.now() + 8 * 60 * 60 * 1000
  // Sources that cannot exist in a real keychain, so the freshness re-read
  // finds nothing and the accounts' in-memory credentials stand.
  const ACCOUNT_A = {
    label: "Claude Pro",
    source: "Claude Code-credentials-aaaaaaa1",
    credentials: {
      accessToken: "token-a",
      refreshToken: "refresh-a",
      expiresAt,
    },
  }
  const ACCOUNT_B = {
    label: "Claude Max",
    source: "Claude Code-credentials-bbbbbbb2",
    credentials: {
      accessToken: "token-b",
      refreshToken: "refresh-b",
      expiresAt,
    },
  }

  async function tokenSentFor(
    account: typeof ACCOUNT_A,
  ): Promise<string | null> {
    let captured: RequestInit | undefined
    const request = await prepareClaudeRequest(
      messageRequest(),
      account.credentials.accessToken,
      account.source,
    )
    captured = { headers: request.headers }
    return new Headers(captured.headers).get("authorization")
  }

  it("bills the credential's own account, not the globally active one", async () => {
    initAccounts([structuredClone(ACCOUNT_A), structuredClone(ACCOUNT_B)])
    // What `/connect` last selected, which the connection in use is not.
    setActiveAccountSource(ACCOUNT_A.source)
    try {
      assert.equal(await tokenSentFor(ACCOUNT_B), "Bearer token-b")
    } finally {
      initAccounts([])
    }
  })

  it("keeps two providers on their own accounts", async () => {
    initAccounts([structuredClone(ACCOUNT_A), structuredClone(ACCOUNT_B)])
    setActiveAccountSource(ACCOUNT_A.source)
    try {
      assert.equal(await tokenSentFor(ACCOUNT_A), "Bearer token-a")
      assert.equal(await tokenSentFor(ACCOUNT_B), "Bearer token-b")
    } finally {
      initAccounts([])
    }
  })

  it("recovers a 401 with its own refresh token", async () => {
    initAccounts([structuredClone(ACCOUNT_A), structuredClone(ACCOUNT_B)])
    setActiveAccountSource(ACCOUNT_A.source)
    const realFetch = globalThis.fetch
    let refreshedWith: string | null = null
    // Only the OAuth token endpoint reaches the global fetch; the Anthropic
    // call goes through the provider's own `fetch` option below.
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      refreshedWith = new URLSearchParams(String(init?.body)).get(
        "refresh_token",
      )
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
      })
    }) as typeof fetch

    try {
      let calls = 0
      const request = await prepareClaudeRequest(
        messageRequest(),
        ACCOUNT_B.credentials.accessToken,
        ACCOUNT_B.source,
      )
      await finishClaudeResponse(
        request,
        new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
        }),
        ACCOUNT_B.source,
        async () => {
          calls++
          return new Response(JSON.stringify({ error: "unauthorized" }), {
            status: 401,
          })
        },
      ).catch(() => {})
      assert.equal(
        calls,
        0,
        "a failed refresh must not resend with another account",
      )
      assert.equal(refreshedWith, "refresh-b")
    } finally {
      globalThis.fetch = realFetch
      initAccounts([])
    }
  })

  it("falls back to the supplied token when the account is gone", async () => {
    initAccounts([structuredClone(ACCOUNT_A)])
    setActiveAccountSource(ACCOUNT_A.source)
    try {
      // B was removed from the keychain since the credential was stored; its
      // token must still be used rather than silently swapped for A's.
      assert.equal(await tokenSentFor(ACCOUNT_B), "Bearer token-b")
    } finally {
      initAccounts([])
    }
  })
})
