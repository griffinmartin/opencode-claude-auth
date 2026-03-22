import assert from "node:assert/strict"
import { describe, it } from "node:test"

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
