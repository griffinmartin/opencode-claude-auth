/**
 * Quota-wait: when every configured Claude account is rate-limited, the plugin
 * must sleep until the soonest bench expires — real waiting, no polling — then
 * re-evaluate the pool and resend the identical request, instead of surfacing
 * the 429 and killing the OpenCode run.
 *
 * Two test levels live here:
 *
 * - unit tests against the real rotation.ts (escalating benches for
 *   unexplained 429s, the wait config, the earliest-bench computation), and
 * - integration tests through the plugin's auth fetch, on a copied source
 *   tree with a mocked keychain and a fake clock/sleeper injected through
 *   __setRotationWaitDepsForTests, so "wait an hour" costs microseconds.
 */

import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, it } from "node:test"

import {
  earliestCooldown,
  getRotationWaitConfig,
  markRateLimited,
  readRotationState,
} from "./rotation.ts"

// ---------------------------------------------------------------------------
// Unit tests: rotation.ts wait plumbing
// ---------------------------------------------------------------------------

const NOW = 1_800_000_000_000

function isolateRotationFile(): void {
  process.env.OPENCODE_CLAUDE_AUTH_ROTATION_FILE = join(
    mkdtempSync(join(tmpdir(), "opencode-claude-auth-waitstate-")),
    "rotation.json",
  )
}

