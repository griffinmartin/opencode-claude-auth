import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  addTokens,
  clearSessionTokens,
  writeTokenStore,
  isTokenSource,
  listTokenEntries,
  parsePastedTokens,
  readEnvTokens,
  readStaticCredentials,
  readTokenAccounts,
  readTokenStore,
  removeToken,
  setTokenDisabled,
  staticCredentialsFor,
  tokenFingerprint,
  tokenIdFor,
  validateTokenInput,
} from "./token-store.ts"

const TOKEN_A = "sk-ant-oat01-AAAAAAAAAAAAAAAAAAAAAA"
const TOKEN_B = "sk-ant-oat01-BBBBBBBBBBBBBBBBBBBBBB"
const TOKEN_C = "sk-ant-oat02-CCCCCCCCCCCCCCCCCCCCCC"

/**
 * Point the store at a fresh file and clear the environment channel, so no
 * test observes another's tokens or the developer's real ones.
 */
function isolateStore(): string {
  const dir = mkdtempSync(join(tmpdir(), "claude-auth-tokenstore-"))
  const path = join(dir, "tokens.json")
  process.env.OPENCODE_CLAUDE_AUTH_TOKENS_FILE = path
  delete process.env.OPENCODE_CLAUDE_AUTH_TOKENS
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN
  return path
}

describe("parsePastedTokens", () => {
  it("accepts a single token", () => {
    const { tokens, invalid } = parsePastedTokens(TOKEN_A)
    assert.deepEqual(tokens, [TOKEN_A])
    assert.deepEqual(invalid, [])
  })

  it("accepts several tokens separated by spaces, commas or newlines", () => {
    const { tokens } = parsePastedTokens(`${TOKEN_A}, ${TOKEN_B}\n${TOKEN_C};`)
    assert.deepEqual(tokens, [TOKEN_A, TOKEN_B, TOKEN_C])
  })

  it("tolerates surrounding whitespace from a terminal paste", () => {
    const { tokens } = parsePastedTokens(`   ${TOKEN_A}   \n`)
    assert.deepEqual(tokens, [TOKEN_A])
  })

  it("collapses a token pasted twice", () => {
    const { tokens } = parsePastedTokens(`${TOKEN_A} ${TOKEN_A}`)
    assert.deepEqual(tokens, [TOKEN_A])
  })

  it("separates invalid entries instead of failing the whole paste", () => {
    const { tokens, invalid } = parsePastedTokens(
      `${TOKEN_A} sk-ant-api03-notanoauthtoken hello`,
    )
    assert.deepEqual(tokens, [TOKEN_A])
    assert.equal(invalid.length, 2)
  })

  it("accepts a future oat version without a code change", () => {
    const { tokens } = parsePastedTokens(TOKEN_C)
    assert.deepEqual(tokens, [TOKEN_C])
  })

  it("returns nothing for empty input", () => {
    assert.deepEqual(parsePastedTokens("   ").tokens, [])
  })
})

describe("validateTokenInput", () => {
  it("rejects empty input", () => {
    assert.equal(validateTokenInput(""), "Paste at least one token")
  })

  it("rejects input with no valid token", () => {
    const message = validateTokenInput("not-a-token")
    assert.ok(message?.includes("sk-ant-oat"))
  })

  it("accepts a valid token", () => {
    assert.equal(validateTokenInput(TOKEN_A), undefined)
  })

  it("reports a partially valid paste", () => {
    const message = validateTokenInput(`${TOKEN_A} garbage`)
    assert.ok(message?.includes("1 of 2"))
  })

  it("never echoes the offending value", () => {
    const message = validateTokenInput("sk-ant-oat01-tooshort")
    assert.ok(message)
    assert.ok(!message.includes("tooshort"))
  })
})

