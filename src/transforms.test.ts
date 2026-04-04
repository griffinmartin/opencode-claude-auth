import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  stripToolPrefix,
  transformBody,
  transformResponseStream,
} from "./transforms.ts"

describe("transforms", () => {
  it("transformBody preserves system text and prefixes tool names", () => {
    const input = JSON.stringify({
      system: [{ type: "text", text: "OpenCode and opencode" }],
      tools: [{ name: "search" }],
      messages: [{ content: [{ type: "tool_use", name: "lookup" }] }],
    })

    const output = transformBody(input)
    assert.equal(typeof output, "string")
    const parsed = JSON.parse(output as string) as {
      system: Array<{ text: string }>
      tools: Array<{ name: string }>
      messages: Array<{ content: Array<{ name: string }> }>
    }

    // system[0] is now the billing header, original system text follows
    assert.ok(
      parsed.system[0].text.startsWith("x-anthropic-billing-header:"),
      "system[0] should be the billing header",
    )
    assert.equal(parsed.system[1].text, "OpenCode and opencode")
    assert.equal(parsed.tools[0].name, "mcp_search")
    assert.equal(parsed.messages[0].content[0].name, "mcp_lookup")
  })

  it("transformBody keeps opencode-claude-auth system text unchanged", () => {
    const input = JSON.stringify({
      system: [
        {
          type: "text",
          text: "Use opencode-claude-auth plugin instructions as-is.",
        },
      ],
    })

    const output = transformBody(input)
    assert.equal(typeof output, "string")
    const parsed = JSON.parse(output as string) as {
      system: Array<{ text: string }>
    }

    // system[0] is billing header, original text at system[1]
    assert.equal(
      parsed.system[1].text,
      "Use opencode-claude-auth plugin instructions as-is.",
    )
  })

  it("transformBody keeps OpenCode and opencode URL/path text unchanged", () => {
    const input = JSON.stringify({
      system: [
        {
          type: "text",
          text: "OpenCode docs: https://example.com/opencode/docs and path /var/opencode/bin",
        },
      ],
    })

    const output = transformBody(input)
    assert.equal(typeof output, "string")
    const parsed = JSON.parse(output as string) as {
      system: Array<{ text: string }>
    }

    // system[0] is billing header, original text at system[1]
    assert.equal(
      parsed.system[1].text,
      "OpenCode docs: https://example.com/opencode/docs and path /var/opencode/bin",
    )
  })

  it("transformBody injects billing header as system[0] with computed cch", () => {
    const input = JSON.stringify({
      system: [{ type: "text", text: "system prompt" }],
      messages: [{ role: "user", content: "hey" }],
    })

    const output = transformBody(input)
    const parsed = JSON.parse(output as string) as {
      system: Array<{ text: string }>
    }

    assert.ok(parsed.system[0].text.startsWith("x-anthropic-billing-header:"))
    assert.ok(
      parsed.system[0].text.includes("cch=fa690"),
      `Expected cch=fa690 for 'hey', got: ${parsed.system[0].text}`,
    )
  })

  it("transformBody billing header has no cache_control", () => {
    const input = JSON.stringify({
      system: [
        { type: "text", text: "prompt", cache_control: { type: "ephemeral" } },
      ],
      messages: [{ role: "user", content: "test" }],
    })

    const output = transformBody(input)
    const parsed = JSON.parse(output as string) as {
      system: Array<{ text: string; cache_control?: unknown }>
    }

    // Billing header (system[0]) should not have cache_control
    assert.equal(
      parsed.system[0].cache_control,
      undefined,
      "Billing header must not have cache_control",
    )
  })

  it("transformBody splits concatenated identity prefix into separate entry", () => {
    const identity = "You are Claude Code, Anthropic's official CLI for Claude."
    const input = JSON.stringify({
      system: [
        {
          type: "text",
          text: `${identity}\nWorking directory: /home/test`,
        },
      ],
      messages: [{ role: "user", content: "test" }],
    })

    const output = transformBody(input)
    const parsed = JSON.parse(output as string) as {
      system: Array<{ type: string; text: string }>
    }

    // system[0] = billing header
    // system[1] = identity prefix (split out)
    // system[2] = remainder
    assert.ok(parsed.system[0].text.startsWith("x-anthropic-billing-header:"))
    assert.equal(parsed.system[1].text, identity)
    assert.equal(parsed.system[2].text, "Working directory: /home/test")
  })

  it("transformBody preserves cache_control when splitting identity", () => {
    const identity = "You are Claude Code, Anthropic's official CLI for Claude."
    const input = JSON.stringify({
      system: [
        {
          type: "text",
          text: `${identity}\nMore content here`,
          cache_control: { type: "ephemeral", ttl: "1h" },
        },
      ],
      messages: [{ role: "user", content: "test" }],
    })

    const output = transformBody(input)
    const parsed = JSON.parse(output as string) as {
      system: Array<{ text: string; cache_control?: unknown }>
    }

    // Both split entries should preserve cache_control from the original
    assert.deepEqual(parsed.system[1].cache_control, {
      type: "ephemeral",
      ttl: "1h",
    })
    assert.deepEqual(parsed.system[2].cache_control, {
      type: "ephemeral",
      ttl: "1h",
    })
  })

  it("transformBody does not split identity-only system entry", () => {
    const identity = "You are Claude Code, Anthropic's official CLI for Claude."
    const input = JSON.stringify({
      system: [{ type: "text", text: identity }],
      messages: [{ role: "user", content: "test" }],
    })

    const output = transformBody(input)
    const parsed = JSON.parse(output as string) as {
      system: Array<{ text: string }>
    }

    // system[0] = billing, system[1] = identity (not split further)
    assert.equal(parsed.system.length, 2)
    assert.equal(parsed.system[1].text, identity)
  })

  it("transformBody removes duplicate billing headers", () => {
    const input = JSON.stringify({
      system: [
        {
          type: "text",
          text: "x-anthropic-billing-header: cc_version=old; cc_entrypoint=cli; cch=00000;",
        },
        { type: "text", text: "prompt" },
      ],
      messages: [{ role: "user", content: "hey" }],
    })

    const output = transformBody(input)
    const parsed = JSON.parse(output as string) as {
      system: Array<{ text: string }>
    }

    const billingEntries = parsed.system.filter((e) =>
      e.text.startsWith("x-anthropic-billing-header:"),
    )
    assert.equal(
      billingEntries.length,
      1,
      "Should have exactly one billing header",
    )
    // And it should be the new computed one, not the old one
    assert.ok(
      billingEntries[0].text.includes("cch=fa690"),
      `Expected computed cch, got: ${billingEntries[0].text}`,
    )
  })

  it("transformBody strips output_config.effort for haiku", () => {
    const input = JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      output_config: { effort: "high" },
      messages: [{ role: "user", content: "test" }],
    })

    const output = transformBody(input)
    const parsed = JSON.parse(output as string) as {
      output_config?: Record<string, unknown>
    }

    assert.equal(
      parsed.output_config,
      undefined,
      "output_config should be removed when effort was its only field",
    )
  })

  it("transformBody strips effort but keeps other output_config fields for haiku", () => {
    const input = JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      output_config: { effort: "high", max_tokens: 1024 },
      messages: [{ role: "user", content: "test" }],
    })

    const output = transformBody(input)
    const parsed = JSON.parse(output as string) as {
      output_config?: { effort?: string; max_tokens?: number }
    }

    assert.ok(
      parsed.output_config,
      "output_config should be preserved when other fields exist",
    )
    assert.equal(parsed.output_config!.max_tokens, 1024)
    assert.equal(
      parsed.output_config!.effort,
      undefined,
      "effort should be stripped",
    )
  })

  it("transformBody strips thinking.effort for haiku", () => {
    const input = JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      thinking: { type: "enabled", effort: "high" },
      messages: [{ role: "user", content: "test" }],
    })

    const output = transformBody(input)
    const parsed = JSON.parse(output as string) as {
      thinking?: Record<string, unknown>
    }

    assert.equal(
      parsed.thinking,
      undefined,
      "thinking should be removed when only effort is present",
    )
  })

  it("transformBody preserves effort for non-haiku models", () => {
    const input = JSON.stringify({
      model: "claude-opus-4-6",
      output_config: { effort: "high" },
      thinking: { type: "enabled", effort: "high" },
      messages: [{ role: "user", content: "test" }],
    })

    const output = transformBody(input)
    const parsed = JSON.parse(output as string) as {
      output_config?: { effort?: string }
      thinking?: { effort?: string }
    }

    assert.equal(
      parsed.output_config!.effort,
      "high",
      "output_config.effort should remain for opus",
    )
    assert.equal(
      parsed.thinking!.effort,
      "high",
      "thinking.effort should remain for opus",
    )
  })

  it("transformBody handles haiku without effort-related fields", () => {
    const input = JSON.stringify({
      model: "claude-haiku-4-5",
      messages: [{ role: "user", content: "test" }],
    })

    const output = transformBody(input)
    const parsed = JSON.parse(output as string) as {
      output_config?: unknown
      thinking?: unknown
    }

    assert.equal(parsed.output_config, undefined)
    assert.equal(parsed.thinking, undefined)
  })

  it("stripToolPrefix removes mcp_ from response payload names", () => {
    const input = '{"name":"mcp_search","type":"tool_use"}'
    assert.equal(stripToolPrefix(input), '{"name": "search","type":"tool_use"}')
  })

  it("transformResponseStream passes error responses through without SSE parsing", async () => {
    const errorBody = JSON.stringify({
      type: "error",
      error: {
        type: "invalid_request_error",
        message: "Test error message",
      },
    })
    const response = new Response(errorBody, {
      status: 400,
      statusText: "Bad Request",
      headers: { "content-type": "application/json" },
    })

    const transformed = transformResponseStream(response)
    assert.equal(transformed.status, 400)
    assert.equal(transformed.statusText, "Bad Request")

    const text = await transformed.text()
    assert.equal(text, errorBody, "Error body should pass through unchanged")
  })

  it("transformResponseStream passes 401 errors through intact", async () => {
    const errorBody = JSON.stringify({
      type: "error",
      error: {
        type: "authentication_error",
        message: "OAuth token has expired.",
      },
    })
    const response = new Response(errorBody, { status: 401 })
    const transformed = transformResponseStream(response)
    assert.equal(transformed.status, 401)
    const text = await transformed.text()
    const parsed = JSON.parse(text) as { error: { message: string } }
    assert.equal(parsed.error.message, "OAuth token has expired.")
  })

  it("transformResponseStream passes 429 errors through intact", async () => {
    const errorBody = JSON.stringify({
      type: "error",
      error: { type: "rate_limit_error", message: "Rate limited" },
    })
    const response = new Response(errorBody, {
      status: 429,
      headers: { "retry-after": "30" },
    })
    const transformed = transformResponseStream(response)
    assert.equal(transformed.status, 429)
    assert.equal(transformed.headers.get("retry-after"), "30")
    const text = await transformed.text()
    assert.ok(text.includes("Rate limited"))
  })

  it("transformResponseStream passes 529 overloaded errors through", async () => {
    const response = new Response("Overloaded", { status: 529 })
    const transformed = transformResponseStream(response)
    assert.equal(transformed.status, 529)
    const text = await transformed.text()
    assert.equal(text, "Overloaded")
  })

  it("transformResponseStream still strips tool prefixes in error bodies", async () => {
    // stripToolPrefix matches the pattern "name": "mcp_..."
    const errorBody = '{"name": "mcp_search", "error": "failed"}'
    const response = new Response(errorBody, { status: 400 })
    const transformed = transformResponseStream(response)
    const text = await transformed.text()
    assert.ok(
      text.includes('"name": "search"'),
      "Should strip mcp_ prefix even in error bodies",
    )
    assert.ok(
      !text.includes("mcp_search"),
      "Should not contain mcp_search after stripping",
    )
  })

  it("transformResponseStream rewrites streamed tool names", async () => {
    const payload = '{"name":"mcp_lookup"}'
    const response = new Response(payload)
    const transformed = transformResponseStream(response)
    const text = await transformed.text()

    assert.equal(text, '{"name": "lookup"}')
  })

  it("transformResponseStream buffers across chunks until event boundary", async () => {
    const chunk1 = 'data: {"name":"mc'
    const chunk2 = 'p_search"}\n\ndata: {"type":"done"}\n\n'
    const encoder = new TextEncoder()

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(chunk1))
        controller.enqueue(encoder.encode(chunk2))
        controller.close()
      },
    })

    const response = new Response(stream)
    const transformed = transformResponseStream(response)
    const text = await transformed.text()

    assert.ok(
      text.includes('"name": "search"'),
      `Expected stripped name in: ${text}`,
    )
    assert.ok(
      !text.includes("mcp_search"),
      `Should not contain mcp_search in: ${text}`,
    )
  })

  it("transformResponseStream withholds output until event boundary arrives", async () => {
    const encoder = new TextEncoder()
    let sendBoundary: (() => void) | undefined

    const source = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"name":"mcp_test"}'))
        sendBoundary = () => {
          controller.enqueue(encoder.encode("\n\n"))
          controller.close()
        }
      },
    })

    const response = new Response(source)
    const transformed = transformResponseStream(response)
    const reader = transformed.body!.getReader()

    const pending = reader.read()
    const raceTimeout = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), 50),
    )

    const first = await Promise.race([pending, raceTimeout])
    assert.equal(
      first,
      "timeout",
      "Expected no output before boundary, but got a chunk",
    )

    sendBoundary!()

    const { done, value } = await pending
    assert.equal(done, false)
    const decoder = new TextDecoder()
    const text = decoder.decode(value)
    assert.ok(
      text.includes('"name": "test"'),
      `Expected stripped name: ${text}`,
    )
    assert.ok(
      !text.includes("mcp_test"),
      `Should not contain mcp_test: ${text}`,
    )

    const final = await reader.read()
    assert.equal(final.done, true)
  })

  it("transformResponseStream flushes remaining buffered data on stream end", async () => {
    const encoder = new TextEncoder()
    const chunk1 = 'data: {"name":"mcp_alpha"}\n\n'
    const chunk2 = 'data: {"name":"mcp_beta"}'

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(chunk1))
        controller.enqueue(encoder.encode(chunk2))
        controller.close()
      },
    })

    const response = new Response(stream)
    const transformed = transformResponseStream(response)
    const text = await transformed.text()

    assert.ok(
      text.includes('"name": "alpha"'),
      `Expected alpha stripped in: ${text}`,
    )
    assert.ok(
      text.includes('"name": "beta"'),
      `Expected beta stripped in: ${text}`,
    )
    assert.ok(
      !text.includes("mcp_alpha"),
      `Should not contain mcp_alpha in: ${text}`,
    )
    assert.ok(
      !text.includes("mcp_beta"),
      `Should not contain mcp_beta in: ${text}`,
    )
  })
})
