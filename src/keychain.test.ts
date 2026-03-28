import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildAccountLabels,
  keychainSuffixForDir,
  parseCredentials,
  readCredentialsFile,
  updateCredentialBlob,
  writeBackCredentials,
} from "./keychain.ts"

// Mirrors listClaudeKeychainServices regex logic for unit testing
function extractServicesFromDump(output: string): string[] {
  const PRIMARY = "Claude Code-credentials"
  const services: string[] = []
  const seen = new Set<string>()

  const re = /"Claude Code-credentials(?:-[0-9a-f]{8})?"/g
  let m = re.exec(output)
  while (m !== null) {
    const svc = m[0].slice(1, -1)
    if (!seen.has(svc)) {
      seen.add(svc)
      services.push(svc)
    }
    m = re.exec(output)
  }

  const ordered: string[] = []
  if (seen.has(PRIMARY)) ordered.push(PRIMARY)
  for (const svc of services) {
    if (svc !== PRIMARY) ordered.push(svc)
  }
  return ordered
}

describe("parseCredentials", () => {
  it("parses credentials with claudeAiOauth wrapper", () => {
    const raw = JSON.stringify({
      claudeAiOauth: {
        accessToken: "at-123",
        refreshToken: "rt-456",
        expiresAt: 1700000000000,
        subscriptionType: "pro",
      },
    })
    const result = parseCredentials(raw)
    assert.ok(result)
    assert.equal(result.accessToken, "at-123")
    assert.equal(result.refreshToken, "rt-456")
    assert.equal(result.expiresAt, 1700000000000)
    assert.equal(result.subscriptionType, "pro")
  })

  it("parses credentials at root level", () => {
    const raw = JSON.stringify({
      accessToken: "at-789",
      refreshToken: "rt-012",
      expiresAt: 1700000000000,
    })
    const result = parseCredentials(raw)
    assert.ok(result)
    assert.equal(result.accessToken, "at-789")
    assert.equal(result.refreshToken, "rt-012")
    assert.equal(result.expiresAt, 1700000000000)
  })

  it("truncates a fractional stored expiresAt", () => {
    const raw = JSON.stringify({
      claudeAiOauth: {
        accessToken: "at-123",
        refreshToken: "rt-456",
        expiresAt: 1784891051785.9011,
      },
    })

    const result = parseCredentials(raw)

    assert.ok(result)
    assert.equal(result.expiresAt, 1784891051785)
    assert.equal(Number.isInteger(result.expiresAt), true)
  })

  it("subscriptionType is undefined when not present", () => {
    const raw = JSON.stringify({
      accessToken: "at",
      refreshToken: "rt",
      expiresAt: 1700000000000,
    })
    const result = parseCredentials(raw)
    assert.ok(result)
    assert.equal(result.subscriptionType, undefined)
  })

  it("returns null for MCP-only entries", () => {
    const raw = JSON.stringify({
      mcpOAuth: { "neon|abc123": { serverName: "neon" } },
    })
    assert.equal(parseCredentials(raw), null)
  })

  it("returns null for invalid JSON", () => {
    assert.equal(parseCredentials("not json {{{"), null)
  })
})

describe("keychain service discovery", () => {
  it("discovers primary and suffixed services", () => {
    const dump = `
    "svce"<blob>="Claude Code-credentials-b28bbb7c"
    "svce"<blob>="Claude Code-credentials"
    `
    assert.deepEqual(extractServicesFromDump(dump), [
      "Claude Code-credentials",
      "Claude Code-credentials-b28bbb7c",
    ])
  })

  it("does not match uppercase or arbitrary suffixes", () => {
    assert.deepEqual(
      extractServicesFromDump(
        `
        "svce"<blob>="Claude Code-credentials-B28BBB7C"
        "svce"<blob>="Claude Code-credentials-myaccount"
        `,
      ),
      [],
    )
  })
})

const makeAccountCreds = (
  sub?: string,
): {
  accessToken: string
  refreshToken: string
  expiresAt: number
  subscriptionType?: string
} => ({
  accessToken: "at",
  refreshToken: "rt",
  expiresAt: 9999999999999,
  subscriptionType: sub,
})