describe("token identity", () => {
  it("derives a stable id from the token content", () => {
    assert.equal(tokenIdFor(TOKEN_A), tokenIdFor(TOKEN_A))
    assert.notEqual(tokenIdFor(TOKEN_A), tokenIdFor(TOKEN_B))
  })

  it("ignores surrounding whitespace when deriving an id", () => {
    assert.equal(tokenIdFor(` ${TOKEN_A} `), tokenIdFor(TOKEN_A))
  })

  it("fingerprints without exposing the token", () => {
    const fp = tokenFingerprint(TOKEN_A)
    assert.equal(fp, `…${TOKEN_A.slice(-6)}`)
    assert.ok(!fp.includes("sk-ant"))
  })

  it("recognises its own source strings", () => {
    assert.ok(isTokenSource(`token:${tokenIdFor(TOKEN_A)}`))
    assert.ok(!isTokenSource("Claude Code-credentials"))
    assert.ok(!isTokenSource("file"))
  })
})

describe("addTokens", () => {
  beforeEach(isolateStore)

  it("stores pasted tokens", () => {
    const result = addTokens([TOKEN_A, TOKEN_B])
    assert.equal(result.added.length, 2)
    assert.equal(result.duplicates.length, 0)
    assert.ok(result.persisted)
    assert.equal(readTokenStore().accounts.length, 2)
  })

  it("treats re-pasting the same token as a duplicate, not a second account", () => {
    addTokens([TOKEN_A])
    const again = addTokens([TOKEN_A])
    assert.equal(again.added.length, 0)
    assert.equal(again.duplicates.length, 1)
    assert.equal(readTokenStore().accounts.length, 1)
  })

  it("numbers labels for a multi-token paste and leaves a single one verbatim", () => {
    addTokens([TOKEN_A, TOKEN_B], "work")
    const labels = readTokenStore().accounts.map((a) => a.label)
    assert.deepEqual(labels, ["work 1", "work 2"])

    isolateStore()
    addTokens([TOKEN_A], "personal")
    assert.equal(readTokenStore().accounts[0]?.label, "personal")
  })

  it("omits the label when none is given", () => {
    addTokens([TOKEN_A], "   ")
    assert.equal(readTokenStore().accounts[0]?.label, undefined)
  })

  it("writes the store readable only by the owner", () => {
    const path = process.env.OPENCODE_CLAUDE_AUTH_TOKENS_FILE!
    addTokens([TOKEN_A])
    assert.equal(statSync(path).mode & 0o777, 0o600)
  })
})

describe("removeToken and setTokenDisabled", () => {
  beforeEach(isolateStore)

  it("removes a stored token", () => {
    addTokens([TOKEN_A, TOKEN_B])
    assert.ok(removeToken(tokenIdFor(TOKEN_A)))
    const remaining = readTokenStore().accounts
    assert.equal(remaining.length, 1)
    assert.equal(remaining[0]?.token, TOKEN_B)
  })

  it("reports when nothing matched", () => {
    addTokens([TOKEN_A])
    assert.equal(removeToken("deadbeef"), false)
    assert.equal(readTokenStore().accounts.length, 1)
  })

  it("keeps a disabled token on file but out of the pool", () => {
    addTokens([TOKEN_A, TOKEN_B])
    assert.ok(setTokenDisabled(tokenIdFor(TOKEN_A), true))
    assert.equal(readTokenStore().accounts.length, 2)
    assert.equal(listTokenEntries().length, 1)
  })
})

