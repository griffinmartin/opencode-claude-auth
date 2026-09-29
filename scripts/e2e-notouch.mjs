#!/usr/bin/env node
/** Real OpenCode + loopback API, isolated HOME/config/cache/credentials.
 * Build first. Run with --scenario long|concurrent|deadline|stop.
 * long holds a turn past 300s; deadline exercises OpenCode's native retry;
 * concurrent completes six sessions; stop cancels one of two parked sessions.
 */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join, resolve as resolvePath } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const scenario = process.argv[process.argv.indexOf("--scenario") + 1] ?? "long"
const mode = process.argv.includes("--scenario") ? scenario : "long"
assert.ok(
  ["long", "concurrent", "deadline", "stop"].includes(mode),
  "unknown scenario",
)
const pluginDir = resolvePath(
  process.env.PLUGIN_DIR ?? join(dirname(fileURLToPath(import.meta.url)), ".."),
)
const binary = process.env.OPENCODE_BIN ?? "opencode"
const root = mkdtempSync(join(tmpdir(), "claude-quota-e2e-"))
const configDir = join(root, ".config/opencode")
const dataDir = join(root, ".local/share/opencode")
const waitDir = join(root, "waits")
const rotationPath = join(root, "rotation.json")
const debugPath = join(root, "debug.log")
const start = Date.now()
const say = (message) =>
  console.log(
    `[${mode} +${((Date.now() - start) / 1000).toFixed(1)}s] ${message}`,
  )
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sessions = []
const hits = []
let server
let serverExit
let serverLog = ""
let fatal
let failed = false
let bReady = false
let bResetAt
let api
const sessionCount = mode === "concurrent" ? 6 : mode === "stop" ? 2 : 1
const resetSeconds = mode === "long" ? 310 : mode === "stop" ? 600 : 8
const limitAt = start + (mode === "long" ? 480_000 : 150_000)
const tokens = ["A", "B"].map((label) => {
  const token = `mock-e2e-quota-${label}`
  return {
    label,
    token,
    id: createHash("sha256").update(token).digest("hex").slice(0, 8),
  }
})
const files = () =>
  existsSync(waitDir)
    ? readdirSync(waitDir).filter((n) => n.endsWith(".json"))
    : []
