/** Regression and fan-out tests using isolated stores and the real token loader. */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { describe, it, type TestContext } from "node:test"
import {
  clearCooldown,
  markRateLimited,
  readRotationState,
  readWaitAttempts,
} from "./rotation.ts"

const NOW = 1_800_000_000_000
const account = (label: string) => {
  const token = `mock-quota-test-${label}`
  const id = createHash("sha256").update(token).digest("hex").slice(0, 8)
  return { id, source: `token:${id}`, label, token }
}
const A = account("A")
const B = account("B")
const C = account("C")
type Account = ReturnType<typeof account>
const limited = (seconds?: number) =>
  new Response(JSON.stringify({ error: { type: "rate_limit_error" } }), {
    status: 429,
    headers: seconds === undefined ? {} : { "retry-after": String(seconds) },
  })
const ok = () => new Response("data: {}\n\n", { status: 200 })
const tick = (ms = 2) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function eventually(predicate: () => boolean, description: string) {
  const deadline = Date.now() + 3_000
  while (!predicate() && Date.now() < deadline) await tick()
  assert.ok(predicate(), description)
}

type Call = { auth: string; body: string; at: number }
type Clock = { nowMs: number; sleeps: number[] }
type PluginModule = typeof import("./index.ts")

async function fixture(
  t: TestContext,
  opts: {
    accounts?: Account[]
    progressMs?: number
    realTime?: boolean
    maxCycles?: number
    maxWaitMs?: number
    rng?: () => number
    sleep?: (
      ms: number,
      signal: AbortSignal | null | undefined,
      clock: Clock,
    ) => Promise<void>
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "claude-quota-stress-"))
  const savedEnv = { ...process.env }
  const originalFetch = globalThis.fetch
  const originalInterval = globalThis.setInterval
  const intervals: ReturnType<typeof setInterval>[] = []
  const controllers: AbortController[] = []
  const pending: Promise<Response>[] = []
  const paths = {
    tokens: join(root, "tokens.json"),
    rotation: join(root, "rotation.json"),
    waits: join(root, "waits"),
    log: join(root, "debug.log"),
  }
  const clock: Clock = { nowMs: NOW, sleeps: [] }
  const now = () => (opts.realTime ? Date.now() : clock.nowMs)
  let moduleCount = 0
  let sleepCount = 0
  let mod: PluginModule | undefined
  t.after(async () => {
    for (const controller of controllers) controller.abort()
    await Promise.allSettled(pending)
    for (const interval of intervals) clearInterval(interval)
    mod?.__setRotationWaitDepsForTests(null)
    globalThis.setInterval = originalInterval
    globalThis.fetch = originalFetch
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key]
    }
    Object.assign(process.env, savedEnv)
    rmSync(root, { recursive: true, force: true })
  })

  for (const key of Object.keys(process.env)) {
    if (key.startsWith("OPENCODE_CLAUDE_AUTH_") || key.startsWith("CLAUDE_"))
      delete process.env[key]
  }
  Object.assign(process.env, {
    HOME: root,
    CLAUDE_CONFIG_DIR: join(root, ".claude"),
    CLAUDE_AUTH_DEBUG: paths.log,
    OPENCODE_CLAUDE_AUTH_TOKENS_FILE: paths.tokens,
    OPENCODE_CLAUDE_AUTH_ROTATION_FILE: paths.rotation,
    OPENCODE_CLAUDE_AUTH_WAIT_DIR: paths.waits,
    OPENCODE_CLAUDE_AUTH_MAX_RETRY_MS: "1",
    OPENCODE_CLAUDE_AUTH_ROTATE_WAIT_PROGRESS_MS: String(
      opts.progressMs ?? 1_000,
    ),
    OPENCODE_CLAUDE_AUTH_ROTATE_WAIT_MAX_CYCLES: String(opts.maxCycles ?? 0),
    OPENCODE_CLAUDE_AUTH_ROTATE_WAIT_MAX_MS: String(opts.maxWaitMs ?? 0),
  })
  const roster = (accounts: Account[]) => {
    writeFileSync(
      `${paths.tokens}.new`,
      JSON.stringify({ version: 1, accounts }),
      { mode: 0o600 },
    )
    renameSync(`${paths.tokens}.new`, paths.tokens)
  }
  roster(opts.accounts ?? [A, B])
  const calls: Call[] = []
  let respond: (call: Call, index: number) => Response | Promise<Response> = ok
  globalThis.fetch = (async (_url, init) => {
    const call = {
      auth: new Headers(init?.headers).get("authorization") ?? "",
      body: String(init?.body ?? ""),
      at: now(),
    }
    calls.push(call)
    return respond(call, calls.length - 1)
  }) as typeof fetch
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const timer = originalInterval(...args)
    intervals.push(timer)
    return timer
  }) as typeof setInterval

  const load = async () => {
    const src = join(root, `module-${moduleCount++}`)
    mkdirSync(src)
    const original = new URL("./", import.meta.url)
    for (const name of readdirSync(original)) {
      if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue
      let text = readFileSync(new URL(name, original), "utf8")
      // Guard against CLI/keychain access even on platforms other than Linux.
      text = text.replaceAll(
        'from "node:child_process"',
        'from "./child-process.ts"',
      )
      writeFileSync(join(src, name), text)
    }
    cpSync(
      new URL("anthropic-prompt.txt", original),
      join(src, "anthropic-prompt.txt"),
    )
    writeFileSync(
      join(src, "child-process.ts"),
      'export function execSync() { throw new Error("CLI disabled in quota tests") }\nexport const execFileSync = execSync\n',
    )
    mod = (await import(
      pathToFileURL(join(src, "index.ts")).href
    )) as PluginModule
    mod.__setRotationWaitDepsForTests(
      opts.realTime
        ? { rng: opts.rng ?? (() => 0) }
        : {
            now,
            rng: opts.rng ?? (() => 0),
            sleep: async (ms, signal) => {
              assert.ok(
                ++sleepCount <= 2_000,
                "test exceeded its bounded sleep count",
              )
              clock.sleeps.push(ms)
              if (opts.sleep) await opts.sleep(ms, signal, clock)
              else clock.nowMs += ms
            },
          },
    )
    const plugin = await mod.default({} as never)
    const auth = (await plugin.auth!.loader!(
      async () => ({
        type: "oauth",
        access: "mock-access",
        refresh: "mock-refresh",
        expires: Date.now() + 60_000,
      }),
      { models: {} } as never,
    )) as { fetch: typeof fetch }
    return auth.fetch
  }
  let sendFetch = await load()
  return {
    paths,
    calls,
    clock,
    now,
    roster,
    respond: (fn: typeof respond) => {
      respond = fn
    },
    restart: async () => {
      sendFetch = await load()
    },
    send: (signal?: AbortSignal, text = "quota stress request") => {
      const controller = new AbortController()
      controllers.push(controller)
      const combined = AbortSignal.any([
        controller.signal,
        t.signal,
        AbortSignal.timeout(8_000),
        ...(signal ? [signal] : []),
      ])
      const request = sendFetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: combined,
        body: JSON.stringify({
          model: "claude-haiku-4-5",
          messages: [{ role: "user", content: text }],
        }),
      })
      pending.push(request)
      void request.catch(() => {}) // attach immediately, including concurrent abort tests
      return request
    },
  }
}

