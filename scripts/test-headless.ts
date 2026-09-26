/**
 * Headless smoke test for a request using fresh Claude Code credentials.
 *
 * Runs a real `opencode run` invocation against the locally built plugin with
 * a sandboxed fake keychain (PATH shims for `security` and `claude`) and
 * asserts on the structured debug log the plugin writes.
 *
 * Safety:
 *   - The real keychain is only ever *read* (once, to obtain a valid access
 *     token so the final API call returns 200).
 *   - No refresh is triggered; this does not test credential recovery.
 *   - User state (`claude-account-source.txt`) is backed up and restored.
 *
 * Requires: macOS, `opencode` V2 on PATH, valid Claude Code credentials.
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

const PRIMARY_SERVICE = "Claude Code-credentials"
const MODEL = "anthropic/claude-haiku-4-5"
const SENTINEL = "HEADLESSOK"
const PROMPT = `Reply with exactly the word: ${SENTINEL}`
const RUN_TIMEOUT_MS = 180_000

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
    fail("`opencode` not found on PATH — install V2 to run this test.")
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
      { $schema: "https://opencode.ai/config.json", plugins: [repoRoot] },
      null,
      2,
    ),
  )

  // Shims record keychain reads and unexpected CLI refresh attempts. The
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
exit 1
`
  const claudeShim = `#!/bin/sh
printf 'claude %s\\n' "$*" >> "${stateDir}/shim.log"
exit 1
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
  }
}

function writeDump(sandbox: Sandbox, services: string[]): void {
  const lines = services.map((s) => `    "svce"<blob>="${s}"`).join("\n")
  writeFileSync(
    join(sandbox.stateDir, "dump.txt"),
    `keychain: "login"\n${lines}\n`,
  )
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

  const result = spawnSync(
    "opencode",
    ["run", "--standalone", "--model", MODEL, PROMPT],
    {
      cwd: sandbox.workDir,
      env,
      encoding: "utf-8",
      timeout: RUN_TIMEOUT_MS,
    },
  )

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
    expected: () => [{ event: "plugin_init" }],
    extraChecks: (_sandbox, _run, shimLog) => {
      if (shimLog.some((l) => l.startsWith("claude "))) {
        return "CLI refresh was invoked despite fresh credentials"
      }
      return null
    },
  },
]

// --- cleanup -----------------------------------------------------------------

function cleanup(
  sandbox: Sandbox | null,
  savedAccountSource: string | null,
): void {
  setAccountSource(savedAccountSource)
  if (!sandbox) return
  if (process.env.HEADLESS_KEEP) {
    console.log(`HEADLESS_KEEP set — sandbox preserved at ${sandbox.root}`)
  } else {
    rmSync(sandbox.root, { recursive: true, force: true })
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
      scenario.setup(sandbox, realBlob)
      const run = runOpencode(sandbox, scenario.name)

      const shimLog = readShimLog(sandbox)

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
      if (run.status !== 0) problems.push(`opencode exited with ${run.status}`)
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
