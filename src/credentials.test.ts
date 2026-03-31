import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { refreshViaOAuth, parseOAuthResponse } from "./credentials.ts"
import { chmodSync, mkdirSync, statSync, writeFileSync } from "node:fs"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

async function loadCredentialsWithCountingKeychain(
  initialExpiresAt: number,
): Promise<{
  credentialsModule: {
    getCachedCredentials: () => {
      accessToken: string
      refreshToken: string
      expiresAt: number
    } | null
    getCredentialsForSync: () => {
      accessToken: string
      refreshToken: string
      expiresAt: number
    } | null
    initAccounts: (accounts: unknown[]) => void
  }
  keychainModule: {
    __getReadCount: () => number
  }
}> {
  const tempDir = await mkdtemp(join(tmpdir(), "opencode-claude-auth-creds-"))
  const tempKeychain = join(tempDir, "keychain.ts")
  const tempBetas = join(tempDir, "betas.ts")
  const tempLogger = join(tempDir, "logger.ts")
  const tempCredentials = join(tempDir, "credentials.ts")
  const sourceCredentials = await readFile(
    new URL("./credentials.ts", import.meta.url),
    "utf8",
  )
  const rewritten = sourceCredentials.replace(
    /from\s+["']\.\/(\w+)\.js["']/g,
    'from "./$1.ts"',
  )

  await writeFile(
    tempLogger,
    `export function log() {}\nexport function initLogger() {}\nexport function closeLogger() {}\n`,
    "utf8",
  )

  await writeFile(
    tempKeychain,
    `let readCount = 0
let credentials = {
  accessToken: "token",
  refreshToken: "refresh",
  expiresAt: ${initialExpiresAt}
}

export function readAllClaudeAccounts() {
  readCount += 1
  return [{ label: "Account 1", source: "keychain", credentials }]
}

export function refreshAccount(source) {
  readCount += 1
  return credentials
}

export function writeBackCredentials() { return true }

export function __getReadCount() {
  return readCount
}
`,
    "utf8",
  )

  await writeFile(
    tempBetas,
    `export function resetExcludedBetas() {}\n`,
    "utf8",
  )
  await writeFile(tempCredentials, rewritten, "utf8")

  const [credentialsModule, keychainModule] = await Promise.all([
    import(pathToFileURL(tempCredentials).href),
    import(pathToFileURL(tempKeychain).href),
  ])

  return {
    credentialsModule: credentialsModule as {
      getCachedCredentials: () => {
        accessToken: string
        refreshToken: string
        expiresAt: number
      } | null
      getCredentialsForSync: () => {
        accessToken: string
        refreshToken: string
        expiresAt: number
      } | null
      initAccounts: (accounts: unknown[]) => void
    },
    keychainModule: keychainModule as { __getReadCount: () => number },
  }
}

describe("credential caching", () => {
  it("getCachedCredentials reuses cached credentials within 30 second TTL", async () => {
    const originalNow = Date.now
    const now = 1_700_000_000_000
    Date.now = () => now

    try {
      const { credentialsModule, keychainModule } =
        await loadCredentialsWithCountingKeychain(now + 10 * 60_000)

      credentialsModule.initAccounts([
        {
          label: "Account 1",
          source: "keychain",
          credentials: {
            accessToken: "token",
            refreshToken: "refresh",
            expiresAt: now + 10 * 60_000,
          },
        },
      ])

      const first = credentialsModule.getCachedCredentials()
      const second = credentialsModule.getCachedCredentials()

      assert.ok(first)
      assert.ok(second)
      assert.equal(keychainModule.__getReadCount(), 0)
    } finally {
      Date.now = originalNow
    }
  })

  it("getCachedCredentials refreshes from source after TTL expires", async () => {
    const originalNow = Date.now
    let now = 1_700_000_000_000
    Date.now = () => now

    try {
      const { credentialsModule } = await loadCredentialsWithCountingKeychain(
        now + 10 * 60_000,
      )

      credentialsModule.initAccounts([
        {
          label: "Account 1",
          source: "keychain",
          credentials: {
            accessToken: "token",
            refreshToken: "refresh",
            expiresAt: now + 10 * 60_000,
          },
        },
      ])

      const first = credentialsModule.getCachedCredentials()
      assert.ok(first)

      now += 31_000

      const second = credentialsModule.getCachedCredentials()
      assert.ok(second)
      assert.equal(second.accessToken, "token")
    } finally {
      Date.now = originalNow
    }
  })

  it("refreshIfNeeded updates account credentials in-place after refresh", async () => {
    const originalNow = Date.now
    let now = 1_700_000_000_000
    Date.now = () => now

    try {
      // Keychain returns fresh creds with 10min expiry
      const { credentialsModule } = await loadCredentialsWithCountingKeychain(
        now + 10 * 60_000,
      )

      const account = {
        label: "Account 1",
        source: "keychain",
        credentials: {
          accessToken: "old-token",
          refreshToken: "old-refresh",
          expiresAt: now + 30_000, // expires in 30s, below 60s threshold
        },
      }

      credentialsModule.initAccounts([account])

      // First call should trigger refresh (token expiring within 60s)
      const result = credentialsModule.getCachedCredentials()
      assert.ok(result)

      // The account object's credentials should now be updated in-place
      assert.ok(
        account.credentials.expiresAt > now + 60_000,
        "account.credentials.expiresAt should be updated after refresh",
      )
    } finally {
      Date.now = originalNow
    }
  })

  it("getCachedCredentials returns null when no accounts are initialised", async () => {
    const { credentialsModule } = await loadCredentialsWithCountingKeychain(
      Date.now() + 10 * 60_000,
    )
    assert.equal(credentialsModule.getCachedCredentials(), null)
  })

  it("getCredentialsForSync returns cached credentials without triggering refresh", async () => {
    const originalNow = Date.now
    let now = 1_700_000_000_000
    Date.now = () => now

    try {
      const { credentialsModule, keychainModule } =
        await loadCredentialsWithCountingKeychain(now + 10 * 60_000)

      credentialsModule.initAccounts([
        {
          label: "Account 1",
          source: "keychain",
          credentials: {
            accessToken: "token",
            refreshToken: "refresh",
            expiresAt: now + 10 * 60_000,
          },
        },
      ])

      // Prime the cache
      credentialsModule.getCachedCredentials()

      // Advance time past cache TTL
      now += 31_000

      // getCredentialsForSync should return the account's current credentials
      // without triggering a keychain read (refresh)
      const readCountBefore = keychainModule.__getReadCount()
      const syncCreds = credentialsModule.getCredentialsForSync()
      const readCountAfter = keychainModule.__getReadCount()

      assert.ok(syncCreds)
      assert.equal(syncCreds.accessToken, "token")
      assert.equal(
        readCountAfter,
        readCountBefore,
        "should not trigger keychain read",
      )
    } finally {
      Date.now = originalNow
    }
  })
})

describe("syncAuthJson file permissions", () => {
  it("writes auth.json with mode 0o600", async () => {
    if (process.platform === "win32") return // Windows doesn't support Unix permissions

    const originalHome = process.env.HOME
    const tempHome = await mkdtemp(
      join(tmpdir(), "opencode-claude-auth-perms-"),
    )
    process.env.HOME = tempHome

    try {
      const tempDir = await mkdtemp(
        join(tmpdir(), "opencode-claude-auth-sync-"),
      )
      const tempCredentials = join(tempDir, "credentials.ts")
      const tempKeychain = join(tempDir, "keychain.ts")
      const tempBetas = join(tempDir, "betas.ts")
      const tempLogger = join(tempDir, "logger.ts")
      const sourceCredentials = await readFile(
        new URL("./credentials.ts", import.meta.url),
        "utf8",
      )
      const rewritten = sourceCredentials.replace(
        /from\s+["']\.\/(\w+)\.js["']/g,
        'from "./$1.ts"',
      )

      await writeFile(
        tempKeychain,
        `export function readAllClaudeAccounts() { return [] }
export function refreshAccount() { return null }
export function writeBackCredentials() { return true }
export function buildAccountLabels(creds) { return creds.map((_, i) => \`Account \${i + 1}\`) }`,
        "utf8",
      )
      await writeFile(
        tempBetas,
        `export function resetExcludedBetas() {}\n`,
        "utf8",
      )
      await writeFile(
        tempLogger,
        `export function log() {}\nexport function initLogger() {}\nexport function closeLogger() {}\n`,
        "utf8",
      )
      await writeFile(tempCredentials, rewritten, "utf8")

      const mod = await import(pathToFileURL(tempCredentials).href)
      mod.syncAuthJson({
        accessToken: "tok",
        refreshToken: "ref",
        expiresAt: Date.now() + 600_000,
      })

      const authPath = join(
        tempHome,
        ".local",
        "share",
        "opencode",
        "auth.json",
      )
      const stats = statSync(authPath)
      const mode = stats.mode & 0o777
      assert.equal(
        mode,
        0o600,
        `Expected file mode 0o600, got 0o${mode.toString(8)}`,
      )
    } finally {
      if (typeof originalHome === "string") {
        process.env.HOME = originalHome
      } else {
        delete process.env.HOME
      }
    }
  })

  it("tightens permissions on pre-existing auth.json from 0o644 to 0o600", async () => {
    if (process.platform === "win32") return

    const originalHome = process.env.HOME
    const tempHome = await mkdtemp(
      join(tmpdir(), "opencode-claude-auth-perms2-"),
    )
    process.env.HOME = tempHome

    try {
      // Create auth.json with permissive mode first
      const authDir = join(tempHome, ".local", "share", "opencode")
      mkdirSync(authDir, { recursive: true })
      const authPath = join(authDir, "auth.json")
      writeFileSync(authPath, "{}", { encoding: "utf-8", mode: 0o644 })
      chmodSync(authPath, 0o644) // Ensure 0o644 regardless of umask

      // Now call syncAuthJson which should tighten permissions
      const tempDir = await mkdtemp(
        join(tmpdir(), "opencode-claude-auth-sync2-"),
      )
      const tempCredentials = join(tempDir, "credentials.ts")
      const tempKeychain = join(tempDir, "keychain.ts")
      const tempBetas = join(tempDir, "betas.ts")
      const tempLogger = join(tempDir, "logger.ts")
      const sourceCredentials = await readFile(
        new URL("./credentials.ts", import.meta.url),
        "utf8",
      )
      const rewritten = sourceCredentials.replace(
        /from\s+["']\.\/(\w+)\.js["']/g,
        'from "./$1.ts"',
      )

      await writeFile(
        tempKeychain,
        `export function readAllClaudeAccounts() { return [] }
export function refreshAccount() { return null }
export function writeBackCredentials() { return true }
export function buildAccountLabels(creds) { return creds.map((_, i) => \`Account \${i + 1}\`) }`,
        "utf8",
      )
      await writeFile(
        tempBetas,
        `export function resetExcludedBetas() {}\n`,
        "utf8",
      )
      await writeFile(
        tempLogger,
        `export function log() {}\nexport function initLogger() {}\nexport function closeLogger() {}\n`,
        "utf8",
      )
      await writeFile(tempCredentials, rewritten, "utf8")

      const mod = await import(pathToFileURL(tempCredentials).href)
      mod.syncAuthJson({
        accessToken: "tok",
        refreshToken: "ref",
        expiresAt: Date.now() + 600_000,
      })

      const stats = statSync(authPath)
      const mode = stats.mode & 0o777
      assert.equal(
        mode,
        0o600,
        `Expected tightened mode 0o600, got 0o${mode.toString(8)}`,
      )
    } finally {
      if (typeof originalHome === "string") {
        process.env.HOME = originalHome
      } else {
        delete process.env.HOME
      }
    }
  })
})

describe("refreshViaOAuth", () => {
  it("is exported as a function", () => {
    assert.equal(typeof refreshViaOAuth, "function")
  })
})

describe("parseOAuthResponse", () => {
  const now = 1_700_000_000_000
  const currentRefresh = "sk-ant-ort01-current"

  it("parses a valid OAuth response with all fields", () => {
    const raw = JSON.stringify({
      access_token: "sk-ant-oat01-new",
      refresh_token: "sk-ant-ort01-new",
      expires_in: 28800,
      token_type: "Bearer",
    })
    const result = parseOAuthResponse(raw, currentRefresh, now)
    assert.ok(result)
    assert.equal(result.accessToken, "sk-ant-oat01-new")
    assert.equal(result.refreshToken, "sk-ant-ort01-new")
    assert.equal(result.expiresAt, now + 28800 * 1000)
  })

  it("returns null when access_token is missing", () => {
    const raw = JSON.stringify({ refresh_token: "rt", expires_in: 3600 })
    assert.equal(parseOAuthResponse(raw, currentRefresh, now), null)
  })

  it("returns null for an error response", () => {
    const raw = JSON.stringify({ error: "invalid_grant" })
    assert.equal(parseOAuthResponse(raw, currentRefresh, now), null)
  })

  it("falls back to current refresh token when response omits it", () => {
    const raw = JSON.stringify({
      access_token: "sk-ant-oat01-new",
      expires_in: 3600,
    })
    const result = parseOAuthResponse(raw, currentRefresh, now)
    assert.ok(result)
    assert.equal(result.refreshToken, currentRefresh)
  })

  it("defaults expires_in to 36000s (10h) when missing", () => {
    const raw = JSON.stringify({ access_token: "sk-ant-oat01-new" })
    const result = parseOAuthResponse(raw, currentRefresh, now)
    assert.ok(result)
    assert.equal(result.expiresAt, now + 36_000 * 1000)
  })

  it("returns null for invalid JSON", () => {
    assert.equal(parseOAuthResponse("not json {", currentRefresh, now), null)
  })

  it("returns null for empty string", () => {
    assert.equal(parseOAuthResponse("", currentRefresh, now), null)
  })
})
