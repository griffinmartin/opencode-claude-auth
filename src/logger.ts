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

function redactValue(key: string, value: unknown): unknown {
  if (
    /^(access[_-]?token|refresh[_-]?token|authorization|proxy-authorization|x-api-key|api[_-]?key|cookie|set-cookie|client[_-]?secret|password)$/i.test(
      key,
    )
  ) {
    return "REDACTED"
  }

  if (Array.isArray(value)) return value.map((item) => redactValue("", item))
  if (value && typeof value === "object")
    return redact(value as Record<string, unknown>)
  if (typeof value !== "string") return value

  if (JWT_PATTERN.test(value)) {
    return `${value.slice(0, 8)}...REDACTED`
  }

  return value
    .replace(/\bBearer\s+[^\s,"']+/gi, "Bearer REDACTED")
    .replace(/\bsk-ant-[A-Za-z0-9_-]+/gi, "REDACTED")
}

export function redact(data: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    result[key] = redactValue(key, value)
  }
  return result
}