describe("rotation wait — unit", () => {
  describe("getRotationWaitConfig", () => {
    it("defaults to enabled with unbounded budgets and a small margin", () => {
      const config = getRotationWaitConfig()
      assert.equal(config.enabled, true)
      assert.equal(config.maxCycles, 0)
      assert.equal(config.maxWaitTotalMs, 0)
      assert.equal(config.marginMs, 1_000)
      assert.equal(config.jitterMs, 2_000)
    })

    it("disables only on the explicit 0", () => {
      process.env.OPENCODE_CLAUDE_AUTH_ROTATE_WAIT = "0"
      try {
        assert.equal(getRotationWaitConfig().enabled, false)
      } finally {
        delete process.env.OPENCODE_CLAUDE_AUTH_ROTATE_WAIT
      }
    })

    it("reads numeric overrides and ignores garbage", () => {
      process.env.OPENCODE_CLAUDE_AUTH_ROTATE_WAIT_MAX_CYCLES = "2"
      process.env.OPENCODE_CLAUDE_AUTH_ROTATE_WAIT_MAX_MS = "45000"
      process.env.OPENCODE_CLAUDE_AUTH_ROTATE_WAIT_MARGIN_MS = "250"
      process.env.OPENCODE_CLAUDE_AUTH_ROTATE_WAIT_JITTER_MS = "not-a-number"
      try {
        const config = getRotationWaitConfig()
        assert.equal(config.maxCycles, 2)
        assert.equal(config.maxWaitTotalMs, 45_000)
        assert.equal(config.marginMs, 250)
        assert.equal(config.jitterMs, 2_000)
      } finally {
        delete process.env.OPENCODE_CLAUDE_AUTH_ROTATE_WAIT_MAX_CYCLES
        delete process.env.OPENCODE_CLAUDE_AUTH_ROTATE_WAIT_MAX_MS
        delete process.env.OPENCODE_CLAUDE_AUTH_ROTATE_WAIT_MARGIN_MS
        delete process.env.OPENCODE_CLAUDE_AUTH_ROTATE_WAIT_JITTER_MS
      }
    })
  })

  describe("earliestCooldown", () => {
    it("returns the soonest live bench", () => {
      isolateRotationFile()
      markRateLimited("acct-a", 120_000, "retry-after", NOW)
      markRateLimited("acct-b", 30_000, "retry-after", NOW)
      const earliest = earliestCooldown(NOW)
      assert.equal(earliest?.source, "acct-b")
      assert.equal(earliest?.until, NOW + 30_000)
    })

    it("returns null when nothing is benched", () => {
      isolateRotationFile()
      assert.equal(earliestCooldown(NOW), null)
    })

    it("skips benches that have already expired", () => {
      isolateRotationFile()
      markRateLimited("acct-a", 30_000, "retry-after", NOW)
      markRateLimited("acct-b", 120_000, "retry-after", NOW)
      const earliest = earliestCooldown(NOW + 31_000)
      assert.equal(earliest?.source, "acct-b")
    })
  })

  describe("escalating default cooldown", () => {
    it("keeps the first unexplained bench at the plain default", () => {
      isolateRotationFile()
      const until = markRateLimited("acct-a", 60_000, "unspecified-429", NOW)
      assert.equal(until, NOW + 60_000)
      assert.equal(readRotationState().cooldowns["acct-a"]?.unspecifiedCount, 1)
    })

    it("doubles the second unexplained bench", () => {
      isolateRotationFile()
      markRateLimited("acct-a", 60_000, "unspecified-429", NOW)
      const until = markRateLimited(
        "acct-a",
        60_000,
        "unspecified-429",
        NOW + 1,
        () => 0.999999,
      )
      assert.ok(
        until >= NOW + 1 + 119_000,
        `expected ~120s, got ${until - NOW}`,
      )
      assert.equal(readRotationState().cooldowns["acct-a"]?.unspecifiedCount, 2)
    })

    it("quadruples the third and never jitters below the base", () => {
      isolateRotationFile()
      markRateLimited("acct-a", 60_000, "unspecified-429", NOW)
      markRateLimited("acct-a", 60_000, "unspecified-429", NOW + 1)
      const until = markRateLimited(
        "acct-a",
        60_000,
        "unspecified-429",
        NOW + 2,
        () => 0.999999,
      )
      assert.ok(
        until >= NOW + 2 + 239_000,
        `expected ~240s, got ${until - NOW}`,
      )

      // A minimum-jitter roll on the second bench must still land at the
      // base, never below it.
      isolateRotationFile()
      markRateLimited("acct-a", 60_000, "unspecified-429", NOW)
      const floor = markRateLimited(
        "acct-a",
        60_000,
        "unspecified-429",
        NOW + 1,
        () => 0,
      )
      assert.ok(floor >= NOW + 1 + 60_000)
    })

    it("caps escalation at the configured ceiling", () => {
      isolateRotationFile()
      process.env.OPENCODE_CLAUDE_AUTH_ROTATE_MAX_COOLDOWN_MS = "90000"
      try {
        markRateLimited("acct-a", 60_000, "unspecified-429", NOW)
        markRateLimited("acct-a", 60_000, "unspecified-429", NOW + 1)
        const until = markRateLimited(
          "acct-a",
          60_000,
          "unspecified-429",
          NOW + 2,
          () => 0.999999,
        )
        assert.equal(until, NOW + 2 + 90_000)
      } finally {
        delete process.env.OPENCODE_CLAUDE_AUTH_ROTATE_MAX_COOLDOWN_MS
      }
    })

    it("escalates an explained-but-timeless usage limit too", () => {
      isolateRotationFile()
      markRateLimited("acct-a", 60_000, "usage-limit-body", NOW)
      const until = markRateLimited(
        "acct-a",
        60_000,
        "usage-limit-body",
        NOW + 1,
        () => 0.999999,
      )
      assert.ok(until >= NOW + 1 + 119_000)
    })

    it("resets the streak once an authoritative reset arrives", () => {
      isolateRotationFile()
      markRateLimited("acct-a", 60_000, "unspecified-429", NOW)
      markRateLimited("acct-a", 3_600_000, "retry-after", NOW + 1)
      // The authoritative entry carries no streak…
      assert.equal(
        readRotationState().cooldowns["acct-a"]?.unspecifiedCount,
        undefined,
      )
      // …so the next unexplained bench starts at the base again.
      markRateLimited("acct-a", 60_000, "unspecified-429", NOW + 3_700_000)
      assert.equal(readRotationState().cooldowns["acct-a"]?.unspecifiedCount, 1)
    })

    it("never shortens a longer authoritative bench, even escalated", () => {
      isolateRotationFile()
      markRateLimited("acct-a", 3_600_000, "retry-after", NOW)
      const until = markRateLimited(
        "acct-a",
        60_000,
        "unspecified-429",
        NOW + 1,
        () => 0.999999,
      )
      assert.equal(until, NOW + 3_600_000)
      assert.equal(
        readRotationState().cooldowns["acct-a"]?.reason,
        "retry-after",
      )
    })
  })
})

// ---------------------------------------------------------------------------
// Integration harness: copied source tree, mocked keychain, fake clock
// ---------------------------------------------------------------------------

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
  "token-store.ts",
  "rotation.ts",
] as const

