import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  buildRequestHeaders,
  CLAUDE_CODE_OAUTH_METADATA_KEY,
  CLAUDE_CODE_OAUTH_METADATA_VALUE,
  claudeSubscriptionFetch,
  createClaudeSubscription,
} from "./index.ts"

const anthropicResponse = () =>
  new Response(
    JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      model: "claude-sonnet-4-6",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { headers: { "content-type": "application/json" } },
  )

async function generateWith(
  provider: ReturnType<typeof createClaudeSubscription>,
) {
  await provider("claude-sonnet-4-6").doGenerate({
    prompt: [
      {
        role: "system",
        content:
          "You are Claude Code, Anthropic's official CLI for Claude.\nStable OpenCode prompt",
      },
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ],
  })
}

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

  it("constructs the OAuth transport for explicitly marked credentials", async () => {
    let captured: { input: RequestInfo | URL; init?: RequestInit } | undefined
    const provider = createClaudeSubscription({
      apiKey: "oauth-token",
      [CLAUDE_CODE_OAUTH_METADATA_KEY]: CLAUDE_CODE_OAUTH_METADATA_VALUE,
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        captured = { input, init }
        return anthropicResponse()
      },
    })

    await generateWith(provider)

    const headers = new Headers(captured?.init?.headers)
    assert.equal(headers.get("authorization"), "Bearer oauth-token")
    assert.equal(headers.has("x-api-key"), false)
    assert.equal(
      new URL(String(captured?.input)).searchParams.get("beta"),
      "true",
    )
    assert.match(String(captured?.init?.body), /x-anthropic-billing-header/)
  })

  it("constructs the stock API-key provider for unmarked credentials", async () => {
    let captured: { input: RequestInfo | URL; init?: RequestInit } | undefined
    const provider = createClaudeSubscription({
      apiKey: "sk-ant-api03-key",
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        captured = { input, init }
        return anthropicResponse()
      },
    })

    await generateWith(provider)

    const headers = new Headers(captured?.init?.headers)
    assert.equal(headers.get("x-api-key"), "sk-ant-api03-key")
    assert.equal(headers.has("authorization"), false)
    assert.equal(
      new URL(String(captured?.input)).searchParams.has("beta"),
      false,
    )
    assert.doesNotMatch(
      String(captured?.init?.body),
      /x-anthropic-billing-header/,
    )
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
