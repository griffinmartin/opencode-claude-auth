/**
 * Headless end-to-end test for the credential refresh flows.
 *
 * Runs real `opencode run` invocations against the locally built plugin with
 * a sandboxed fake keychain (PATH shims for `security` and `claude`) and
 * asserts on the structured debug log the plugin writes.
 *
 * Scenarios:
 *   1. Happy path — fresh primary credentials, no refresh expected.
 *   2. Expired primary — OAuth refresh fails (bogus refresh token), CLI shim
 *      "refreshes" the primary entry, request succeeds.
 *   3. Bug 1 — active account is a stale *suffixed* keychain entry; the CLI
 *      shim writes fresh credentials to the primary entry only (replicating
 *      the real Claude CLI behaviour), and the plugin must fall back to the
 *      primary entry.
 *
 * Safety:
 *   - The real keychain is only ever *read* (once, to obtain a valid access
 *     token so the final API call returns 200).
 *   - The real refresh token is never placed in a stale entry, so the OAuth
 *     refresh path fails at the real endpoint with a 4xx and nothing is
 *     rotated.
 *   - User state (`claude-account-source.txt`) is backed up and restored.
 *
 * Requires: macOS, `opencode` on PATH, valid Claude Code credentials.
 * Run with: pnpm test:headless
 */
import { execFileSync, spawnSync } from "node:child_process"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { keychainSuffixForDir } from "../dist/keychain.js"

const PRIMARY_SERVICE = "Claude Code-credentials"
const MODEL = "anthropic/claude-haiku-4-5"
const SENTINEL = "HEADLESSOK"
const PROMPT = `Reply with exactly the word: ${SENTINEL}`
const RUN_TIMEOUT_MS = 180_000
const STALE_EXPIRES_AT = 1_000_000_000_000 // 2001, definitively stale

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const accountSourcePath = join(
  homedir(),
  ".local",
  "share",
  "opencode",
  "claude-account-source.txt",
)

interface LogEvent {
  event: string
  [key: string]: unknown
}

interface ExpectedEvent {
  event: string
  fields?: Record<string, unknown>
}

function fail(msg: string): never {
  console.error(`\n✗ ${msg}`)
  process.exit(1)
}

// --- preflight -------------------------------------------------------------

function preflight(): { realBlob: string } {
  if (process.platform !== "darwin") {
    console.log(
      "test:headless requires macOS (keychain simulation) — skipping.",
    )
    process.exit(0)
  }
  const version = spawnSync("opencode", ["--version"], { encoding: "utf-8" })
  if (version.status !== 0) {
    fail("`opencode` not found on PATH — install it to run this test.")
  }
  let realBlob: string
  try {
    realBlob = execFileSync(
      "/usr/bin/security",
      ["find-generic-password", "-s", PRIMARY_SERVICE, "-w"],
      { encoding: "utf-8", timeout: 5000 },
    ).trim()
  } catch {
    fail(
      `No readable "${PRIMARY_SERVICE}" keychain entry. Log in with the Claude CLI first.`,
    )
  }
  const expiresAt = blobExpiresAt(realBlob)
  if (!expiresAt || expiresAt < Date.now() + 5 * 60_000) {
    fail(
      "Real Claude credentials are missing an expiry or expire within 5 minutes. Run `claude` to refresh them, then retry.",
    )
  }
  return { realBlob }
}

function blobExpiresAt(raw: string): number | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const target = (parsed.claudeAiOauth ?? parsed) as Record<string, unknown>
    return typeof target.expiresAt === "number" ? target.expiresAt : null
  } catch {
    return null
  }
}

// --- sandbox ---------------------------------------------------------------

interface Sandbox {
  root: string
  binDir: string
  stateDir: string
  workDir: string
  xdgDir: string
  fakeConfigDir: string
  suffix: string
  suffixedService: string
}