describe("static credentials", () => {
  beforeEach(isolateStore)

  it("marks the credential static with no refresh token", () => {
    const creds = staticCredentialsFor({
      id: "a",
      token: TOKEN_A,
      addedAt: 1_000,
    })
    assert.equal(creds.kind, "static")
    assert.equal(creds.accessToken, TOKEN_A)
    assert.equal(creds.refreshToken, "")
    assert.ok(creds.expiresAt > 1_000)
  })

  it("resolves a stored token by its source string", () => {
    addTokens([TOKEN_A])
    const source = `token:${tokenIdFor(TOKEN_A)}`
    assert.equal(readStaticCredentials(source)?.accessToken, TOKEN_A)
  })

  it("returns null once the token is removed, so the account drops out", () => {
    addTokens([TOKEN_A])
    const source = `token:${tokenIdFor(TOKEN_A)}`
    removeToken(tokenIdFor(TOKEN_A))
    assert.equal(readStaticCredentials(source), null)
  })

  it("returns null for a non-token source", () => {
    assert.equal(readStaticCredentials("Claude Code-credentials"), null)
  })
})

describe("readTokenAccounts", () => {
  beforeEach(isolateStore)

  it("exposes each token as an account with a token: source", () => {
    addTokens([TOKEN_A, TOKEN_B], "work")
    const accounts = readTokenAccounts()
    assert.equal(accounts.length, 2)
    assert.equal(accounts[0]?.source, `token:${tokenIdFor(TOKEN_A)}`)
    assert.equal(accounts[0]?.credentials.kind, "static")
  })

  it("labels an unlabelled token by fingerprint, never in full", () => {
    addTokens([TOKEN_A])
    const label = readTokenAccounts()[0]?.label ?? ""
    assert.ok(label.includes(tokenFingerprint(TOKEN_A)))
    assert.ok(!label.includes(TOKEN_A))
  })

  it("returns nothing when no tokens are configured", () => {
    assert.deepEqual(readTokenAccounts(), [])
  })
})

describe("environment tokens", () => {
  beforeEach(isolateStore)

  it("reads OPENCODE_CLAUDE_AUTH_TOKENS", () => {
    process.env.OPENCODE_CLAUDE_AUTH_TOKENS = `${TOKEN_A},${TOKEN_B}`
    const entries = readEnvTokens()
    assert.equal(entries.length, 2)
    assert.equal(entries[0]?.token, TOKEN_A)
  })

  it("honours Claude Code's own CLAUDE_CODE_OAUTH_TOKEN", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = TOKEN_A
    assert.equal(readEnvTokens()[0]?.token, TOKEN_A)
  })

  it("sorts environment tokens ahead of stored ones", () => {
    addTokens([TOKEN_B])
    process.env.OPENCODE_CLAUDE_AUTH_TOKENS = TOKEN_A
    const entries = listTokenEntries()
    assert.equal(entries[0]?.token, TOKEN_A)
    assert.equal(entries[1]?.token, TOKEN_B)
  })

  it("does not double-count a token present in both env and file", () => {
    addTokens([TOKEN_A])
    process.env.OPENCODE_CLAUDE_AUTH_TOKENS = TOKEN_A
    assert.equal(listTokenEntries().length, 1)
  })

  it("ignores an invalid value rather than failing startup", () => {
    process.env.OPENCODE_CLAUDE_AUTH_TOKENS = "nonsense"
    assert.deepEqual(readEnvTokens(), [])
  })
})

describe("store resilience", () => {
  it("treats a malformed file as empty instead of throwing", () => {
    const path = isolateStore()
    writeFileSync(path, "{ this is not json", "utf8")
    assert.deepEqual(readTokenStore().accounts, [])
    assert.deepEqual(readTokenAccounts(), [])
  })

  it("treats a missing accounts array as empty", () => {
    const path = isolateStore()
    writeFileSync(path, JSON.stringify({ version: 1 }), "utf8")
    assert.deepEqual(readTokenStore().accounts, [])
  })

  it("keeps good entries when one record is broken", () => {
    const path = isolateStore()
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        accounts: [{ id: "a", token: TOKEN_A, addedAt: 1 }, { nope: true }],
      }),
      "utf8",
    )
    const accounts = readTokenStore().accounts
    assert.equal(accounts.length, 1)
    assert.equal(accounts[0]?.token, TOKEN_A)
  })

  it("repairs an id a hand-edit desynchronised from its token", () => {
    const path = isolateStore()
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        accounts: [{ id: "", token: TOKEN_A, addedAt: 1 }],
      }),
      "utf8",
    )
    assert.equal(readTokenStore().accounts[0]?.id, tokenIdFor(TOKEN_A))
  })

  it("returns empty when the file does not exist", () => {
    process.env.OPENCODE_CLAUDE_AUTH_TOKENS_FILE = join(
      mkdtempSync(join(tmpdir(), "claude-auth-absent-")),
      "nope.json",
    )
    delete process.env.OPENCODE_CLAUDE_AUTH_TOKENS
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN
    assert.deepEqual(readTokenStore().accounts, [])
  })
})

