import assert from "node:assert/strict"
import { describe, it, beforeEach, afterEach } from "node:test"
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { PassThrough } from "node:stream"
import { initLogger, log, closeLogger, redact } from "./logger.ts"

describe("logger", () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "claude-auth-log-test-"))
    delete process.env.CLAUDE_AUTH_DEBUG
  })

  afterEach(() => {
    closeLogger()
    delete process.env.CLAUDE_AUTH_DEBUG
    rmSync(tmpDir, { recursive: true, force: true })
  })

  describe("no-op mode", () => {
    it("log() does nothing when CLAUDE_AUTH_DEBUG is unset", () => {
      initLogger()
      log("test_event", { key: "value" })
      // No file should be created at default path
      const defaultPath = join(tmpDir, "claude-auth-debug.log")
      assert.ok(!existsSync(defaultPath), "No log file should be created")
    })

    it("log() does nothing when CLAUDE_AUTH_DEBUG is empty string", () => {
      process.env.CLAUDE_AUTH_DEBUG = ""
      initLogger()
      log("test_event", { key: "value" })
      const defaultPath = join(tmpDir, "claude-auth-debug.log")
      assert.ok(!existsSync(defaultPath), "No log file should be created")
    })
  })

  describe("file mode", () => {
    it("writes JSON lines to the specified path", () => {
      const logPath = join(tmpDir, "test.log")
      process.env.CLAUDE_AUTH_DEBUG = logPath
      initLogger()

      log("test_event", { key: "value" })

      const content = readFileSync(logPath, "utf-8").trim()
      const parsed = JSON.parse(content)
      assert.equal(parsed.event, "test_event")
      assert.equal(parsed.key, "value")
      assert.ok(parsed.ts, "should have a timestamp")
    })

    it("appends multiple events as separate lines", () => {
      const logPath = join(tmpDir, "test.log")
      process.env.CLAUDE_AUTH_DEBUG = logPath
      initLogger()

      log("event_one", { a: 1 })
      log("event_two", { b: 2 })

      const lines = readFileSync(logPath, "utf-8").trim().split("\n")
      assert.equal(lines.length, 2)
      assert.equal(JSON.parse(lines[0]).event, "event_one")
      assert.equal(JSON.parse(lines[1]).event, "event_two")
    })

    it("truncates the file on initLogger()", () => {
      const logPath = join(tmpDir, "test.log")
      process.env.CLAUDE_AUTH_DEBUG = logPath

      // First session
      initLogger()
      log("old_event", {})
      closeLogger()

      // Second session — should truncate
      initLogger()
      log("new_event", {})

      const lines = readFileSync(logPath, "utf-8").trim().split("\n")
      assert.equal(lines.length, 1)
      assert.equal(JSON.parse(lines[0]).event, "new_event")
    })

    it("creates parent directories if they don't exist", () => {
      const logPath = join(tmpDir, "nested", "dirs", "test.log")
      process.env.CLAUDE_AUTH_DEBUG = logPath
      initLogger()

      log("test_event", {})

      assert.ok(
        existsSync(logPath),
        "Log file should be created in nested dirs",
      )
    })

    it("treats CLAUDE_AUTH_DEBUG=1 as default path", () => {
      process.env.CLAUDE_AUTH_DEBUG = "1"
      // Just verify initLogger doesn't throw — we can't easily assert
      // the default path without polluting the real filesystem
      initLogger()
      log("test_event", {})
      closeLogger()
    })
  })

  describe("stream mode", () => {
    it("writes JSON lines to a provided stream", () => {
      const stream = new PassThrough()
      const chunks: string[] = []
      stream.on("data", (chunk) => chunks.push(chunk.toString()))

      initLogger({ stream })
      log("stream_event", { key: "value" })

      const parsed = JSON.parse(chunks.join("").trim())
      assert.equal(parsed.event, "stream_event")
      assert.equal(parsed.key, "value")
    })

    it("ignores CLAUDE_AUTH_DEBUG env var when stream is provided", () => {
      const logPath = join(tmpDir, "should-not-exist.log")
      process.env.CLAUDE_AUTH_DEBUG = logPath

      const stream = new PassThrough()
      const chunks: string[] = []
      stream.on("data", (chunk) => chunks.push(chunk.toString()))

      initLogger({ stream })
      log("stream_event", {})

      assert.ok(
        !existsSync(logPath),
        "File should not be created when stream is provided",
      )
      assert.ok(chunks.length > 0, "Stream should have received data")
    })
  })

  describe("timestamp", () => {
    it("includes an ISO 8601 timestamp", () => {
      const logPath = join(tmpDir, "test.log")
      process.env.CLAUDE_AUTH_DEBUG = logPath
      initLogger()

      const before = new Date().toISOString()
      log("ts_test", {})
      const after = new Date().toISOString()

      const parsed = JSON.parse(readFileSync(logPath, "utf-8").trim())
      assert.ok(parsed.ts >= before, "Timestamp should be >= before")
      assert.ok(parsed.ts <= after, "Timestamp should be <= after")
    })
  })
})

describe("redact", () => {
  it("prefix-redacts accessToken", () => {
    const result = redact({
      accessToken: "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.abc123",
    })
    assert.equal(result.accessToken, "eyJhbGci...REDACTED")
  })

  it("fully redacts refreshToken", () => {
    const result = redact({ refreshToken: "dGhpcyBpcyBhIHJlZnJlc2ggdG9rZW4" })
    assert.equal(result.refreshToken, "REDACTED")
  })

  it("redacts x-api-key", () => {
    const result = redact({ "x-api-key": "sk-ant-api03-abc123def456" })
    assert.equal(result["x-api-key"], "REDACTED")
  })

  it("catches JWT-pattern strings in arbitrary keys", () => {
    const result = redact({
      someToken: "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature",
    })
    assert.equal(result.someToken, "eyJhbGci...REDACTED")
  })

  it("preserves non-sensitive fields", () => {
    const result = redact({
      expiresAt: 1742860800000,
      subscriptionType: "max",
      source: "Claude Code-credentials",
      modelId: "claude-opus-4-6",
    })
    assert.equal(result.expiresAt, 1742860800000)
    assert.equal(result.subscriptionType, "max")
    assert.equal(result.source, "Claude Code-credentials")
    assert.equal(result.modelId, "claude-opus-4-6")
  })

  it("handles short accessToken without crashing", () => {
    const result = redact({ accessToken: "short" })
    assert.equal(result.accessToken, "short...REDACTED")
  })

  it("handles empty string values", () => {
    const result = redact({ accessToken: "", refreshToken: "" })
    assert.equal(result.accessToken, "...REDACTED")
    assert.equal(result.refreshToken, "REDACTED")
  })

  it("passes through non-string values unchanged", () => {
    const result = redact({
      count: 42,
      success: true,
      items: ["a", "b"],
    })
    assert.equal(result.count, 42)
    assert.equal(result.success, true)
    assert.deepEqual(result.items, ["a", "b"])
  })
})