describe("account labelling", () => {
  it("uses subscription type and deduplicates tiers", () => {
    assert.deepEqual(
      buildAccountLabels([
        makeAccountCreds("pro"),
        makeAccountCreds("pro"),
        makeAccountCreds("max"),
      ]),
      ["Claude Pro 1", "Claude Pro 2", "Claude Max"],
    )
  })

  it("falls back to Claude when no subscription type", () => {
    assert.equal(buildAccountLabels([makeAccountCreds()])[0], "Claude")
  })

  it("appends email when provided", () => {
    assert.deepEqual(
      buildAccountLabels(
        [makeAccountCreds("pro"), makeAccountCreds("pro")],
        ["a@example.com", "b@example.com"],
      ),
      ["Claude Pro 1: a@example.com", "Claude Pro 2: b@example.com"],
    )
  })

  it("skips email when absent", () => {
    assert.deepEqual(
      buildAccountLabels(
        [makeAccountCreds("pro"), makeAccountCreds("team")],
        [null, "bob@example.com"],
      ),
      ["Claude Pro", "Claude Team: bob@example.com"],
    )
  })
})

describe("credentials file fallback", () => {
  const tmpDir = join(tmpdir(), `claude-test-${process.pid}`)

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("reads valid credentials from a config dir", () => {
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(
      join(tmpDir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "file-at",
          refreshToken: "file-rt",
          expiresAt: 1700000000000,
        },
      }),
    )

    assert.deepEqual(readCredentialsFile(tmpDir), {
      accessToken: "file-at",
      refreshToken: "file-rt",
      expiresAt: 1700000000000,
      subscriptionType: undefined,
    })
  })

  it("returns null when the file does not exist", () => {
    assert.equal(readCredentialsFile(join(tmpDir, "missing")), null)
  })

  it("returns null when the file contains invalid JSON", () => {
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(join(tmpDir, ".credentials.json"), "{ broken json")
    assert.equal(readCredentialsFile(tmpDir), null)
  })
})

describe("updateCredentialBlob", () => {
  it("updates tokens in claudeAiOauth wrapper format", () => {
    const existing = JSON.stringify({
      claudeAiOauth: {
        accessToken: "old-at",
        refreshToken: "old-rt",
        expiresAt: 1000,
        subscriptionType: "pro",
      },
    })
    const newCreds = {
      accessToken: "new-at",
      refreshToken: "new-rt",
      expiresAt: 2000,
    }
    const result = JSON.parse(updateCredentialBlob(existing, newCreds)!)
    assert.equal(result.claudeAiOauth.accessToken, "new-at")
    assert.equal(result.claudeAiOauth.subscriptionType, "pro")
  })

  it("returns null for invalid JSON input", () => {
    assert.equal(
      updateCredentialBlob("not json", {
        accessToken: "a",
        refreshToken: "r",
        expiresAt: 1,
      }),
      null,
    )
  })
})

describe("writeBackCredentials (file source)", () => {
  it("reads, updates, and writes back credentials to file", async () => {
    const originalHome = process.env.HOME
    const tempHome = await mkdtemp(join(tmpdir(), "opencode-claude-auth-wb-"))
    process.env.HOME = tempHome

    try {
      const claudeDir = join(tempHome, ".claude")
      mkdirSync(claudeDir, { recursive: true })
      const credPath = join(claudeDir, ".credentials.json")
      writeFileSync(
        credPath,
        JSON.stringify({
          claudeAiOauth: {
            accessToken: "old-at",
            refreshToken: "old-rt",
            expiresAt: 1000,
            subscriptionType: "pro",
          },
        }),
        { encoding: "utf-8", mode: 0o600 },
      )

      const result = writeBackCredentials("file", {
        accessToken: "new-at",
        refreshToken: "new-rt",
        expiresAt: 2000,
      })

      assert.equal(result, true)
      const written = JSON.parse(readFileSync(credPath, "utf-8"))
      assert.equal(written.claudeAiOauth.accessToken, "new-at")
      assert.equal(written.claudeAiOauth.subscriptionType, "pro")
    } finally {
      if (typeof originalHome === "string") {
        process.env.HOME = originalHome
      } else {
        delete process.env.HOME
      }
      rmSync(tempHome, { recursive: true, force: true })
    }
  })

  it("writes file with 0o600 permissions", async () => {
    if (process.platform === "win32") return

    const originalHome = process.env.HOME
    const tempHome = await mkdtemp(join(tmpdir(), "opencode-claude-auth-wb-perms-"))
    process.env.HOME = tempHome

    try {
      const claudeDir = join(tempHome, ".claude")
      mkdirSync(claudeDir, { recursive: true })
      const credPath = join(claudeDir, ".credentials.json")
      writeFileSync(
        credPath,
        JSON.stringify({ accessToken: "at", refreshToken: "rt", expiresAt: 1 }),
        { encoding: "utf-8", mode: 0o644 },
      )
      chmodSync(credPath, 0o644)

      writeBackCredentials("file", {
        accessToken: "new-at",
        refreshToken: "new-rt",
        expiresAt: 2000,
      })

      const mode = statSync(credPath).mode & 0o777
      assert.equal(mode, 0o600)
    } finally {
      if (typeof originalHome === "string") {
        process.env.HOME = originalHome
      } else {
        delete process.env.HOME
      }
      rmSync(tempHome, { recursive: true, force: true })
    }
  })
})