function createSandbox(): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "claude-auth-headless-"))
  const binDir = join(root, "bin")
  const stateDir = join(root, "state")
  const workDir = join(root, "work")
  const xdgDir = join(root, "xdg")
  mkdirSync(binDir, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  mkdirSync(workDir, { recursive: true })
  mkdirSync(join(xdgDir, "opencode"), { recursive: true })

  // Isolated opencode config: load only the locally built plugin.
  writeFileSync(
    join(xdgDir, "opencode", "opencode.json"),
    JSON.stringify(
      { $schema: "https://opencode.ai/config.json", plugin: [repoRoot] },
      null,
      2,
    ),
  )

  // The suffix-to-dir scan only walks dot-directories directly under $HOME,
  // so the fake config dir must live there. Removed in cleanup.
  const fakeConfigDir = join(homedir(), `.claude-simtest-${process.pid}`)
  mkdirSync(fakeConfigDir, { recursive: true })
  writeFileSync(
    join(fakeConfigDir, ".claude.json"),
    JSON.stringify({ oauthAccount: { emailAddress: "sim@headless.test" } }),
  )
  const suffix = keychainSuffixForDir(fakeConfigDir)
  const suffixedService = `${PRIMARY_SERVICE}-${suffix}`

  // Both shims append to a single shim.log so the interleaved order of
  // keychain reads and CLI refresh invocations is recorded reliably. The
  // plugin's own debug log cannot serve this purpose: the plugin initialises
  // more than once per `opencode run` and each init truncates that log, so
  // early refresh events are racily lost.
  const securityShim = `#!/bin/sh
STATE_DIR="${stateDir}"
printf 'security %s\\n' "$*" >> "$STATE_DIR/shim.log"
if [ "$1" = "dump-keychain" ]; then
  cat "$STATE_DIR/dump.txt" 2>/dev/null || true
  exit 0
fi
if [ "$1" = "find-generic-password" ]; then
  svc=""
  prev=""
  for a in "$@"; do
    [ "$prev" = "-s" ] && svc="$a"
    prev="$a"
  done
  case "$svc" in
    "Claude Code-credentials"*)
      f="$STATE_DIR/$svc.json"
      if [ -f "$f" ]; then
        cat "$f"
        exit 0
      fi
      exit 44
      ;;
  esac
fi
exec /usr/bin/security "$@"
`
  // Replicates the real Claude CLI bug: a refresh triggered for a suffixed
  // account writes the new token to the PRIMARY keychain entry.
  const claudeShim = `#!/bin/sh
STATE_DIR="${stateDir}"
printf 'claude %s CLAUDE_CONFIG_DIR=%s\\n' "$*" "\${CLAUDE_CONFIG_DIR:-}" >> "$STATE_DIR/shim.log"
cp "$STATE_DIR/fresh-primary.json" "$STATE_DIR/Claude Code-credentials.json"
printf 'ok\\n'
exit 0
`
  writeFileSync(join(binDir, "security"), securityShim)
  writeFileSync(join(binDir, "claude"), claudeShim)
  chmodSync(join(binDir, "security"), 0o755)
  chmodSync(join(binDir, "claude"), 0o755)

  return {
    root,
    binDir,
    stateDir,
    workDir,
    xdgDir,
    fakeConfigDir,
    suffix,
    suffixedService,
  }
}

function staleBlob(): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: "sim-stale-access-token",
      refreshToken: "sim-bogus-refresh-token",
      expiresAt: STALE_EXPIRES_AT,
      scopes: ["user:inference"],
      subscriptionType: "pro",
    },
  })
}

function writeDump(sandbox: Sandbox, services: string[]): void {
  const lines = services.map((s) => `    "svce"<blob>="${s}"`).join("\n")
  writeFileSync(
    join(sandbox.stateDir, "dump.txt"),
    `keychain: "login"\n${lines}\n`,
  )
}

function resetState(sandbox: Sandbox): void {
  rmSync(sandbox.stateDir, { recursive: true, force: true })
  mkdirSync(sandbox.stateDir, { recursive: true })
}

// --- account source backup/restore ------------------------------------------

function backupAccountSource(): string | null {
  try {
    return readFileSync(accountSourcePath, "utf-8")
  } catch {
    return null
  }
}

function setAccountSource(source: string | null): void {
  if (source === null) {
    rmSync(accountSourcePath, { force: true })
    return
  }
  mkdirSync(dirname(accountSourcePath), { recursive: true })
  writeFileSync(accountSourcePath, source, "utf-8")
}

// --- runner & assertions -----------------------------------------------------

interface RunResult {
  stdout: string
  stderr: string
  status: number | null
  events: LogEvent[]
  logPath: string
}