describe(
  "quota stress and boundary regressions",
  { concurrency: false, timeout: 15_000 },
  () => {
    it("preserves reset margin, fixed jitter and one cycle across hundreds of ticks", async (t) => {
      const deadlines = new Set<number>()
      const cycles = new Set<number>()
      let rolls = 0
      const h = await fixture(t, {
        accounts: [A],
        progressMs: 100,
        maxCycles: 1,
        rng: () => {
          rolls++
          return 0.5
        },
        sleep: async (ms, _signal, clock) => {
          const wait = readWaitAttempts()[0]!.active
          deadlines.add(wait.until)
          cycles.add(wait.cycle)
          clock.nowMs += ms
        },
      })
      h.respond((_call, i) => (i === 0 ? limited(45) : ok()))
      assert.equal((await h.send()).status, 200)
      assert.equal(h.calls[1]!.at - NOW, 47_000)
      assert.deepEqual([...deadlines], [NOW + 47_000])
      assert.deepEqual([...cycles], [1])
      assert.equal(rolls, 1)
      assert.equal(readWaitAttempts().length, 0)
    })

    it("enforces total wait budget across ticks without exhausting it repeatedly", async (t) => {
      const h = await fixture(t, {
        accounts: [A],
        progressMs: 1_000,
        maxWaitMs: 2_500,
      })
      h.respond(() => limited(300))
      assert.equal((await h.send()).status, 429)
      assert.deepEqual(h.clock.sleeps, [1_000, 1_000, 500])
      assert.equal(h.calls.length, 1)
      assert.equal(readWaitAttempts().length, 0)
    })

    for (const progressMs of [0, 1_000]) {
      it(`replans immediately after a sibling clears a cooldown (progress=${progressMs})`, async (t) => {
        const h = await fixture(t, {
          progressMs,
          sleep: async (_ms, _signal, clock) => {
            clock.nowMs += 100
            clearCooldown(B.source, clock.nowMs)
          },
        })
        h.respond((_call, i) => (i < 2 ? limited(150) : ok()))
        assert.equal((await h.send()).status, 200)
        assert.deepEqual(
          h.calls.map((c) => c.auth),
          [A, B, B].map((a) => `Bearer ${a.token}`),
        )
        assert.equal(h.clock.nowMs - NOW, 100)
        assert.equal(h.clock.sleeps.length, 1)
      })
    }

    it("discovers an atomically added token during a live filesystem-watched wait", async (t) => {
      const h = await fixture(t, {
        accounts: [A],
        realTime: true,
        progressMs: 60_000,
      })
      h.respond((call) =>
        call.auth === `Bearer ${A.token}` ? limited(300) : ok(),
      )
      const request = h.send()
      await eventually(() => readWaitAttempts().length === 1, "request parked")
      const changedAt = Date.now()
      h.roster([A, B])
      assert.equal((await request).status, 200)
      assert.ok(
        Date.now() - changedAt < 2_000,
        "file notification must beat the 60s progress tick",
      )
      assert.deepEqual(
        h.calls.map((c) => c.auth),
        [A, B].map((a) => `Bearer ${a.token}`),
      )
      assert.equal(readWaitAttempts().length, 0)
    })

    it("recomputes the winner after a sibling extends the earliest cooldown", async (t) => {
      let extended = false
      const h = await fixture(t, {
        sleep: async (ms, _signal, clock) => {
          clock.nowMs += ms
          if (!extended) {
            extended = true
            markRateLimited(B.source, 300_000, "retry-after", clock.nowMs)
          }
        },
      })
      h.respond((_call, i) =>
        i === 0 ? limited(60) : i === 1 ? limited(30) : ok(),
      )
      assert.equal((await h.send()).status, 200)
      assert.equal(h.calls[2]!.auth, `Bearer ${A.token}`)
      assert.equal(h.calls[2]!.at, NOW + 61_000)
    })

    it("does not resurrect an account removed while waiting for its cooldown", async (t) => {
      let removed = false
      const h = await fixture(t, {
        sleep: async (ms, _signal, clock) => {
          clock.nowMs += ms
          if (!removed) {
            removed = true
            h.roster([A])
          }
        },
      })
      h.respond((_call, i) =>
        i === 0 ? limited(60) : i === 1 ? limited(30) : ok(),
      )
      assert.equal((await h.send()).status, 200)
      assert.equal(h.calls[2]!.auth, `Bearer ${A.token}`)
      assert.ok(h.calls[2]!.at >= NOW + 61_000)
    })

    for (const preflight of [false, true]) {
      it(`defers a synthetic header timeout using the earliest cooldown (preflight=${preflight})`, async (t) => {
        const controller = new AbortController()
        const h = await fixture(t, {
          sleep: async (_ms, _signal, clock) => {
            clock.nowMs += 5_000
            controller.abort(
              Object.assign(new Error("response header timeout"), {
                name: "HeaderTimeoutError",
              }),
            )
          },
        })
        if (preflight) {
          markRateLimited(A.source, 600_000, "retry-after", h.now())
          markRateLimited(B.source, 360_000, "retry-after", h.now())
        }
        h.respond((_call, i) => limited(i === 0 ? 600 : 360))
        const response = await h.send(controller.signal)
        assert.equal(response.status, 429)
        assert.equal(response.headers.get("retry-after"), "355")
        assert.match(await response.text(), /Claude quota/)
        assert.equal(h.calls.length, preflight ? 0 : 2)
        assert.equal(readWaitAttempts().length, 0)
      })
    }

    for (const reason of [
      undefined,
      new Error("user stop"),
      new DOMException("deadline", "TimeoutError"),
    ]) {
      it(`propagates caller cancellation without a deferred response (${reason?.name ?? "AbortError"})`, async (t) => {
        const controller = new AbortController()
        const h = await fixture(t, {
          accounts: [A],
          sleep: async () => {
            controller.abort(reason)
          },
        })
        h.respond(() => limited(300))
        await assert.rejects(
          h.send(controller.signal),
          (error) => error === controller.signal.reason,
        )
        assert.equal(h.calls.length, 1)
        assert.equal(readWaitAttempts().length, 0)
      })
    }

    it("rejects an already-aborted Request signal before credentials or HTTP", async (t) => {
      const h = await fixture(t)
      const controller = new AbortController()
      controller.abort()
      await assert.rejects(h.send(controller.signal), { name: "AbortError" })
      assert.equal(h.calls.length, 0)
    })

    it("walks eight accounts without the legacy three-switch limit and preserves the request", async (t) => {
      const accounts = Array.from({ length: 8 }, (_, i) => account(String(i)))
      const h = await fixture(t, { accounts })
      h.respond((_call, i) => (i < 7 ? limited(300) : ok()))
      assert.equal((await h.send()).status, 200)
      assert.deepEqual(
        h.calls.map((c) => c.auth),
        accounts.map((a) => `Bearer ${a.token}`),
      )
      assert.equal(new Set(h.calls.map((c) => c.body)).size, 1)
      assert.deepEqual(h.clock.sleeps, [])
    })

    it("honors explicit priority order when several accounts become eligible", async (t) => {
      const h = await fixture(t, { accounts: [A, B, C] })
      process.env.OPENCODE_CLAUDE_AUTH_ACCOUNT_ORDER = `${C.source},${B.source}`
      markRateLimited(A.source, 300_000, "retry-after", h.now())
      assert.equal((await h.send()).status, 200)
      assert.equal(h.calls[0]!.auth, `Bearer ${C.token}`)
    })

    it("keeps persisted cooldowns and the healthy selection after a fresh module load", async (t) => {
      const h = await fixture(t)
      h.respond((call) =>
        call.auth === `Bearer ${A.token}` ? limited(300) : ok(),
      )
      assert.equal((await h.send()).status, 200)
      const until = readRotationState().cooldowns[A.source]!.until
      await h.restart()
      assert.equal((await h.send()).status, 200)
      assert.equal(h.calls.length, 3)
      assert.equal(h.calls[2]!.auth, `Bearer ${B.token}`)
      assert.equal(readRotationState().cooldowns[A.source]!.until, until)
    })

    it("escalates unknown-reset cooldowns within their jitter bands and clears the streak on success", async (t) => {
      const entries = new Map<number, { at: number; until: number }>()
      const h = await fixture(t, {
        accounts: [A],
        progressMs: 30_000,
        sleep: async (ms, _signal, clock) => {
          const entry = readRotationState().cooldowns[A.source]!
          entries.set(entry.unspecifiedCount!, entry)
          clock.nowMs += ms
        },
      })
      h.respond((_call, i) => (i < 3 ? limited() : ok()))
      assert.equal((await h.send()).status, 200)
      assert.deepEqual([...entries.keys()], [1, 2, 3])
      for (const [count, lower, upper] of [
        [1, 60_000, 60_000],
        [2, 60_000, 120_000],
        [3, 120_000, 240_000],
      ]) {
        const entry = entries.get(count!)!
        assert.ok(
          entry.until - entry.at >= lower! && entry.until - entry.at <= upper!,
        )
        assert.ok(
          h.calls[count!]!.at >= entry.until + 1_000,
          "every wake includes the reset margin",
        )
      }
      assert.deepEqual(readRotationState().cooldowns, {})
    })

    it("isolates 32 concurrent waits: aborting half leaves the other half able to resume", async (t) => {
      const h = await fixture(t, { realTime: true, progressMs: 60_000 })
      markRateLimited(A.source, 300_000, "retry-after", h.now())
      markRateLimited(B.source, 600_000, "retry-after", h.now())
      const controllers = Array.from(
        { length: 32 },
        () => new AbortController(),
      )
      const requests = controllers.map((c, i) =>
        h.send(c.signal, `request-${i}`),
      )
      await eventually(
        () => readWaitAttempts().length === 32,
        "all 32 waits published",
      )
      assert.equal(new Set(readWaitAttempts().map((w) => w.id)).size, 32)
      assert.equal(h.calls.length, 0, "no requests against benched accounts")
      for (const c of controllers.slice(0, 16)) c.abort()
      const canceled = await Promise.allSettled(requests.slice(0, 16))
      assert.ok(
        canceled.every(
          (r) => r.status === "rejected" && r.reason.name === "AbortError",
        ),
      )
      assert.equal(readWaitAttempts().length, 16)
      clearCooldown(B.source)
      const results = await Promise.all(requests.slice(16))
      assert.ok(results.every((r) => r.status === 200))
      assert.equal(h.calls.length, 16)
      assert.ok(h.calls.every((call) => call.auth === `Bearer ${B.token}`))
      assert.equal(new Set(h.calls.map((call) => call.body)).size, 16)
      assert.equal(readWaitAttempts().length, 0)
      const log = readFileSync(h.paths.log, "utf8")
      assert.ok(
        !log.includes(A.token) && !log.includes(B.token),
        "mock secrets are redacted in diagnostics",
      )
    })
  },
)