describe("token store hardening", () => {
  beforeEach(() => {
    clearSessionTokens()
    isolateStore()
  })

  it("keeps tokens usable for the session when the store cannot be written", () => {
    // A directory in place of the file makes every write fail.
    const dir = mkdtempSync(join(tmpdir(), "claude-auth-unwritable-"))
    process.env.OPENCODE_CLAUDE_AUTH_TOKENS_FILE = join(dir, "sub")
    mkdirSync(join(dir, "sub"), { recursive: true })

    const result = addTokens([TOKEN_A], "fallback")
    assert.equal(result.persisted, false, "the write is expected to fail here")
    assert.equal(result.added.length, 1)

    // The promise made to the user — "applies to this session only" — has to
    // hold: the token must be resolvable through the normal reader path.
    const entries = listTokenEntries()
    assert.equal(entries.length, 1)
    assert.equal(entries[0]?.token, TOKEN_A)

    const source = `token:${tokenIdFor(TOKEN_A)}`
    assert.equal(readStaticCredentials(source)?.accessToken, TOKEN_A)
    assert.equal(readTokenAccounts()[0]?.source, source)
  })

  it("does not duplicate a session token added twice", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-auth-unwritable-"))
    process.env.OPENCODE_CLAUDE_AUTH_TOKENS_FILE = join(dir, "sub")
    mkdirSync(join(dir, "sub"), { recursive: true })

    addTokens([TOKEN_A])
    addTokens([TOKEN_A])
    assert.equal(listTokenEntries().length, 1)
  })

  it("drops session tokens once cleared, mirroring a restart", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-auth-unwritable-"))
    process.env.OPENCODE_CLAUDE_AUTH_TOKENS_FILE = join(dir, "sub")
    mkdirSync(join(dir, "sub"), { recursive: true })

    addTokens([TOKEN_A])
    assert.equal(listTokenEntries().length, 1)
    clearSessionTokens()
    assert.equal(listTokenEntries().length, 0)
  })

  it("refuses to write through a pre-created symlink at the temp path", () => {
    const dir = mkdtempSync(join(tmpdir(), "claude-auth-symlink-"))
    const storePath = join(dir, "tokens.json")
    process.env.OPENCODE_CLAUDE_AUTH_TOKENS_FILE = storePath

    // Stand in for a hostile local user who guessed the temp path. Both the
    // legacy name and the pid-qualified one are planted, so the test fails if
    // the implementation reverts to either without exclusive creation.
    const victim = join(dir, "victim.txt")
    writeFileSync(victim, "original\n")
    symlinkSync(victim, `${storePath}.tmp`)
    symlinkSync(victim, `${storePath}.${process.pid}.tmp`)

    const ok = writeTokenStore({
      version: 1,
      accounts: [{ id: "a", token: TOKEN_A, addedAt: 1 }],
    })

    assert.equal(ok, false, "the write must fail rather than follow a symlink")
    assert.equal(
      readFileSync(victim, "utf8"),
      "original\n",
      "the symlink target must not be overwritten",
    )
    assert.ok(
      !readFileSync(victim, "utf8").includes("sk-ant"),
      "no token may reach the attacker-chosen file",
    )
  })
})
