import { before, describe, it } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"

let helpers: typeof import("./index.ts")

type TestAuthLoader = (
  getAuth: () => Promise<{ type: "oauth"; refresh: string; access: string; expires: number }>,
  provider: { models: Record<string, { cost?: unknown }> },
) => Promise<{ fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> }>

async function loadHelpersWithCountingKeychain(initialExpiresAt: number): Promise<{
  helpersModule: typeof import("./index.ts")
  keychainModule: {
    __getReadCount: () => number
  }
}> {
  const tempDir = await mkdtemp(join(tmpdir(), "opencode-claude-auth-cache-"))
  const tempKeychain = join(tempDir, "keychain.js")
  const tempIndex = join(tempDir, "index.ts")
  const sourceIndex = await readFile(new URL("./index.ts", import.meta.url), "utf8")

  await writeFile(
    tempKeychain,
    `let readCount = 0
let credentials = {
  accessToken: "token",
  refreshToken: "refresh",
  expiresAt: ${initialExpiresAt}
}

export function readClaudeCredentials() {
  readCount += 1
  return credentials
}

export function __getReadCount() {
  return readCount
}
`,
    "utf8",
  )
  await writeFile(tempIndex, sourceIndex, "utf8")

  const [helpersModule, keychainModule] = await Promise.all([
    import(pathToFileURL(tempIndex).href),
    import(pathToFileURL(tempKeychain).href),
  ])

  return {
    helpersModule,
    keychainModule: keychainModule as { __getReadCount: () => number },
  }
}

