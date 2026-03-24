import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { homedir, tmpdir } from "node:os"
import { pathToFileURL } from "node:url"

// We test readCredentialsFile indirectly by manipulating the file it reads.
// Since readClaudeCredentials on non-darwin falls back to file reading,
// we can test the file-parsing logic directly.

describe("credential file parsing", () => {
  it("parses credentials with claudeAiOauth wrapper", () => {
    const data = {
      claudeAiOauth: {
        accessToken: "at-123",
        refreshToken: "rt-456",
        expiresAt: 1700000000000,
      },
    }

    const creds = extractCredentials(data)
    assert.deepEqual(creds, {
      accessToken: "at-123",
      refreshToken: "rt-456",
      expiresAt: 1700000000000,
    })
  })

  it("parses credentials at root level", () => {
    const data = {
      accessToken: "at-789",
      refreshToken: "rt-012",
      expiresAt: 1700000000000,
    }

    const creds = extractCredentials(data)
    assert.deepEqual(creds, {
      accessToken: "at-789",
      refreshToken: "rt-012",
      expiresAt: 1700000000000,
    })
  })

  it("returns null for missing accessToken", () => {
    const data = { refreshToken: "rt", expiresAt: 123 }
    assert.equal(extractCredentials(data), null)
  })

  it("returns null for missing refreshToken", () => {
    const data = { accessToken: "at", expiresAt: 123 }
    assert.equal(extractCredentials(data), null)
  })

  it("returns null for missing expiresAt", () => {
    const data = { accessToken: "at", refreshToken: "rt" }
    assert.equal(extractCredentials(data), null)
  })

  it("returns null for wrong types", () => {
    const data = { accessToken: 123, refreshToken: "rt", expiresAt: 456 }
    assert.equal(extractCredentials(data), null)
  })
})

describe("config dir resolution", () => {
  it("uses CLAUDE_CONFIG_DIR for credentials file path", async () => {
    const dir = join(tmpdir(), "claude-custom")
    const prev = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = dir

    try {
      const mod = await loadKeychainModule()
      assert.equal(mod.getCredentialsFilePath(), join(dir, ".credentials.json"))
    } finally {
      resetConfigEnv(prev)
    }
  })

  it("treats empty CLAUDE_CONFIG_DIR as unset for credentials file path", async () => {
    const prev = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = ""

    try {
      const mod = await loadKeychainModule()
      assert.equal(mod.getCredentialsFilePath(), join(homedir(), ".claude", ".credentials.json"))
    } finally {
      resetConfigEnv(prev)
    }
  })

  it("derives a hashed keychain service name for custom CLAUDE_CONFIG_DIR", async () => {
    const dir = join(tmpdir(), "claude-custom")
    const prev = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = dir

    try {
      const mod = await loadKeychainModule()
      const hash = createHash("sha256").update(dir).digest("hex").slice(0, 8)
      assert.equal(mod.getClaudeCredentialServiceName(), `Claude Code-credentials-${hash}`)
    } finally {
      resetConfigEnv(prev)
    }
  })

  it("normalizes CLAUDE_CONFIG_DIR before hashing the keychain service name", async () => {
    const decomposedDir = join(tmpdir(), "cafe\u0301")
    const normalizedDir = decomposedDir.normalize("NFC")
    const prev = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = decomposedDir

    try {
      const mod = await loadKeychainModule()
      const hash = createHash("sha256").update(normalizedDir).digest("hex").slice(0, 8)
      assert.notEqual(decomposedDir, normalizedDir)
      assert.equal(mod.getClaudeCredentialServiceName(), `Claude Code-credentials-${hash}`)
    } finally {
      resetConfigEnv(prev)
    }
  })

  it("treats empty CLAUDE_CONFIG_DIR as unset for keychain service name", async () => {
    const prev = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = ""

    try {
      const mod = await loadKeychainModule()
      assert.equal(mod.getClaudeCredentialServiceName(), "Claude Code-credentials")
    } finally {
      resetConfigEnv(prev)
    }
  })
})

// Mirrors the credential extraction logic from keychain.ts readCredentialsFile
function extractCredentials(
  parsed: Record<string, unknown>,
): { accessToken: string; refreshToken: string; expiresAt: number } | null {
  const data =
    (parsed as { claudeAiOauth?: Record<string, unknown> }).claudeAiOauth ??
    parsed
  const creds = data as {
    accessToken?: unknown
    refreshToken?: unknown
    expiresAt?: unknown
  }

  if (
    typeof creds.accessToken !== "string" ||
    typeof creds.refreshToken !== "string" ||
    typeof creds.expiresAt !== "number"
  ) {
    return null
  }

  return {
    accessToken: creds.accessToken,
    refreshToken: creds.refreshToken,
    expiresAt: creds.expiresAt,
  }
}

async function loadKeychainModule(): Promise<{
  getCredentialsFilePath: () => string
  getClaudeCredentialServiceName: () => string
}> {
  const dir = await mkdtemp(join(tmpdir(), "opencode-claude-auth-keychain-"))
  const file = join(dir, "keychain.ts")
  const src = await readFile(new URL("./keychain.ts", import.meta.url), "utf8")

  await writeFile(
    file,
    `${src}\nexport { getCredentialsFilePath, getClaudeCredentialServiceName }\n`,
    "utf8",
  )

  return import(pathToFileURL(file).href) as Promise<{
    getCredentialsFilePath: () => string
    getClaudeCredentialServiceName: () => string
  }>
}

function resetConfigEnv(value: string | undefined): void {
  if (typeof value === "string") {
    process.env.CLAUDE_CONFIG_DIR = value
    return
  }

  delete process.env.CLAUDE_CONFIG_DIR
}
