import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { transformBody, stripToolPrefix, transformResponseStream } from "./transforms.ts"

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

    assert.equal(parsed.system[0].text, "OpenCode and opencode")
    assert.equal(parsed.tools[0].name, "mcp_search")
    assert.equal(parsed.messages[0].content[0].name, "mcp_lookup")
  })

  it("transformBody keeps opencode-claude-auth system text unchanged", () => {
    const input = JSON.stringify({
      system: [{ type: "text", text: "Use opencode-claude-auth plugin instructions as-is." }],
    })

    const output = transformBody(input)
    assert.equal(typeof output, "string")
    const parsed = JSON.parse(output as string) as {
      system: Array<{ text: string }>
    }

    assert.equal(parsed.system[0].text, "Use opencode-claude-auth plugin instructions as-is.")
  })

  it("transformBody keeps OpenCode and opencode URL/path text unchanged", () => {
    const input = JSON.stringify({
      system: [{
        type: "text",
        text: "OpenCode docs: https://example.com/opencode/docs and path /var/opencode/bin",
      }],
    })

    const output = transformBody(input)
    assert.equal(typeof output, "string")
    const parsed = JSON.parse(output as string) as {
      system: Array<{ text: string }>
    }

    assert.equal(
      parsed.system[0].text,
      "OpenCode docs: https://example.com/opencode/docs and path /var/opencode/bin",
    )
  })

  it("stripToolPrefix removes mcp_ from response payload names", () => {
    const input = '{"name":"mcp_search","type":"tool_use"}'
    assert.equal(stripToolPrefix(input), '{"name": "search","type":"tool_use"}')
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

    assert.ok(text.includes('"name": "search"'), `Expected stripped name in: ${text}`)
    assert.ok(!text.includes("mcp_search"), `Should not contain mcp_search in: ${text}`)
  })

  it("transformResponseStream withholds output until event boundary arrives", async () => {
    const encoder = new TextEncoder()
    let sendBoundary: (() => void) | undefined

    const source = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"name":"mcp_test"}'))
        sendBoundary = () => {
          controller.enqueue(encoder.encode('\n\n'))
          controller.close()
        }
      },
    })

    const response = new Response(source)
    const transformed = transformResponseStream(response)
    const reader = transformed.body!.getReader()

    const pending = reader.read()
    const raceTimeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 50))

    const first = await Promise.race([pending, raceTimeout])
    assert.equal(first, "timeout", "Expected no output before boundary, but got a chunk")

    sendBoundary!()

    const { done, value } = await pending
    assert.equal(done, false)
    const decoder = new TextDecoder()
    const text = decoder.decode(value)
    assert.ok(text.includes('"name": "test"'), `Expected stripped name: ${text}`)
    assert.ok(!text.includes("mcp_test"), `Should not contain mcp_test: ${text}`)

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

    assert.ok(text.includes('"name": "alpha"'), `Expected alpha stripped in: ${text}`)
    assert.ok(text.includes('"name": "beta"'), `Expected beta stripped in: ${text}`)
    assert.ok(!text.includes("mcp_alpha"), `Should not contain mcp_alpha in: ${text}`)
    assert.ok(!text.includes("mcp_beta"), `Should not contain mcp_beta in: ${text}`)
  })
})
