import assert from "node:assert/strict"
import {
  existsSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, dirname } from "node:path"
import { before, describe, it } from "node:test"
import { pathToFileURL } from "node:url"

// Keep the cross-process refresh lock off the real OpenCode data dir in tests.
process.env.OPENCODE_CLAUDE_AUTH_REFRESH_LOCK_DIR = mkdtempSync(
  join(tmpdir(), "opencode-claude-auth-locktest-"),
)

interface ClaudeCredentials {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

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

interface Account {
  label: string
  source: string
  credentials: ClaudeCredentials
}

// Mirrors authorize()'s account-resolution logic
function resolveAccount(
  accounts: Account[],
  selectedSource: string | undefined,
): Account {
  const found = accounts.find((a) => a.source === selectedSource)
  return found ?? accounts[0]
}

// Mirrors the select prompt options builder
function buildSelectOptions(
  accounts: Account[],
  activeSource: string,
): Array<{ label: string; value: string; hint?: string }> {
  return accounts.map((a) => ({
    label: a.label,
    value: a.source,
    hint: a.source === activeSource ? "active" : undefined,
  }))
}

// Mirrors syncToPath logic
function syncToPath(
  authPath: string,
  creds: ClaudeCredentials,
  fs: {
    existsSync: (p: string) => boolean
    readFileSync: (p: string, enc: string) => string
    writeFileSync: (p: string, data: string, enc: string) => void
    mkdirSync: (p: string, opts: object) => void
    dirname: (p: string) => string
  },
): void {
  let auth: Record<string, unknown> = {}
  if (fs.existsSync(authPath)) {
    const raw = fs.readFileSync(authPath, "utf-8").trim()
    if (raw) {
      try {
        auth = JSON.parse(raw)
      } catch {
        // Malformed file, start fresh
      }
    }
  }
  auth.anthropic = {
    type: "oauth",
    access: creds.accessToken,
    refresh: creds.refreshToken,
    expires: creds.expiresAt,
  }
  const dir = fs.dirname(authPath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(authPath, JSON.stringify(auth, null, 2), "utf-8")
}

// Mirrors refreshIfNeeded expiry logic
function refreshIfNeeded(
  creds: ClaudeCredentials,
  nowMs: number,
): "fresh" | "expired" {
  return creds.expiresAt > nowMs + 60_000 ? "fresh" : "expired"
}

// Mirrors the authorize() callback return shape
function buildAuthorizeResult(account: Account) {
  const creds = account.credentials
  return {
    url: "",
    instructions: `Using ${account.label} — credentials loaded from macOS Keychain.`,
    method: "auto" as const,
    async callback() {
      return {
        type: "success" as const,
        provider: "anthropic",
        access: creds.accessToken,
        refresh: creds.refreshToken,
        expires: creds.expiresAt,
      }
    },
  }
}

const SOURCE_FILES = [
  "index.ts",
  "betas.ts",
  "model-config.ts",
  "signing.ts",
  "transforms.ts",
  "credentials.ts",
  "refresh-backoff.ts",
  "refresh-lock.ts",
  "logger.ts",
  "http.ts",
] as const

async function copySourceFiles(
  tempDir: string,
  opts?: { oauthTokenUrl?: string },
): Promise<void> {
  await Promise.all(
    SOURCE_FILES.map(async (file) => {
      let source = await readFile(new URL(`./${file}`, import.meta.url), "utf8")
      source = source.replace(
        /from\s+["']\.\/([\w-]+)\.js["']/g,
        'from "./$1.ts"',
      )
      if (file === "credentials.ts") {
        if (opts?.oauthTokenUrl) {
          // Point the OAuth refresh at a local test server so the real
          // refreshViaOAuth path runs offline.
          source = source.replace(
            "https://claude.ai/v1/oauth/token",
            opts.oauthTokenUrl,
          )
        }
        // Keep refreshViaCli from launching the real claude binary.
        source = source.replace(
          'import { execSync } from "node:child_process"',
          'import { execSync } from "./child-process.ts"',
        )
      }
      await writeFile(join(tempDir, file), source, "utf8")
    }),
  )

  await writeFile(
    join(tempDir, "child-process.ts"),
    `export function execSync() {
  return ""
}
`,
    "utf8",
  )
}

async function loadHelpersWithCountingKeychain(
  initialExpiresAt: number,
  options: { oauthTokenUrl?: string; throwOnReload?: boolean } = {},
): Promise<{
  helpersModule: typeof import("./index.ts")
  keychainModule: {
    __getReadCount: () => number
    __setCredentials: (c: ClaudeCredentials) => void
  }
}> {
  const tempDir = await mkdtemp(join(tmpdir(), "opencode-claude-auth-cache-"))
  const tempKeychain = join(tempDir, "keychain.ts")

  await copySourceFiles(tempDir, options)
  if (options.throwOnReload) {
    const tempCredentials = join(tempDir, "credentials.ts")
    const reloadSignature =
      "export function reloadCredentialsFromSource(): ClaudeCredentials | null {"
    const credentialsSource = await readFile(tempCredentials, "utf8")
    assert.ok(credentialsSource.includes(reloadSignature))
    await writeFile(
      tempCredentials,
      credentialsSource.replace(
        reloadSignature,
        `${reloadSignature}\n  throw new Error("forced reload failure")`,
      ),
      "utf8",
    )
  }
  await writeFile(
    tempKeychain,
    `let readCount = 0
let credentials = {
  accessToken: "token",
  refreshToken: "refresh",
  expiresAt: ${initialExpiresAt}
}

export const PRIMARY_SERVICE = "Claude Code-credentials"

export function readAllClaudeAccounts() {
  readCount += 1
  return [{ label: "Account 1", source: "Claude Code-credentials", credentials }]
}

export function refreshAccount(source) {
  readCount += 1
  return credentials
}

export function writeBackCredentials() { return true }

export function buildAccountLabels(creds) {
  return creds.map((_, i) => \`Account \${i + 1}\`)
}

export function __getReadCount() {
  return readCount
}

export function __setCredentials(c) {
  credentials = c
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
    keychainModule: keychainModule as {
      __getReadCount: () => number
      __setCredentials: (c: ClaudeCredentials) => void
    },
  }
}

/**
 * Fake keychain with TWO accounts, used to regression-test the proactive
 * refresh timer's account resolution (bug: it used to read the closure-
 * captured `accounts[0]` instead of the currently active account after a
 * switch). Both accounts get `refreshToken: ""` so `refreshViaOAuth()`'s
 * `if (creds.refreshToken)` guard skips it entirely — no real network call
 * — and the refresh cascade falls straight through to the CLI fallback
 * (which fails fast with ENOENT since `claude` isn't installed in test
 * envs) and finally to the mocked `refreshAccount(source)`, which is what
 * actually determines success/failure here.
 */
async function loadHelpersWithMultiAccountKeychain(opts: {
  aExpiresAt: number
  bExpiresAt: number
  bRefreshResult: "success" | "fail"
}): Promise<{
  helpersModule: typeof import("./index.ts")
}> {
  const tempDir = await mkdtemp(
    join(tmpdir(), "opencode-claude-auth-multi-acct-"),
  )
  const tempKeychain = join(tempDir, "keychain.ts")

  await copySourceFiles(tempDir)
  await writeFile(
    tempKeychain,
    `let credsA = { accessToken: "token-a", refreshToken: "", expiresAt: ${opts.aExpiresAt} }
let credsB = { accessToken: "token-b", refreshToken: "", expiresAt: ${opts.bExpiresAt} }

export function readAllClaudeAccounts() {
  return [
    { label: "Account 1", source: "acct-a", credentials: credsA },
    { label: "Account 2", source: "acct-b", credentials: credsB },
  ]
}

export function refreshAccount(source) {
  if (source !== "acct-b") return null
  ${
    opts.bRefreshResult === "success"
      ? `credsB = { accessToken: "token-b-refreshed", refreshToken: "", expiresAt: Date.now() + 10 * 60 * 60 * 1000 }
  return credsB`
      : `return null`
  }
}

export function writeBackCredentials() { return true }
export function buildAccountLabels(creds) { return creds.map((_, i) => \`Account \${i + 1}\`) }
export const PRIMARY_SERVICE = "Claude Code-credentials"
`,
    "utf8",
  )

  const helpersModule = await import(
    pathToFileURL(join(tempDir, "index.ts")).href
  )

  return { helpersModule }
}

function makeCreds(overrides?: Partial<ClaudeCredentials>): ClaudeCredentials {
  return {
    accessToken: "sk-ant-test-access",
    refreshToken: "sk-ant-test-refresh",
    expiresAt: Date.now() + 300_000,
    ...overrides,
  }
}

const accounts: Account[] = [
  {
    label: "Account 1",
    source: "Claude Code-credentials",
    credentials: makeCreds({ accessToken: "at-1" }),
  },
  {
    label: "Account 2",
    source: "Claude Code-credentials-b28bbb7c",
    credentials: makeCreds({ accessToken: "at-2" }),
  },
  {
    label: "Account 3",
    source: "Claude Code-credentials-abc123",
    credentials: makeCreds({ accessToken: "at-3" }),
  },
]

const realFs = {
  existsSync: (p: string) => {
    try {
      readFileSync(p)
      return true
    } catch {
      return false
    }
  },
  readFileSync: (p: string, _enc: string) => readFileSync(p, "utf-8"),
  writeFileSync: (p: string, data: string, _enc: string) =>
    writeFileSync(p, data, "utf-8"),
  mkdirSync: (p: string, opts: object) =>
    mkdirSync(p, opts as Parameters<typeof mkdirSync>[1]),
  dirname: (p: string) => dirname(p),
}

let helpers: typeof import("./index.ts")

describe("exported helpers", () => {
  before(async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "opencode-claude-auth-"))
    const tempKeychain = join(tempDir, "keychain.ts")

    await copySourceFiles(tempDir)
    await writeFile(
      tempKeychain,
      `export const PRIMARY_SERVICE = "Claude Code-credentials"
export function readAllClaudeAccounts() { return [{ label: "Account 1", source: "Claude Code-credentials", credentials: { accessToken: "token", refreshToken: "refresh", expiresAt: 1 } }] }
export function refreshAccount() { return null }
export function writeBackCredentials() { return true }
export function buildAccountLabels(creds) { return creds.map((_, i) => \`Account \${i + 1}\`) }
`,
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
    assert.equal(headers.get("anthropic-version"), "2023-06-01")
    assert.equal(headers.get("x-api-key"), null)
    assert.equal(headers.get("x-custom"), "keep-me")
    assert.ok(headers.get("anthropic-beta")?.includes("custom-beta"))
    assert.ok(
      headers.get("anthropic-beta")?.includes("advisor-tool-2026-03-01"),
    )
    assert.equal(
      headers.get("anthropic-dangerous-direct-browser-access"),
      "true",
    )
    assert.equal(headers.get("x-stainless-lang"), "js")
    assert.equal(headers.get("x-stainless-runtime"), "node")
    assert.equal(
      headers.get("x-anthropic-billing-header"),
      null,
      "Billing header should not be set as HTTP header (it is injected into system array by transformBody)",
    )
    assert.ok(
      headers.get("x-client-request-id"),
      "Expected x-client-request-id to be set",
    )
    assert.match(
      headers.get("x-client-request-id")!,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      "x-client-request-id should be a UUID",
    )
    assert.ok(
      headers.get("x-claude-code-session-id"),
      "Expected X-Claude-Code-Session-Id to be set",
    )
    assert.match(
      headers.get("x-claude-code-session-id")!,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      "X-Claude-Code-Session-Id should be a UUID",
    )
  })

  it("x-client-request-id is unique per call", () => {
    const h1 = helpers.buildRequestHeaders(
      "https://api.anthropic.com/v1/messages",
      { headers: {} },
      "token",
      "claude-sonnet-4-6",
    )
    const h2 = helpers.buildRequestHeaders(
      "https://api.anthropic.com/v1/messages",
      { headers: {} },
      "token",
      "claude-sonnet-4-6",
    )
    assert.notEqual(
      h1.get("x-client-request-id"),
      h2.get("x-client-request-id"),
      "Each call should produce a unique x-client-request-id",
    )
  })

  it("X-Claude-Code-Session-Id is stable across calls", () => {
    const h1 = helpers.buildRequestHeaders(
      "https://api.anthropic.com/v1/messages",
      { headers: {} },
      "token",
      "claude-sonnet-4-6",
    )
    const h2 = helpers.buildRequestHeaders(
      "https://api.anthropic.com/v1/messages",
      { headers: {} },
      "token",
      "claude-sonnet-4-6",
    )
    assert.equal(
      h1.get("x-claude-code-session-id"),
      h2.get("x-claude-code-session-id"),
      "Session ID should be stable within the same process",
    )
  })

  it("billing header is no longer set as HTTP header", () => {
    const headers = helpers.buildRequestHeaders(
      "https://api.anthropic.com/v1/messages",
      { headers: {} },
      "token",
      "claude-opus-4-1",
    )
    assert.equal(
      headers.get("x-anthropic-billing-header"),
      null,
      "Billing header moved from HTTP headers to system array",
    )
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
      assert.ok(headers.get("user-agent")?.includes("sdk-cli"))
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

  it("ANTHROPIC_CLI_VERSION overrides version in billing header (via transformBody)", () => {
    process.env.ANTHROPIC_CLI_VERSION = "9.9.9"
    try {
      // The billing header is now computed and injected by transformBody,
      // so we test via transformBody rather than buildRequestHeaders
      const { transformBody } = helpers
      const body = JSON.stringify({
        system: [{ type: "text", text: "test" }],
        messages: [{ role: "user", content: "hey" }],
      })
      const result = transformBody(body)
      assert.ok(typeof result === "string")
      const parsed = JSON.parse(result as string) as {
        system: Array<{ text: string }>
      }
      const billing = parsed.system[0].text
      assert.ok(
        billing.includes("cc_version=9.9.9"),
        `Expected billing header to include 9.9.9, got: ${billing}`,
      )
      assert.ok(
        billing.includes("cc_entrypoint=sdk-cli"),
        `Expected billing header to include sdk-cli, got: ${billing}`,
      )
    } finally {
      delete process.env.ANTHROPIC_CLI_VERSION
    }
  })

  it("buildRequestHeaders preserves provided stainless headers", () => {
    const headers = helpers.buildRequestHeaders(
      "https://api.anthropic.com/v1/messages",
      {
        headers: {
          "x-stainless-runtime": "custom-runtime",
        },
      },
      "token",
      "claude-sonnet-4-6",
    )
    assert.equal(headers.get("x-stainless-runtime"), "custom-runtime")
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

  // refreshViaOAuth bounds its whole request with an AbortController. If the
  // backoff ignores that signal, the effective timeout is the retry delay
  // (capped at 30s) rather than the 15s the caller asked for.
  it("fetchWithRetry stops backing off once the request is aborted", async () => {
    const controller = new AbortController()
    let calls = 0
    const mockFetch = async () => {
      calls += 1
      return new Response("rate limited", {
        status: 429,
        headers: { "retry-after": "5" },
      })
    }

    setTimeout(() => controller.abort(), 50)
    const started = Date.now()
    const res = await helpers.fetchWithRetry(
      "https://example.com",
      { signal: controller.signal },
      3,
      mockFetch as unknown as typeof fetch,
    )
    const elapsed = Date.now() - started

    assert.equal(res.status, 429)
    assert.equal(calls, 1, "must not keep retrying after abort")
    assert.ok(elapsed < 1_000, `expected a prompt return, took ${elapsed}ms`)
  })

  it("fetchWithRetry returns immediately when retry-after exceeds max delay cap", async () => {
    // A retry-after of 31s (31,000ms) exceeds the 30,000ms cap and signals a
    // quota/usage-limit reset, not a transient rate limit. The function must
    // return the error response immediately rather than waiting and hanging.
    const start = Date.now()
    let callCount = 0
    const mockFetch = (() => {
      callCount++
      return Promise.resolve(
        new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "31" },
        }),
      )
    }) as unknown as typeof fetch
    const res = await helpers.fetchWithRetry(
      "https://example.com",
      {},
      3,
      mockFetch,
    )
    const elapsed = Date.now() - start
    assert.equal(res.status, 429)
    assert.equal(callCount, 1, "should not retry when delay exceeds cap")
    assert.ok(elapsed < 5000, `Expected immediate return, got ${elapsed}ms`)
  })

  it("fetchWithRetry respects OPENCODE_CLAUDE_AUTH_MAX_RETRY_MS env override", async () => {
    // Override the cap below the natural retry-after delay so the env var
    // demonstrably changes behaviour: a `retry-after: 1` produces a 1000ms
    // delay, which exceeds the 500ms override cap, so the function must
    // bail immediately. Without the override the default 30s cap would
    // permit the retry and elapsed would be ~1000ms — the gap is what
    // proves the env var took effect.
    process.env.OPENCODE_CLAUDE_AUTH_MAX_RETRY_MS = "500"
    let callCount = 0
    const mockFetch = (() => {
      callCount++
      return Promise.resolve(
        new Response("rate limited", {
          status: 429,
          headers: { "retry-after": "1" },
        }),
      )
    }) as unknown as typeof fetch
    try {
      const start = Date.now()
      const res = await helpers.fetchWithRetry(
        "https://example.com",
        {},
        3,
        mockFetch,
      )
      const elapsed = Date.now() - start
      assert.equal(res.status, 429)
      assert.equal(
        callCount,
        1,
        "should not retry when delay exceeds env-override cap",
      )
      assert.ok(elapsed < 500, `expected immediate return, got ${elapsed}ms`)
    } finally {
      delete process.env.OPENCODE_CLAUDE_AUTH_MAX_RETRY_MS
    }
  })

  it("fetchWithRetry still retries when retry-after is within the delay cap", async () => {
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
    const res = await helpers.fetchWithRetry(
      "https://example.com",
      {},
      3,
      mockFetch,
    )
    assert.equal(res.status, 200)
    assert.equal(callCount, 2, "should retry when delay is within cap")
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

  it("proactive refresh timer targets the ACTIVE account after a switch, not accounts[0]", async () => {
    const originalSetInterval = globalThis.setInterval
    const originalHome = process.env.HOME
    const originalDebug = process.env.CLAUDE_AUTH_DEBUG
    const tempHome = await mkdtemp(join(tmpdir(), "opencode-claude-auth-home-"))
    const debugLogPath = join(tempHome, "debug.log")
    process.env.HOME = tempHome
    // Capture the timer's own log ("proactive_refresh_check") so we can
    // assert which account it resolved to. The CLAUDE_AUTH_DEBUG env
    // routes logs to a file (see logger.ts).
    process.env.CLAUDE_AUTH_DEBUG = debugLogPath

    let tickCallback: (() => void | Promise<void>) | undefined
    globalThis.setInterval = ((cb: () => void | Promise<void>) => {
      tickCallback = cb
      return { unref() {} }
    }) as unknown as typeof setInterval

    try {
      const { helpersModule } = await loadHelpersWithMultiAccountKeychain({
        // accounts[0] ("acct-a") — far from expiry. The pre-fix code used
        // THIS account's expiry to decide whether to take the proactive
        // branch at all, regardless of which account is actually active.
        aExpiresAt: Date.now() + 10 * 60 * 60 * 1000,
        // Active account after the switch below — within the 1h proactive
        // window but past the 60s reactive threshold, so authorize()'s own
        // getCachedCredentials() call must NOT refresh it (isolating the
        // timer as the only thing that triggers a refresh here).
        bExpiresAt: Date.now() + 10 * 60 * 1000,
        bRefreshResult: "success",
      })

      const plugin = await helpersModule.default({} as never)
      assert.ok(
        tickCallback,
        "Expected setInterval to capture the tick callback",
      )

      const typedPlugin = plugin as {
        auth?: {
          methods?: Array<{
            authorize?: (i: { account?: string }) => Promise<unknown>
          }>
        }
      }
      await typedPlugin.auth!.methods![0]!.authorize!({ account: "acct-b" })

      // Truncate the log so we only inspect entries produced by the tick.
      await writeFile(debugLogPath, "", "utf-8")

      // Fire the timer tick manually — this is the only thing that should
      // trigger a refresh in this scenario.
      await tickCallback!()

      const logs = await readFile(debugLogPath, "utf-8")
      // The fix: timer's proactive_refresh_check should reference the
      // ACTIVE account (acct-b), not the closure-captured accounts[0]
      // (acct-a). With the accounts[0] bug, the log would show
      // "source":"acct-a" here.
      const proactiveCheckEntries = logs
        .split("\n")
        .filter((line) => line.includes("proactive_refresh_check"))
      assert.ok(
        proactiveCheckEntries.length > 0,
        `Expected proactive_refresh_check log entry, got log: ${logs}`,
      )
      assert.ok(
        proactiveCheckEntries.some((l) => l.includes('"source":"acct-b"')),
        `Timer should resolve ACTIVE account (acct-b) after switch, not ` +
          `accounts[0] (acct-a). Log: ${logs}`,
      )
      assert.ok(
        !proactiveCheckEntries.some((l) => l.includes('"source":"acct-a"')),
        "Timer should NOT be checking accounts[0] after switch. " +
          `Log: ${logs}`,
      )
    } finally {
      globalThis.setInterval = originalSetInterval
      if (typeof originalHome === "string") {
        process.env.HOME = originalHome
      } else {
        delete process.env.HOME
      }
      if (originalDebug === undefined) {
        delete process.env.CLAUDE_AUTH_DEBUG
      } else {
        process.env.CLAUDE_AUTH_DEBUG = originalDebug
      }
    }
  })

  it("proactive refresh timer warns at most once per outage (no spam on repeated failures)", async () => {
    const originalSetInterval = globalThis.setInterval
    const originalHome = process.env.HOME
    const originalWarn = console.warn
    const tempHome = await mkdtemp(join(tmpdir(), "opencode-claude-auth-home-"))
    process.env.HOME = tempHome

    let tickCallback: (() => void | Promise<void>) | undefined
    globalThis.setInterval = ((cb: () => void | Promise<void>) => {
      tickCallback = cb
      return { unref() {} }
    }) as unknown as typeof setInterval

    const warnMessages: string[] = []
    console.warn = ((...args: unknown[]) => {
      warnMessages.push(String(args[0]))
    }) as typeof console.warn

    try {
      const { helpersModule } = await loadHelpersWithMultiAccountKeychain({
        // Set acct-a to ALREADY EXPIRED so upstream's tryFallbackAccount
        // cannot borrow its creds when acct-b's refresh fails. Without
        // this, the new fallback would return acct-a's still-valid creds
        // and refreshIfNeeded would return non-null — making the warn
        // path unreachable and the latch untestable.
        aExpiresAt: Date.now() - 60_000,
        // Inside the reactive window, so the refresh chain runs to
        // exhaustion instead of short-circuiting on still-usable creds.
        bExpiresAt: Date.now() + 30_000,
        bRefreshResult: "fail",
      })

      const plugin = await helpersModule.default({} as never)
      assert.ok(tickCallback)

      const typedPlugin = plugin as {
        auth?: {
          methods?: Array<{
            authorize?: (i: { account?: string }) => Promise<unknown>
          }>
        }
      }
      await typedPlugin.auth!.methods![0]!.authorize!({ account: "acct-b" })

      warnMessages.length = 0 // ignore any warnings emitted during init/authorize

      // Simulate 3 consecutive failed sync ticks (15 minutes of downtime).
      // Awaited individually: real ticks are 5 minutes apart, so each one
      // completes long before the next fires.
      await tickCallback!()
      await tickCallback!()
      await tickCallback!()

      const proactiveWarnings = warnMessages.filter((m) =>
        m.includes("Proactive token refresh failed"),
      )
      assert.equal(
        proactiveWarnings.length,
        1,
        `Expected exactly 1 warning across 3 failed ticks (latched), got ${proactiveWarnings.length}`,
      )
    } finally {
      globalThis.setInterval = originalSetInterval
      console.warn = originalWarn
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

      assert.equal(forwardedInput, `${originalInput}?beta=true`)
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

  it("auth fetch reloads the source and retries once with a rotated token", async () => {
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

    const authorizationHeaders: string[] = []

    try {
      const { helpersModule, keychainModule } =
        await loadHelpersWithCountingKeychain(Date.now() + 10 * 60_000)
      globalThis.fetch = (async (_input, init) => {
        authorizationHeaders.push(
          new Headers(init?.headers).get("authorization") ?? "",
        )
        return authorizationHeaders.length === 1
          ? new Response("revoked", { status: 401 })
          : new Response("ok", { status: 200 })
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

      keychainModule.__setCredentials({
        accessToken: "replacement-token",
        refreshToken: "replacement-refresh",
        expiresAt: Date.now() + 8 * 60 * 60_000,
      })

      const response = await authConfig.fetch(
        "https://api.anthropic.com/v1/messages",
        {
          method: "POST",
          body: JSON.stringify({ model: "claude-haiku-4-5", messages: [] }),
        },
      )

      assert.equal(response.status, 200)
      assert.deepEqual(authorizationHeaders, [
        "Bearer token",
        "Bearer replacement-token",
      ])
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

  it("auth fetch force-refreshes on a 401 when the source token is unchanged", async () => {
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

    let apiCalls = 0
    let oauthCalls = 0

    try {
      const { helpersModule } = await loadHelpersWithCountingKeychain(
        Date.now() + 10 * 60_000,
      )

      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : String(input)
        if (url.includes("/oauth/token")) {
          oauthCalls += 1
          return new Response(
            JSON.stringify({
              access_token: "recovered-token",
              refresh_token: "rt-recovered",
              expires_in: 36_000,
            }),
            { status: 200 },
          )
        }
        apiCalls += 1
        return apiCalls === 1
          ? new Response('{"error":"expired"}', { status: 401 })
          : new Response("data: {}\n\n", { status: 200 })
      }) as typeof fetch

      const plugin = await helpersModule.default({} as never)
      const typedPlugin = plugin as { auth?: { loader?: TestAuthLoader } }
      const authConfig = await typedPlugin.auth!.loader!(
        async () => ({
          type: "oauth",
          refresh: "refresh",
          access: "access",
          expires: Date.now() + 60_000,
        }),
        { models: {} },
      )

      const response = await authConfig.fetch(
        "https://api.anthropic.com/v1/messages",
        {
          method: "POST",
          body: JSON.stringify({ model: "claude-haiku-4-5", messages: [] }),
        },
      )

      assert.equal(response.status, 200)
      assert.equal(oauthCalls, 1, "the unchanged token must force a refresh")
      assert.equal(apiCalls, 2, "the refreshed token must be retried once")
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

  it("auth fetch surfaces the 401 unchanged when recovery cannot progress", async () => {
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

    let apiCalls = 0
    const errorBody = '{"name":"mcp_UnchangedToken"}'

    try {
      const { helpersModule } = await loadHelpersWithCountingKeychain(
        Date.now() + 10 * 60_000,
      )

      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : String(input)
        if (url.includes("/oauth/token")) {
          // A 429 from the token endpoint must read as a failed refresh, not
          // as something that loops account recovery. retry-after beyond the
          // 30s cap makes fetchWithRetry return instead of backing off.
          return new Response('{"error":"rate_limited"}', {
            status: 429,
            headers: { "retry-after": "3600" },
          })
        }
        apiCalls += 1
        return new Response(errorBody, {
          status: 401,
          headers: { "x-request-id": "unchanged-token-401" },
        })
      }) as typeof fetch

      const plugin = await helpersModule.default({} as never)
      const typedPlugin = plugin as { auth?: { loader?: TestAuthLoader } }
      const authConfig = await typedPlugin.auth!.loader!(
        async () => ({
          type: "oauth",
          refresh: "refresh",
          access: "access",
          expires: Date.now() + 60_000,
        }),
        { models: {} },
      )

      const response = await authConfig.fetch(
        "https://api.anthropic.com/v1/messages",
        {
          method: "POST",
          body: JSON.stringify({ model: "claude-haiku-4-5", messages: [] }),
        },
      )

      assert.equal(response.status, 401)
      assert.equal(response.headers.get("x-request-id"), "unchanged-token-401")
      assert.equal(await response.text(), errorBody)
      assert.equal(apiCalls, 1, "no retry without a different token")
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

  it("auth fetch makes a second recovery attempt when the first retry is also rejected", async () => {
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

    let apiCalls = 0
    let oauthCalls = 0

    try {
      const { helpersModule, keychainModule } =
        await loadHelpersWithCountingKeychain(Date.now() + 10 * 60_000)

      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : String(input)
        if (url.includes("/oauth/token")) {
          oauthCalls += 1
          return new Response(
            JSON.stringify({
              access_token: "second-stage-token",
              refresh_token: "rt-second-stage",
              expires_in: 36_000,
            }),
            { status: 200 },
          )
        }
        apiCalls += 1
        // Calls 1 and 2 are rejected; only the force-refreshed token works.
        return apiCalls <= 2
          ? new Response('{"error":"expired"}', { status: 401 })
          : new Response("data: {}\n\n", { status: 200 })
      }) as typeof fetch

      const plugin = await helpersModule.default({} as never)
      const typedPlugin = plugin as { auth?: { loader?: TestAuthLoader } }
      const authConfig = await typedPlugin.auth!.loader!(
        async () => ({
          type: "oauth",
          refresh: "refresh",
          access: "access",
          expires: Date.now() + 60_000,
        }),
        { models: {} },
      )

      // Attempt 1's reload finds a different, still-valid-looking token.
      keychainModule.__setCredentials({
        accessToken: "concurrently-rotated",
        refreshToken: "rt-concurrent",
        expiresAt: Date.now() + 10 * 60_000,
      })

      const response = await authConfig.fetch(
        "https://api.anthropic.com/v1/messages",
        {
          method: "POST",
          body: JSON.stringify({ model: "claude-haiku-4-5", messages: [] }),
        },
      )

      assert.equal(response.status, 200)
      assert.equal(apiCalls, 3, "original, reload retry, force-refresh retry")
      assert.equal(oauthCalls, 1, "only the second attempt force-refreshes")
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

  it("auth fetch preserves the original 401 when credential reload throws", async () => {
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

    let apiCalls = 0
    let oauthCalls = 0
    const errorBody = '{"name":"mcp_ReloadFailure"}'

    try {
      const { helpersModule } = await loadHelpersWithCountingKeychain(
        Date.now() + 10 * 60_000,
        { throwOnReload: true },
      )
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : String(input)
        // A thrown reload leaves no candidate, so the loop falls through to
        // the force refresh. Rejecting it here is what makes recovery
        // terminal and surfaces the original 401 untouched.
        if (url.includes("/oauth/token")) {
          oauthCalls += 1
          return new Response('{"error":"invalid_grant"}', { status: 401 })
        }
        apiCalls += 1
        return new Response(errorBody, {
          status: 401,
          statusText: "Unauthorized",
          headers: {
            "content-type": "text/plain",
            "x-request-id": "request-401",
          },
        })
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

      const response = await authConfig.fetch(
        "https://api.anthropic.com/v1/messages",
        {
          method: "POST",
          body: JSON.stringify({ model: "claude-haiku-4-5", messages: [] }),
        },
      )

      assert.equal(response.status, 401)
      assert.equal(response.statusText, "Unauthorized")
      assert.equal(response.headers.get("content-type"), "text/plain")
      assert.equal(response.headers.get("x-request-id"), "request-401")
      assert.equal(await response.text(), errorBody)
      assert.equal(apiCalls, 1, "no retry once recovery cannot progress")
      assert.equal(oauthCalls, 1, "a thrown reload still forces a refresh")
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

  it("auth fetch returns quota errors without writing over the terminal UI", async () => {
    const originalNow = Date.now
    const originalSetInterval = globalThis.setInterval
    const originalHome = process.env.HOME
    const originalFetch = globalThis.fetch
    const originalWarn = console.warn
    const tempHome = await mkdtemp(join(tmpdir(), "opencode-claude-auth-home-"))
    process.env.HOME = tempHome
    Date.now = () => 1_700_000_000_000
    globalThis.setInterval = (() => ({
      unref() {},
    })) as unknown as typeof setInterval

    const errorBody = JSON.stringify({
      type: "error",
      error: {
        type: "rate_limit_error",
        message:
          "This request would exceed your account's rate limit. Please try again later.",
      },
    })
    let fetchCount = 0
    const warnings: unknown[][] = []

    try {
      const { helpersModule } = await loadHelpersWithCountingKeychain(
        Date.now() + 10 * 60_000,
      )
      globalThis.fetch = (async () => {
        fetchCount += 1
        return new Response(errorBody, {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": "11218",
          },
        })
      }) as typeof fetch
      console.warn = (...args: unknown[]) => {
        warnings.push(args)
      }

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

      const response = await authConfig.fetch(
        "https://api.anthropic.com/v1/messages",
        {
          method: "POST",
          body: JSON.stringify({
            model: "claude-opus-4-8",
            messages: [],
          }),
        },
      )

      assert.equal(response.status, 429)
      assert.equal(response.headers.get("retry-after"), "11218")
      assert.equal(await response.text(), errorBody)
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.equal(fetchCount, 1)
      assert.deepEqual(warnings, [])
    } finally {
      Date.now = originalNow
      globalThis.setInterval = originalSetInterval
      globalThis.fetch = originalFetch
      console.warn = originalWarn
      if (typeof originalHome === "string") {
        process.env.HOME = originalHome
      } else {
        delete process.env.HOME
      }
    }
  })

  it("auth fetch stops at the recovery attempt cap when the store rotates on every read", async () => {
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

    // Against a store rotated on every read, every candidate differs from the
    // token in use, so the no-progress break never fires and the attempt cap
    // is the only thing stopping the loop. Nothing else pins that ceiling —
    // the two-attempt test exits via success, so it constrains the floor.
    const authorizationHeaders: string[] = []

    try {
      const { helpersModule, keychainModule } =
        await loadHelpersWithCountingKeychain(Date.now() + 10 * 60_000)

      globalThis.fetch = (async (_input, init) => {
        authorizationHeaders.push(
          new Headers(init?.headers).get("authorization") ?? "",
        )
        // Rotate the store before answering, so the next reload always finds
        // a token it has not seen.
        keychainModule.__setCredentials({
          accessToken: `rotated-${authorizationHeaders.length}`,
          refreshToken: `rt-${authorizationHeaders.length}`,
          expiresAt: Date.now() + 10 * 60_000,
        })
        return new Response('{"error":"expired"}', { status: 401 })
      }) as typeof fetch

      const plugin = await helpersModule.default({} as never)
      const typedPlugin = plugin as { auth?: { loader?: TestAuthLoader } }
      const authConfig = await typedPlugin.auth!.loader!(
        async () => ({
          type: "oauth",
          refresh: "refresh",
          access: "access",
          expires: Date.now() + 60_000,
        }),
        { models: {} },
      )

      const response = await authConfig.fetch(
        "https://api.anthropic.com/v1/messages",
        {
          method: "POST",
          body: JSON.stringify({ model: "claude-haiku-4-5", messages: [] }),
        },
      )

      assert.equal(response.status, 401)
      assert.equal(
        authorizationHeaders.length,
        3,
        "original request plus two capped recovery attempts, and no more",
      )
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

  it("auth fetch compares the 429 re-read against the recovered token, not the original", async () => {
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

    // 401 -> recover -> the retry comes back 429. The 429 block must compare
    // the source against the token it just recovered with. Comparing against
    // the original `latest` instead still compiles and passes every other
    // test, while retrying a quota error on a token the source already agrees
    // is current — the exact hazard the block's own comment predicts.
    const authorizationHeaders: string[] = []

    try {
      const { helpersModule, keychainModule } =
        await loadHelpersWithCountingKeychain(Date.now() + 10 * 60_000)

      globalThis.fetch = (async (_input, init) => {
        authorizationHeaders.push(
          new Headers(init?.headers).get("authorization") ?? "",
        )
        if (authorizationHeaders.length === 1) {
          return new Response('{"error":"expired"}', { status: 401 })
        }
        return new Response('{"error":"rate_limited"}', {
          status: 429,
          headers: { "retry-after": "3600" },
        })
      }) as typeof fetch

      const plugin = await helpersModule.default({} as never)
      const typedPlugin = plugin as { auth?: { loader?: TestAuthLoader } }
      const authConfig = await typedPlugin.auth!.loader!(
        async () => ({
          type: "oauth",
          refresh: "refresh",
          access: "access",
          expires: Date.now() + 60_000,
        }),
        { models: {} },
      )

      // The store already holds the token the 401 recovery will adopt, so
      // once recovered there is nothing further to rotate to.
      keychainModule.__setCredentials({
        accessToken: "recovered-token",
        refreshToken: "rt-recovered",
        expiresAt: Date.now() + 10 * 60_000,
      })

      const response = await authConfig.fetch(
        "https://api.anthropic.com/v1/messages",
        {
          method: "POST",
          body: JSON.stringify({ model: "claude-haiku-4-5", messages: [] }),
        },
      )

      assert.equal(response.status, 429)
      assert.deepEqual(
        authorizationHeaders,
        ["Bearer token", "Bearer recovered-token"],
        "the 429 must not be retried once the source agrees with the token in use",
      )
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

  it("auth fetch retries a 429 once when the source token changed", async () => {
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

    // Captured per call, not just counted: a count alone cannot tell a
    // retry that carried the rotated token from one that replayed the
    // exhausted token, which is the whole behavior under test.
    const authorizationHeaders: string[] = []

    try {
      const { helpersModule, keychainModule } =
        await loadHelpersWithCountingKeychain(Date.now() + 10 * 60_000)

      globalThis.fetch = (async (_input, init) => {
        authorizationHeaders.push(
          new Headers(init?.headers).get("authorization") ?? "",
        )
        if (authorizationHeaders.length === 1) {
          // retry-after beyond the 30s cap: quota exhaustion, not a
          // transient limit, so fetchWithRetry returns immediately.
          return new Response('{"error":"rate_limited"}', {
            status: 429,
            headers: { "retry-after": "3600" },
          })
        }
        return new Response("data: {}\n\n", { status: 200 })
      }) as typeof fetch

      const plugin = await helpersModule.default({} as never)
      const typedPlugin = plugin as { auth?: { loader?: TestAuthLoader } }
      const authConfig = await typedPlugin.auth!.loader!(
        async () => ({
          type: "oauth",
          refresh: "refresh",
          access: "access",
          expires: Date.now() + 60_000,
        }),
        { models: {} },
      )

      // An external switch lands while this session is still on the
      // exhausted account.
      keychainModule.__setCredentials({
        accessToken: "switched-token",
        refreshToken: "rt-switched",
        expiresAt: Date.now() + 10 * 60_000,
      })

      const response = await authConfig.fetch(
        "https://api.anthropic.com/v1/messages",
        {
          method: "POST",
          body: JSON.stringify({ model: "claude-haiku-4-5", messages: [] }),
        },
      )

      assert.equal(response.status, 200)
      assert.deepEqual(
        authorizationHeaders,
        ["Bearer token", "Bearer switched-token"],
        "the retry must carry the rotated token, not replay the exhausted one",
      )
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

  it("auth fetch does not retry a 429 when the source token is unchanged", async () => {
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

    let apiCalls = 0

    try {
      const { helpersModule } = await loadHelpersWithCountingKeychain(
        Date.now() + 10 * 60_000,
      )

      globalThis.fetch = (async () => {
        apiCalls += 1
        return new Response('{"error":"rate_limited"}', {
          status: 429,
          headers: { "retry-after": "3600" },
        })
      }) as typeof fetch

      const plugin = await helpersModule.default({} as never)
      const typedPlugin = plugin as { auth?: { loader?: TestAuthLoader } }
      const authConfig = await typedPlugin.auth!.loader!(
        async () => ({
          type: "oauth",
          refresh: "refresh",
          access: "access",
          expires: Date.now() + 60_000,
        }),
        { models: {} },
      )

      const response = await authConfig.fetch(
        "https://api.anthropic.com/v1/messages",
        {
          method: "POST",
          body: JSON.stringify({ model: "claude-haiku-4-5", messages: [] }),
        },
      )

      assert.equal(response.status, 429)
      assert.equal(apiCalls, 1, "an unchanged token must not be retried")
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

  it("auth fetch does not retry a 429 when the source is unreadable", async () => {
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

    let apiCalls = 0

    try {
      const { helpersModule, keychainModule } =
        await loadHelpersWithCountingKeychain(Date.now() + 10 * 60_000)

      globalThis.fetch = (async () => {
        apiCalls += 1
        return new Response('{"error":"rate_limited"}', {
          status: 429,
          headers: { "retry-after": "3600" },
        })
      }) as typeof fetch

      const plugin = await helpersModule.default({} as never)
      const typedPlugin = plugin as { auth?: { loader?: TestAuthLoader } }
      const authConfig = await typedPlugin.auth!.loader!(
        async () => ({
          type: "oauth",
          refresh: "refresh",
          access: "access",
          expires: Date.now() + 60_000,
        }),
        { models: {} },
      )

      // Distinct from the unchanged-token arm: the token DID change, but
      // reloadCredentialsFromSource rejects anything expiring within 60s,
      // so it yields null. Retrying with a token the reload refused to
      // vouch for would burn a request on a credential already known bad.
      keychainModule.__setCredentials({
        accessToken: "expiring-token",
        refreshToken: "rt-expiring",
        expiresAt: Date.now() + 30_000,
      })

      const response = await authConfig.fetch(
        "https://api.anthropic.com/v1/messages",
        {
          method: "POST",
          body: JSON.stringify({ model: "claude-haiku-4-5", messages: [] }),
        },
      )

      assert.equal(response.status, 429)
      assert.equal(apiCalls, 1, "an unusable reload must not be retried")
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

describe("auth hook — account resolution", () => {
  it("defaults to Account 1 when no input is provided", () => {
    assert.equal(resolveAccount(accounts, undefined).label, "Account 1")
  })

  it("selects Account 2 by its source key", () => {
    assert.equal(
      resolveAccount(accounts, "Claude Code-credentials-b28bbb7c").label,
      "Account 2",
    )
  })

  it("selects Account 3 by its source key", () => {
    assert.equal(
      resolveAccount(accounts, "Claude Code-credentials-abc123").label,
      "Account 3",
    )
  })

  it("falls back to Account 1 when source doesn't match any account", () => {
    assert.equal(
      resolveAccount(accounts, "Claude Code-credentials-unknown").label,
      "Account 1",
    )
  })

  it("returns the correct credentials for the resolved account", () => {
    assert.equal(
      resolveAccount(accounts, "Claude Code-credentials-b28bbb7c").credentials
        .accessToken,
      "at-2",
    )
  })

  it("works correctly when only one account exists", () => {
    const single = [
      {
        label: "Account 1",
        source: "Claude Code-credentials",
        credentials: makeCreds(),
      },
    ]
    assert.equal(resolveAccount(single, undefined).label, "Account 1")
    assert.equal(resolveAccount(single, "nonexistent").label, "Account 1")
  })
})

describe("auth hook — select prompt options", () => {
  it("builds one option per account", () => {
    assert.equal(buildSelectOptions(accounts, accounts[0].source).length, 3)
  })

  it("uses label as display text and source as value", () => {
    const options = buildSelectOptions(accounts, accounts[0].source)
    assert.equal(options[0].label, "Account 1")
    assert.equal(options[0].value, "Claude Code-credentials")
    assert.equal(options[1].label, "Account 2")
    assert.equal(options[1].value, "Claude Code-credentials-b28bbb7c")
  })

  it("marks the active account in its hint", () => {
    const options = buildSelectOptions(
      accounts,
      "Claude Code-credentials-b28bbb7c",
    )
    assert.equal(options[1].hint, "active")
    assert.equal(options[0].hint, undefined)
    assert.equal(options[2].hint, undefined)
  })

  it("shows no prompts when only one account exists", () => {
    const single = [accounts[0]]
    const prompts =
      single.length > 1 ? buildSelectOptions(single, single[0].source) : []
    assert.deepEqual(prompts, [])
  })

  it("shows prompts when multiple accounts exist", () => {
    const prompts =
      accounts.length > 1
        ? buildSelectOptions(accounts, accounts[0].source)
        : []
    assert.equal(prompts.length, 3)
  })
})

describe("auth hook — authorize callback", () => {
  it("returns url as empty string", () => {
    assert.equal(buildAuthorizeResult(accounts[0]).url, "")
  })

  it("returns method: auto", () => {
    assert.equal(buildAuthorizeResult(accounts[0]).method, "auto")
  })

  it("instructions mention the chosen account label", () => {
    assert.ok(
      buildAuthorizeResult(accounts[1]).instructions.includes("Account 2"),
    )
  })

  it("callback returns type: success", async () => {
    assert.equal(
      (await buildAuthorizeResult(accounts[0]).callback()).type,
      "success",
    )
  })

  it("callback returns provider: anthropic", async () => {
    assert.equal(
      (await buildAuthorizeResult(accounts[0]).callback()).provider,
      "anthropic",
    )
  })

  it("callback returns the account's access token", async () => {
    assert.equal(
      (await buildAuthorizeResult(accounts[1]).callback()).access,
      "at-2",
    )
  })

  it("callback returns the account's refresh token", async () => {
    const account = {
      label: "Account 1",
      source: "Claude Code-credentials",
      credentials: makeCreds({ refreshToken: "rt-specific" }),
    }
    assert.equal(
      (await buildAuthorizeResult(account).callback()).refresh,
      "rt-specific",
    )
  })

  it("callback returns the account's expiry timestamp", async () => {
    const account = {
      label: "Account 1",
      source: "Claude Code-credentials",
      credentials: makeCreds({ expiresAt: 1700000000000 }),
    }
    assert.equal(
      (await buildAuthorizeResult(account).callback()).expires,
      1700000000000,
    )
  })
})

describe("syncToPath", () => {
  const tmp = join(tmpdir(), `opencode-test-${process.pid}`)

  it("writes anthropic credentials to auth.json", () => {
    mkdirSync(tmp, { recursive: true })
    const authPath = join(tmp, "auth.json")
    const creds = makeCreds({
      accessToken: "at-write",
      refreshToken: "rt-write",
      expiresAt: 1700000000000,
    })
    syncToPath(authPath, creds, realFs)
    const written = JSON.parse(readFileSync(authPath, "utf-8"))
    assert.deepEqual(written.anthropic, {
      type: "oauth",
      access: "at-write",
      refresh: "rt-write",
      expires: 1700000000000,
    })
    rmSync(tmp, { recursive: true, force: true })
  })

  it("preserves other providers already in auth.json", () => {
    mkdirSync(tmp, { recursive: true })
    const authPath = join(tmp, "auth.json")
    writeFileSync(
      authPath,
      JSON.stringify({
        "github-copilot": { type: "oauth", access: "gh-token" },
      }),
      "utf-8",
    )
    syncToPath(authPath, makeCreds(), realFs)
    const written = JSON.parse(readFileSync(authPath, "utf-8"))
    assert.ok(written["github-copilot"])
    assert.equal(written["github-copilot"].access, "gh-token")
    assert.ok(written.anthropic)
    rmSync(tmp, { recursive: true, force: true })
  })

  it("starts fresh when existing auth.json contains invalid JSON", () => {
    mkdirSync(tmp, { recursive: true })
    const authPath = join(tmp, "auth.json")
    writeFileSync(authPath, "{ broken json {{", "utf-8")
    syncToPath(authPath, makeCreds({ accessToken: "at-fresh" }), realFs)
    const written = JSON.parse(readFileSync(authPath, "utf-8"))
    assert.equal(written.anthropic.access, "at-fresh")
    assert.equal(Object.keys(written).length, 1)
    rmSync(tmp, { recursive: true, force: true })
  })

  it("creates the directory if it does not exist", () => {
    const authPath = join(tmp, "deep", "nested", "auth.json")
    syncToPath(authPath, makeCreds(), realFs)
    assert.ok(JSON.parse(readFileSync(authPath, "utf-8")).anthropic)
    rmSync(tmp, { recursive: true, force: true })
  })
})

function saveAccountSourceTo(stateFile: string, source: string): void {
  const dir = join(stateFile, "..")
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(stateFile, source, "utf-8")
}

function loadPersistedAccountSourceFrom(stateFile: string): string | null {
  try {
    if (existsSync(stateFile)) {
      return readFileSync(stateFile, "utf-8").trim() || null
    }
  } catch {
    // ignore
  }
  return null
}

function resolveStartupAccount(
  candidateAccounts: Account[],
  persistedSource: string | null,
): Account {
  return (
    (persistedSource &&
      candidateAccounts.find((a) => a.source === persistedSource)) ||
    candidateAccounts[0]
  )
}

describe("account persistence — saveAccountSource / loadPersistedAccountSource", () => {
  const tmp = join(tmpdir(), `opencode-persist-test-${process.pid}`)
  const stateFile = join(tmp, "claude-account-source.txt")

  it("returns null when the state file does not exist", () => {
    try {
      rmSync(stateFile, { force: true })
    } catch {
      /* ignore */
    }
    assert.equal(loadPersistedAccountSourceFrom(stateFile), null)
  })

  it("saves and loads the account source correctly", () => {
    saveAccountSourceTo(stateFile, "Claude Code-credentials-b28bbb7c")
    assert.equal(
      loadPersistedAccountSourceFrom(stateFile),
      "Claude Code-credentials-b28bbb7c",
    )
    rmSync(tmp, { recursive: true, force: true })
  })

  it("overwrites a previously saved source", () => {
    saveAccountSourceTo(stateFile, "Claude Code-credentials")
    saveAccountSourceTo(stateFile, "Claude Code-credentials-abc123")
    assert.equal(
      loadPersistedAccountSourceFrom(stateFile),
      "Claude Code-credentials-abc123",
    )
    rmSync(tmp, { recursive: true, force: true })
  })

  it("returns null when the state file is empty", () => {
    mkdirSync(tmp, { recursive: true })
    writeFileSync(stateFile, "   ", "utf-8")
    assert.equal(loadPersistedAccountSourceFrom(stateFile), null)
    rmSync(tmp, { recursive: true, force: true })
  })
})

describe("startup account selection — uses persisted source", () => {
  it("uses Account 1 when no source is persisted", () => {
    assert.equal(resolveStartupAccount(accounts, null).label, "Account 1")
  })

  it("restores Account 2 from persisted source", () => {
    assert.equal(
      resolveStartupAccount(accounts, "Claude Code-credentials-b28bbb7c").label,
      "Account 2",
    )
  })

  it("restores Account 3 from persisted source", () => {
    assert.equal(
      resolveStartupAccount(accounts, "Claude Code-credentials-abc123").label,
      "Account 3",
    )
  })

  it("falls back to Account 1 when the persisted source no longer exists", () => {
    assert.equal(
      resolveStartupAccount(accounts, "Claude Code-credentials-gone").label,
      "Account 1",
    )
  })

  it("restores correct credentials for the persisted account", () => {
    assert.equal(
      resolveStartupAccount(accounts, "Claude Code-credentials-b28bbb7c")
        .credentials.accessToken,
      "at-2",
    )
  })
})

describe("authorize() — immediate syncAuthJson + saveAccountSource", () => {
  const tmp = join(tmpdir(), `opencode-authorize-test-${process.pid}`)

  it("auth.json reflects the chosen account immediately after authorize()", () => {
    mkdirSync(tmp, { recursive: true })
    const authPath = join(tmp, "auth.json")
    const stateFile = join(tmp, "claude-account-source.txt")

    const chosen = accounts[1] // Account 2
    syncToPath(authPath, chosen.credentials, realFs)
    saveAccountSourceTo(stateFile, chosen.source)

    const written = JSON.parse(readFileSync(authPath, "utf-8"))
    assert.equal(written.anthropic.access, "at-2")
    assert.equal(
      loadPersistedAccountSourceFrom(stateFile),
      "Claude Code-credentials-b28bbb7c",
    )

    rmSync(tmp, { recursive: true, force: true })
  })

  it("a subsequent startup restores the account written by authorize()", () => {
    mkdirSync(tmp, { recursive: true })
    const stateFile = join(tmp, "claude-account-source.txt")

    saveAccountSourceTo(stateFile, "Claude Code-credentials-abc123")

    const restored = resolveStartupAccount(
      accounts,
      loadPersistedAccountSourceFrom(stateFile),
    )
    assert.equal(restored.label, "Account 3")
    assert.equal(restored.credentials.accessToken, "at-3")

    rmSync(tmp, { recursive: true, force: true })
  })
})

describe("refreshIfNeeded — token expiry", () => {
  it("returns fresh when token expires more than 60s from now", () => {
    assert.equal(
      refreshIfNeeded(
        makeCreds({ expiresAt: Date.now() + 120_000 }),
        Date.now(),
      ),
      "fresh",
    )
  })

  it("returns expired when token expires in less than 60s", () => {
    assert.equal(
      refreshIfNeeded(
        makeCreds({ expiresAt: Date.now() + 30_000 }),
        Date.now(),
      ),
      "expired",
    )
  })

  it("returns expired when token is already past expiry", () => {
    assert.equal(
      refreshIfNeeded(makeCreds({ expiresAt: Date.now() - 1000 }), Date.now()),
      "expired",
    )
  })

  it("returns expired when token expires exactly at the 60s boundary", () => {
    const now = Date.now()
    assert.equal(
      refreshIfNeeded(makeCreds({ expiresAt: now + 60_000 }), now),
      "expired",
    )
  })

  it("returns fresh when token expires exactly 1ms past the 60s boundary", () => {
    const now = Date.now()
    assert.equal(
      refreshIfNeeded(makeCreds({ expiresAt: now + 60_001 }), now),
      "fresh",
    )
  })
})
