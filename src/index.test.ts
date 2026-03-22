import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { before, describe, it } from "node:test"
import { pathToFileURL } from "node:url"

let helpers: typeof import("./index.ts")

type TestAuthLoader = (
  getAuth: () => Promise<{
    type: "oauth"
    refresh: string
    access: string
    expires: number
  }>,
  provider: { models: Record<string, { cost?: unknown }> },
) => Promise<{
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
}>

const SOURCE_FILES = [
  "index.ts",
  "betas.ts",
  "transforms.ts",
  "credentials.ts",
] as const

async function copySourceFiles(tempDir: string): Promise<void> {
  await Promise.all(
    SOURCE_FILES.map(async (file) => {
      let source = await readFile(new URL(`./${file}`, import.meta.url), "utf8")
      // Rewrite .js imports to .ts for temp dir (no tsconfig to handle resolution)
      source = source.replace(/from\s+["']\.\/(\w+)\.js["']/g, 'from "./$1.ts"')
      await writeFile(join(tempDir, file), source, "utf8")
    }),
  )
}

async function loadHelpersWithCountingKeychain(
  initialExpiresAt: number,
): Promise<{
  helpersModule: typeof import("./index.ts")
  keychainModule: {
    __getReadCount: () => number
  }
}> {
  const tempDir = await mkdtemp(join(tmpdir(), "opencode-claude-auth-cache-"))
  const tempKeychain = join(tempDir, "keychain.ts")

  await copySourceFiles(tempDir)
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

  const [helpersModule, keychainModule] = await Promise.all([
    import(pathToFileURL(join(tempDir, "index.ts")).href),
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
    const tempKeychain = join(tempDir, "keychain.ts")

    await copySourceFiles(tempDir)
    await writeFile(
      tempKeychain,
      'export function readClaudeCredentials() { return { accessToken: "token", refreshToken: "refresh", expiresAt: 1 } }\n',
      "utf8",
    )

    helpers = await import(pathToFileURL(join(tempDir, "index.ts")).href)
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
    assert.ok(
      headers.get("x-anthropic-billing-header")?.includes("claude-sonnet-4-6"),
    )
  })

  it("getBillingHeader includes version and model", () => {
    const header = helpers.getBillingHeader("claude-opus-4-1")
    assert.ok(header.includes("cc_version=2.1.80.claude-opus-4-1"))
    assert.ok(header.includes("cc_entrypoint=cli"))
  })

  it("buildRequestHeaders uses ANTHROPIC_CLI_VERSION for user-agent", () => {
    process.env.ANTHROPIC_CLI_VERSION = "9.9.9"
    try {
      const headers = helpers.buildRequestHeaders(
        "https://api.anthropic.com/v1/messages",
        { headers: {} },
        "token",
        "claude-sonnet-4-6",
      )
      assert.ok(
        headers.get("user-agent")?.includes("9.9.9"),
        `Expected user-agent to include 9.9.9, got: ${headers.get("user-agent")}`,
      )
    } finally {
      delete process.env.ANTHROPIC_CLI_VERSION
    }
  })

  it("buildRequestHeaders uses ANTHROPIC_USER_AGENT when set", () => {
    process.env.ANTHROPIC_USER_AGENT = "custom-agent/1.0"
    try {
      const headers = helpers.buildRequestHeaders(
        "https://api.anthropic.com/v1/messages",
        { headers: {} },
        "token",
        "claude-sonnet-4-6",
      )
      assert.equal(headers.get("user-agent"), "custom-agent/1.0")
    } finally {
      delete process.env.ANTHROPIC_USER_AGENT
    }
  })

  it("getBillingHeader uses ANTHROPIC_CLI_VERSION when set", () => {
    process.env.ANTHROPIC_CLI_VERSION = "9.9.9"
    try {
      const header = helpers.getBillingHeader("claude-opus-4-1")
      assert.ok(
        header.includes("cc_version=9.9.9"),
        `Expected billing header to include 9.9.9, got: ${header}`,
      )
    } finally {
      delete process.env.ANTHROPIC_CLI_VERSION
    }
  })

  it("fetchWithRetry retries on 429 and succeeds", async () => {
    let callCount = 0
    const mockFetch = (() => {
      callCount++
      if (callCount === 1)
        return Promise.resolve(new Response("rate limited", { status: 429 }))
      return Promise.resolve(new Response("ok", { status: 200 }))
    }) as unknown as typeof fetch
    const res = await helpers.fetchWithRetry(
      "https://example.com",
      {},
      3,
      mockFetch,
    )
    assert.equal(res.status, 200)
    assert.equal(callCount, 2)
  })

  it("fetchWithRetry retries on 529 and succeeds", async () => {
    let callCount = 0
    const mockFetch = (() => {
      callCount++
      if (callCount === 1)
        return Promise.resolve(new Response("overloaded", { status: 529 }))
      return Promise.resolve(new Response("ok", { status: 200 }))
    }) as unknown as typeof fetch
    const res = await helpers.fetchWithRetry(
      "https://example.com",
      {},
      3,
      mockFetch,
    )
    assert.equal(res.status, 200)
    assert.equal(callCount, 2)
  })

  it("fetchWithRetry returns non-retryable errors immediately", async () => {
    let callCount = 0
    const mockFetch = (() => {
      callCount++
      return Promise.resolve(new Response("bad request", { status: 400 }))
    }) as unknown as typeof fetch
    const res = await helpers.fetchWithRetry(
      "https://example.com",
      {},
      3,
      mockFetch,
    )
    assert.equal(res.status, 400)
    assert.equal(callCount, 1)
  })

  it("fetchWithRetry gives up after max retries", async () => {
    let callCount = 0
    const mockFetch = (() => {
      callCount++
      return Promise.resolve(new Response("rate limited", { status: 429 }))
    }) as unknown as typeof fetch
    const res = await helpers.fetchWithRetry(
      "https://example.com",
      {},
      2,
      mockFetch,
    )
    assert.equal(res.status, 429)
    assert.equal(callCount, 2)
  })

  it("fetchWithRetry respects retry-after header", async () => {
    const start = Date.now()
    let callCount = 0
    const mockFetch = (() => {
      callCount++
      if (callCount === 1) {
        return Promise.resolve(
          new Response("rate limited", {
            status: 429,
            headers: { "retry-after": "1" },
          }),
        )
      }
      return Promise.resolve(new Response("ok", { status: 200 }))
    }) as unknown as typeof fetch
    await helpers.fetchWithRetry("https://example.com", {}, 3, mockFetch)
    const elapsed = Date.now() - start
    assert.ok(elapsed >= 900, `Expected at least 900ms delay, got ${elapsed}ms`)
  })

  it("fetchWithRetry falls back to default delay when retry-after is non-numeric", async () => {
    const start = Date.now()
    let callCount = 0
    const mockFetch = (() => {
      callCount++
      if (callCount === 1) {
        return Promise.resolve(
          new Response("rate limited", {
            status: 429,
            headers: { "retry-after": "not-a-number" },
          }),
        )
      }
      return Promise.resolve(new Response("ok", { status: 200 }))
    }) as unknown as typeof fetch
    await helpers.fetchWithRetry("https://example.com", {}, 3, mockFetch)
    const elapsed = Date.now() - start
    // Default delay for first retry (i=0) is (0+1)*2000 = 2000ms
    assert.ok(
      elapsed >= 1900,
      `Expected at least 1900ms fallback delay, got ${elapsed}ms`,
    )
  })

  it("system transform does not inject when system already contains prefix", async () => {
    const originalSetInterval = globalThis.setInterval
    const originalHome = process.env.HOME
    const tempHome = await mkdtemp(join(tmpdir(), "opencode-claude-auth-home-"))
    process.env.HOME = tempHome
    globalThis.setInterval = (() => ({
      unref() {},
    })) as unknown as typeof setInterval

    try {
      const plugin = await helpers.default({} as never)
      assert.equal(
        typeof plugin["experimental.chat.system.transform"],
        "function",
      )

      const transform = plugin["experimental.chat.system.transform"] as (
        input: { model?: { providerID?: string } },
        output: { system: string[] },
      ) => Promise<void>

      const prefixed =
        "You are Claude Code, Anthropic's official CLI for Claude.\n\nExisting"
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
    globalThis.setInterval = (() => ({
      unref() {},
    })) as unknown as typeof setInterval

    try {
      const plugin = await helpers.default({} as never)
      assert.equal(
        typeof plugin["experimental.chat.system.transform"],
        "function",
      )

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

  it("plugin calls unref on the sync interval timer", async () => {
    const originalSetInterval = globalThis.setInterval
    const originalHome = process.env.HOME
    const tempHome = await mkdtemp(join(tmpdir(), "opencode-claude-auth-home-"))
    process.env.HOME = tempHome

    let unrefCalled = false
    const fakeTimer = {
      unref() {
        unrefCalled = true
      },
    }
    globalThis.setInterval = (() => fakeTimer) as unknown as typeof setInterval

    try {
      await helpers.default({} as never)
      assert.ok(
        unrefCalled,
        "Expected .unref() to be called on the interval timer",
      )
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
    globalThis.setInterval = (() => ({
      unref() {},
    })) as unknown as typeof setInterval

    let forwardedInput: RequestInfo | URL | undefined

    try {
      const { helpersModule } = await loadHelpersWithCountingKeychain(
        Date.now() + 10 * 60_000,
      )
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        forwardedInput = input
        return new Response("ok")
      }) as typeof fetch

      const plugin = await helpersModule.default({} as never)
      const typedPlugin = plugin as { auth?: { loader?: TestAuthLoader } }
      assert.equal(typeof typedPlugin.auth?.loader, "function")
      const authConfig = await typedPlugin.auth!.loader!(
        async () => ({
          type: "oauth",
          refresh: "refresh",
          access: "access",
          expires: Date.now() + 60_000,
        }),
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