const events = () =>
  existsSync(debugPath)
    ? readFileSync(debugPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((s) => JSON.parse(s))
    : []
const atomicJSON = (path, value) => {
  writeFileSync(`${path}.new`, JSON.stringify(value), { mode: 0o600 })
  renameSync(`${path}.new`, path)
}
async function until(predicate, description) {
  while (Date.now() < limitAt) {
    if (fatal) throw fatal
    if (await predicate()) return
    await sleep(100)
  }
  throw new Error(`timed out: ${description}`)
}
const sse = (marker) =>
  [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: `msg_${marker}`,
          type: "message",
          role: "assistant",
          content: [],
          model: "claude-haiku-4-5",
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 3, output_tokens: 1 },
        },
      },
    ],
    [
      "content_block_start",
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
    ],
    [
      "content_block_delta",
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: `ok ${marker}` },
      },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    [
      "message_delta",
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn", stop_sequence: null },
        usage: { output_tokens: 2 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  ]
    .map(
      ([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
    )
    .join("")

const stub = createServer((req, res) => {
  let body = ""
  req.on("data", (chunk) => {
    body += chunk
  })
  req.on("end", () => {
    const token = tokens.find(
      (t) => req.headers.authorization === `Bearer ${t.token}`,
    )
    const marker = body.match(/E2E-\d+/)?.[0]
    if (!token || !marker || !req.url.startsWith("/v1/messages")) {
      fatal = new Error(
        `unexpected stub request: ${req.method} ${req.url}, marker=${marker}, account=${token?.label}`,
      )
      res.writeHead(400).end("unexpected request")
      return
    }
    if (token.label === "B" && bResetAt === undefined)
      bResetAt = Date.now() + resetSeconds * 1000
    const ready = token.label === "B" && (bReady || Date.now() >= bResetAt)
    const hit = {
      at: Date.now(),
      account: token.label,
      marker,
      status: ready ? 200 : 429,
    }
    hits.push(hit)
    if (!ready) {
      const retry =
        token.label === "A"
          ? 600
          : Math.max(1, Math.ceil((bResetAt - Date.now()) / 1000))
      res.writeHead(429, {
        "content-type": "application/json",
        "retry-after": String(retry),
      })
      res.end(
        JSON.stringify({
          type: "error",
          error: { type: "rate_limit_error", message: "mock quota exhausted" },
        }),
      )
    } else {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.end(sse(marker))
    }
  })
})

try {
  for (const dir of [configDir, dataDir, waitDir])
    mkdirSync(dir, { recursive: true })
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve))
  const origin = `http://127.0.0.1:${stub.address().port}`
  const plugin = join(root, "plugin")
  mkdirSync(plugin)
  cpSync(join(pluginDir, "dist"), join(plugin, "dist"), { recursive: true })
  cpSync(
    join(pluginDir, "opencode-claude-auth.js"),
    join(plugin, "opencode-claude-auth.js"),
  )
  const hash = createHash("sha256")
  for (const name of readdirSync(join(pluginDir, "dist"))
    .filter((n) => n.endsWith(".js"))
    .sort()) {
    hash.update(name).update(readFileSync(join(pluginDir, "dist", name)))
  }
  const artifact = hash.digest("hex")
  const index = join(plugin, "dist/index.js")
  const source = readFileSync(index, "utf8")
  assert.ok(
    source.includes("https://api.anthropic.com/v1"),
    "expected endpoint to redirect",
  )
  writeFileSync(
    index,
    source.replaceAll("https://api.anthropic.com/v1", `${origin}/v1`),
  )
  // Assert the actual network boundary too: a misrouted plugin request fails
  // locally rather than reaching Anthropic, OAuth, or another external host.
  const http = join(plugin, "dist/http.js")
  writeFileSync(
    http,
    `const sandboxFetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== ${JSON.stringify(origin)}) throw new Error("E2E blocked external plugin request");
      return fetch(input, init);
    };\n` +
      readFileSync(http, "utf8").replaceAll(
        "fetchImpl = fetch,",
        "fetchImpl = sandboxFetch,",
      ),
  )
  atomicJSON(join(root, "tokens.json"), { version: 1, accounts: tokens })
  atomicJSON(join(configDir, "opencode.json"), {
    $schema: "https://opencode.ai/config.json",
    plugin: [pathToFileURL(join(plugin, "opencode-claude-auth.js")).href],
    autoupdate: false,
    snapshot: false,
    share: "disabled",
    enabled_providers: ["anthropic"],
    agent: { title: { disable: true }, summary: { disable: true } },
    provider: {
      anthropic: {
        options: {
          headerTimeout: mode === "deadline" ? 1_500 : false,
          timeout: false,
        },
      },
    },
    model: "anthropic/claude-haiku-4-5",
  })
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    XDG_CONFIG_HOME: join(root, ".config"),
    XDG_DATA_HOME: join(root, ".local/share"),
    XDG_CACHE_HOME: join(root, ".cache"),
    XDG_STATE_HOME: join(root, ".local/state"),
    CLAUDE_CONFIG_DIR: join(root, ".claude"),
    CLAUDE_AUTH_DEBUG: debugPath,
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
    OPENCODE_CLAUDE_AUTH_TOKENS_FILE: join(root, "tokens.json"),
    OPENCODE_CLAUDE_AUTH_ROTATION_FILE: rotationPath,
    OPENCODE_CLAUDE_AUTH_WAIT_DIR: waitDir,
    OPENCODE_CLAUDE_AUTH_ROTATE_WAIT_PROGRESS_MS: "1000",
  }
  server = spawn(binary, ["serve", "--port", "0", "--hostname", "127.0.0.1"], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  })
  serverExit = new Promise((resolve) => {
    server.on("exit", (code, signal) => {
      fatal ??= new Error(`sandbox server exited: ${code}/${signal}`)
      resolve()
    })
    server.on("error", (error) => {
      fatal = error
      resolve()
    })
  })
  for (const stream of [server.stdout, server.stderr])
    stream.on("data", (chunk) => {
      serverLog = (serverLog + chunk).slice(-40_000)
    })
  await until(() => /127\.0\.0\.1:\d+/.test(serverLog), "server listening")
  api = `http://127.0.0.1:${serverLog.match(/127\.0\.0\.1:(\d+)/)[1]}`
  const json = async (path, init) => {
    const response = await fetch(`${api}${path}`, {
      ...init,
      signal: AbortSignal.timeout(60_000),
    })
    assert.ok(response.ok, `sandbox HTTP ${response.status}: ${path}`)
    return response.json()
  }
  say(`built artifact ${artifact}; starting ${sessionCount} session(s)`)
  for (let i = 0; i < sessionCount; i++) {
    const session = await json("/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: `quota ${mode} ${i}` }),
    })
    const marker = `E2E-${i}`
    sessions.push({ id: session.id, marker })
    // Session completion is verified through persisted messages: a long-lived
    // POST connection can time out independently of the running turn.
    void fetch(`${api}/session/${session.id}/message`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: { providerID: "anthropic", modelID: "claude-haiku-4-5" },
        parts: [{ type: "text", text: `Reply ok ${marker}` }],
      }),
      signal: AbortSignal.timeout(mode === "long" ? 400_000 : 80_000),
    })
      .then((response) => response.text())
      .catch(() => {})
  }
  await until(
    () => files().length >= sessionCount,
    "all sessions parked in quota waits",
  )
  say(`${files().length} independent wait publications observed`)
  let canceledId
  if (mode === "stop") {
    canceledId = sessions[0].id
    await json(`/session/${canceledId}/abort`, { method: "POST" })
    await until(() => files().length === 1, "only the survivor's wait remains")
    bReady = true
    const state = JSON.parse(readFileSync(rotationPath, "utf8"))
    delete state.cooldowns[`token:${tokens[1].id}`]
    atomicJSON(rotationPath, state)
    say("one session stopped; sibling cooldown cleared atomically")
  }
  const expected = sessions.filter((s) => s.id !== canceledId)
  const completed = new Set()
  await until(async () => {
    for (const session of expected) {
      if (completed.has(session.id)) continue
      const messages = await json(`/session/${session.id}/message?limit=20`)
      const answer = messages.find(
        (m) =>
          m.info.role === "assistant" &&
          m.info.time?.completed &&
          m.parts.some(
            (p) => p.type === "text" && p.text.includes(`ok ${session.marker}`),
          ),
      )
      if (answer) {
        assert.equal(
          answer.info.error,
          undefined,
          "turn must complete without an error",
        )
        completed.add(session.id)
      }
    }
    return completed.size === expected.length
  }, "assistant completion for every surviving session")
  await until(() => files().length === 0, "all wait publications removed")
  const successes = hits.filter((hit) => hit.status === 200)
  assert.equal(successes.length, expected.length)
  assert.ok(successes.every((hit) => hit.account === "B"))
  if (mode !== "stop")
    assert.ok(
      successes.every((hit) => hit.at >= bResetAt),
      "never retry before the reset",
    )
  assert.ok(
    hits.length <= sessionCount * 3 + 3,
    `unexpected request storm: ${hits.length}`,
  )
  if (mode === "long")
    assert.ok(
      successes[0].at - hits[0].at > 300_000,
      "must cross the actual 300s boundary",
    )
  const trace = events()
  if (mode === "deadline")
    assert.ok(
      trace.some((e) => e.event === "rotation_deferred_retry"),
      "native header timeout must exercise deferred retry",
    )
  if (mode === "stop") {
    assert.ok(
      !successes.some((hit) => hit.marker === sessions[0].marker),
      "stopped turn must not resume",
    )
    assert.ok(trace.some((e) => e.event === "rotation_wait_aborted"))
  }
  const debug = readFileSync(debugPath, "utf8")
  assert.ok(
    tokens.every((token) => !debug.includes(token.token)),
    "debug log must redact tokens",
  )
  say(
    `PASS: ${completed.size} completed, ${hits.length} stub requests, no residual waits`,
  )
  console.log(
    JSON.stringify({
      mode,
      artifact,
      completed: completed.size,
      hits: hits.map((h) => ({
        account: h.account,
        marker: h.marker,
        status: h.status,
        at: h.at - start,
      })),
      elapsedMs: Date.now() - start,
    }),
  )
} catch (error) {
  failed = true
  process.exitCode = 1
  console.error(error)
  console.error(serverLog.slice(-8_000))
  if (existsSync(debugPath))
    console.error(readFileSync(debugPath, "utf8").slice(-8_000))
  console.error(`Sandbox artifacts: ${root}`)
} finally {
  if (server && server.exitCode === null && server.signalCode === null) {
    server.kill("SIGTERM")
    await Promise.race([serverExit, sleep(2_000)])
    if (server.exitCode === null && server.signalCode === null)
      server.kill("SIGKILL")
    await serverExit
  }
  stub.closeAllConnections()
  if (stub.listening) {
    const closed = once(stub, "close")
    stub.close()
    await closed
  }
  if (!failed) rmSync(root, { recursive: true, force: true })
}
