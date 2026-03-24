import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { writeFileSync, mkdirSync, rmSync } from "node:fs"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { buildAccountLabels } from "./keychain.ts"

// Mirrors the parseCredentials logic from keychain.ts for unit testing
function parseCredentials(raw: string): {
  accessToken: string
  refreshToken: string
  expiresAt: number
  subscriptionType?: string
} | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  const data = (parsed as { claudeAiOauth?: unknown }).claudeAiOauth ?? parsed
  const creds = data as {
    accessToken?: unknown
    refreshToken?: unknown
    expiresAt?: unknown
    subscriptionType?: unknown
    mcpOAuth?: unknown
  }

  if ((parsed as { mcpOAuth?: unknown }).mcpOAuth && !creds.accessToken) {
    return null
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
    subscriptionType:
      typeof creds.subscriptionType === "string"
        ? creds.subscriptionType
        : undefined,
  }
}

// Mirrors listClaudeKeychainServices regex logic for unit testing
function extractServicesFromDump(output: string): string[] {
  const PRIMARY = "Claude Code-credentials"
  const services: string[] = []
  const seen = new Set<string>()

  const re = /"Claude Code-credentials(?:-[0-9a-f]+)?"/g
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

function readCredentialsFile(credPath: string): {
  accessToken: string
  refreshToken: string
  expiresAt: number
} | null {
  try {
    const raw = readFileSync(credPath, "utf-8")
    return parseCredentials(raw)
  } catch {
    return null
  }
}

describe("parseCredentials", () => {
  it("parses credentials with claudeAiOauth wrapper", () => {
    const raw = JSON.stringify({
      claudeAiOauth: {
        accessToken: "at-123",
        refreshToken: "rt-456",
        expiresAt: 1700000000000,
        scopes: ["user:inference"],
        subscriptionType: "pro",
        rateLimitTier: "default_claude_ai",
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
      mcpOAuth: {
        "neon|abc123": {
          serverName: "neon",
          accessToken: "some-token",
          expiresAt: 1700000000000,
        },
      },
    })
    assert.equal(parseCredentials(raw), null)
  })

  it("returns null for missing accessToken", () => {
    assert.equal(
      parseCredentials(JSON.stringify({ refreshToken: "rt", expiresAt: 123 })),
      null,
    )
  })

  it("returns null for missing refreshToken", () => {
    assert.equal(
      parseCredentials(JSON.stringify({ accessToken: "at", expiresAt: 123 })),
      null,
    )
  })

  it("returns null for missing expiresAt", () => {
    assert.equal(
      parseCredentials(
        JSON.stringify({ accessToken: "at", refreshToken: "rt" }),
      ),
      null,
    )
  })

  it("returns null for wrong types", () => {
    assert.equal(
      parseCredentials(
        JSON.stringify({
          accessToken: 123,
          refreshToken: "rt",
          expiresAt: 456,
        }),
      ),
      null,
    )
  })

  it("returns null for invalid JSON", () => {
    assert.equal(parseCredentials("not json {{{"), null)
  })

  it("returns null for empty string", () => {
    assert.equal(parseCredentials(""), null)
  })
})

describe("keychain service discovery", () => {
  const SAMPLE_DUMP = `
keychain: "/Users/test/Library/Keychains/login.keychain-db"
version: 512
class: "genp"
attributes:
    0x00000007 <blob>="Claude Code-credentials-e8dc196c"
    "svce"<blob>="Claude Code-credentials-e8dc196c"
keychain: "/Users/test/Library/Keychains/login.keychain-db"
version: 512
class: "genp"
attributes:
    0x00000007 <blob>="Claude Code-credentials-b28bbb7c"
    "svce"<blob>="Claude Code-credentials-b28bbb7c"
keychain: "/Users/test/Library/Keychains/login.keychain-db"
version: 512
class: "genp"
attributes:
    0x00000007 <blob>="Claude Code-credentials"
    "svce"<blob>="Claude Code-credentials"
  `

  it("discovers all Claude Code-credentials* services", () => {
    const services = extractServicesFromDump(SAMPLE_DUMP)
    assert.ok(services.includes("Claude Code-credentials"))
    assert.ok(services.includes("Claude Code-credentials-e8dc196c"))
    assert.ok(services.includes("Claude Code-credentials-b28bbb7c"))
    assert.equal(services.length, 3)
  })

  it("puts the primary service first", () => {
    assert.equal(
      extractServicesFromDump(SAMPLE_DUMP)[0],
      "Claude Code-credentials",
    )
  })

  it("deduplicates entries that appear twice (svce and blob line)", () => {
    const services = extractServicesFromDump(SAMPLE_DUMP)
    assert.equal(
      services.filter((s) => s === "Claude Code-credentials").length,
      1,
    )
    assert.equal(
      services.filter((s) => s === "Claude Code-credentials-b28bbb7c").length,
      1,
    )
  })

  it("ignores non-Claude-Code keychain entries", () => {
    const dump = `
    0x00000007 <blob>="Some Other Service"
    "svce"<blob>="Some Other Service"
    0x00000007 <blob>="Claude Code-credentials"
    `
    assert.deepEqual(extractServicesFromDump(dump), ["Claude Code-credentials"])
  })

  it("returns empty array for a dump with no Claude Code entries", () => {
    assert.deepEqual(extractServicesFromDump("no relevant entries here"), [])
  })

  it("does not match uppercase hex suffixes", () => {
    assert.deepEqual(
      extractServicesFromDump(
        `"svce"<blob>="Claude Code-credentials-B28BBB7C"`,
      ),
      [],
    )
  })

  it("does not match arbitrary word suffixes", () => {
    assert.deepEqual(
      extractServicesFromDump(
        `"svce"<blob>="Claude Code-credentials-myaccount"`,
      ),
      [],
    )
  })

  it("handles a dump where primary service appears after suffixed ones", () => {
    const dump = `
    "svce"<blob>="Claude Code-credentials-b28bbb7c"
    "svce"<blob>="Claude Code-credentials"
    `
    const services = extractServicesFromDump(dump)
    assert.equal(services[0], "Claude Code-credentials")
    assert.equal(services[1], "Claude Code-credentials-b28bbb7c")
  })

  it("handles all five real-world suffixes from a populated keychain", () => {
    const dump = `
    "svce"<blob>="Claude Code-credentials"
    "svce"<blob>="Claude Code-credentials-e8dc196c"
    "svce"<blob>="Claude Code-credentials-3519e293"
    "svce"<blob>="Claude Code-credentials-b3d57fec"
    "svce"<blob>="Claude Code-credentials-b28bbb7c"
    `
    const services = extractServicesFromDump(dump)
    assert.equal(services.length, 5)
    assert.equal(services[0], "Claude Code-credentials")
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
  it("uses subscription type as label when available", () => {
    assert.equal(buildAccountLabels([makeAccountCreds("pro")])[0], "Claude Pro")
    assert.equal(buildAccountLabels([makeAccountCreds("max")])[0], "Claude Max")
    assert.equal(
      buildAccountLabels([makeAccountCreds("free")])[0],
      "Claude Free",
    )
  })

  it("capitalises the subscription tier", () => {
    assert.equal(buildAccountLabels([makeAccountCreds("pro")])[0], "Claude Pro")
  })

  it("falls back to 'Claude' when no subscription type", () => {
    assert.equal(buildAccountLabels([makeAccountCreds()])[0], "Claude")
  })

  it("deduplicates labels with counter when multiple accounts share a tier", () => {
    const labels = buildAccountLabels([
      makeAccountCreds("pro"),
      makeAccountCreds("pro"),
      makeAccountCreds("max"),
    ])
    assert.deepEqual(labels, ["Claude Pro 1", "Claude Pro 2", "Claude Max"])
  })

  it("keeps single account of each tier un-numbered", () => {
    assert.deepEqual(
      buildAccountLabels([makeAccountCreds("pro"), makeAccountCreds("max")]),
      ["Claude Pro", "Claude Max"],
    )
  })

  it("handles three accounts of the same tier", () => {
    assert.deepEqual(
      buildAccountLabels([
        makeAccountCreds("pro"),
        makeAccountCreds("pro"),
        makeAccountCreds("pro"),
      ]),
      ["Claude Pro 1", "Claude Pro 2", "Claude Pro 3"],
    )
  })

  it("handles mixed known and unknown subscription types", () => {
    assert.deepEqual(
      buildAccountLabels([
        makeAccountCreds(),
        makeAccountCreds("pro"),
        makeAccountCreds(),
      ]),
      ["Claude 1", "Claude Pro", "Claude 2"],
    )
  })
})

describe("credentials file fallback", () => {
  const tmpDir = join(tmpdir(), `claude-test-${process.pid}`)

  it("reads valid credentials from a JSON file", () => {
    mkdirSync(tmpDir, { recursive: true })
    const credPath = join(tmpDir, ".credentials.json")
    writeFileSync(
      credPath,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "file-at",
          refreshToken: "file-rt",
          expiresAt: 1700000000000,
        },
      }),
    )
    const result = readCredentialsFile(credPath)
    assert.deepEqual(result, {
      accessToken: "file-at",
      refreshToken: "file-rt",
      expiresAt: 1700000000000,
      subscriptionType: undefined,
    })
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("returns null when the file does not exist", () => {
    assert.equal(
      readCredentialsFile(join(tmpDir, "nonexistent", ".credentials.json")),
      null,
    )
  })

  it("returns null when the file contains invalid JSON", () => {
    mkdirSync(tmpDir, { recursive: true })
    const credPath = join(tmpDir, ".credentials.json")
    writeFileSync(credPath, "{ broken json")
    assert.equal(readCredentialsFile(credPath), null)
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("returns null when the file is valid JSON but missing required fields", () => {
    mkdirSync(tmpDir, { recursive: true })
    const credPath = join(tmpDir, ".credentials.json")
    writeFileSync(
      credPath,
      JSON.stringify({ claudeAiOauth: { accessToken: "only-this" } }),
    )
    assert.equal(readCredentialsFile(credPath), null)
    rmSync(tmpDir, { recursive: true, force: true })
  })
})