describe("exported helpers", () => {
  before(async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "opencode-claude-auth-"))
    const tempKeychain = join(tempDir, "keychain.js")
    const tempIndex = join(tempDir, "index.ts")
    const sourceIndex = await readFile(new URL("./index.ts", import.meta.url), "utf8")

    await writeFile(
      tempKeychain,
      'export function readClaudeCredentials() { return { accessToken: "token", refreshToken: "refresh", expiresAt: 1 } }\n',
      "utf8",
    )
    await writeFile(tempIndex, sourceIndex, "utf8")

    helpers = await import(pathToFileURL(tempIndex).href)
  })

  it("buildRequestHeaders sets auth headers and strips x-api-key", () => {
    const headers = helpers.buildRequestHeaders(
      "https://api.anthropic.com/v1/messages",
      {
        headers: {
          "anthropic-beta": "custom-beta",
          "x-api-key": "old-key",
          "x-custom": "keep-me",
        },
      },
      "access-token",
      "claude-sonnet-4-6",
    )

    assert.equal(headers.get("authorization"), "Bearer access-token")
    assert.equal(headers.get("x-api-key"), null)
    assert.equal(headers.get("x-custom"), "keep-me")
    assert.ok(headers.get("anthropic-beta")?.includes("custom-beta"))
    assert.ok(headers.get("x-anthropic-billing-header")?.includes("claude-sonnet-4-6"))
  })

  it("getCachedCredentials reuses cached credentials within 30 second TTL", async () => {
    const originalNow = Date.now
    let now = 1_700_000_000_000
    Date.now = () => now

    try {
      const { helpersModule, keychainModule } = await loadHelpersWithCountingKeychain(now + 10 * 60_000)

      const first = helpersModule.getCachedCredentials()
      const second = helpersModule.getCachedCredentials()

      assert.ok(first)
      assert.ok(second)
      assert.equal(keychainModule.__getReadCount(), 1)
    } finally {
      Date.now = originalNow
    }
  })

  it("getCachedCredentials refreshes from source after TTL expires", async () => {
    const originalNow = Date.now
    let now = 1_700_000_000_000
    Date.now = () => now

    try {
      const { helpersModule, keychainModule } = await loadHelpersWithCountingKeychain(now + 10 * 60_000)

      const first = helpersModule.getCachedCredentials()
      now += 31_000
      const second = helpersModule.getCachedCredentials()

      assert.ok(first)
      assert.ok(second)
      assert.equal(keychainModule.__getReadCount(), 2)
    } finally {
      Date.now = originalNow
    }
  })

  it("getModelBetas handles model-specific betas", () => {
    const sonnetBetas = helpers.getModelBetas("claude-sonnet-4-6")
    assert.ok(sonnetBetas.includes("context-1m-2025-08-07"))
    assert.ok(sonnetBetas.includes("claude-code-20250219"))

    const haikuBetas = helpers.getModelBetas("claude-haiku-4-5")
    assert.ok(!haikuBetas.includes("claude-code-20250219"))
  })

  it("getBillingHeader includes version and model", () => {
    const header = helpers.getBillingHeader("claude-opus-4-1")
    assert.ok(header.includes("cc_version=2.1.80.claude-opus-4-1"))
    assert.ok(header.includes("cc_entrypoint=cli"))
  })

  it("transformBody preserves system text and prefixes tool names", () => {
    const input = JSON.stringify({
      system: [{ type: "text", text: "OpenCode and opencode" }],
      tools: [{ name: "search" }],
      messages: [{ content: [{ type: "tool_use", name: "lookup" }] }],
    })

    const output = helpers.transformBody(input)
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

    const output = helpers.transformBody(input)
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

    const output = helpers.transformBody(input)
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
    assert.equal(helpers.stripToolPrefix(input), '{"name": "search","type":"tool_use"}')
  })

  it("transformResponseStream rewrites streamed tool names", async () => {
    const payload = '{"name":"mcp_lookup"}'
    const response = new Response(payload)
    const transformed = helpers.transformResponseStream(response)
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
    const transformed = helpers.transformResponseStream(response)
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
    const transformed = helpers.transformResponseStream(response)
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
    const transformed = helpers.transformResponseStream(response)
    const text = await transformed.text()

    assert.ok(text.includes('"name": "alpha"'), `Expected alpha stripped in: ${text}`)
    assert.ok(text.includes('"name": "beta"'), `Expected beta stripped in: ${text}`)
    assert.ok(!text.includes("mcp_alpha"), `Should not contain mcp_alpha in: ${text}`)
    assert.ok(!text.includes("mcp_beta"), `Should not contain mcp_beta in: ${text}`)
  })

  it("system transform does not inject when system already contains prefix", async () => {
    const originalSetInterval = globalThis.setInterval
    const originalHome = process.env.HOME
    const tempHome = await mkdtemp(join(tmpdir(), "opencode-claude-auth-home-"))
    process.env.HOME = tempHome
    globalThis.setInterval = (() => 0 as unknown as ReturnType<typeof setInterval>) as unknown as typeof setInterval

    try {
      const plugin = await helpers.default({} as never)
      assert.equal(typeof plugin["experimental.chat.system.transform"], "function")

      const transform = plugin["experimental.chat.system.transform"] as (
        input: { model?: { providerID?: string } },
        output: { system: string[] },
      ) => Promise<void>

      const prefixed = "You are Claude Code, Anthropic's official CLI for Claude.\n\nExisting"
      const output = { system: [prefixed] }

      await transform({ model: { providerID: "anthropic" } }, output)

      assert.deepEqual(output.system, [prefixed])
    } finally {
      globalThis.setInterval = originalSetInterval
      if (typeof originalHome === "string") {
        process.env.HOME = originalHome
      } else {
        delete process.env.HOME
      }
    }
  })

  it("system transform injects prefix at most once when already present", async () => {
    const originalSetInterval = globalThis.setInterval
    const originalHome = process.env.HOME
    const tempHome = await mkdtemp(join(tmpdir(), "opencode-claude-auth-home-"))
    process.env.HOME = tempHome
    globalThis.setInterval = (() => 0 as unknown as ReturnType<typeof setInterval>) as unknown as typeof setInterval

    try {
      const plugin = await helpers.default({} as never)
      assert.equal(typeof plugin["experimental.chat.system.transform"], "function")

      const transform = plugin["experimental.chat.system.transform"] as (
        input: { model?: { providerID?: string } },
        output: { system: string[] },
      ) => Promise<void>

      const output = {
        system: [
          "Existing instruction",
          "You are Claude Code, Anthropic's official CLI for Claude.\n\nAlready present",
        ],
      }

      await transform({ model: { providerID: "anthropic" } }, output)

      const occurrences = output.system
        .join("\n")
        .match(/You are Claude Code, Anthropic's official CLI for Claude\./g)
      assert.equal(occurrences?.length, 1)
      assert.deepEqual(output.system, [
        "Existing instruction",
        "You are Claude Code, Anthropic's official CLI for Claude.\n\nAlready present",
      ])
    } finally {
      globalThis.setInterval = originalSetInterval
      if (typeof originalHome === "string") {
        process.env.HOME = originalHome
      } else {
        delete process.env.HOME
      }
    }
  })

  it("auth fetch forwards original input URL unchanged", async () => {
    const originalNow = Date.now
    const originalSetInterval = globalThis.setInterval
    const originalHome = process.env.HOME
    const originalFetch = globalThis.fetch
    const tempHome = await mkdtemp(join(tmpdir(), "opencode-claude-auth-home-"))
    process.env.HOME = tempHome
    Date.now = () => 1_700_000_000_000
    globalThis.setInterval = (() => 0 as unknown as ReturnType<typeof setInterval>) as unknown as typeof setInterval

    let forwardedInput: RequestInfo | URL | undefined

    try {
      const { helpersModule } = await loadHelpersWithCountingKeychain(Date.now() + 10 * 60_000)
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        forwardedInput = input
        return new Response("ok")
      }) as typeof fetch

      const plugin = await helpersModule.default({} as never)
      const typedPlugin = plugin as { auth?: { loader?: TestAuthLoader } }
      assert.equal(typeof typedPlugin.auth?.loader, "function")
      const authConfig = await typedPlugin.auth!.loader!(
        async () => ({ type: "oauth", refresh: "refresh", access: "access", expires: Date.now() + 60_000 }),
        { models: {} },
      )

      const originalInput = "https://api.anthropic.com/v1/messages"
      await authConfig.fetch(originalInput, {
        method: "POST",
        body: JSON.stringify({ model: "claude-haiku-4-5", messages: [] }),
      })

      assert.equal(forwardedInput, originalInput)
    } finally {
      Date.now = originalNow
      globalThis.setInterval = originalSetInterval
      globalThis.fetch = originalFetch
      if (typeof originalHome === "string") {
        process.env.HOME = originalHome
      } else {
        delete process.env.HOME
      }
    }
  })
})
