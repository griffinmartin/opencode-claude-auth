#!/usr/bin/env node
// Read-only quota countdown. Token-store records are used only for ID/label;
// token values are never printed or sent to the status endpoint.
import { readFileSync, readdirSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"

const dataDir = join(
  process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
  "opencode",
)
const rotationPath =
  process.env.OPENCODE_CLAUDE_AUTH_ROTATION_FILE ??
  join(dataDir, "claude-auth-rotation.json")
const tokenPath =
  process.env.OPENCODE_CLAUDE_AUTH_TOKENS_FILE ??
  join(dataDir, "claude-auth-tokens.json")
const waitDir =
  process.env.OPENCODE_CLAUDE_AUTH_WAIT_DIR ??
  join(dirname(rotationPath), "claude-auth-waits")
const activePath = join(dataDir, "claude-account-source.txt")
const rawProgress = Number(
  process.env.OPENCODE_CLAUDE_AUTH_ROTATE_WAIT_PROGRESS_MS,
)
const progressMs =
  Number.isFinite(rawProgress) && rawProgress > 0 ? rawProgress : 60_000
const staleMs = Math.max(90_000, 2 * progressMs + 30_000)

function read(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return fallback
  }
}

export function countdown(ms) {
  if (ms <= 0) return "eligible now"
  const seconds = Math.ceil(ms / 1000)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = seconds % 60
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(rest).padStart(2, "0")}`
}

function waits() {
  try {
    return readdirSync(waitDir)
      .filter((name) => /^[0-9a-f-]+\.json$/.test(name))
      .flatMap((name) => {
        const state = read(join(waitDir, name), null)
        return state?.version === 1 &&
          Number.isFinite(state?.active?.updatedAt) &&
          Number.isFinite(state?.active?.until)
          ? [state.active]
          : []
      })
  } catch {
    return []
  }
}

export function formatSessionStatus(snapshot, now = Date.now(), timeZone) {
  if (snapshot.error)
    return "Session status unavailable; retry schedule cannot be confirmed."
  if (!snapshot.status)
    return "Session is not reported as busy/retrying by OpenCode."
  const status = snapshot.status
  if (status.type === "retry") {
    if (!Number.isFinite(status.next)) {
      return `OpenCode retry #${status.attempt ?? "?"}: no retry time supplied by server.`
    }
    const at = new Date(status.next).toLocaleString("en-GB", {
      timeZone,
      timeZoneName: "short",
      hour12: false,
    })
    const remaining = status.next - now
    return `OpenCode retry #${status.attempt ?? "?"}: ${remaining > 0 ? countdown(remaining) : "due now; awaiting server update"}\nNext scheduled attempt: ${at}`
  }
  return status.type === "busy"
    ? "OpenCode: busy (request/tool work or plugin wait may be in progress)."
    : `OpenCode: ${status.type === "idle" ? "idle" : "unrecognised status"}.`
}

export async function loadSessionStatus(server, sessionId, directory) {
  const url = new URL("/session/status", server)
  if (directory) url.searchParams.set("directory", directory)
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) })
    if (!response.ok) return { error: true }
    const statuses = await response.json()
    if (!statuses || typeof statuses !== "object" || Array.isArray(statuses))
      return { error: true }
    return { status: statuses[sessionId] ?? null }
  } catch {
    return { error: true }
  }
}