async function copySourceFiles(tempDir: string): Promise<void> {
  await Promise.all(
    SOURCE_FILES.map(async (file) => {
      let source = await readFile(new URL(`./${file}`, import.meta.url), "utf8")
      source = source.replace(
        /from\s+["']\.\/([\w-]+)\.js["']/g,
        'from "./$1.ts"',
      )
      if (file === "credentials.ts") {
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

interface MockAccountDef {
  source: string
  label: string
  token: string
}

type PluginModule = typeof import("./index.ts")

interface FetchCall {
  auth: string
  body: string | undefined
  headers: Headers
}

interface Harness {
  helpersModule: PluginModule
  calls: FetchCall[]
  clock: { nowMs: number; sleeps: number[] }
  setRespond: (fn: (callIndex: number, auth: string) => Response) => void
  callFetch: (opts?: { signal?: AbortSignal }) => Promise<Response>
  rotationStatePath: string
  homeDir: string
  persistedSource: () => string | null
  authJsonAccess: () => string | null
  cleanup: () => void
}

function rateLimited(afterSeconds: number): Response {
  return new Response('{"error":{"type":"rate_limit_error"}}', {
    status: 429,
    headers: { "retry-after": String(afterSeconds) },
  })
}

function bareRateLimited(): Response {
  // An unexplained 429: no reset signal anywhere. The harness runs with
  // OPENCODE_CLAUDE_AUTH_MAX_RETRY_MS=1, so fetchWithRetry returns it
  // immediately instead of sleeping 2s/4s for real.
  return new Response('{"error":{"type":"rate_limit_error"}}', {
    status: 429,
  })
}

function okResponse(): Response {
  return new Response("data: {}\n\n", { status: 200 })
}

async function setupHarness(opts: {
  accounts: MockAccountDef[]
  startMs?: number
  rng?: () => number
  marginMs?: number
  jitterMs?: number
  maxCycles?: number
  maxWaitMs?: number
  sleepImpl?: (
    ms: number,
    signal: AbortSignal | null | undefined,
    clock: { nowMs: number; sleeps: number[] },
  ) => Promise<void>
}): Promise<Harness> {
  const homeDir = mkdtempSync(join(tmpdir(), "opencode-claude-auth-waithome-"))
  const rotationStatePath = join(
    mkdtempSync(join(tmpdir(), "opencode-claude-auth-waitstate-")),
    "rotation.json",
  )
  const tokensPath = join(
    mkdtempSync(join(tmpdir(), "opencode-claude-auth-waitoks-")),
    "tokens.json",
  )

  const originalHome = process.env.HOME
  const originalFetch = globalThis.fetch
  const originalSetInterval = globalThis.setInterval
  const originalDebug = process.env.CLAUDE_AUTH_DEBUG

  process.env.HOME = homeDir
  process.env.OPENCODE_CLAUDE_AUTH_ROTATION_FILE = rotationStatePath
  process.env.OPENCODE_CLAUDE_AUTH_TOKENS_FILE = tokensPath
  delete process.env.OPENCODE_CLAUDE_AUTH_TOKENS
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  delete process.env.OPENCODE_CLAUDE_AUTH_ROTATE
  delete process.env.OPENCODE_CLAUDE_AUTH_ROTATE_WAIT
  delete process.env.OPENCODE_CLAUDE_AUTH_ACCOUNT_ORDER
  delete process.env.OPENCODE_CLAUDE_AUTH_ROTATE_WAIT_MAX_CYCLES
  delete process.env.OPENCODE_CLAUDE_AUTH_ROTATE_WAIT_MAX_MS
  delete process.env.OPENCODE_CLAUDE_AUTH_ROTATE_WAIT_MARGIN_MS
  delete process.env.OPENCODE_CLAUDE_AUTH_ROTATE_WAIT_JITTER_MS
  delete process.env.CLAUDE_AUTH_DEBUG
  // fetchWithRetry must return every scripted 429 on the first attempt —
  // otherwise short retry-afters and bare 429s trigger its real 2s/4s sleeps
  // and re-fetch three times per scripted slot, breaking the call counts.
  process.env.OPENCODE_CLAUDE_AUTH_MAX_RETRY_MS = "1"
  if (opts.marginMs !== undefined) {
    process.env.OPENCODE_CLAUDE_AUTH_ROTATE_WAIT_MARGIN_MS = String(
      opts.marginMs,
    )
  }
  if (opts.jitterMs !== undefined) {
    process.env.OPENCODE_CLAUDE_AUTH_ROTATE_WAIT_JITTER_MS = String(
      opts.jitterMs,
    )
  }
  if (opts.maxCycles !== undefined) {
    process.env.OPENCODE_CLAUDE_AUTH_ROTATE_WAIT_MAX_CYCLES = String(
      opts.maxCycles,
    )
  }
  if (opts.maxWaitMs !== undefined) {
    process.env.OPENCODE_CLAUDE_AUTH_ROTATE_WAIT_MAX_MS = String(opts.maxWaitMs)
  }

  globalThis.setInterval = (() => ({
    unref() {},
  })) as unknown as typeof setInterval

  const calls: FetchCall[] = []
  let respond: (callIndex: number, auth: string) => Response = () =>
    okResponse()
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    const auth = headers.get("authorization") ?? ""
    calls.push({
      auth,
      body: typeof init?.body === "string" ? init.body : undefined,
      headers,
    })
    return respond(calls.length - 1, auth)
  }) as typeof fetch

  const tempDir = await mkdtemp(join(tmpdir(), "opencode-claude-auth-waitsrc-"))
  await copySourceFiles(tempDir)
  await writeFile(
    join(tempDir, "keychain.ts"),
    `import { isTokenSource, readStaticCredentials, readTokenAccounts } from "./token-store.ts"

const farFuture = Date.now() + 10 * 60 * 60 * 1000
const defs = ${JSON.stringify(opts.accounts)}

function credsOf(token) {
  return { accessToken: token, refreshToken: "rt-" + token, expiresAt: farFuture }
}

export const PRIMARY_SERVICE = "Claude Code-credentials"

export function isStaticCredential(creds) {
  return creds.kind === "static"
}

export function isCredentialUsable(creds, now = Date.now(), thresholdMs = 60_000) {
  if (isStaticCredential(creds)) return true
  return creds.expiresAt > now + thresholdMs
}

export function readAllClaudeAccounts() {
  return [
    ...defs.map((a) => ({ label: a.label, source: a.source, credentials: credsOf(a.token) })),
    ...readTokenAccounts(),
  ]
}

export function refreshAccount(source) {
  if (isTokenSource(source)) return readStaticCredentials(source)
  const a = defs.find((x) => x.source === source)
  return a ? credsOf(a.token) : null
}

export function writeBackCredentials() { return true }
export function buildAccountLabels(creds) { return creds.map((_, i) => \`Account \${i + 1}\`) }
`,
    "utf8",
  )

  const helpersModule = (await import(
    pathToFileURL(join(tempDir, "index.ts")).href
  )) as PluginModule

  const clock = {
    nowMs: opts.startMs ?? NOW,
    sleeps: [] as number[],
  }
  helpersModule.__setRotationWaitDepsForTests({
    now: () => clock.nowMs,
    sleep: opts.sleepImpl
      ? (ms, signal) => opts.sleepImpl!(ms, signal, clock)
      : async (ms: number) => {
          clock.sleeps.push(ms)
          clock.nowMs += ms
        },
    rng: opts.rng ?? (() => 0),
  })

  async function callFetch(callOpts?: {
    signal?: AbortSignal
  }): Promise<Response> {
    const plugin = await helpersModule.default({} as never)
    const typedPlugin = plugin as {
      auth?: {
        loader?: (
          getAuth: () => Promise<{
            type: string
            refresh: string
            access: string
            expires: number
          }>,
          provider: { models: Record<string, never> },
        ) => Promise<{ fetch: typeof fetch }>
      }
    }
    const authConfig = await typedPlugin.auth!.loader!(
      async () => ({
        type: "oauth",
        refresh: "refresh",
        access: "access",
        expires: Date.now() + 10 * 60 * 60 * 1000,
      }),
      { models: {} },
    )
    return authConfig.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "claude-haiku-4-5", messages: [] }),
      ...(callOpts?.signal ? { signal: callOpts.signal } : {}),
    })
  }

  function persistedSource(): string | null {
    try {
      const raw = readFileSync(
        join(
          homeDir,
          ".local",
          "share",
          "opencode",
          "claude-account-source.txt",
        ),
        "utf-8",
      )
      return raw.trim() || null
    } catch {
      return null
    }
  }

  function authJsonAccess(): string | null {
    try {
      const raw = JSON.parse(
        readFileSync(
          join(homeDir, ".local", "share", "opencode", "auth.json"),
          "utf-8",
        ),
      ) as { anthropic?: { access?: string } }
      return raw.anthropic?.access ?? null
    } catch {
      return null
    }
  }

  function cleanup(): void {
    helpersModule.__setRotationWaitDepsForTests(null)
    globalThis.setInterval = originalSetInterval
    globalThis.fetch = originalFetch
    if (typeof originalHome === "string") {
      process.env.HOME = originalHome
    } else {
      delete process.env.HOME
    }
    if (typeof originalDebug === "string") {
      process.env.CLAUDE_AUTH_DEBUG = originalDebug
    } else {
      delete process.env.CLAUDE_AUTH_DEBUG
    }
    delete process.env.OPENCODE_CLAUDE_AUTH_ROTATION_FILE
    delete process.env.OPENCODE_CLAUDE_AUTH_TOKENS_FILE
    delete process.env.OPENCODE_CLAUDE_AUTH_ROTATE_WAIT_MARGIN_MS
    delete process.env.OPENCODE_CLAUDE_AUTH_ROTATE_WAIT_JITTER_MS
    delete process.env.OPENCODE_CLAUDE_AUTH_ROTATE_WAIT_MAX_CYCLES
    delete process.env.OPENCODE_CLAUDE_AUTH_ROTATE_WAIT_MAX_MS
    delete process.env.OPENCODE_CLAUDE_AUTH_MAX_RETRY_MS
    rmSync(tempDir, { recursive: true, force: true })
  }

  return {
    helpersModule,
    calls,
    clock,
    setRespond: (fn) => {
      respond = fn
    },
    callFetch,
    rotationStatePath,
    homeDir,
    persistedSource,
    authJsonAccess,
    cleanup,
  }
}

