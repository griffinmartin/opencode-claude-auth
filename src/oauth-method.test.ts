import assert from "node:assert/strict"
import { describe, it } from "node:test"
import type { ClaudeAccount } from "./keychain.ts"
import {
  authorizeOAuth,
  buildOAuthCredential,
  labelOAuthCredential,
  oauthMethodDescriptor,
  refreshOAuthCredential,
  resolveAuthorizeSource,
  type OAuthDeps,
} from "./oauth-method.ts"

function account(overrides: Partial<ClaudeAccount> = {}): ClaudeAccount {
  return {
    label: "Claude Pro",
    source: "Claude Code-credentials",
    credentials: {
      accessToken: "sk-ant-oat01-access",
      refreshToken: "sk-ant-ort01-refresh",
      expiresAt: Date.now() + 3_600_000,
    },
    ...overrides,
  }
}

function makeDeps(overrides: Partial<OAuthDeps> = {}): OAuthDeps & {
  calls: Record<string, unknown[]>
} {
  const calls: Record<string, unknown[]> = {
    setActiveAccountSource: [],
    saveAccountSource: [],
    writeBackCredentials: [],
    log: [],
  }
  return {
    calls,
    refreshAccountsList: () => [account()],
    loadPersistedAccountSource: () => null,
    getCachedCredentials: async () => null,
    setActiveAccountSource: (source) => {
      calls.setActiveAccountSource.push(source)
    },
    saveAccountSource: (source) => {
      calls.saveAccountSource.push(source)
    },
    reloadCredentialsFromSource: () => null,
    refreshViaOAuth: async () => null,
    writeBackCredentials: (source, creds, configDir, expected) => {
      calls.writeBackCredentials.push([source, creds, configDir, expected])
      return true
    },
    log: (event, data) => {
      calls.log.push([event, data])
    },
    ...overrides,
  }
}

describe("oauthMethodDescriptor", () => {
  it("omits prompts for a single account", () => {
    const descriptor = oauthMethodDescriptor([account()])
    assert.equal(descriptor.id, "claude-code")
    assert.equal(descriptor.type, "oauth")
    assert.equal(descriptor.label, "Import Claude Code subscription")
    assert.equal("prompts" in descriptor, false)
  })

  it("omits prompts for zero accounts", () => {
    const descriptor = oauthMethodDescriptor([])
    assert.equal("prompts" in descriptor, false)
  })

  it("includes a select prompt for multiple accounts", () => {
    const descriptor = oauthMethodDescriptor([
      account({ label: "Claude Pro", source: "a" }),
      account({ label: "Claude Max", source: "b" }),
    ])
    assert.ok("prompts" in descriptor)
    const prompt = descriptor.prompts?.[0]
    assert.equal(prompt?.type, "select")
    assert.equal(prompt?.key, "account")
    assert.deepEqual(prompt?.options, [
      { label: "Claude Pro", value: "a", hint: "a" },
      { label: "Claude Max", value: "b", hint: "b" },
    ])
  })
})

describe("resolveAuthorizeSource", () => {
  it("prefers inputs.account over everything else", () => {
    const deps = makeDeps({
      refreshAccountsList: () => [account({ source: "latest" })],
      loadPersistedAccountSource: () => "persisted",
    })
    const source = resolveAuthorizeSource(
      { account: "explicit" },
      [account({ source: "fallback" })],
      deps,
    )
    assert.equal(source, "explicit")
  })

  it("falls back to the persisted account source", () => {
    const deps = makeDeps({
      refreshAccountsList: () => [account({ source: "latest" })],
      loadPersistedAccountSource: () => "persisted",
    })
    const source = resolveAuthorizeSource(
      {},
      [account({ source: "fallback" })],
      deps,
    )
    assert.equal(source, "persisted")
  })

  it("falls back to the first freshly-listed account", () => {
    const deps = makeDeps({
      refreshAccountsList: () => [account({ source: "latest" })],
      loadPersistedAccountSource: () => null,
    })
    const source = resolveAuthorizeSource(
      {},
      [account({ source: "fallback" })],
      deps,
    )
    assert.equal(source, "latest")
  })

  it("falls back to the first account from the original snapshot", () => {
    const deps = makeDeps({
      refreshAccountsList: () => [],
      loadPersistedAccountSource: () => null,
    })
    const source = resolveAuthorizeSource(
      {},
      [account({ source: "fallback" })],
      deps,
    )
    assert.equal(source, "fallback")
  })

  it("returns undefined when nothing is available", () => {
    const deps = makeDeps({
      refreshAccountsList: () => [],
      loadPersistedAccountSource: () => null,
    })
    const source = resolveAuthorizeSource({}, [], deps)
    assert.equal(source, undefined)
  })

  it("ignores a non-string inputs.account", () => {
    const deps = makeDeps({
      refreshAccountsList: () => [account({ source: "latest" })],
      loadPersistedAccountSource: () => null,
    })
    const source = resolveAuthorizeSource({ account: 42 }, [], deps)
    assert.equal(source, "latest")
  })
})