function display(session, timeZone) {
  const now = Date.now()
  const tokens = read(tokenPath, { accounts: [] }).accounts ?? []
  const labels = new Map(
    tokens.map((entry) => [
      `token:${entry.id}`,
      entry.label ?? `token:${entry.id}`,
    ]),
  )
  const cooldowns = read(rotationPath, { cooldowns: {} }).cooldowns ?? {}
  let active = null
  try {
    active = readFileSync(activePath, "utf8").trim()
  } catch {
    /* no active source */
  }
  const sources = new Set([...labels.keys(), ...Object.keys(cooldowns)])
  if (active) sources.add(active)
  const lines = [
    `Claude quota · ${new Date(now).toLocaleString("en-GB", { timeZone, timeZoneName: "short" })}`,
  ]
  if (session) lines.push(formatSessionStatus(session, now, timeZone), "")
  lines.push("* = persisted account preference (running sessions may differ)")
  if (sources.size === 0)
    lines.push("No Claude accounts found in this state directory.")
  for (const source of sources) {
    const end = cooldowns[source]?.until ?? 0
    lines.push(
      `${source === active ? "*" : " "} ${labels.get(source) ?? source}: ${countdown(end - now)}`,
    )
  }
  const pending = waits()
  if (pending.length === 0) {
    lines.push(
      "No plugin-held wait published. OpenCode can still be backing off between requests; see session status above (or use --server and --session).",
    )
  } else {
    lines.push(
      `${pending.length} in-flight quota wait${pending.length === 1 ? "" : "s"}:`,
    )
    for (const item of pending.sort((a, b) => a.until - b.until)) {
      const stale = now - item.updatedAt > staleMs
      lines.push(
        `  ${item.plannedLabel ?? item.plannedSource}: ${stale ? "STALE (request may have ended)" : countdown(item.until - now)} · cycle ${item.cycle}`,
      )
    }
  }
  if (
    session?.status?.type === "retry" &&
    Number.isFinite(session.status.next)
  ) {
    const eligible = [...sources].some(
      (source) => !cooldowns[source] || cooldowns[source].until <= now,
    )
    const deadlines = [...sources]
      .map((source) => cooldowns[source]?.until)
      .filter(Number.isFinite)
    const earliest = eligible ? now : Math.min(...deadlines)
    if (earliest < session.status.next) {
      lines.push(
        "Account eligibility is earlier than the scheduled retry. This viewer does not reschedule the session.",
      )
    }
  }
  return lines.join("\n")
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes("--help")) {
    process.stdout.write(
      "Usage: quota-watch [--watch] [--server http://127.0.0.1:PORT --session SESSION_ID [--directory PATH]] [--time-zone Europe/Prague]\nRead-only: local countdown every second, server status refreshed every 15 seconds. No Anthropic calls.\n",
    )
    return
  }
  const flags = new Set(["--server", "--session", "--directory", "--time-zone"])
  const options = {}
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]
    if (flag === "--watch") continue
    if (
      !flags.has(flag) ||
      !args[index + 1] ||
      args[index + 1].startsWith("--")
    ) {
      throw new Error("Invalid arguments; use --help.")
    }
    options[flag] = args[++index]
  }
  if (Boolean(options["--server"]) !== Boolean(options["--session"])) {
    throw new Error("--server and --session must be specified together.")
  }
  const timeZone = options["--time-zone"]
  new Intl.DateTimeFormat("en-GB", { timeZone }).format()
  let snapshot = null
  let pending = false
  let stopped = false
  const refresh = async () => {
    if (!options["--server"] || pending || stopped) return
    pending = true
    try {
      snapshot = await loadSessionStatus(
        options["--server"],
        options["--session"],
        options["--directory"],
      )
    } finally {
      pending = false
    }
  }
  await refresh()
  const watch = args.includes("--watch")
  const paint = () => {
    if (watch && process.stdout.isTTY) process.stdout.write("\x1b[H\x1b[J")
    process.stdout.write(display(snapshot, timeZone) + "\n")
  }
  paint()
  if (watch) {
    const renderTimer = setInterval(paint, 1000)
    const statusTimer = options["--server"]
      ? setInterval(() => {
          void refresh()
        }, 15_000)
      : null
    const stop = () => {
      stopped = true
      clearInterval(renderTimer)
      if (statusTimer) clearInterval(statusTimer)
      process.removeListener("SIGINT", stop)
      process.removeListener("SIGTERM", stop)
    }
    process.on("SIGINT", stop)
    process.on("SIGTERM", stop)
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  main().catch(() => {
    process.stderr.write(
      "Unable to start quota-watch. Check --help, server URL and time zone.\n",
    )
    process.exitCode = 1
  })
}