function runOpencode(sandbox: Sandbox, scenarioName: string): RunResult {
  const logPath = join(sandbox.root, `${scenarioName}.log`)
  const env = { ...process.env }
  delete env.CLAUDE_CONFIG_DIR
  env.PATH = `${sandbox.binDir}:${env.PATH}`
  env.CLAUDE_AUTH_DEBUG = logPath
  env.XDG_CONFIG_HOME = sandbox.xdgDir

  const result = spawnSync("opencode", ["run", "--model", MODEL, PROMPT], {
    cwd: sandbox.workDir,
    env,
    encoding: "utf-8",
    timeout: RUN_TIMEOUT_MS,
  })

  let events: LogEvent[] = []
  try {
    events = readFileSync(logPath, "utf-8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as LogEvent)
  } catch {
    // missing log handled by assertions
  }
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status,
    events,
    logPath,
  }
}

function matchesFields(
  ev: LogEvent,
  fields?: Record<string, unknown>,
): boolean {
  if (!fields) return true
  return Object.entries(fields).every(([k, v]) => ev[k] === v)
}

function assertEventSubsequence(
  run: RunResult,
  expected: ExpectedEvent[],
): string | null {
  let i = 0
  for (const ev of run.events) {
    const want = expected[i]
    if (!want) break
    if (ev.event === want.event && matchesFields(ev, want.fields)) i++
  }
  if (i >= expected.length) return null
  const want = expected[i]
  return `debug log missing event #${i}: ${want.event}${want.fields ? " " + JSON.stringify(want.fields) : ""}`
}

function readShimLog(sandbox: Sandbox): string[] {
  try {
    return readFileSync(join(sandbox.stateDir, "shim.log"), "utf-8")
      .split("\n")
      .filter((l) => l.length > 0)
  } catch {
    return []
  }
}

/** Ordered subsequence match over shim.log lines using substring predicates. */
function assertShimSubsequence(
  lines: string[],
  expected: string[],
): string | null {
  let i = 0
  for (const line of lines) {
    const want = expected[i]
    if (!want) break
    if (line.includes(want)) i++
  }
  if (i >= expected.length) return null
  return `shim log missing step #${i}: ${JSON.stringify(expected[i])}`
}

const READ_PRIMARY = `find-generic-password -s ${PRIMARY_SERVICE} -w`

interface Scenario {
  name: string
  setup: (sandbox: Sandbox, realBlob: string) => void
  /** Ordered substrings expected in shim.log — append-only ground truth. */
  shimExpected: (sandbox: Sandbox) => string[]
  /** Events asserted on the plugin debug log (late events only; see shims). */
  expected: (sandbox: Sandbox) => ExpectedEvent[]
  extraChecks?: (
    sandbox: Sandbox,
    run: RunResult,
    shimLog: string[],
  ) => string | null
}

const scenarios: Scenario[] = [
  {
    name: "happy-path",
    setup: (sandbox, realBlob) => {
      writeDump(sandbox, [PRIMARY_SERVICE])
      writeFileSync(join(sandbox.stateDir, `${PRIMARY_SERVICE}.json`), realBlob)
      setAccountSource(null)
    },
    shimExpected: () => [READ_PRIMARY],
    expected: () => [
      { event: "plugin_init" },
      { event: "fetch_response", fields: { status: 200 } },
    ],
    extraChecks: (_sandbox, _run, shimLog) => {
      if (shimLog.some((l) => l.startsWith("claude "))) {
        return "CLI refresh was invoked despite fresh credentials"
      }
      return null
    },
  },
  {
    // The CLI shim is only ever invoked by refreshViaCli, which itself only
    // runs after the OAuth refresh attempt fails (bogus refresh token), so
    // its presence in shim.log proves the full expired → refresh flow.
    name: "expired-cli-refresh",
    setup: (sandbox, realBlob) => {
      writeDump(sandbox, [PRIMARY_SERVICE])
      writeFileSync(
        join(sandbox.stateDir, `${PRIMARY_SERVICE}.json`),
        staleBlob(),
      )
      writeFileSync(join(sandbox.stateDir, "fresh-primary.json"), realBlob)
      setAccountSource(null)
    },
    shimExpected: () => [
      READ_PRIMARY, // initial read: stale
      "claude -p", // CLI refresh triggered
      READ_PRIMARY, // post-refresh re-read: fresh
    ],
    expected: () => [
      { event: "plugin_init" },
      { event: "fetch_response", fields: { status: 200 } },
    ],
  },
  {
    name: "bug1-suffixed-fallback",
    setup: (sandbox, realBlob) => {
      writeDump(sandbox, [PRIMARY_SERVICE, sandbox.suffixedService])
      writeFileSync(
        join(sandbox.stateDir, `${PRIMARY_SERVICE}.json`),
        staleBlob(),
      )
      writeFileSync(
        join(sandbox.stateDir, `${sandbox.suffixedService}.json`),
        staleBlob(),
      )
      writeFileSync(join(sandbox.stateDir, "fresh-primary.json"), realBlob)
      setAccountSource(sandbox.suffixedService)
    },
    shimExpected: (sandbox) => [
      `find-generic-password -s ${sandbox.suffixedService} -w`, // initial read: stale
      `claude -p . --model haiku CLAUDE_CONFIG_DIR=${sandbox.fakeConfigDir}`, // CLI refresh, correct config dir threaded through
      `find-generic-password -s ${sandbox.suffixedService} -w`, // re-read suffixed: still stale (CLI wrote to primary)
      READ_PRIMARY, // Bug 1 fix: fall back to the primary entry
    ],
    expected: () => [
      { event: "plugin_init" },
      { event: "fetch_response", fields: { status: 200 } },
    ],
  },
]