describe("buildOAuthCredential", () => {
  it("builds a credential for the matching account", async () => {
    const deps = makeDeps({
      refreshAccountsList: () => [
        account({ source: "a", label: "A" }),
        account({ source: "b", label: "B" }),
      ],
    })
    const value = await buildOAuthCredential("b", deps)
    assert.equal(value.type, "oauth")
    assert.equal(value.methodID, "claude-code")
    assert.equal(value.metadata?.source, "b")
    assert.equal(value.metadata?.label, "B")
  })

  it("falls back to the first account when the source doesn't match any", async () => {
    const deps = makeDeps({
      refreshAccountsList: () => [account({ source: "only" })],
    })
    const value = await buildOAuthCredential("missing", deps)
    assert.equal(value.metadata?.source, "only")
  })

  it("throws when there are no accounts at all", async () => {
    const deps = makeDeps({ refreshAccountsList: () => [] })
    await assert.rejects(
      () => buildOAuthCredential("anything", deps),
      /Run `claude` to authenticate first/,
    )
  })

  it("prefers cached credentials over the account's stored credentials", async () => {
    const deps = makeDeps({
      refreshAccountsList: () => [account({ source: "a" })],
      getCachedCredentials: async () => ({
        accessToken: "cached-access",
        refreshToken: "cached-refresh",
        expiresAt: 123,
      }),
    })
    const value = await buildOAuthCredential("a", deps)
    assert.equal(value.access, "cached-access")
    assert.equal(value.refresh, "cached-refresh")
    assert.equal(value.expires, 123)
  })

  it("falls back to the account's stored credentials when nothing is cached", async () => {
    const deps = makeDeps({
      refreshAccountsList: () => [
        account({
          source: "a",
          credentials: {
            accessToken: "stored-access",
            refreshToken: "stored-refresh",
            expiresAt: 456,
          },
        }),
      ],
      getCachedCredentials: async () => null,
    })
    const value = await buildOAuthCredential("a", deps)
    assert.equal(value.access, "stored-access")
    assert.equal(value.refresh, "stored-refresh")
    assert.equal(value.expires, 456)
  })

  it("includes configDir in metadata only when present", async () => {
    const withConfigDir = makeDeps({
      refreshAccountsList: () => [
        account({ source: "a", configDir: "/tmp/claude" }),
      ],
    })
    const without = makeDeps({
      refreshAccountsList: () => [account({ source: "a" })],
    })
    assert.equal(
      (await buildOAuthCredential("a", withConfigDir)).metadata?.configDir,
      "/tmp/claude",
    )
    assert.equal(
      "configDir" in (await buildOAuthCredential("a", without)).metadata!,
      false,
    )
  })

  it("includes subscriptionType in metadata only when present", async () => {
    const withType = makeDeps({
      refreshAccountsList: () => [
        account({
          source: "a",
          credentials: {
            accessToken: "x",
            refreshToken: "y",
            expiresAt: 1,
            subscriptionType: "team",
          },
        }),
      ],
    })
    const without = makeDeps({
      refreshAccountsList: () => [account({ source: "a" })],
    })
    assert.equal(
      (await buildOAuthCredential("a", withType)).metadata?.subscriptionType,
      "team",
    )
    assert.equal(
      "subscriptionType" in
        (await buildOAuthCredential("a", without)).metadata!,
      false,
    )
  })

  it("marks the resolved account as active and persists the selection", async () => {
    const deps = makeDeps({
      refreshAccountsList: () => [account({ source: "chosen" })],
    })
    await buildOAuthCredential("chosen", deps)
    assert.deepEqual(deps.calls.setActiveAccountSource, ["chosen"])
    assert.deepEqual(deps.calls.saveAccountSource, ["chosen"])
  })
})

describe("authorizeOAuth", () => {
  it("builds a credential for the resolved source", async () => {
    const deps = makeDeps({
      refreshAccountsList: () => [account({ source: "resolved" })],
      loadPersistedAccountSource: () => "resolved",
    })
    const value = await authorizeOAuth({}, [], deps)
    assert.equal(value.metadata?.source, "resolved")
  })

  it("throws a clear error when no source can be resolved", async () => {
    const deps = makeDeps({
      refreshAccountsList: () => [],
      loadPersistedAccountSource: () => null,
    })
    await assert.rejects(
      () => authorizeOAuth({}, [], deps),
      /Run `claude` to authenticate first/,
    )
  })
})