const accountA = { source: "acct-a", label: "Account A", token: "token-a" }
const accountB = { source: "acct-b", label: "Account B", token: "token-b" }
const accountC = { source: "acct-c", label: "Account C", token: "token-c" }

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("quota wait — integration", () => {
  it("fails over A -> B when only A is limited, replaying the identical request", async () => {
    const h = await setupHarness({ accounts: [accountA, accountB] })
    try {
      h.setRespond((_i, auth) =>
        auth === "Bearer token-a" ? rateLimited(60) : okResponse(),
      )

      const response = await h.callFetch()

      assert.equal(response.status, 200)
      assert.equal(h.calls.length, 2)
      assert.equal(h.calls[0]?.auth, "Bearer token-a")
      assert.equal(h.calls[1]?.auth, "Bearer token-b")
      // One logical request: identical transformed bodies, no sleeps.
      assert.equal(h.calls[0]?.body, h.calls[1]?.body)
      assert.equal(h.clock.sleeps.length, 0)
      assert.equal(h.persistedSource(), "acct-b")
      assert.equal(h.authJsonAccess(), "token-b")
    } finally {
      h.cleanup()
    }
  })

  it("waits for B first when both are exhausted and B resets sooner, then succeeds", async () => {
    const h = await setupHarness({ accounts: [accountA, accountB] })
    try {
      // A resets in 60s, B in 45s. Both above fetchWithRetry's 30s cap so no
      // real sleeping happens inside it.
      h.setRespond((_i, auth) => {
        if (auth === "Bearer token-a") return rateLimited(60)
        if (auth === "Bearer token-b" && h.clock.sleeps.length === 0) {
          return rateLimited(45)
        }
        return okResponse()
      })

      const response = await h.callFetch()

      assert.equal(response.status, 200)
      // A 429 -> B 429 -> (wait) -> B retried -> 200.
      assert.equal(h.calls.length, 3)
      assert.equal(h.calls[2]?.auth, "Bearer token-b")
      // Exactly one sleep, until B's reset + the safety margin (rng pinned).
      assert.equal(h.clock.sleeps.length, 1)
      assert.equal(h.clock.sleeps[0], 45_000 + 1_000)
      // Same logical request throughout.
      assert.equal(h.calls[0]?.body, h.calls[1]?.body)
      assert.equal(h.calls[1]?.body, h.calls[2]?.body)
      // The post-wake success cleared B's persisted bench.
      const state = readRotationState()
      assert.equal(state.cooldowns["acct-b"], undefined)
      assert.ok(state.cooldowns["acct-a"])
    } finally {
      h.cleanup()
    }
  })

  it("waits for A first when both are exhausted and A resets sooner", async () => {
    const h = await setupHarness({ accounts: [accountA, accountB] })
    try {
      h.setRespond((i, auth) => {
        if (auth === "Bearer token-b") return rateLimited(90)
        // First call goes to A and fails with the sooner reset; after the
        // wake, A serves again.
        return i === 0 ? rateLimited(40) : okResponse()
      })

      const response = await h.callFetch()

      assert.equal(response.status, 200)
      assert.equal(h.calls.length, 3)
      assert.equal(h.calls[0]?.auth, "Bearer token-a")
      assert.equal(h.calls[1]?.auth, "Bearer token-b")
      assert.equal(h.calls[2]?.auth, "Bearer token-a")
      assert.deepEqual(h.clock.sleeps, [40_000 + 1_000])
    } finally {
      h.cleanup()
    }
  })

  it("walks a three-account chain without ever waiting", async () => {
    const h = await setupHarness({
      accounts: [accountA, accountB, accountC],
    })
    try {
      h.setRespond((_i, auth) => {
        if (auth === "Bearer token-c") return okResponse()
        return rateLimited(120)
      })

      const response = await h.callFetch()

      assert.equal(response.status, 200)
      assert.deepEqual(
        h.calls.map((c) => c.auth),
        ["Bearer token-a", "Bearer token-b", "Bearer token-c"],
      )
      assert.equal(h.clock.sleeps.length, 0)
      assert.equal(h.persistedSource(), "acct-c")
    } finally {
      h.cleanup()
    }
  })

  it("waits for the earliest of three exhausted accounts", async () => {
    const h = await setupHarness({
      accounts: [accountA, accountB, accountC],
    })
    try {
      h.setRespond((_i, auth) => {
        if (h.clock.sleeps.length > 0) return okResponse()
        if (auth === "Bearer token-a") return rateLimited(120)
        if (auth === "Bearer token-b") return rateLimited(45)
        return rateLimited(60)
      })

      const response = await h.callFetch()

      assert.equal(response.status, 200)
      assert.equal(h.calls.length, 4)
      assert.equal(h.calls[3]?.auth, "Bearer token-b")
      assert.deepEqual(h.clock.sleeps, [45_000 + 1_000])
    } finally {
      h.cleanup()
    }
  })

  it("serves a single-account setup through its own reset window", async () => {
    const h = await setupHarness({ accounts: [accountA] })
    try {
      h.setRespond((i) => (i === 0 ? rateLimited(31) : okResponse()))

      const response = await h.callFetch()

      assert.equal(response.status, 200)
      assert.equal(h.calls.length, 2)
      assert.ok(
        h.calls.every((c) => c.auth === "Bearer token-a"),
        "no other account may appear",
      )
      assert.deepEqual(h.clock.sleeps, [31_000 + 1_000])
    } finally {
      h.cleanup()
    }
  })

  it("keeps using the healthy rotation target on later requests and never switches back on schedule", async () => {
    // Request 1: A is limited, B takes over.
    const h1 = await setupHarness({ accounts: [accountA, accountB] })
    const home = h1.homeDir
    const statePath = h1.rotationStatePath
    try {
      h1.setRespond((_i, auth) =>
        auth === "Bearer token-a" ? rateLimited(120) : okResponse(),
      )
      const r1 = await h1.callFetch()
      assert.equal(r1.status, 200)
      assert.equal(h1.persistedSource(), "acct-b")
    } finally {
      h1.cleanup()
    }

    // Request 2, "new process": same HOME and state file, fresh module.
    const h2 = await setupHarness({
      accounts: [accountA, accountB],
      startMs: h1.clock.nowMs,
    })
    // Redirect this harness at the first one's HOME/state to model a restart
    // with shared on-disk state.
    process.env.HOME = home
    process.env.OPENCODE_CLAUDE_AUTH_ROTATION_FILE = statePath
    try {
      h2.setRespond((_i, auth) =>
        auth === "Bearer token-b" ? okResponse() : rateLimited(120),
      )
      const r2 = await h2.callFetch()
      assert.equal(r2.status, 200)
      assert.equal(
        h2.calls[0]?.auth,
        "Bearer token-b",
        "the healthy account stays sticky across restarts",
      )
      assert.equal(h2.calls.length, 1, "no probe of the benched account")
    } finally {
      h2.cleanup()
    }
  })

  it("re-evaluates after waking instead of trusting the planned account", async () => {
    const h = await setupHarness({ accounts: [accountA, accountB] })
    try {
      // A resets +60, B +45. At the +45 wake B fails again (reset pushes to
      // +300); the wait must then fall to A's window instead of spinning on B.
      h.setRespond((_i, auth) => {
        if (auth === "Bearer token-a" && h.calls.length === 1) {
          return rateLimited(60)
        }
        if (auth === "Bearer token-b") {
          return h.calls.length <= 2 ? rateLimited(45) : rateLimited(300)
        }
        return okResponse()
      })

      const response = await h.callFetch()

      assert.equal(response.status, 200)
      assert.deepEqual(
        h.calls.map((c) => c.auth),
        [
          "Bearer token-a",
          "Bearer token-b",
          "Bearer token-b",
          "Bearer token-a",
        ],
      )
      // First wait until B's +45 reset (+margin), the second recomputed
      // against A's +60 bench after B failed again at the wake.
      assert.deepEqual(h.clock.sleeps, [45_000 + 1_000, 15_000])
    } finally {
      h.cleanup()
    }
  })

  it("backs off with escalating bounded waits when no account reports a reset", async () => {
    const h = await setupHarness({ accounts: [accountA] })
    try {
      h.setRespond((i) => (i < 3 ? bareRateLimited() : okResponse()))

      const response = await h.callFetch()

      assert.equal(response.status, 200)
      assert.equal(h.calls.length, 4)
      assert.equal(h.clock.sleeps.length, 3)
      // Unexplained 429s carry no reset info, so the benches come from the
      // default and its escalation (60s, up to 120s, up to 240s). Later waits
      // are jittered, so assert the bands and that no wait ever collapses
      // — a metronome back to zero would be a busy loop.
      const [w1, w2, w3] = h.clock.sleeps
      assert.equal(w1, 61_000)
      assert.ok(w2 !== undefined && w2 >= 61_000 && w2 <= 121_000)
      assert.ok(w3 !== undefined && w3 >= 121_000 && w3 <= 241_000)
    } finally {
      h.cleanup()
    }
  })

  it("prefers an earlier unknown bench and an earlier known reset alike (earliest credible wins)", async () => {
    // Scenario 1: A unknown (default 60s), B known in 300s -> wake at ~60s on A.
    const h1 = await setupHarness({ accounts: [accountA, accountB] })
    try {
      h1.setRespond((i, auth) => {
        if (i === 0 && auth === "Bearer token-a") return bareRateLimited()
        if (auth === "Bearer token-b") return rateLimited(300)
        return okResponse()
      })
      const r1 = await h1.callFetch()
      assert.equal(r1.status, 200)
      assert.equal(h1.calls[2]?.auth, "Bearer token-a")
      assert.equal(h1.clock.sleeps.length, 1)
      assert.ok(
        h1.clock.sleeps[0] !== undefined && h1.clock.sleeps[0] < 300_000,
        "the sooner unknown bench governs the first wake",
      )
    } finally {
      h1.cleanup()
    }

    // Scenario 2: A known in 45s, B unknown (default 60s) -> wake at ~45s on A.
    const h2 = await setupHarness({ accounts: [accountA, accountB] })
    try {
      h2.setRespond((i, auth) => {
        if (i === 0 && auth === "Bearer token-a") return rateLimited(45)
        if (auth === "Bearer token-b") return bareRateLimited()
        return okResponse()
      })
      const r2 = await h2.callFetch()
      assert.equal(r2.status, 200)
      assert.equal(h2.calls[2]?.auth, "Bearer token-a")
      assert.deepEqual(h2.clock.sleeps, [45_000 + 1_000])
    } finally {
      h2.cleanup()
    }
  })

  it("stops waiting promptly when the request is aborted", async () => {
    const h = await setupHarness({
      accounts: [accountA],
      sleepImpl: (ms, signal, clock) => {
        clock.sleeps.push(ms)
        // Park until the caller aborts; time deliberately does NOT advance.
        return new Promise<void>((resolve) => {
          if (signal?.aborted) {
            resolve()
            return
          }
          signal?.addEventListener("abort", () => resolve(), { once: true })
        })
      },
    })
    try {
      h.setRespond(() => rateLimited(300))
      const controller = new AbortController()

      const pending = h.callFetch({ signal: controller.signal })
      // Let the request reach the wait.
      for (let i = 0; i < 100 && h.clock.sleeps.length === 0; i++) {
        await new Promise((resolve) => setImmediate(resolve))
      }
      assert.equal(h.clock.sleeps.length, 1, "the wait must be in progress")

      const start = Date.now()
      controller.abort()
      const response = await pending

      assert.ok(Date.now() - start < 5_000, "abort must resolve promptly")
      assert.equal(response.status, 429, "the held limit response surfaces")
      assert.equal(h.calls.length, 1, "no request fires after the abort")
    } finally {
      h.cleanup()
    }
  })

  it("never benches an account over a 401 or an OAuth-refresh rate-limit", async () => {
    const h = await setupHarness({ accounts: [accountA, accountB] })
    try {
      const realFetch = globalThis.fetch
      h.setRespond(() => okResponse())
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : String(input)
        if (url.includes("/oauth/token")) {
          // A rate-limited refresh endpoint is a refresh problem…
          return new Response('{"error":"rate_limited"}', {
            status: 429,
            headers: { "retry-after": "3600" },
          })
        }
        return new Response('{"error":"expired"}', { status: 401 })
      }) as typeof fetch

      const response = await h.callFetch()

      // …never a quota problem: the account must carry no rotation bench,
      // and the 401 handling stays exactly as upstream shipped it.
      assert.equal(response.status, 401)
      assert.deepEqual(readRotationState().cooldowns, {})
      globalThis.fetch = realFetch
    } finally {
      h.cleanup()
    }
  })

  it("honours benches persisted by a previous process, then waits for the earliest", async () => {
    const h = await setupHarness({ accounts: [accountA, accountB] })
    try {
      // A previous "process" (this file's rotation.ts over the same state
      // path) benched A for 120s and B for 45s before the plugin even loaded.
      markRateLimited("acct-a", 120_000, "retry-after", h.clock.nowMs)
      markRateLimited("acct-b", 45_000, "retry-after", h.clock.nowMs)

      h.setRespond((_i, auth) => {
        if (h.clock.sleeps.length > 0 && auth === "Bearer token-b") {
          return okResponse()
        }
        return rateLimited(300)
      })

      const response = await h.callFetch()

      assert.equal(response.status, 200)
      // The startup pick lands on one account (both benched), its 429
      // refreshes its bench, nothing else is pickable, so the plugin waits
      // for B — the earliest persisted bench — and then B serves.
      assert.equal(h.clock.sleeps.length, 1)
      assert.ok(
        (h.clock.sleeps[0] ?? 0) <= 45_000 + 2_000,
        `must not wait A's 120s window, saw ${h.clock.sleeps[0]}`,
      )
      assert.equal(h.calls[h.calls.length - 1]?.auth, "Bearer token-b")
    } finally {
      h.cleanup()
    }
  })

  it("terminates after the configured cycle budget instead of looping forever", async () => {
    const h = await setupHarness({
      accounts: [accountA, accountB],
      maxCycles: 3,
    })
    try {
      h.setRespond(() => bareRateLimited())

      const start = h.clock.nowMs
      const response = await h.callFetch()

      assert.equal(response.status, 429, "the budget expiry surfaces the limit")
      assert.equal(h.clock.sleeps.length, 3, "bounded sleeps, no loop")
      // Each sleep is one full remaining bench window plus margin — short
      // residuals are legitimate when benches are staggered, but a sleep must
      // never be shorter than the margin, i.e. never a busy retry.
      assert.deepEqual(
        h.clock.sleeps.map((s) => s >= 1_000),
        [true, true, true],
        `every sleep is a real wait, never a spin: ${JSON.stringify(h.clock.sleeps)}`,
      )
      // Per cycle: at most the initial call plus switches-and-wake retries.
      assert.ok(
        h.calls.length <= 1 + 3 * 3,
        `bounded API calls, saw ${h.calls.length}`,
      )
      assert.ok(h.clock.nowMs > start, "time only ever moves forward")
    } finally {
      h.cleanup()
    }
  })

  it("stays bounded even when the clock lies (frozen time, capped cycles)", async () => {
    const h = await setupHarness({
      accounts: [accountA],
      maxCycles: 2,
      sleepImpl: (ms, _signal, clock) => {
        clock.sleeps.push(ms)
        // Resolve instantly without advancing time — pathological, but the
        // cycle budget must still terminate the loop.
        return Promise.resolve()
      },
    })
    try {
      h.setRespond(() => bareRateLimited())

      const response = await h.callFetch()

      assert.equal(response.status, 429)
      assert.equal(h.clock.sleeps.length, 2)
      assert.ok(h.calls.length <= 6)
    } finally {
      h.cleanup()
    }
  })

  it("logs the wait without ever leaking token material", async () => {
    const logPath = join(
      mkdtempSync(join(tmpdir(), "opencode-claude-auth-waitlog-")),
      "debug.log",
    )
    const h = await setupHarness({
      accounts: [
        accountA,
        {
          source: "acct-b",
          label: "Account B",
          token: "sk-ant-oat01-TESTSECRETf6f7ba12",
        },
      ],
    })
    try {
      process.env.CLAUDE_AUTH_DEBUG = logPath
      // Both accounts 429 once (so the wait actually engages, with B's token
      // on the wire for the second call), then the wake succeeds.
      h.setRespond((i) => {
        if (i === 0) return rateLimited(45)
        if (i === 1) return rateLimited(60)
        return okResponse()
      })

      const response = await h.callFetch()
      assert.equal(response.status, 200)

      const content = readFileSync(logPath, "utf-8")
      assert.ok(content.includes("rotation_wait_start"), "wait is logged")
      assert.ok(
        !content.includes("sk-ant-oat01-TESTSECRET"),
        "static tokens never reach the log",
      )
      assert.ok(
        !content.includes("Bearer token-b"),
        "authorization headers never reach the log",
      )
      assert.ok(
        !content.includes('"token-b"'),
        "account tokens never reach the log",
      )
    } finally {
      h.cleanup()
    }
  })
})