// --- cleanup -----------------------------------------------------------------

function cleanup(
  sandbox: Sandbox | null,
  savedAccountSource: string | null,
): void {
  setAccountSource(savedAccountSource)
  if (!sandbox) return
  rmSync(sandbox.fakeConfigDir, { recursive: true, force: true })
  if (process.env.HEADLESS_KEEP) {
    console.log(`HEADLESS_KEEP set — sandbox preserved at ${sandbox.root}`)
  } else {
    rmSync(sandbox.root, { recursive: true, force: true })
  }
  // The tested code paths never write to the real keychain, but if a future
  // regression adds a writeback, it would land on the fake suffixed service
  // name. Detect and remove it.
  const probe = spawnSync(
    "/usr/bin/security",
    ["find-generic-password", "-s", sandbox.suffixedService],
    { encoding: "utf-8" },
  )
  if (probe.status === 0) {
    console.warn(
      `warning: junk keychain entry "${sandbox.suffixedService}" was created during the run — deleting it.`,
    )
    spawnSync("/usr/bin/security", [
      "delete-generic-password",
      "-s",
      sandbox.suffixedService,
    ])
  }
}

// --- main ----------------------------------------------------------------------

function main(): void {
  const { realBlob } = preflight()
  const savedAccountSource = backupAccountSource()
  let sandbox: Sandbox | null = null
  const failures: string[] = []

  try {
    sandbox = createSandbox()
    for (const scenario of scenarios) {
      process.stdout.write(`▶ ${scenario.name} ... `)
      resetState(sandbox)
      scenario.setup(sandbox, realBlob)
      const run = runOpencode(sandbox, scenario.name)

      const shimLog = readShimLog(sandbox)

      // Preserve the shim log for post-mortem before the next scenario
      // resets the state dir.
      writeFileSync(
        join(sandbox.root, `${scenario.name}-shim.log`),
        shimLog.length > 0 ? shimLog.join("\n") + "\n" : "",
      )

      const problems: string[] = []
      const shimError = assertShimSubsequence(
        shimLog,
        scenario.shimExpected(sandbox),
      )
      if (shimError) problems.push(shimError)
      const seqError = assertEventSubsequence(run, scenario.expected(sandbox))
      if (seqError) problems.push(seqError)
      const extraError = scenario.extraChecks?.(sandbox, run, shimLog)
      if (extraError) problems.push(extraError)
      if (!run.stdout.includes(SENTINEL)) {
        problems.push(`stdout did not contain ${SENTINEL}`)
      }

      if (problems.length === 0) {
        console.log("ok")
      } else {
        console.log("FAIL")
        for (const p of problems) console.log(`    ${p}`)
        console.log(`    exit status: ${run.status}`)
        console.log(
          `    stdout tail: ${JSON.stringify(run.stdout.slice(-300))}`,
        )
        console.log(
          `    stderr tail: ${JSON.stringify(run.stderr.slice(-300))}`,
        )
        console.log(
          `    debug events: ${run.events.map((e) => e.event).join(" → ")}`,
        )
        console.log(
          `    shim log:\n${shimLog.map((l) => `      ${l}`).join("\n")}`,
        )
        failures.push(scenario.name)
      }
    }
  } finally {
    cleanup(sandbox, savedAccountSource)
  }

  if (failures.length > 0) {
    fail(
      `${failures.length}/${scenarios.length} scenario(s) failed: ${failures.join(", ")}`,
    )
  }
  console.log(`\n✓ all ${scenarios.length} scenarios passed`)
}

main()
