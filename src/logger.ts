import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import type { Writable } from "node:stream"

const JWT_PATTERN = /^eyJ[A-Za-z0-9_-]{10,}/

type LogMode = "disabled" | "file" | "stream"

let mode: LogMode = "disabled"
let logFilePath: string | null = null
let logStream: Writable | null = null

function getDefaultLogPath(): string {
  return join(homedir(), ".local", "share", "opencode", "claude-auth-debug.log")
}

export function initLogger(options?: { stream?: Writable }): void {
  closeLogger()

  if (options?.stream) {
    mode = "stream"
    logStream = options.stream
    return
  }

  const envVal = process.env.CLAUDE_AUTH_DEBUG
  if (!envVal) {
    mode = "disabled"
    return
  }

  mode = "file"
  logFilePath = envVal === "1" ? getDefaultLogPath() : envVal

  const dir = dirname(logFilePath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(logFilePath, "", "utf-8")
}

export function log(event: string, data?: Record<string, unknown>): void {
  if (mode === "disabled") return

  const entry = {
    ts: new Date().toISOString(),
    event,
    ...redact(data ?? {}),
  }
  const line = JSON.stringify(entry) + "\n"

  if (mode === "file" && logFilePath) {
    appendFileSync(logFilePath, line, "utf-8")
  } else if (mode === "stream" && logStream) {
    logStream.write(line)
  }
}

export function closeLogger(): void {
  mode = "disabled"
  logFilePath = null
  logStream = null
}

const REDACTED_KEYS = new Set([
  "refreshToken",
  "x-api-key",
  "accessToken",
  // Pasted long-lived tokens (src/token-store.ts) travel under these names.
  "token",
  "tokens",
  "authorization",
])

// Claude Code OAuth tokens (`sk-ant-oat…`) and API keys (`sk-ant-api…`) are not
// JWT-shaped, so the pattern above cannot catch them. They must be matched by
// value too: a pasted token logged under an unanticipated key would otherwise
// land in a file users are explicitly told is safe to attach to an issue.
const ANTHROPIC_SECRET_PATTERN = /^sk-ant-[A-Za-z0-9_-]+/

function redactValue(key: string, value: unknown): unknown {
  if (typeof value !== "string") return value

  if (REDACTED_KEYS.has(key)) {
    return "REDACTED"
  }

  if (ANTHROPIC_SECRET_PATTERN.test(value)) {
    // Keep the tail: it is what the account picker shows, so a log line stays
    // matchable to an account without carrying a usable secret.
    return `sk-ant-...REDACTED...${value.slice(-6)}`
  }

  if (JWT_PATTERN.test(value)) {
    return `${value.slice(0, 8)}...REDACTED`
  }

  return value
}

export function redact(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    result[key] = redactValue(key, value)
  }
  return result
}