describe("refreshOAuthCredential", () => {
  const value = {
    type: "oauth" as const,
    access: "old-access",
    refresh: "old-refresh",
    metadata: { source: "acct", configDir: "/tmp/claude" },
  }

  it("resyncs from the keychain instead of hitting the network when it disagrees", async () => {
    let refreshViaOAuthCalled = false
    const deps = makeDeps({
      reloadCredentialsFromSource: () => ({
        accessToken: "fresh-access",
        refreshToken: "fresh-refresh",
        expiresAt: 999,
      }),
      refreshViaOAuth: async () => {
        refreshViaOAuthCalled = true
        return null
      },
    })
    const result = await refreshOAuthCredential(value, deps)
    assert.equal(result.access, "fresh-access")
    assert.equal(result.refresh, "fresh-refresh")
    assert.equal(result.expires, 999)
    assert.equal(refreshViaOAuthCalled, false)
    assert.deepEqual(deps.calls.log[0], [
      "refresh_resynced_from_keychain",
      { source: "acct" },
    ])
  })

  it("falls through to a network refresh when the keychain is unavailable", async () => {
    const deps = makeDeps({
      reloadCredentialsFromSource: () => null,
      refreshViaOAuth: async () => ({
        accessToken: "refreshed-access",
        refreshToken: "refreshed-refresh",
        expiresAt: 111,
      }),
    })
    const result = await refreshOAuthCredential(value, deps)
    assert.equal(result.access, "refreshed-access")
  })

  it("falls through to a network refresh when the keychain agrees with what we have", async () => {
    const deps = makeDeps({
      reloadCredentialsFromSource: () => ({
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: 1,
      }),
      refreshViaOAuth: async () => ({
        accessToken: "refreshed-access",
        refreshToken: "refreshed-refresh",
        expiresAt: 222,
      }),
    })
    const result = await refreshOAuthCredential(value, deps)
    assert.equal(result.access, "refreshed-access")
  })

  it("throws a clear error when the network refresh fails", async () => {
    const deps = makeDeps({
      reloadCredentialsFromSource: () => null,
      refreshViaOAuth: async () => null,
    })
    await assert.rejects(
      () => refreshOAuthCredential(value, deps),
      /Run `claude` to re-authenticate/,
    )
  })

  it("writes back credentials after a successful network refresh", async () => {
    const deps = makeDeps({
      reloadCredentialsFromSource: () => null,
      refreshViaOAuth: async () => ({
        accessToken: "refreshed-access",
        refreshToken: "refreshed-refresh",
        expiresAt: 333,
      }),
    })
    await refreshOAuthCredential(value, deps)
    assert.equal(deps.calls.writeBackCredentials.length, 1)
    assert.deepEqual(deps.calls.writeBackCredentials[0], [
      "acct",
      {
        accessToken: "refreshed-access",
        refreshToken: "refreshed-refresh",
        expiresAt: 333,
      },
      "/tmp/claude",
      "old-access",
    ])
  })

  it("does not write back credentials when there is no source in metadata", async () => {
    const deps = makeDeps({
      reloadCredentialsFromSource: () => null,
      refreshViaOAuth: async () => ({
        accessToken: "refreshed-access",
        refreshToken: "refreshed-refresh",
        expiresAt: 333,
      }),
    })
    await refreshOAuthCredential(
      { type: "oauth" as const, access: "a", refresh: "r" },
      deps,
    )
    assert.equal(deps.calls.writeBackCredentials.length, 0)
  })

  it("marks the account active before checking the keychain, only when a source is present", async () => {
    const successfulRefresh = {
      reloadCredentialsFromSource: () => null,
      refreshViaOAuth: async () => ({
        accessToken: "refreshed-access",
        refreshToken: "refreshed-refresh",
        expiresAt: 999,
      }),
    }
    const deps = makeDeps(successfulRefresh)
    await refreshOAuthCredential(value, deps)
    assert.deepEqual(deps.calls.setActiveAccountSource, ["acct"])

    const depsNoSource = makeDeps(successfulRefresh)
    await refreshOAuthCredential(
      { type: "oauth" as const, access: "a", refresh: "r" },
      depsNoSource,
    )
    assert.deepEqual(depsNoSource.calls.setActiveAccountSource, [])
  })
})

describe("labelOAuthCredential", () => {
  it("returns the label when it is a string", () => {
    assert.equal(
      labelOAuthCredential({ metadata: { label: "Claude Pro" } }),
      "Claude Pro",
    )
  })

  it("returns undefined when metadata is absent", () => {
    assert.equal(labelOAuthCredential({}), undefined)
  })

  it("returns undefined when the label is not a string", () => {
    assert.equal(labelOAuthCredential({ metadata: { label: 42 } }), undefined)
  })
})
