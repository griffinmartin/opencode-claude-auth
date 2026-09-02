import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  refreshViaOAuth,
  parseOAuthResponse,
  extractOAuthError,
  OAUTH_SCOPE,
  OAUTH_TOKEN_URL,
} from "./credentials.ts"
import { Writable } from "node:stream"
import { closeLogger, initLogger } from "./logger.ts"
import { acquireRefreshLock } from "./refresh-lock.ts"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

// Keep the cross-process refresh lock off the real OpenCode data dir during
// tests, and isolated to this test process.
process.env.OPENCODE_CLAUDE_AUTH_REFRESH_LOCK_DIR = mkdtempSync(
  join(tmpdir(), "opencode-claude-auth-locktest-"),
)

type Creds = {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

// refreshViaOAuth now uses the runtime's fetch, so an unstubbed test would
// reach the real token endpoint. Fail closed; tests that exercise the OAuth
// path install their own stub and restore back to this one.
globalThis.fetch = (async () => {
  throw new Error("network disabled in test harness")
}) as typeof fetch

async function loadCredentialsWithCountingKeychain(
  initialExpiresAt: number,
): Promise<{
  credentialsModule: {
    getCachedCredentials: () => Promise<Creds | null>
    reloadCredentialsFromSource: () => Creds | null
    getCredentialsForSync: () => Creds | null
    refreshIfNeeded: (
      account?: {
        label: string
        source: string
        credentials: Creds
      },
      thresholdMs?: number,
    ) => Promise<Creds | null>
    initAccounts: (accounts: unknown[]) => void
    setActiveAccountSource: (source: string) => void
    getActiveAccount: () => unknown
    invalidateCredentialCache: () => void
    refreshAccountsList: () => unknown[]
    reloadActiveAccount: () => void
    forceRefreshActiveAccount: (
      refresh?: (refreshToken: string) => Promise<Creds | null>,
    ) => Promise<Creds | null>
    getActiveRefreshFailureKind: () => "transient" | "terminal" | null
  }
  keychainModule: {
    __getReadCount: () => number
    __getWriteCount: () => number
    __setCredentials: (c: Creds | null) => void
    __setCredentialsForSource: (source: string, c: Creds | null) => void
    __setAccounts: (list: unknown[]) => void
    __setReadError: (enabled: boolean) => void
    __setReadHook: (hook: (() => void) | null) => void
    __getWrites: () => Array<{
      source: string
      creds: Creds
      configDir?: string
      expectedPriorAccessToken?: string
    }>
    __getReads: () => Array<{ source: string; configDir?: string }>
    __setWriteResult: (v: boolean) => void
  }
  childProcessModule: {
    __getExecFileSyncCount: () => number
    __getExecSyncCount: () => number
    __setExecSyncError: (enabled: boolean) => void
    __setExecSyncHook: (hook: (() => void) | null) => void
    __getExecSyncCalls: () => Array<{
      command: string
      options?: { env?: Record<string, string | undefined> }
    }>
  }
  loggerModule: {
    __getLogs: () => Array<{ event: string; data?: unknown }>
  }
}> {
  const tempDir = await mkdtemp(join(tmpdir(), "opencode-claude-auth-creds-"))
  const tempKeychain = join(tempDir, "keychain.ts")
  const tempBetas = join(tempDir, "betas.ts")
  const tempChildProcess = join(tempDir, "child-process.ts")
  const tempLogger = join(tempDir, "logger.ts")
  const tempCredentials = join(tempDir, "credentials.ts")
  const tempHttp = join(tempDir, "http.ts")
  const sourceCredentials = await readFile(
    new URL("./credentials.ts", import.meta.url),
    "utf8",
  )
  // Real retry helper; its only dependency is the stubbed logger.
  await writeFile(
    tempHttp,
    await readFile(new URL("./http.ts", import.meta.url), "utf8"),
    "utf8",
  )
  const refreshBackoffSource = await readFile(
    new URL("./refresh-backoff.ts", import.meta.url),
    "utf8",
  )
  await writeFile(
    join(tempDir, "refresh-backoff.ts"),
    refreshBackoffSource.replace(
      "process.env.OPENCODE_CLAUDE_AUTH_REFRESH_STATE_DIR ??",
      `${JSON.stringify(tempDir)} ??`,
    ),
    "utf8",
  )
  await writeFile(
    join(tempDir, "refresh-lock.ts"),
    await readFile(new URL("./refresh-lock.ts", import.meta.url), "utf8"),
    "utf8",
  )
  const rewritten = sourceCredentials
    .replace(/from\s+["']\.\/(\w+)\.js["']/g, 'from "./$1.ts"')
    .replace(
      'import { execSync } from "node:child_process"',
      'import { execSync } from "./child-process.ts"',
    )

  await writeFile(
    tempLogger,
    `const logs = []
export function log(event, data) {
  logs.push({ event, data })
}
export function __getLogs() {
  return logs
}
export function initLogger() {}
export function closeLogger() {}
`,
    "utf8",
  )

  await writeFile(
    tempChildProcess,
    `let execFileSyncCount = 0
let execSyncCount = 0
const execSyncCalls = []
let execSyncError = false
let execSyncHook = null

export function execFileSync() {
  execFileSyncCount += 1
  throw new Error("oauth disabled in test harness")
}

export function execSync(command, options) {
  execSyncCount += 1
  execSyncCalls.push({ command, options })
  if (execSyncHook) execSyncHook()
  if (execSyncError) throw new Error("CLI timed out")
  return ""
}

export function __getExecFileSyncCount() {
  return execFileSyncCount
}

export function __getExecSyncCount() {
  return execSyncCount
}

export function __getExecSyncCalls() {
  return execSyncCalls
}

export function __setExecSyncError(enabled) {
  execSyncError = enabled
}

export function __setExecSyncHook(hook) {
  execSyncHook = hook
}
`,
    "utf8",
  )

  await writeFile(
    tempKeychain,
    `let readCount = 0
let writeCount = 0
const writes = []
const reads = []
let writeResult = true
let accounts = null // null = derive a single account from the credentials var
let readError = false
let readHook = null
let credentials = {
  accessToken: "token",
  refreshToken: "refresh",
  expiresAt: ${initialExpiresAt}
}
const bySource = {}

export const PRIMARY_SERVICE = "Claude Code-credentials"

export function readAllClaudeAccounts() {
  readCount += 1
  if (accounts !== null) return accounts
  return [{ label: "Account 1", source: "Claude Code-credentials", credentials }]
}

export function refreshAccount(source, configDir) {
  readCount += 1
  reads.push({ source, configDir })
  if (readError) throw new Error("Keychain read denied")
  if (readHook) readHook()
  if (Object.prototype.hasOwnProperty.call(bySource, source)) {
    return bySource[source]
  }
  return credentials
}

export function __setReadError(enabled) {
  readError = enabled
}

export function __setReadHook(hook) {
  readHook = hook
}

export function writeBackCredentials(source, creds, configDir, expectedPriorAccessToken) {
  writeCount += 1
  writes.push({ source, creds, configDir, expectedPriorAccessToken })
  return writeResult
}

export function __setWriteResult(v) {
  writeResult = v
}

export function __getWrites() {
  return writes
}

export function __getReads() {
  return reads
}

export function __getReadCount() {
  return readCount
}

export function __getWriteCount() {
  return writeCount
}

export function __setCredentials(c) {
  credentials = c
}

export function __setCredentialsForSource(source, c) {
  bySource[source] = c
}

export function __setAccounts(list) {
  accounts = list
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

  const [credentialsModule, keychainModule, childProcessModule] =
    await Promise.all([
      import(pathToFileURL(tempCredentials).href),
      import(pathToFileURL(tempKeychain).href),
      import(pathToFileURL(tempChildProcess).href),
    ])
  const loggerModule = await import(pathToFileURL(tempLogger).href)

  return {
    credentialsModule: credentialsModule as {
      getCachedCredentials: () => Promise<Creds | null>
      reloadCredentialsFromSource: () => Creds | null
      getCredentialsForSync: () => Creds | null
      refreshIfNeeded: (
        account?: {
          label: string
          source: string
          credentials: Creds
        },
        thresholdMs?: number,
      ) => Promise<Creds | null>
      initAccounts: (accounts: unknown[]) => void
      setActiveAccountSource: (source: string) => void
      getActiveAccount: () => unknown
      invalidateCredentialCache: () => void
      refreshAccountsList: () => unknown[]
      reloadActiveAccount: () => void
      forceRefreshActiveAccount: (
        refresh?: (refreshToken: string) => Promise<Creds | null>,
      ) => Promise<Creds | null>
    },
    keychainModule: keychainModule as {
      __getReadCount: () => number
      __getWriteCount: () => number
      __setCredentials: (c: Creds | null) => void
      __setCredentialsForSource: (source: string, c: Creds | null) => void
      __setAccounts: (list: unknown[]) => void
      __setReadError: (enabled: boolean) => void
      __setReadHook: (hook: (() => void) | null) => void
      __getWrites: () => Array<{
        source: string
        creds: Creds
        configDir?: string
        expectedPriorAccessToken?: string
      }>
      __getReads: () => Array<{ source: string; configDir?: string }>
      __setWriteResult: (v: boolean) => void
    },
    childProcessModule: childProcessModule as {
      __getExecFileSyncCount: () => number
      __getExecSyncCount: () => number
      __setExecSyncError: (enabled: boolean) => void
      __setExecSyncHook: (hook: (() => void) | null) => void
      __getExecSyncCalls: () => Array<{
        command: string
        options?: { env?: Record<string, string | undefined> }
      }>
    },
    loggerModule: loggerModule as {
      __getLogs: () => Array<{ event: string; data?: unknown }>
    },
  }
}

describe("credential caching", () => {
  it("reloadCredentialsFromSource bypasses cache and stores rotated Keychain credentials", async () => {
    const originalNow = Date.now
    const now = 1_700_000_000_000
    Date.now = () => now

    try {
      const { credentialsModule, keychainModule } =
        await loadCredentialsWithCountingKeychain(now + 10 * 60_000)

      credentialsModule.initAccounts([
        {
          label: "Account 1",
          source: "Claude Code-credentials",
          credentials: {
            accessToken: "old-token",
            refreshToken: "old-refresh",
            expiresAt: now + 10 * 60_000,
          },
        },
      ])

      // The source agrees with memory to begin with, so priming the cache
      // (which re-reads the source) leaves the account on "old-token".
      keychainModule.__setCredentialsForSource("Claude Code-credentials", {
        accessToken: "old-token",
        refreshToken: "old-refresh",
        expiresAt: now + 10 * 60_000,
      })

      assert.equal(
        (await credentialsModule.getCachedCredentials())?.accessToken,
        "old-token",
      )

      keychainModule.__setCredentialsForSource("Claude Code-credentials", {
        accessToken: "new-token",
        refreshToken: "new-refresh",
        expiresAt: now + 8 * 60 * 60_000,
      })

      const reloaded = credentialsModule.reloadCredentialsFromSource()
      const readCountAfterReload = keychainModule.__getReadCount()

      assert.equal(reloaded?.accessToken, "new-token")
      assert.equal(
        readCountAfterReload,
        2,
        "one re-read while priming the cache, one for the explicit reload",
      )
      assert.equal(
        (await credentialsModule.getCachedCredentials())?.accessToken,
        "new-token",
      )
      assert.equal(keychainModule.__getReadCount(), readCountAfterReload)
    } finally {
      Date.now = originalNow
    }
  })

  it("reloadCredentialsFromSource returns null when the source read throws", async () => {
    const originalNow = Date.now
    const now = 1_700_000_000_000
    Date.now = () => now

    try {
      const { credentialsModule, keychainModule } =
        await loadCredentialsWithCountingKeychain(now + 10 * 60_000)

      credentialsModule.initAccounts([
        {
          label: "Account 1",
          source: "Claude Code-credentials",
          credentials: {
            accessToken: "old-token",
            refreshToken: "old-refresh",
            expiresAt: now + 10 * 60_000,
          },
        },
      ])
      await credentialsModule.getCachedCredentials()
      keychainModule.__setReadError(true)

      assert.equal(credentialsModule.reloadCredentialsFromSource(), null)
      assert.equal(keychainModule.__getReadCount(), 2)
    } finally {
      Date.now = originalNow
    }
  })

  it("reloadCredentialsFromSource rejects credentials that enter the expiry buffer during source read", async () => {
    const originalNow = Date.now
    let now = 1_700_000_000_000
    Date.now = () => now

    try {
      const { credentialsModule, keychainModule } =
        await loadCredentialsWithCountingKeychain(now + 61_000)

      credentialsModule.initAccounts([
        {
          label: "Account 1",
          source: "Claude Code-credentials",
          credentials: {
            accessToken: "old-token",
            refreshToken: "old-refresh",
            expiresAt: now + 10 * 60_000,
          },
        },
      ])
      keychainModule.__setReadHook(() => {
        now += 2_000
      })

      assert.equal(credentialsModule.reloadCredentialsFromSource(), null)
    } finally {
      Date.now = originalNow
    }
  })

  it("reloadCredentialsFromSource returns null when the source is unavailable", async () => {
    const originalNow = Date.now
    const now = 1_700_000_000_000
    Date.now = () => now

    try {
      const { credentialsModule, keychainModule } =
        await loadCredentialsWithCountingKeychain(now + 10 * 60_000)

      credentialsModule.initAccounts([
        {
          label: "Account 1",
          source: "Claude Code-credentials",
          credentials: {
            accessToken: "old-token",
            refreshToken: "old-refresh",
            expiresAt: now + 10 * 60_000,
          },
        },
      ])
      keychainModule.__setCredentials(null)

      assert.equal(credentialsModule.reloadCredentialsFromSource(), null)
    } finally {
      Date.now = originalNow
    }
  })

  it("reloadCredentialsFromSource rejects a blank access token", async () => {
    const originalNow = Date.now
    const now = 1_700_000_000_000
    Date.now = () => now

    try {
      const { credentialsModule, keychainModule } =
        await loadCredentialsWithCountingKeychain(now + 10 * 60_000)

      credentialsModule.initAccounts([
        {
          label: "Account 1",
          source: "Claude Code-credentials",
          credentials: {
            accessToken: "old-token",
            refreshToken: "old-refresh",
            expiresAt: now + 10 * 60_000,
          },
        },
      ])
      keychainModule.__setCredentials({
        accessToken: "   ",
        refreshToken: "new-refresh",
        expiresAt: now + 8 * 60 * 60_000,
      })

      assert.equal(credentialsModule.reloadCredentialsFromSource(), null)
    } finally {
      Date.now = originalNow
    }
  })

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
          source: "Claude Code-credentials",
          credentials: {
            accessToken: "token",
            refreshToken: "refresh",
            expiresAt: now + 10 * 60_000,
          },
        },
      ])

      const first = await credentialsModule.getCachedCredentials()
      const second = await credentialsModule.getCachedCredentials()

      assert.ok(first)
      assert.ok(second)
      assert.equal(
        keychainModule.__getReadCount(),
        1,
        "cache miss re-reads the source once; the cached call does not",
      )
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
          source: "Claude Code-credentials",
          credentials: {
            accessToken: "token",
            refreshToken: "refresh",
            expiresAt: now + 10 * 60_000,
          },
        },
      ])

      const first = await credentialsModule.getCachedCredentials()
      assert.ok(first)

      now += 31_000

      const second = await credentialsModule.getCachedCredentials()
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
        source: "Claude Code-credentials",
        credentials: {
          accessToken: "old-token",
          refreshToken: "old-refresh",
          expiresAt: now + 30_000, // expires in 30s, below 60s threshold
        },
      }

      credentialsModule.initAccounts([account])

      // First call should trigger refresh (token expiring within 60s)
      const result = await credentialsModule.getCachedCredentials()
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
    assert.equal(await credentialsModule.getCachedCredentials(), null)
  })

  it("does not fall back to the first account when the selected source is missing", async () => {
    const now = Date.now()
    const { credentialsModule } = await loadCredentialsWithCountingKeychain(
      now + 10 * 60_000,
    )
    credentialsModule.initAccounts([
      {
        label: "Account 1",
        source: "account-1",
        credentials: {
          accessToken: "account-1-token",
          refreshToken: "account-1-refresh",
          expiresAt: now + 10 * 60_000,
        },
      },
    ])
    credentialsModule.setActiveAccountSource("missing-account")

    assert.equal(credentialsModule.getActiveAccount(), null)
    assert.equal(await credentialsModule.getCachedCredentials(), null)
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
          source: "Claude Code-credentials",
          credentials: {
            accessToken: "token",
            refreshToken: "refresh",
            expiresAt: now + 10 * 60_000,
          },
        },
      ])

      // Prime the cache
      await credentialsModule.getCachedCredentials()

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

  it("refreshIfNeeded reloads file-source credentials from disk on every call", async () => {
    const originalNow = Date.now
    const now = 1_700_000_000_000
    Date.now = () => now

    try {
      const { credentialsModule, keychainModule } =
        await loadCredentialsWithCountingKeychain(now + 10 * 60_000)

      const account = {
        label: "Account 1",
        source: "file",
        credentials: {
          accessToken: "old-token",
          refreshToken: "old-refresh",
          expiresAt: now + 10 * 60_000,
        },
      }

      // External writer (e.g. switch_claude_account) replaces .credentials.json
      keychainModule.__setCredentials({
        accessToken: "new-token",
        refreshToken: "new-refresh",
        expiresAt: now + 10 * 60_000,
      })

      const result = await credentialsModule.refreshIfNeeded(account)

      assert.ok(result)
      assert.equal(
        result.accessToken,
        "new-token",
        "should return on-disk creds, not the stale in-memory copy",
      )
      assert.equal(
        account.credentials.accessToken,
        "new-token",
        "account.credentials should be updated in place so future calls see the new tokens",
      )
    } finally {
      Date.now = originalNow
    }
  })

  it("refreshAccountsList keeps existing accounts when the source reads empty", async () => {
    const now = Date.now()
    const { credentialsModule, keychainModule } =
      await loadCredentialsWithCountingKeychain(now + 10 * 60_000)

    credentialsModule.initAccounts([
      {
        label: "Account 1",
        source: "Claude Code-credentials",
        credentials: {
          accessToken: "token",
          refreshToken: "refresh",
          expiresAt: now + 10 * 60_000,
        },
      },
    ])

    // Transient empty read (e.g. keychain race while the claude CLI
    // rewrites credentials) must not clobber a working session.
    keychainModule.__setAccounts([])
    const result = credentialsModule.refreshAccountsList()

    assert.equal(
      result.length,
      1,
      "must not clobber a healthy session with an empty account list",
    )
    assert.ok(
      await credentialsModule.getCachedCredentials(),
      "credentials must remain available after the empty read",
    )
  })

  it("refreshIfNeeded adopts the active account when its keychain entry was refreshed externally", async () => {
    const originalNow = Date.now
    const now = 1_700_000_000_000
    Date.now = () => now

    try {
      const { credentialsModule, keychainModule } =
        await loadCredentialsWithCountingKeychain(now - 1_000)

      // The active account's live keychain entry was refreshed externally
      // after its in-memory credentials expired.
      credentialsModule.initAccounts([
        {
          label: "Account 1",
          source: "Claude Code-credentials-aabbccdd",
          credentials: {
            accessToken: "stale-suffixed",
            refreshToken: "rt-suffixed",
            expiresAt: now - 1_000,
          },
        },
        {
          label: "Account 2",
          source: "Claude Code-credentials",
          credentials: {
            accessToken: "stale-primary",
            refreshToken: "rt-primary",
            expiresAt: now - 1_000,
          },
        },
      ])

      keychainModule.__setCredentials({
        accessToken: "externally-refreshed",
        refreshToken: "rt-new",
        expiresAt: now + 8 * 60 * 60_000,
      })

      const result = await credentialsModule.refreshIfNeeded()

      assert.equal(
        result?.accessToken,
        "externally-refreshed",
        "stale in-memory expiry must not prevent a live active-source read",
      )
    } finally {
      Date.now = originalNow
    }
  })

  it("never substitutes another account when the selected account cannot refresh", async () => {
    const originalNow = Date.now
    const now = 1_700_000_000_000
    Date.now = () => now

    try {
      const { credentialsModule, keychainModule } =
        await loadCredentialsWithCountingKeychain(now - 1_000)

      // Pin the expired account's own stored value so the up-front re-read is
      // a no-op rather than swapping in the other account's blob.
      keychainModule.__setCredentialsForSource(
        "Claude Code-credentials-aabbccdd",
        {
          accessToken: "stale-suffixed",
          refreshToken: "rt-suffixed",
          expiresAt: now - 1_000,
        },
      )

      const readsBefore = keychainModule.__getReads().length
      const selected = {
        label: "Account 1",
        source: "Claude Code-credentials-aabbccdd",
        credentials: {
          accessToken: "stale-suffixed",
          refreshToken: "rt-suffixed",
          expiresAt: now - 1_000,
        },
      }
      credentialsModule.initAccounts([
        selected,
        {
          label: "Account 2",
          source: "Claude Code-credentials",
          credentials: {
            accessToken: "fresh-in-memory",
            refreshToken: "rt-primary",
            expiresAt: now + 8 * 60 * 60_000,
          },
        },
      ])
      const result = await credentialsModule.refreshIfNeeded(selected)

      assert.equal(result, null)
      assert.equal(selected.credentials.accessToken, "stale-suffixed")
      const reads = keychainModule.__getReads().slice(readsBefore)
      assert.ok(reads.length > 0)
      assert.ok(
        reads.every(({ source }) => source === selected.source),
        "only the selected account source may be re-read",
      )
    } finally {
      Date.now = originalNow
    }
  })

  it("reloadActiveAccount picks up rotated keychain credentials in place", async () => {
    const now = Date.now()
    const { credentialsModule, keychainModule } =
      await loadCredentialsWithCountingKeychain(now + 10 * 60_000)

    // A 401 must reload the source immediately rather than waiting for the
    // next refreshIfNeeded, which the 30s credential cache can defer.
    const account = {
      label: "Account 1",
      source: "Claude Code-credentials",
      credentials: {
        accessToken: "token",
        refreshToken: "refresh",
        expiresAt: now + 10 * 60_000,
      },
    }
    credentialsModule.initAccounts([account])

    keychainModule.__setCredentials({
      accessToken: "rotated",
      refreshToken: "rotated-refresh",
      expiresAt: now + 10 * 60_000,
    })

    credentialsModule.reloadActiveAccount()

    assert.equal(account.credentials.accessToken, "rotated")
  })

  // Every other refreshAccount call site in credentials.ts forwards the
  // account's configDir; these two re-read paths did not. Unreachable while
  // readAllClaudeAccounts assigns every file account
  // `CLAUDE_CONFIG_DIR ?? ~/.claude` — exactly what readCredentialsFile
  // recomputes by default — but the CAS guard added here compares a read
  // against a write, so the two must resolve the same file by construction
  // rather than by coincidence.
  it("reloadCredentialsFromSource reads the account's own configDir", async () => {
    const now = Date.now()
    const { credentialsModule, keychainModule } =
      await loadCredentialsWithCountingKeychain(now + 10 * 60_000)

    credentialsModule.initAccounts([
      {
        label: "Account 1",
        source: "file",
        configDir: "/custom/config/dir",
        credentials: {
          accessToken: "token",
          refreshToken: "refresh",
          expiresAt: now + 10 * 60_000,
        },
      },
    ])

    const readsBefore = keychainModule.__getReads().length
    credentialsModule.reloadCredentialsFromSource()

    const reads = keychainModule.__getReads().slice(readsBefore)
    assert.ok(reads.length > 0, "expected a source read")
    assert.equal(
      reads[reads.length - 1].configDir,
      "/custom/config/dir",
      "the re-read must target the account's own config directory",
    )
  })

  it("reloadActiveAccount reads the account's own configDir", async () => {
    const now = Date.now()
    const { credentialsModule, keychainModule } =
      await loadCredentialsWithCountingKeychain(now + 10 * 60_000)

    credentialsModule.initAccounts([
      {
        label: "Account 1",
        source: "file",
        configDir: "/custom/config/dir",
        credentials: {
          accessToken: "token",
          refreshToken: "refresh",
          expiresAt: now + 10 * 60_000,
        },
      },
    ])

    const readsBefore = keychainModule.__getReads().length
    credentialsModule.reloadActiveAccount()

    const reads = keychainModule.__getReads().slice(readsBefore)
    assert.ok(reads.length > 0, "expected a source read")
    assert.equal(
      reads[reads.length - 1].configDir,
      "/custom/config/dir",
      "the re-read must target the account's own config directory",
    )
  })

  it("forceRefreshActiveAccount swaps in OAuth-refreshed credentials and writes back", async () => {
    const now = Date.now()
    const { credentialsModule, keychainModule } =
      await loadCredentialsWithCountingKeychain(now + 10 * 60_000)

    const account = {
      label: "Account 1",
      source: "Claude Code-credentials",
      credentials: {
        accessToken: "rejected-token",
        refreshToken: "refresh-token",
        expiresAt: now + 10 * 60_000,
      },
    }
    credentialsModule.initAccounts([account])

    const newCreds = {
      accessToken: "oauth-refreshed",
      refreshToken: "new-refresh",
      expiresAt: now + 10 * 60_000,
    }
    const seenRefreshTokens: string[] = []
    const writesBefore = keychainModule.__getWriteCount()

    const result = await credentialsModule.forceRefreshActiveAccount(
      (token) => {
        seenRefreshTokens.push(token)
        return newCreds
      },
    )

    assert.ok(result)
    assert.equal(result.accessToken, "oauth-refreshed")
    assert.deepEqual(seenRefreshTokens, ["refresh-token"])
    assert.equal(account.credentials.accessToken, "oauth-refreshed")
    assert.equal(
      keychainModule.__getWriteCount(),
      writesBefore + 1,
      "refreshed credentials must be written back to the source",
    )
    const cached = await credentialsModule.getCachedCredentials()
    assert.equal(
      cached?.accessToken,
      "oauth-refreshed",
      "cache must serve the refreshed token immediately",
    )
  })

  // The token must be captured before the await: account.credentials is
  // reassigned to the refreshed pair before write-back runs, so reading it at
  // the call site would compare the new token against the store and skip
  // every write.
  it("forceRefreshActiveAccount guards write-back with the pre-refresh token", async () => {
    const now = Date.now()
    const { credentialsModule, keychainModule } =
      await loadCredentialsWithCountingKeychain(now + 10 * 60_000)

    const account = {
      label: "Account 1",
      source: "Claude Code-credentials",
      credentials: {
        accessToken: "rejected-token",
        refreshToken: "refresh-token",
        expiresAt: now + 10 * 60_000,
      },
    }
    credentialsModule.initAccounts([account])

    const writesBefore = keychainModule.__getWrites().length

    await credentialsModule.forceRefreshActiveAccount(async () => ({
      accessToken: "oauth-refreshed",
      refreshToken: "new-refresh",
      expiresAt: now + 10 * 60_000,
    }))

    const writes = keychainModule.__getWrites()
    assert.equal(writes.length, writesBefore + 1)
    const write = writes[writes.length - 1]
    assert.equal(write.creds.accessToken, "oauth-refreshed")
    assert.equal(
      write.expectedPriorAccessToken,
      "rejected-token",
      "the guard must carry the token the refresh was issued against",
    )
  })

  it("forceRefreshActiveAccount returns null and leaves the account untouched on failure", async () => {
    const now = Date.now()
    const { credentialsModule } = await loadCredentialsWithCountingKeychain(
      now + 10 * 60_000,
    )

    const account = {
      label: "Account 1",
      source: "Claude Code-credentials",
      credentials: {
        accessToken: "rejected-token",
        refreshToken: "refresh-token",
        expiresAt: now + 10 * 60_000,
      },
    }
    credentialsModule.initAccounts([account])

    const result = await credentialsModule.forceRefreshActiveAccount(() => null)

    assert.equal(result, null)
    assert.equal(account.credentials.accessToken, "rejected-token")
  })

  it("forceRefreshActiveAccount applies account cooldown after a transient failure", async () => {
    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return new Response(JSON.stringify({ error: "rate_limit_error" }), {
        status: 429,
      })
    }) as typeof fetch

    try {
      const now = Date.now()
      const { credentialsModule, keychainModule } =
        await loadCredentialsWithCountingKeychain(now + 10 * 60_000)
      credentialsModule.initAccounts([
        {
          label: "Account 1",
          source: "Claude Code-credentials",
          credentials: {
            accessToken: "rejected-token",
            refreshToken: "refresh-token",
            expiresAt: now + 10 * 60_000,
          },
        },
      ])
      keychainModule.__setCredentials({
        accessToken: "rejected-token",
        refreshToken: "refresh-token",
        expiresAt: now + 10 * 60_000,
      })

      assert.equal(await credentialsModule.forceRefreshActiveAccount(), null)
      assert.equal(await credentialsModule.forceRefreshActiveAccount(), null)
      assert.equal(calls, 1)
      assert.equal(credentialsModule.getActiveRefreshFailureKind(), "transient")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("invalidateCredentialCache forces the next read to bypass the 30s TTL", async () => {
    const originalNow = Date.now
    const now = 1_700_000_000_000
    Date.now = () => now

    try {
      const { credentialsModule, keychainModule } =
        await loadCredentialsWithCountingKeychain(now + 10 * 60_000)

      const account = {
        label: "Account 1",
        source: "file",
        credentials: {
          accessToken: "token",
          refreshToken: "refresh",
          expiresAt: now + 10 * 60_000,
        },
      }
      credentialsModule.initAccounts([account])

      // Prime the cache
      const first = await credentialsModule.getCachedCredentials()
      assert.ok(first)

      // Server-side rotation: on-disk credentials change, but the local
      // copy still looks valid so the cache would serve it for 30s.
      keychainModule.__setCredentials({
        accessToken: "rotated-token",
        refreshToken: "rotated-refresh",
        expiresAt: now + 10 * 60_000,
      })

      const cached = await credentialsModule.getCachedCredentials()
      assert.ok(cached)
      assert.equal(
        cached.accessToken,
        "token",
        "within TTL the stale token is served from cache",
      )

      // After invalidation (e.g. a 401 from the API), the next read must
      // go back to the source instead of serving the rejected token.
      credentialsModule.invalidateCredentialCache()
      const fresh = await credentialsModule.getCachedCredentials()
      assert.ok(fresh)
      assert.equal(fresh.accessToken, "rotated-token")
    } finally {
      Date.now = originalNow
    }
  })

  it("refreshIfNeeded skips OAuth refresh writeback when on-disk file source is fresh", async () => {
    const originalNow = Date.now
    const now = 1_700_000_000_000
    Date.now = () => now

    try {
      const { credentialsModule, keychainModule } =
        await loadCredentialsWithCountingKeychain(now + 10 * 60_000)

      // In-memory copy is expiring within the 60s threshold (would normally
      // trigger the OAuth-refresh + writeBackCredentials path).
      const account = {
        label: "Account 1",
        source: "file",
        credentials: {
          accessToken: "stale-token",
          refreshToken: "stale-refresh",
          expiresAt: now + 30_000,
        },
      }

      // External writer already replaced the file with fresh creds.
      keychainModule.__setCredentials({
        accessToken: "fresh-token",
        refreshToken: "fresh-refresh",
        expiresAt: now + 10 * 60_000,
      })

      const writeCountBefore = keychainModule.__getWriteCount()
      const result = await credentialsModule.refreshIfNeeded(account)
      const writeCountAfter = keychainModule.__getWriteCount()

      assert.ok(result)
      assert.equal(result.accessToken, "fresh-token")
      assert.equal(
        writeCountAfter,
        writeCountBefore,
        "writeBackCredentials must not run when on-disk creds are already fresh; otherwise the stale in-memory refreshToken would be spliced into the new account's JSON blob",
      )
    } finally {
      Date.now = originalNow
    }
  })

  it("refreshIfNeeded adopts credentials rotated externally in a keychain source", async () => {
    const originalNow = Date.now
    const now = 1_700_000_000_000
    Date.now = () => now

    try {
      const { credentialsModule, keychainModule } =
        await loadCredentialsWithCountingKeychain(now + 10 * 60_000)

      credentialsModule.initAccounts([
        {
          label: "Account 1",
          source: "Claude Code-credentials",
          credentials: {
            accessToken: "before-switch",
            refreshToken: "rt-before",
            expiresAt: now + 10 * 60_000,
          },
        },
      ])

      // An external process (cswap, the claude CLI, a second OpenCode)
      // replaces the stored credential with a different account's.
      keychainModule.__setCredentials({
        accessToken: "after-switch",
        refreshToken: "rt-after",
        expiresAt: now + 10 * 60_000,
      })

      const result = await credentialsModule.refreshIfNeeded()

      assert.equal(result?.accessToken, "after-switch")
    } finally {
      Date.now = originalNow
    }
  })

  // writeBackCredentials can fail while the read that precedes it succeeds:
  // a malformed stored blob makes updateCredentialBlob return null, and an
  // ACL can permit reads but not add-generic-password. performRefresh
  // discards that false, so memory ends up holding freshly refreshed
  // credentials while the store still holds the pre-refresh blob — which,
  // because we only refresh inside the 60s window, has under 60s left.
  // Adopting it would re-enter performRefresh with a refresh token our own
  // successful refresh just rotated dead, failing over to two 60s claude
  // spawns on every cache miss, forever.
  it("refreshIfNeeded does not adopt a stale stored blob over valid in-memory credentials", async () => {
    const originalNow = Date.now
    const now = 1_700_000_000_000
    Date.now = () => now

    try {
      const { credentialsModule, keychainModule, childProcessModule } =
        await loadCredentialsWithCountingKeychain(now + 10 * 60_000)

      credentialsModule.initAccounts([
        {
          label: "Account 1",
          source: "Claude Code-credentials",
          credentials: {
            accessToken: "fresh-in-memory",
            refreshToken: "rt-fresh",
            expiresAt: now + 10 * 60_000,
          },
        },
      ])

      // The store still holds the pre-refresh blob the failed write-back
      // never replaced.
      keychainModule.__setCredentials({
        accessToken: "stale-in-store",
        refreshToken: "rt-stale",
        expiresAt: now + 30_000,
      })

      const result = await credentialsModule.refreshIfNeeded()

      assert.equal(result?.accessToken, "fresh-in-memory")
      assert.equal(
        childProcessModule.__getExecSyncCount(),
        0,
        "adopting the stale blob would fail OAuth and fall through to the CLI",
      )
    } finally {
      Date.now = originalNow
    }
  })

  // Complement of the test above: the guard must decline only the unusable
  // blob. If it declined whenever memory was valid, external rotation would
  // stop being picked up and this task's whole premise would regress.
  it("refreshIfNeeded adopts a usable stored blob even when memory is still valid", async () => {
    const originalNow = Date.now
    const now = 1_700_000_000_000
    Date.now = () => now

    try {
      const { credentialsModule, keychainModule } =
        await loadCredentialsWithCountingKeychain(now + 10 * 60_000)

      const account = {
        label: "Account 1",
        source: "Claude Code-credentials",
        credentials: {
          accessToken: "in-memory-valid",
          refreshToken: "rt-memory",
          expiresAt: now + 10 * 60_000,
        },
      }
      credentialsModule.initAccounts([account])

      keychainModule.__setCredentials({
        accessToken: "rotated-in-store",
        refreshToken: "rt-rotated",
        expiresAt: now + 8 * 60 * 60_000,
      })

      const result = await credentialsModule.refreshIfNeeded()

      assert.equal(result?.accessToken, "rotated-in-store")
      assert.equal(
        account.credentials.accessToken,
        "rotated-in-store",
        "the adoption must land on the account so later calls see it",
      )
    } finally {
      Date.now = originalNow
    }
  })

  it("refreshIfNeeded keeps in-memory credentials when the source read throws", async () => {
    const originalNow = Date.now
    const now = 1_700_000_000_000
    Date.now = () => now

    try {
      const { credentialsModule, keychainModule } =
        await loadCredentialsWithCountingKeychain(now + 10 * 60_000)

      credentialsModule.initAccounts([
        {
          label: "Account 1",
          source: "Claude Code-credentials",
          credentials: {
            accessToken: "in-memory",
            refreshToken: "rt",
            expiresAt: now + 10 * 60_000,
          },
        },
      ])

      keychainModule.__setReadError(true)

      const result = await credentialsModule.refreshIfNeeded()

      assert.equal(result?.accessToken, "in-memory")
    } finally {
      Date.now = originalNow
    }
  })

  it("performRefresh passes the pre-refresh token as the write-back guard", async () => {
    const originalNow = Date.now
    const now = 1_700_000_000_000
    Date.now = () => now
    const originalFetch = globalThis.fetch

    try {
      const { credentialsModule, keychainModule } =
        await loadCredentialsWithCountingKeychain(now - 60_000)

      keychainModule.__setCredentials({
        accessToken: "stale-token",
        refreshToken: "rt-stale",
        expiresAt: now - 60_000,
      })

      credentialsModule.initAccounts([
        {
          label: "Account 1",
          source: "Claude Code-credentials",
          credentials: {
            accessToken: "stale-token",
            refreshToken: "rt-stale",
            expiresAt: now - 60_000,
          },
        },
      ])

      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            access_token: "rotated-token",
            refresh_token: "rt-rotated",
            expires_in: 36_000,
          }),
          { status: 200 },
        )) as typeof fetch

      await credentialsModule.refreshIfNeeded()

      const writes = keychainModule.__getWrites()
      assert.equal(writes.length, 1)
      assert.equal(writes[0].creds.accessToken, "rotated-token")
      assert.equal(writes[0].expectedPriorAccessToken, "stale-token")
    } finally {
      Date.now = originalNow
      globalThis.fetch = originalFetch
    }
  })

  // forceRefreshActiveAccount logs force_refresh_writeback_failed on the same
  // condition; performRefresh discarded the return value entirely, so a
  // rejected write-back left no trace anywhere in the debug log. The session
  // continues from memory either way — this pins the observability, not a
  // control-flow change.
  it("performRefresh logs a rejected write-back", async () => {
    const originalNow = Date.now
    const now = 1_700_000_000_000
    Date.now = () => now
    const originalFetch = globalThis.fetch

    try {
      const { credentialsModule, keychainModule, loggerModule } =
        await loadCredentialsWithCountingKeychain(now - 60_000)

      keychainModule.__setCredentials({
        accessToken: "stale-token",
        refreshToken: "rt-stale",
        expiresAt: now - 60_000,
      })

      credentialsModule.initAccounts([
        {
          label: "Account 1",
          source: "Claude Code-credentials",
          credentials: {
            accessToken: "stale-token",
            refreshToken: "rt-stale",
            expiresAt: now - 60_000,
          },
        },
      ])

      // An external switch landed inside the OAuth round trip, so the CAS in
      // writeBackCredentials rejects the write.
      keychainModule.__setWriteResult(false)

      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            access_token: "rotated-token",
            refresh_token: "rt-rotated",
            expires_in: 36_000,
          }),
          { status: 200 },
        )) as typeof fetch

      const result = await credentialsModule.refreshIfNeeded()

      assert.equal(
        result?.accessToken,
        "rotated-token",
        "the caller still receives the refreshed credentials",
      )
      assert.ok(
        loggerModule
          .__getLogs()
          .some((entry) => entry.event === "refresh_writeback_failed"),
        "a rejected write-back must be visible in the debug log",
      )
    } finally {
      Date.now = originalNow
      globalThis.fetch = originalFetch
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
      await writeFile(
        join(tempDir, "http.ts"),
        await readFile(new URL("./http.ts", import.meta.url), "utf8"),
        "utf8",
      )
      await writeFile(
        join(tempDir, "refresh-backoff.ts"),
        await readFile(
          new URL("./refresh-backoff.ts", import.meta.url),
          "utf8",
        ),
        "utf8",
      )
      await writeFile(
        join(tempDir, "refresh-lock.ts"),
        await readFile(new URL("./refresh-lock.ts", import.meta.url), "utf8"),
        "utf8",
      )
      const rewritten = sourceCredentials.replace(
        /from\s+["']\.\/(\w+)\.js["']/g,
        'from "./$1.ts"',
      )

      await writeFile(
        tempKeychain,
        `export const PRIMARY_SERVICE = "Claude Code-credentials"
export function readAllClaudeAccounts() { return [] }
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
      await writeFile(
        join(tempDir, "http.ts"),
        await readFile(new URL("./http.ts", import.meta.url), "utf8"),
        "utf8",
      )
      await writeFile(
        join(tempDir, "refresh-backoff.ts"),
        await readFile(
          new URL("./refresh-backoff.ts", import.meta.url),
          "utf8",
        ),
        "utf8",
      )
      await writeFile(
        join(tempDir, "refresh-lock.ts"),
        await readFile(new URL("./refresh-lock.ts", import.meta.url), "utf8"),
        "utf8",
      )
      const rewritten = sourceCredentials.replace(
        /from\s+["']\.\/(\w+)\.js["']/g,
        'from "./$1.ts"',
      )

      await writeFile(
        tempKeychain,
        `export const PRIMARY_SERVICE = "Claude Code-credentials"
export function readAllClaudeAccounts() { return [] }
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

  // Regression: the previous implementation shelled out to
  // `execFileSync(process.execPath, ["-e", script])`. Inside OpenCode,
  // process.execPath is the compiled single-file binary, which does not
  // evaluate `-e` scripts, so every OAuth refresh failed silently and the
  // plugin fell back to spawning the claude CLI.
  it("refreshes through the runtime fetch rather than spawning a child process", async () => {
    const originalFetch = globalThis.fetch
    const originalNow = Date.now
    const now = 1_700_000_000_000
    Date.now = () => now

    let requestUrl: string | null = null
    let requestBody: string | null = null
    let requestMethod: string | undefined
    let requestHeaders: HeadersInit | undefined

    globalThis.fetch = (async (
      url: string | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      requestUrl = String(url)
      requestBody = String(init?.body ?? "")
      requestMethod = init?.method
      requestHeaders = init?.headers
      return new Response(
        JSON.stringify({
          access_token: "sk-ant-oat01-fresh",
          refresh_token: "sk-ant-ort01-fresh",
          expires_in: 28_800,
        }),
        { status: 200 },
      )
    }) as typeof fetch

    try {
      const result = await refreshViaOAuth("sk-ant-ort01-current")

      assert.ok(result, "expected credentials from the OAuth endpoint")
      assert.equal(result.accessToken, "sk-ant-oat01-fresh")
      assert.equal(result.refreshToken, "sk-ant-ort01-fresh")
      assert.equal(result.expiresAt, now + 28_800 * 1000)
      assert.equal(requestUrl, OAUTH_TOKEN_URL)
      assert.equal(requestMethod, "POST")
      assert.deepEqual(requestHeaders, { "Content-Type": "application/json" })
      assert.deepEqual(JSON.parse(String(requestBody)), {
        grant_type: "refresh_token",
        client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
        refresh_token: "sk-ant-ort01-current",
        scope: OAUTH_SCOPE,
      })
    } finally {
      globalThis.fetch = originalFetch
      Date.now = originalNow
    }
  })

  it("returns null when the OAuth endpoint rejects the refresh token", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
      })) as typeof fetch

    try {
      assert.equal(await refreshViaOAuth("sk-ant-ort01-stale"), null)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("returns null instead of hanging when the request outlives its timeout", async () => {
    const originalFetch = globalThis.fetch
    let aborted = false

    globalThis.fetch = ((_url: string | URL, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            resolve(
              new Response(
                JSON.stringify({
                  access_token: "sk-ant-oat01-too-late",
                  expires_in: 28_800,
                }),
                { status: 200 },
              ),
            ),
          2_000,
        )
        init?.signal?.addEventListener("abort", () => {
          aborted = true
          clearTimeout(timer)
          reject(new DOMException("The operation was aborted.", "AbortError"))
        })
      })) as typeof fetch

    try {
      assert.equal(await refreshViaOAuth("sk-ant-ort01-current", 20), null)
      assert.equal(aborted, true, "expected the request to be aborted")
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("returns after one rate-limited request so account backoff owns retries", async () => {
    const originalFetch = globalThis.fetch
    let calls = 0

    globalThis.fetch = (async () => {
      calls += 1
      return new Response(JSON.stringify({ error: "rate_limited" }), {
        status: 429,
      })
    }) as typeof fetch

    try {
      assert.equal(await refreshViaOAuth("sk-ant-ort01-current"), null)
      assert.equal(calls, 1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("returns null when the OAuth request throws", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => {
      throw new Error("network unreachable")
    }) as typeof fetch

    try {
      assert.equal(await refreshViaOAuth("sk-ant-ort01-current"), null)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it("logs the token endpoint's failure reason on a rejected refresh", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "Refresh token not found or invalid",
        }),
        { status: 400 },
      )) as typeof fetch

    const lines: string[] = []
    initLogger({
      stream: new Writable({
        write(chunk, _enc, cb) {
          lines.push(chunk.toString())
          cb()
        },
      }),
    })

    try {
      assert.equal(await refreshViaOAuth("sk-ant-ort01-stale"), null)
      const entry = lines
        .map((l) => JSON.parse(l) as Record<string, unknown>)
        .find((e) => e.event === "refresh_failed")
      assert.ok(entry, "expected a refresh_failed log line")
      assert.equal(entry.error, "HTTP 400")
      assert.equal(entry.oauthError, "invalid_grant")
      assert.equal(
        entry.oauthErrorDescription,
        "Refresh token not found or invalid",
      )
    } finally {
      closeLogger()
      globalThis.fetch = originalFetch
    }
  })
})

describe("extractOAuthError", () => {
  it("extracts the OAuth error and description", () => {
    assert.deepEqual(
      extractOAuthError(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "Refresh token not found or invalid",
        }),
      ),
      {
        oauthError: "invalid_grant",
        oauthErrorDescription: "Refresh token not found or invalid",
      },
    )
  })

  it("handles Anthropic's nested error envelope", () => {
    assert.deepEqual(
      extractOAuthError(
        JSON.stringify({
          error: { type: "rate_limit_error", message: "Rate limited." },
        }),
      ),
      {
        oauthError: "rate_limit_error",
        oauthErrorDescription: "Rate limited.",
      },
    )
  })

  it("returns an empty object for non-JSON bodies", () => {
    assert.deepEqual(extractOAuthError("<html>gateway error</html>"), {})
  })

  it("returns an empty object when no error field is present", () => {
    assert.deepEqual(extractOAuthError(JSON.stringify({ ok: true })), {})
  })

  it("truncates overly long descriptions", () => {
    const long = "x".repeat(1000)
    const result = extractOAuthError(
      JSON.stringify({ error: "server_error", error_description: long }),
    )
    assert.equal(result.oauthError, "server_error")
    assert.equal(result.oauthErrorDescription?.length, 500)
  })

  it("returns an empty object for JSON primitives and arrays without throwing", () => {
    // JSON.parse("null") === null etc. — must not crash the error-logging path.
    for (const body of ["null", "123", '"a string"', "[1,2,3]", "true"]) {
      assert.deepEqual(extractOAuthError(body), {}, `body: ${body}`)
    }
  })

  it("prefers the flat error_description over a nested message when both are present", () => {
    const result = extractOAuthError(
      JSON.stringify({
        error: { type: "foo", message: "nested" },
        error_description: "flat",
      }),
    )
    assert.equal(result.oauthError, "foo")
    assert.equal(result.oauthErrorDescription, "flat")
  })
})

function makeAccount(expiresAt: number) {
  return {
    label: "Account 1",
    source: "Claude Code-credentials",
    credentials: {
      accessToken: "existing-token",
      refreshToken: "existing-refresh",
      expiresAt,
    },
  }
}

describe("refreshIfNeeded CLI fallback scope", () => {
  it("refreshes via OAuth without spawning the claude CLI", async () => {
    const originalFetch = globalThis.fetch
    const originalNow = Date.now
    const now = 1_700_000_000_000
    Date.now = () => now

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          access_token: "sk-ant-oat01-fresh",
          refresh_token: "sk-ant-ort01-fresh",
          expires_in: 28_800,
        }),
        { status: 200 },
      )) as typeof fetch

    try {
      const { credentialsModule, childProcessModule } =
        await loadCredentialsWithCountingKeychain(now + 30_000)
      const target = makeAccount(now + 30_000)
      credentialsModule.initAccounts([target])

      const result = await credentialsModule.refreshIfNeeded(target)

      assert.equal(result?.accessToken, "sk-ant-oat01-fresh")
      assert.equal(
        childProcessModule.__getExecSyncCount(),
        0,
        "claude CLI must not be spawned when OAuth succeeds",
      )
    } finally {
      globalThis.fetch = originalFetch
      Date.now = originalNow
    }
  })

  // Regression for the proactive-refresh window (1h). The claude CLI only
  // rotates a token that is close to expiry, so invoking it an hour early
  // burns a real API call every sync tick and returns the same token.
  it("does not spawn the claude CLI while credentials are still usable", async () => {
    const originalFetch = globalThis.fetch
    const originalNow = Date.now
    const now = 1_700_000_000_000
    Date.now = () => now

    globalThis.fetch = (async () => {
      throw new Error("network unreachable")
    }) as typeof fetch

    try {
      const { credentialsModule, keychainModule, childProcessModule } =
        await loadCredentialsWithCountingKeychain(now + 30 * 60_000)
      const target = makeAccount(now + 30 * 60_000)
      credentialsModule.initAccounts([target])

      // Pin the target's own stored value so the up-front re-read is a no-op
      // and the assertion below speaks to the CLI, not to source adoption.
      keychainModule.__setCredentialsForSource("Claude Code-credentials", {
        accessToken: "existing-token",
        refreshToken: "existing-refresh",
        expiresAt: now + 30 * 60_000,
      })

      const result = await credentialsModule.refreshIfNeeded(
        target,
        60 * 60_000,
      )

      assert.equal(
        result?.accessToken,
        "existing-token",
        "still-valid credentials must be returned, not discarded",
      )
      assert.equal(
        childProcessModule.__getExecSyncCount(),
        0,
        "claude CLI must not be spawned while credentials remain usable",
      )
    } finally {
      globalThis.fetch = originalFetch
      Date.now = originalNow
    }
  })

  // The proactive sync timer calls refreshIfNeeded() directly while the
  // request path reaches it through getCachedCredentials(). A rotation
  // invalidates the refresh token it was issued against, so two concurrent
  // refreshes would leave one caller holding a token that is already dead.
  it("collapses concurrent refreshes of one account into a single OAuth call", async () => {
    const originalFetch = globalThis.fetch
    const originalNow = Date.now
    const now = 1_700_000_000_000
    Date.now = () => now

    let fetchCount = 0
    globalThis.fetch = (async () => {
      fetchCount += 1
      await new Promise((resolve) => setTimeout(resolve, 10))
      return new Response(
        JSON.stringify({
          access_token: `sk-ant-oat01-${fetchCount}`,
          refresh_token: `sk-ant-ort01-${fetchCount}`,
          expires_in: 28_800,
        }),
        { status: 200 },
      )
    }) as typeof fetch

    try {
      const { credentialsModule } = await loadCredentialsWithCountingKeychain(
        now + 30_000,
      )
      const target = makeAccount(now + 30_000)
      credentialsModule.initAccounts([target])

      const [viaTimer, viaRequest] = await Promise.all([
        credentialsModule.refreshIfNeeded(undefined, 60 * 60_000),
        credentialsModule.getCachedCredentials(),
      ])

      assert.equal(fetchCount, 1, "expected exactly one OAuth refresh")
      assert.equal(viaTimer?.accessToken, "sk-ant-oat01-1")
      assert.equal(viaRequest?.accessToken, "sk-ant-oat01-1")
    } finally {
      globalThis.fetch = originalFetch
      Date.now = originalNow
    }
  })

  // Deduplication must survive an exhausted refresh: callers that joined a
  // failed attempt all observe null, and the retry round they trigger has
  // to collapse into one request too rather than one per caller.
  it("keeps collapsing requests across rounds when a refresh is exhausted", async () => {
    const originalFetch = globalThis.fetch
    const originalNow = Date.now
    const now = 1_700_000_000_000
    let clock = now
    Date.now = () => clock

    let fetchCount = 0
    globalThis.fetch = (async () => {
      fetchCount += 1
      await new Promise((resolve) => setTimeout(resolve, 5))
      throw new Error("network unreachable")
    }) as typeof fetch

    try {
      const { credentialsModule, keychainModule } =
        await loadCredentialsWithCountingKeychain(now + 30_000)
      credentialsModule.initAccounts([makeAccount(now + 30_000)])
      // Force the CLI fallback to come back empty so the chain exhausts.
      keychainModule.__setCredentials(null)

      const first = await Promise.all([
        credentialsModule.getCachedCredentials(),
        credentialsModule.getCachedCredentials(),
        credentialsModule.getCachedCredentials(),
      ])
      const afterFirstRound = fetchCount

      // Advance past the post-transient refresh cooldown so the next round
      // actually re-attempts (rather than being cooldown-skipped) — the point
      // of the assertion is that the retry still collapses to one attempt.
      clock += 61_000

      const second = await Promise.all([
        credentialsModule.getCachedCredentials(),
        credentialsModule.getCachedCredentials(),
        credentialsModule.getCachedCredentials(),
      ])

      assert.deepEqual(first, [null, null, null])
      assert.deepEqual(second, [null, null, null])
      assert.equal(afterFirstRound, 1, "3 callers must share one attempt")
      assert.equal(
        fetchCount,
        2,
        "the retry round must collapse into one attempt, not one per caller",
      )
    } finally {
      globalThis.fetch = originalFetch
      Date.now = originalNow
    }
  })

  // Each OpenCode instance refreshes independently, and a rotation
  // invalidates the refresh token every other instance is holding. The
  // loser's OAuth call fails, but the winner has already written usable
  // credentials to the shared store — cheaper to re-read than to spawn the
  // claude CLI.
  it("adopts credentials rotated by another process instead of spawning the CLI", async () => {
    const originalFetch = globalThis.fetch
    const originalNow = Date.now
    const now = 1_700_000_000_000
    Date.now = () => now

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
      })) as typeof fetch

    try {
      const { credentialsModule, keychainModule, childProcessModule } =
        await loadCredentialsWithCountingKeychain(now + 30_000)
      const target = {
        ...makeAccount(now + 30_000),
        source: "Claude Code-credentials-aabbccdd",
        configDir: "/Users/test/.claude-work",
      }
      credentialsModule.initAccounts([target])

      // Another instance won the rotation and wrote the result to the store.
      keychainModule.__setCredentials({
        accessToken: "rotated-by-other-process",
        refreshToken: "rt-rotated",
        expiresAt: now + 8 * 60 * 60_000,
      })

      const result = await credentialsModule.refreshIfNeeded(target)

      assert.equal(result?.accessToken, "rotated-by-other-process")
      assert.equal(
        childProcessModule.__getExecSyncCount(),
        0,
        "a source re-read must be preferred over spawning the claude CLI",
      )
    } finally {
      globalThis.fetch = originalFetch
      Date.now = originalNow
    }
  })

  it("falls back to the claude CLI once credentials reach the expiry window", async () => {
    const originalFetch = globalThis.fetch
    const originalNow = Date.now
    const now = 1_700_000_000_000
    Date.now = () => now

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
      })) as typeof fetch

    try {
      const { credentialsModule, keychainModule, childProcessModule } =
        await loadCredentialsWithCountingKeychain(now + 30_000)
      const target = makeAccount(now + 30_000)
      credentialsModule.initAccounts([target])

      // The store initially matches memory, so neither the up-front re-read
      // nor the pre-CLI re-read finds anything new. Only once the CLI has run
      // does the entry rotate — hence the third read, not the second:
      // 1) refreshIfNeeded's up-front re-read, 2) the re-read after OAuth
      // fails, 4) the read after the CLI has rotated the entry. The lock
      // holder also re-checks the source immediately after acquisition.
      keychainModule.__setCredentials({
        accessToken: "existing-token",
        refreshToken: "existing-refresh",
        expiresAt: now + 30_000,
      })
      let reads = 0
      keychainModule.__setReadHook(() => {
        reads += 1
        if (reads >= 4) {
          keychainModule.__setCredentials({
            accessToken: "cli-rotated-token",
            refreshToken: "cli-rotated-refresh",
            expiresAt: now + 8 * 60 * 60_000,
          })
        }
      })

      const result = await credentialsModule.refreshIfNeeded(target)

      assert.equal(result?.accessToken, "cli-rotated-token")
      assert.equal(
        childProcessModule.__getExecSyncCount(),
        1,
        "claude CLI is the intended fallback inside the expiry window",
      )
      assert.equal(
        childProcessModule.__getExecSyncCalls()[0].options?.env
          ?.CLAUDE_CONFIG_DIR,
        target.configDir,
      )
    } finally {
      globalThis.fetch = originalFetch
      Date.now = originalNow
    }
  })

  it("uses one CLI startup fallback after a transient refresh failure", async () => {
    const originalFetch = globalThis.fetch
    const originalNow = Date.now
    const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
    const now = 1_700_000_000_000
    Date.now = () => now
    process.env.CLAUDE_CONFIG_DIR = "/Users/test/.claude-second"

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "rate_limit_error" }), {
        status: 429,
      })) as typeof fetch

    try {
      const { credentialsModule, keychainModule, childProcessModule } =
        await loadCredentialsWithCountingKeychain(now - 1_000)
      const target = {
        label: "Account 1",
        source: "Claude Code-credentials",
        configDir: "/Users/test/.claude",
        credentials: {
          accessToken: "expired-token",
          refreshToken: "expired-refresh",
          expiresAt: now - 1_000,
        },
      }
      credentialsModule.initAccounts([target])
      keychainModule.__setCredentials({ ...target.credentials })

      let reads = 0
      keychainModule.__setReadHook(() => {
        reads += 1
        if (reads >= 5) {
          keychainModule.__setCredentials({
            accessToken: "cli-refreshed-token",
            refreshToken: "cli-refreshed-refresh",
            expiresAt: now + 8 * 60 * 60_000,
          })
        }
      })

      const result = await credentialsModule.refreshIfNeeded(target)
      const [call] = childProcessModule.__getExecSyncCalls()

      assert.equal(result?.accessToken, "cli-refreshed-token")
      assert.equal(childProcessModule.__getExecSyncCount(), 1)
      assert.equal(call.command, "claude -p . --model haiku")
      assert.equal(
        call.options?.env?.CLAUDE_CONFIG_DIR,
        undefined,
        "primary account must use Claude's default config lookup",
      )
    } finally {
      globalThis.fetch = originalFetch
      Date.now = originalNow
      if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
  })

  // Pointing CLAUDE_CONFIG_DIR at the default directory makes the CLI look for
  // ~/.claude/.claude.json, miss ~/.claude.json, and report loggedIn: false, so
  // the file account could never refresh itself.
  it("leaves CLAUDE_CONFIG_DIR unset for a file account in the default dir", async () => {
    const originalFetch = globalThis.fetch
    const originalNow = Date.now
    const now = 1_700_000_000_000
    Date.now = () => now

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "rate_limit_error" }), {
        status: 429,
      })) as typeof fetch

    try {
      const { credentialsModule, keychainModule, childProcessModule } =
        await loadCredentialsWithCountingKeychain(now - 1_000)
      const target = {
        label: "Account 1",
        source: "file",
        configDir: join(homedir(), ".claude"),
        credentials: {
          accessToken: "expired-token",
          refreshToken: "expired-refresh",
          expiresAt: now - 1_000,
        },
      }
      credentialsModule.initAccounts([target])
      keychainModule.__setCredentials({ ...target.credentials })

      await credentialsModule.refreshIfNeeded(target)
      const [call] = childProcessModule.__getExecSyncCalls()

      assert.equal(childProcessModule.__getExecSyncCount(), 1)
      assert.equal(call.options?.env?.CLAUDE_CONFIG_DIR, undefined)
    } finally {
      globalThis.fetch = originalFetch
      Date.now = originalNow
    }
  })

  it("refuses the CLI for a suffixed account whose config dir is unknown", async () => {
    const originalFetch = globalThis.fetch
    const originalNow = Date.now
    const now = 1_700_000_000_000
    Date.now = () => now

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "rate_limit_error" }), {
        status: 429,
      })) as typeof fetch

    try {
      const { credentialsModule, keychainModule, childProcessModule } =
        await loadCredentialsWithCountingKeychain(now - 1_000)
      const target = {
        label: "Account 2",
        source: "Claude Code-credentials-deadbeef",
        credentials: {
          accessToken: "expired-token",
          refreshToken: "expired-refresh",
          expiresAt: now - 1_000,
        },
      }
      credentialsModule.initAccounts([target])
      keychainModule.__setCredentials({ ...target.credentials })

      const result = await credentialsModule.refreshIfNeeded(target)

      assert.equal(result, null)
      assert.equal(
        childProcessModule.__getExecSyncCount(),
        0,
        "an unscoped CLI run would rotate the primary account's tokens",
      )
    } finally {
      globalThis.fetch = originalFetch
      Date.now = originalNow
    }
  })

  it("uses the CLI immediately when expired during an OAuth cooldown", async () => {
    const originalFetch = globalThis.fetch
    const originalNow = Date.now
    const now = 1_700_000_000_000
    Date.now = () => now

    let fetchCount = 0
    globalThis.fetch = (async () => {
      fetchCount += 1
      return new Response(JSON.stringify({ error: "rate_limit_error" }), {
        status: 429,
      })
    }) as typeof fetch

    try {
      const { credentialsModule, keychainModule, childProcessModule } =
        await loadCredentialsWithCountingKeychain(now + 30 * 60_000)
      const target = makeAccount(now + 30 * 60_000)
      credentialsModule.initAccounts([target])
      keychainModule.__setCredentials({ ...target.credentials })

      await credentialsModule.refreshIfNeeded(target, 60 * 60_000)
      assert.equal(fetchCount, 1)
      assert.equal(childProcessModule.__getExecSyncCount(), 0)

      target.credentials.expiresAt = now - 1_000
      keychainModule.__setCredentials({ ...target.credentials })
      const readsBefore = keychainModule.__getReadCount()
      keychainModule.__setReadHook(() => {
        if (keychainModule.__getReadCount() >= readsBefore + 5) {
          keychainModule.__setCredentials({
            accessToken: "cli-refreshed-token",
            refreshToken: "cli-refreshed-refresh",
            expiresAt: now + 8 * 60 * 60_000,
          })
        }
      })

      const result = await credentialsModule.refreshIfNeeded(target)

      assert.equal(result?.accessToken, "cli-refreshed-token")
      assert.equal(fetchCount, 1, "OAuth cooldown must still be honored")
      assert.equal(childProcessModule.__getExecSyncCount(), 1)
    } finally {
      globalThis.fetch = originalFetch
      Date.now = originalNow
    }
  })

  it("does not repeat a failed CLI fallback during its cooldown", async () => {
    const originalFetch = globalThis.fetch
    const originalNow = Date.now
    const now = 1_700_000_000_000
    Date.now = () => now

    let fetchCount = 0
    globalThis.fetch = (async () => {
      fetchCount += 1
      return new Response(JSON.stringify({ error: "rate_limit_error" }), {
        status: 429,
      })
    }) as typeof fetch

    try {
      const { credentialsModule, keychainModule, childProcessModule } =
        await loadCredentialsWithCountingKeychain(now + 30 * 60_000)
      const target = makeAccount(now + 30 * 60_000)
      credentialsModule.initAccounts([target])
      keychainModule.__setCredentials({ ...target.credentials })

      await credentialsModule.refreshIfNeeded(target, 60 * 60_000)
      target.credentials.expiresAt = now - 1_000
      keychainModule.__setCredentials({ ...target.credentials })

      const first = await credentialsModule.refreshIfNeeded(target)
      const second = await credentialsModule.refreshIfNeeded(target)

      assert.equal(first, null)
      assert.equal(second, null)
      assert.equal(fetchCount, 1)
      assert.equal(childProcessModule.__getExecSyncCount(), 1)
    } finally {
      globalThis.fetch = originalFetch
      Date.now = originalNow
    }
  })

  it("starts the CLI cooldown after a timed-out process exits", async () => {
    const originalFetch = globalThis.fetch
    const originalNow = Date.now
    let now = 1_700_000_000_000
    Date.now = () => now

    let fetchCount = 0
    globalThis.fetch = (async () => {
      fetchCount += 1
      return new Response(JSON.stringify({ error: "rate_limit_error" }), {
        status: 429,
      })
    }) as typeof fetch

    try {
      const { credentialsModule, keychainModule, childProcessModule } =
        await loadCredentialsWithCountingKeychain(now - 1_000)
      const target = makeAccount(now - 1_000)
      credentialsModule.initAccounts([target])
      keychainModule.__setCredentials({ ...target.credentials })
      childProcessModule.__setExecSyncError(true)
      childProcessModule.__setExecSyncHook(() => {
        now += 60_000
      })

      const first = await credentialsModule.refreshIfNeeded(target)
      const second = await credentialsModule.refreshIfNeeded(target)

      assert.equal(first, null)
      assert.equal(second, null)
      assert.equal(fetchCount, 2)
      assert.equal(childProcessModule.__getExecSyncCount(), 1)
    } finally {
      globalThis.fetch = originalFetch
      Date.now = originalNow
    }
  })

  it("contains a source read failure after the CLI exits", async () => {
    const originalFetch = globalThis.fetch
    const originalNow = Date.now
    const now = 1_700_000_000_000
    Date.now = () => now

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "rate_limit_error" }), {
        status: 429,
      })) as typeof fetch

    try {
      const {
        credentialsModule,
        keychainModule,
        childProcessModule,
        loggerModule,
      } = await loadCredentialsWithCountingKeychain(now - 1_000)
      const target = makeAccount(now - 1_000)
      credentialsModule.initAccounts([target])
      keychainModule.__setCredentials({ ...target.credentials })
      childProcessModule.__setExecSyncHook(() => {
        keychainModule.__setReadError(true)
      })

      const result = await credentialsModule.refreshIfNeeded(target)

      assert.equal(result, null)
      assert.equal(childProcessModule.__getExecSyncCount(), 1)
      assert.ok(
        loggerModule
          .__getLogs()
          .some(({ event }) => event === "refresh_source_reread_failed"),
      )
    } finally {
      globalThis.fetch = originalFetch
      Date.now = originalNow
    }
  })

  it("keeps the selected account isolated once a terminal failure is on record", async () => {
    const originalFetch = globalThis.fetch
    const originalNow = Date.now
    const now = 1_700_000_000_000
    Date.now = () => now

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
      })) as typeof fetch

    try {
      const { credentialsModule, keychainModule, childProcessModule } =
        await loadCredentialsWithCountingKeychain(now - 1_000)

      const target = {
        label: "Account 1",
        source: "Claude Code-credentials",
        credentials: {
          accessToken: "dead-token",
          refreshToken: "dead-refresh",
          expiresAt: now - 1_000,
        },
      }
      credentialsModule.initAccounts([
        target,
        {
          label: "Account 2",
          source: "Claude Code-credentials-11223344",
          credentials: {
            accessToken: "sibling-token",
            refreshToken: "sibling-refresh",
            expiresAt: now + 8 * 60 * 60_000,
          },
        },
      ])
      // The store keeps agreeing with memory, so nothing is ever adopted and
      // the terminal record is what drives both rounds.
      keychainModule.__setCredentialsForSource("Claude Code-credentials", {
        accessToken: "dead-token",
        refreshToken: "dead-refresh",
        expiresAt: now - 1_000,
      })

      await credentialsModule.refreshIfNeeded(target)
      assert.equal(credentialsModule.getActiveRefreshFailureKind(), "terminal")
      const spawnsAfterFirstRound = childProcessModule.__getExecSyncCount()

      const result = await credentialsModule.refreshIfNeeded(target)

      assert.equal(result, null)
      assert.equal(target.credentials.accessToken, "dead-token")
      assert.equal(
        childProcessModule.__getExecSyncCount(),
        spawnsAfterFirstRound,
        "the CLI performs the same rejected exchange, so it is not re-spawned",
      )
    } finally {
      globalThis.fetch = originalFetch
      Date.now = originalNow
    }
  })
})

describe("refreshViaCli command shape", () => {
  it("uses the stable haiku alias, not a dated model ID", () => {
    const source = readFileSync(
      new URL("./credentials.ts", import.meta.url),
      "utf-8",
    )

    assert.match(source, /claude -p \. --model haiku/)
    assert.doesNotMatch(source, /claude-haiku-4-5-20250514/)
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

  it("truncates fractional expires_in to integer milliseconds", () => {
    const expiresIn = 28_800.000_901_1
    const raw = JSON.stringify({
      access_token: "sk-ant-oat01-new",
      expires_in: expiresIn,
    })

    const result = parseOAuthResponse(raw, currentRefresh, now)

    assert.ok(result)
    assert.equal(result.expiresAt, Math.trunc(now + expiresIn * 1000))
    assert.equal(Number.isInteger(result.expiresAt), true)
  })

  it("honors an absolute future expires_at (ms) over expires_in", () => {
    const expiresAt = now + 8 * 60 * 60_000
    const raw = JSON.stringify({
      access_token: "sk-ant-oat01-new",
      expires_in: 60, // deliberately tiny; expires_at should win
      expires_at: expiresAt,
    })
    const result = parseOAuthResponse(raw, currentRefresh, now)
    assert.ok(result)
    assert.equal(result.expiresAt, expiresAt)
  })

  it("ignores a non-future (e.g. seconds-precision) expires_at and falls back to expires_in", () => {
    // A seconds-precision value read as ms lands in 1970 (<= now); must not be
    // used, or the token would read as already-expired.
    const raw = JSON.stringify({
      access_token: "sk-ant-oat01-new",
      expires_in: 28_800,
      expires_at: 1_900_000_000, // seconds, not ms
    })
    const result = parseOAuthResponse(raw, currentRefresh, now)
    assert.ok(result)
    assert.equal(result.expiresAt, now + 28_800 * 1000)
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

describe("cross-process refresh lock (single-flight)", () => {
  it("waits for and adopts a sibling's token while another process holds the lock", async () => {
    const originalNow = Date.now
    const originalFetch = globalThis.fetch
    const now = 1_700_000_000_000
    Date.now = () => now
    // If the lock path were ever bypassed, the endpoint must not hand back a
    // usable token — this asserts the result came from the store, not a refresh.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "rate_limit_error" }), {
        status: 429,
        headers: { "retry-after": "3600" },
      })) as typeof fetch
    try {
      const { credentialsModule, keychainModule } =
        await loadCredentialsWithCountingKeychain(now - 1_000)
      const target = makeAccount(now - 1_000)
      credentialsModule.initAccounts([target])
      keychainModule.__setCredentials({
        accessToken: "existing-token",
        refreshToken: "existing-refresh",
        expiresAt: now - 1_000,
      })

      // The store looks stale on the up-front re-read, then a sibling (holding
      // the lock) rotates it fresh on the very next read.
      let reads = 0
      keychainModule.__setReadHook(() => {
        reads += 1
        if (reads >= 2) {
          keychainModule.__setCredentials({
            accessToken: "holder-token",
            refreshToken: "holder-refresh",
            expiresAt: now + 8 * 60 * 60_000,
          })
        }
      })

      // A sibling process owns the refresh lock for this source.
      const held = acquireRefreshLock(target.source)
      assert.ok(held, "test acquires the lock to simulate another process")
      try {
        const adopted = await credentialsModule.refreshIfNeeded(target)
        assert.equal(
          adopted?.accessToken,
          "holder-token",
          "waits for and adopts the lock holder's freshly stored token",
        )
      } finally {
        held!.release()
      }
    } finally {
      Date.now = originalNow
      globalThis.fetch = originalFetch
    }
  })
})
