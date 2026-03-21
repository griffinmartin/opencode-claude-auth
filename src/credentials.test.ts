import { describe, it, before } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { pathToFileURL } from "node:url"

async function loadCredentialsWithCountingKeychain(initialExpiresAt: number): Promise<{
  credentialsModule: {
    getCachedCredentials: () => { accessToken: string; refreshToken: string; expiresAt: number } | null
  }
  keychainModule: {
    __getReadCount: () => number
  }
}> {
  const tempDir = await mkdtemp(join(tmpdir(), "opencode-claude-auth-creds-"))
  const tempKeychain = join(tempDir, "keychain.js")
  const tempCredentials = join(tempDir, "credentials.ts")
  const sourceCredentials = await readFile(new URL("./credentials.ts", import.meta.url), "utf8")

  await writeFile(
    tempKeychain,
    `let readCount = 0
let credentials = {
  accessToken: "token",
  refreshToken: "refresh",
  expiresAt: ${initialExpiresAt}
}

export function readClaudeCredentials() {
  readCount += 1
  return credentials
}

export function __getReadCount() {
  return readCount
}
`,
    "utf8",
  )
  await writeFile(tempCredentials, sourceCredentials, "utf8")

  const [credentialsModule, keychainModule] = await Promise.all([
    import(pathToFileURL(tempCredentials).href),
    import(pathToFileURL(tempKeychain).href),
  ])

  return {
    credentialsModule,
    keychainModule: keychainModule as { __getReadCount: () => number },
  }
}

describe("credential caching", () => {
  it("getCachedCredentials reuses cached credentials within 30 second TTL", async () => {
    const originalNow = Date.now
    let now = 1_700_000_000_000
    Date.now = () => now

    try {
      const { credentialsModule, keychainModule } = await loadCredentialsWithCountingKeychain(now + 10 * 60_000)

      const first = credentialsModule.getCachedCredentials()
      const second = credentialsModule.getCachedCredentials()

      assert.ok(first)
      assert.ok(second)
      assert.equal(keychainModule.__getReadCount(), 1)
    } finally {
      Date.now = originalNow
    }
  })

  it("getCachedCredentials refreshes from source after TTL expires", async () => {
    const originalNow = Date.now
    let now = 1_700_000_000_000
    Date.now = () => now

    try {
      const { credentialsModule, keychainModule } = await loadCredentialsWithCountingKeychain(now + 10 * 60_000)

      const first = credentialsModule.getCachedCredentials()
      now += 31_000
      const second = credentialsModule.getCachedCredentials()

      assert.ok(first)
      assert.ok(second)
      assert.equal(keychainModule.__getReadCount(), 2)
    } finally {
      Date.now = originalNow
    }
  })
})