function makeCreds(accessToken: string) {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken,
      refreshToken: "rt",
      expiresAt: Date.now() + 3_600_000,
    },
  })
}

describe("CLAUDE_CONFIG_DIR support", () => {
  const savedEnv = process.env.CLAUDE_CONFIG_DIR

  afterEach(() => {
    if (savedEnv === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = savedEnv
    }
  })

  it("uses ~/.claude by default when CLAUDE_CONFIG_DIR is unset", async () => {
    const originalHome = process.env.HOME
    delete process.env.CLAUDE_CONFIG_DIR
    const fakeHome = await mkdtemp(join(tmpdir(), "claude-home-"))
    const defaultDir = join(fakeHome, ".claude")
    mkdirSync(defaultDir, { recursive: true })
    writeFileSync(join(defaultDir, ".credentials.json"), makeCreds("default-token"))

    process.env.HOME = fakeHome

    try {
      const creds = readCredentialsFile()
      assert.ok(creds)
      assert.equal(creds.accessToken, "default-token")
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = originalHome
      }
      rmSync(fakeHome, { recursive: true, force: true })
    }
  })

  it("uses CLAUDE_CONFIG_DIR when set to a custom path", async () => {
    const customDir = await mkdtemp(join(tmpdir(), "claude-custom-"))
    mkdirSync(customDir, { recursive: true })
    writeFileSync(join(customDir, ".credentials.json"), makeCreds("custom-token"))

    process.env.CLAUDE_CONFIG_DIR = customDir

    const creds = readCredentialsFile()
    assert.ok(creds)
    assert.equal(creds.accessToken, "custom-token")

    rmSync(customDir, { recursive: true, force: true })
  })

  it("works with arbitrary custom directory names", async () => {
    const arbitraryDir = await mkdtemp(join(tmpdir(), "claude-arbitrary-"))
    writeFileSync(
      join(arbitraryDir, ".credentials.json"),
      makeCreds("arbitrary-token"),
    )

    process.env.CLAUDE_CONFIG_DIR = arbitraryDir

    const creds = readCredentialsFile()
    assert.ok(creds)
    assert.equal(creds.accessToken, "arbitrary-token")

    rmSync(arbitraryDir, { recursive: true, force: true })
  })
})

describe("keychainSuffixForDir", () => {
  it("derives the expected suffix for a known path", () => {
    assert.equal(keychainSuffixForDir("/Users/example/.work"), "d4b84687")
  })

  it("produces different suffixes for different dirs", () => {
    const a = keychainSuffixForDir("/Users/example/.claude")
    const b = keychainSuffixForDir("/Users/example/.work")
    const c = keychainSuffixForDir("/Users/example/.personal")
    assert.notEqual(a, b)
    assert.notEqual(b, c)
    assert.notEqual(a, c)
  })

  it("produces 8-character hex strings", () => {
    const suffix = keychainSuffixForDir("/Users/example/.claude")
    assert.match(suffix, /^[0-9a-f]{8}$/)
  })

  it("is consistent for the same input", () => {
    const dir = join(homedir(), ".someconfig")
    assert.equal(keychainSuffixForDir(dir), keychainSuffixForDir(dir))
  })
})
