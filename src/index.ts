import { Plugin, Provider } from "@opencode-ai/plugin"
import type { IntegrationOAuthMethodRegistration } from "@opencode-ai/plugin/promise/integration"
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
          model.cost = []
        })
      }
    })

    await ctx.session.hook("context", (event) => {
      if (event.model.providerID !== PROVIDER_ID) return
      if (event.system.some((part) => part.text.includes(SYSTEM_IDENTITY)))
        return
      event.system.unshift({ type: "text", text: SYSTEM_IDENTITY })
    })

    if (accounts.length === 0) {
      log("plugin_init_no_accounts", { reason: "no credentials found" })
      return
    }
    log("plugin_init", {
      accountCount: accounts.length,
      sources: accounts.map((account) => account.source),
    })
  },
})

export default ClaudeAuthPlugin
