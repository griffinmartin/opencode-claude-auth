import { Plugin, Provider } from "@opencode/plugin"
import type { IntegrationOAuthMethodRegistration } from "@opencode/plugin/promise/integration"
import type { SessionRequest } from "@opencode/plugin/promise/session"
import {
  initAccounts,
  loadPersistedAccountSource,
  setActiveAccountSource,
} from "./credentials.ts"
import { readAllClaudeAccounts } from "./keychain.ts"
import { initLogger, log } from "./logger.ts"
import {
  authorizeOAuth,
  INTEGRATION_ID,
  labelOAuthCredential,
  oauthMethodDescriptor,
  realOAuthDeps,
  refreshOAuthCredential,
} from "./oauth-method.ts"
import { setCredentialTypeResolver, type CredentialType } from "./provider.ts"

export * from "./betas.ts"
export * from "./credentials.ts"
export * from "./oauth-method.ts"
export * from "./provider.ts"
export * from "./signing.ts"
export * from "./transforms.ts"

const PROVIDER_ID = Provider.ID.make("anthropic")
const SYSTEM_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude."
const PROVIDER_PACKAGE = `aisdk:${new URL("./provider.js", import.meta.url).href}`

/**
 * Session request kinds that reach the model and are billed to the connected
 * subscription. OpenCode 2 dispatches one hook per kind - `context` drives the
 * agent loop, and compaction, generation and title are issued alongside it - so
 * a hook registered for only one of them leaves the rest without the identity
 * Claude Code requests are expected to carry.
 */
export const IDENTITY_REQUEST_HOOKS = [
  "context",
  "compaction",
  "generate",
  "title",
] as const

/** Prepends the Claude Code identity to an Anthropic request, once. */
export function injectClaudeIdentity(event: SessionRequest): void {
  if (event.model.providerID !== PROVIDER_ID) return
  if (event.system.some((part) => part.text.includes(SYSTEM_IDENTITY))) return
  event.system.unshift({ type: "text", text: SYSTEM_IDENTITY })
}

function oauth(accounts: ReturnType<typeof readAllClaudeAccounts>) {
  return {
    integrationID: INTEGRATION_ID,
    method: oauthMethodDescriptor(accounts),
    authorize: async (inputs) => {
      const value = await authorizeOAuth(inputs, accounts, realOAuthDeps)
      return {
        mode: "auto" as const,
        url: "",
        instructions: "Claude Code credentials imported from this device.",
        callback: Promise.resolve(value),
      }
    },
    refresh: (value) => refreshOAuthCredential(value, realOAuthDeps),
    label: (value) => labelOAuthCredential(value),
  } satisfies IntegrationOAuthMethodRegistration
}

export const ClaudeAuthPlugin = Plugin.define({
  id: "griffinmartin.claude-auth",
  setup: async (ctx) => {
    initLogger()
    let accounts: ReturnType<typeof readAllClaudeAccounts> = []
    try {
      accounts = readAllClaudeAccounts()
    } catch (cause) {
      log("plugin_init_error", { cause: String(cause) })
    }
    initAccounts(accounts)
    const selected = loadPersistedAccountSource() ?? accounts[0]?.source
    if (selected) setActiveAccountSource(selected)

    await ctx.integration.transform((draft) => {
      draft.update(INTEGRATION_ID, (integration) => {
        integration.name = "Anthropic"
      })
      draft.method.update(oauth(accounts))
    })

    // The Anthropic integration keeps its built-in API-key method alongside
    // the subscription method registered above. Which one the user picked
    // decides both the transport (see provider.ts) and whether usage is
    // billed to the subscription, so cost metadata is only zeroed for OAuth.
    const activeCredentialType = async (): Promise<
      CredentialType | undefined
    > => {
      const connection = await ctx.integration.connection.active(INTEGRATION_ID)
      if (!connection) return undefined
      const credential = await ctx.integration.connection.resolve(connection)
      return credential?.type
    }
    setCredentialTypeResolver(activeCredentialType)

    let subscription: boolean = false
    const loadConnection = async () => {
      try {
        subscription = (await activeCredentialType()) === "oauth"
      } catch (cause) {
        subscription = false
        log("connection_lookup_failed", { cause: String(cause) })
      }
    }
    await loadConnection()

    await ctx.catalog.transform((catalog) => {
      const anthropic = catalog.provider.get(PROVIDER_ID)
      if (!anthropic) return
      catalog.provider.update(PROVIDER_ID, (provider) => {
        provider.name = "Anthropic"
        provider.integrationID = INTEGRATION_ID
        provider.package = PROVIDER_PACKAGE
      })
      for (const [modelID] of anthropic.models) {
        catalog.model.update(PROVIDER_ID, modelID, (model) => {
          model.package = PROVIDER_PACKAGE
          if (subscription) model.cost = []
        })
      }
    })

    // Re-evaluate when the user switches credentials so the catalog follows
    // the active connection instead of whatever was selected at startup.
    const watcher = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({
        signal: watcher.signal,
      })) {
        if (
          event.type === "credential.updated" ||
          (event.type === "credential.switched" &&
            event.data.integrationID === INTEGRATION_ID)
        ) {
          const before: boolean = subscription
          await loadConnection()
          if (subscription !== before) await ctx.catalog.reload()
        }
      }
    })().catch((cause) => {
      if (!watcher.signal.aborted)
        log("connection_watch_failed", { cause: String(cause) })
    })

    for (const kind of IDENTITY_REQUEST_HOOKS)
      await ctx.session.hook(kind, injectClaudeIdentity)

    if (accounts.length === 0) {
      log("plugin_init_no_accounts", { reason: "no credentials found" })
    } else {
      log("plugin_init", {
        accountCount: accounts.length,
        sources: accounts.map((account) => account.source),
      })
    }

    return () => {
      watcher.abort()
      setCredentialTypeResolver(undefined)
    }
  },
})

export default ClaudeAuthPlugin
