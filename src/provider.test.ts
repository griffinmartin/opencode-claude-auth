import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { buildRequestHeaders, claudeSubscriptionFetch } from "./index.ts"

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
            text: "You are Claude Code, Anthropic's official CLI for Claude.",
          },
        ],
        messages: [{ role: "user", content: "hello" }],
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
      system: Array<{ text: string }>
      tools: Array<{ name: string }>
    }
    assert.match(body.system[0].text, /^x-anthropic-billing-header/)
    assert.equal(body.tools[0].name, "mcp_Read")
    assert.match(await response.text(), /"name": "read"/)
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
