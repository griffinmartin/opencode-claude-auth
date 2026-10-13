// OpenCode 2 plugin entrypoint for opencode-claude-auth.
//
// The V1 implementation in ./index.ts supplied a custom `fetch` through the
// `auth.loader` hook. V2 removed that hook: provider credentials are stored in
// OpenCode's own database and requests are intercepted with session hooks
// instead. This module maps the V1 behaviour onto that API:
//
//   V1 `auth.loader` custom fetch        -> V2 `http.request` / `http.response`
//   V1 `auth.methods[0]` (oauth method)  -> V2 `ctx.integration.transform`
//   V1 `experimental.chat.system.transform` -> V2 `ctx.session.hook("context")`
//
// See https://opencode.ai/v2/docs/build/plugins/migrate-v1 for the mapping.
import { Integration, Plugin } from "@opencode/plugin"
import { readAllClaudeAccounts, type ClaudeAccount } from "./keychain.ts"
import { initLogger, log } from "./logger.ts"
import {
  addExcludedBeta,
  getExcludedBetas,
  getNextBetaToExclude,
  isLongContextError,
} from "./betas.ts"
import {
  SYSTEM_IDENTITY,
  transformBody,
  transformResponseStream,
} from "./transforms.ts"
import {
  forceRefreshActiveAccount,
  getActiveAccount,
  getCachedCredentials,
  getCredentialsWithBackoff,
  initAccounts,
  loadPersistedAccountSource,
  refreshAccountsList,
  refreshIfNeeded,
  refreshViaOAuthDetailed,
  saveAccountSource,
  setActiveAccountSource,
  type ClaudeCredentials,
} from "./credentials.ts"
import { buildRequestHeaders } from "./request.ts"

export const V2_PLUGIN_ID = "opencode-claude-auth"

const SYNC_INTERVAL = 5 * 60 * 1000 // 5 minutes
const PROACTIVE_REFRESH_THRESHOLD_MS = 60 * 60 * 1000 // 1 hour before expiry

const CLAUDE_CODE_METHOD_ID = "claude-code"

function isClaudeOAuthCredential(credential: { type: string }): credential is {
  type: "oauth"
  access: string
  refresh: string
  expires: number
} {
  return credential.type === "oauth"
}

// V1 only ever ran when Claude Code credentials were the active credential. In
// V2 the provider attaches whatever credential OpenCode resolved, so decide from
// the request itself: sign it only when it already carries a Claude Code OAuth
// token, or when it carries no credential at all. API-key requests must pass
// through untouched or we would authenticate them as Claude Code.
export function shouldSignClaudeRequest(request: Request): boolean {
  const authorization = request.headers.get("authorization") ?? ""
  if (authorization.startsWith("Bearer sk-ant-oat")) return true
  return authorization === "" && !request.headers.has("x-api-key")
}

function describeSource(account: ClaudeAccount): string {
  return account.source === "file"
    ? `credentials file (${account.configDir ?? "~/.claude"}/.credentials.json)`
    : `macOS Keychain (${account.source})`
}

export function createV2Plugin() {
  return Plugin.define({
    id: V2_PLUGIN_ID,

    async setup(ctx) {
      initLogger()

      let accounts: ClaudeAccount[] = []
      try {
        accounts = readAllClaudeAccounts()
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        log("plugin_init_error", { error })
        console.warn(
          "opencode-claude-auth: Failed to read Claude Code credentials:",
          error,
        )
        return
      }

      initAccounts(accounts)

      if (accounts.length === 0) {
        log("plugin_init_no_accounts", { reason: "no credentials found" })
        console.warn(
          "opencode-claude-auth: No Claude Code credentials found. Running in API key mode with transform hook enabled.",
        )
      } else {
        const persistedSource = loadPersistedAccountSource()
        const defaultAccount =
          (persistedSource &&
            accounts.find((a) => a.source === persistedSource)) ||
          accounts[0]

        setActiveAccountSource(defaultAccount.source)

        log("plugin_init", {
          accountCount: accounts.length,
          sources: accounts.map((a) => a.source),
          activeSource: defaultAccount.source,
        })

        const initialCreds = await getCachedCredentials()
        if (!initialCreds) {
          console.warn(
            "opencode-claude-auth: Claude credentials are expired and could not be refreshed. Run `claude` to re-authenticate.",
          )
        }
      }

      // Keep our in-memory credentials warm so the http.request hook always has
      // a live token to sign with. Unlike V1 this no longer writes auth.json —
      // V2 imports that file once during its database migration and ignores it
      // afterwards, so refreshed tokens are served from here (and, for OpenCode's
      // own bookkeeping, through the integration refresh callback below).
      let proactiveRefreshWarned = false
      let syncTimer: ReturnType<typeof setInterval> | undefined

      if (accounts.length > 0) {
        syncTimer = setInterval(async () => {
          try {
            const creds = await refreshIfNeeded(
              undefined,
              PROACTIVE_REFRESH_THRESHOLD_MS,
            )
            if (creds) {
              proactiveRefreshWarned = false
            } else if (!proactiveRefreshWarned) {
              proactiveRefreshWarned = true
              log("proactive_refresh_failed", {})
              console.warn(
                "opencode-claude-auth: Proactive token refresh failed. Run `claude` to re-authenticate.",
              )
            }
          } catch {
            // Non-fatal
          }
        }, SYNC_INTERVAL)
        syncTimer.unref?.()
      }

      // V1: `experimental.chat.system.transform` prepended the Claude Code
      // identity to the system prompt for anthropic requests.
      await ctx.session.hook(
        "context",
        (event) => {
          if (event.model.providerID !== "anthropic") return
          const hasIdentityPrefix = event.system.some(
            (entry) =>
              typeof entry.text === "string" &&
              entry.text.includes(SYSTEM_IDENTITY),
          )
          if (!hasIdentityPrefix) {
            event.system.unshift({ type: "text", text: SYSTEM_IDENTITY })
          }
        },
        { providerID: "anthropic" },
      )

      // V1 zeroed every anthropic model's cost inside `auth.loader`, which also ran
      // in API key mode. Usage on Claude Code credentials is billed to the
      // subscription, so the guessed API pricing would be misleading — but a user
      // with no Claude Code credentials is genuinely paying API prices.
      if (accounts.length > 0) {
        await ctx.model.transform((editor) => {
          for (const model of editor.list("anthropic")) {
            editor.update(
              String(model.providerID),
              String(model.id),
              (draft) => {
                draft.cost = draft.cost.map((tier) => ({
                  ...tier,
                  input: 0 as never,
                  output: 0 as never,
                  cache: { read: 0 as never, write: 0 as never },
                }))
              },
            )
          }
        })
      }

      // V1's custom `fetch` signed the request and rewrote the URL/body. Rebuild
      // the Request here; the provider has already attached its own credentials,
      // but we replace them with the active Claude Code token so a refreshed
      // token is always used even though OpenCode's stored credential can lag.
      await ctx.session.hook(
        "http.request",
        async (event) => {
          const request = event.request

          if (!shouldSignClaudeRequest(request)) {
            log("fetch_skip_non_claude_credential", {})
            return
          }

          let latest = await getCachedCredentials()
          if (!latest) {
            latest = await getCredentialsWithBackoff({
              signal: request.signal ?? undefined,
            })
          }
          if (!latest) {
            // Leave the request untouched and let OpenCode surface its own auth
            // error rather than throwing out of the hook.
            log("fetch_no_credentials", { modelId: "unknown" })
            return
          }

          const bodyText = await request
            .clone()
            .text()
            .catch(() => undefined)

          if (bodyText === undefined) {
            // Rebuilding the Request without the body would quietly send an empty
            // request. Leave it to OpenCode's own credential instead.
            log("fetch_body_unreadable", {})
            return
          }

          let modelId = "unknown"
          if (bodyText) {
            try {
              modelId =
                (JSON.parse(bodyText) as { model?: string }).model ?? "unknown"
            } catch {
              // Ignore non-JSON bodies.
            }
          }

          const excluded = getExcludedBetas(modelId)
          const url = new URL(request.url)
          if (
            url.pathname === "/v1/messages" &&
            !url.searchParams.has("beta")
          ) {
            url.searchParams.set("beta", "true")
          }

          const headers = buildRequestHeaders(
            request,
            {},
            latest.accessToken,
            modelId,
            excluded,
          )
          const body = transformBody(bodyText)

          log("fetch_credentials", {
            modelId,
            accessToken: latest.accessToken,
            expiresAt: latest.expiresAt,
          })

          event.request = new Request(url.toString(), {
            method: request.method,
            headers,
            body: (body ?? null) as BodyInit | null,
            signal: request.signal,
          })
        },
        { providerID: "anthropic" },
      )

      // V1 rewrote the response stream before returning it. The V2 hook owns the
      // Response object directly.
      await ctx.session.hook(
        "http.response",
        (event) => {
          event.response = transformResponseStream(event.response)
        },
        { providerID: "anthropic" },
      )

      // V1 retried a rejected long-context request with one more beta excluded.
      // V2 gives us a retry hook plus the raw error body, so the same recovery
      // is expressed as a forced retry.
      await ctx.session.hook(
        "retry",
        (event) => {
          if (event.error.status !== 400 && event.error.status !== 429) return
          const responseBody = event.error.response?.body
          if (!responseBody || !isLongContextError(responseBody)) return

          const modelId = event.model.id ?? "unknown"
          const betaToExclude = getNextBetaToExclude(modelId)
          if (!betaToExclude) return

          addExcludedBeta(modelId, betaToExclude)
          log("fetch_beta_excluded", { modelId, excludedBeta: betaToExclude })
          event.decision = { retry: true, delay: 0 }
        },
        { providerID: "anthropic" },
      )

      // V1 registered an oauth method that switched which Claude Code account
      // OpenCode used. V2 owns credential storage, so the equivalent is an
      // integration method: OpenCode stores the credential and calls our
      // `refresh` when the token nears expiry.
      await ctx.integration.transform((editor) => {
        const currentAccounts = refreshAccountsList()
        const currentSource =
          loadPersistedAccountSource() ?? currentAccounts[0]?.source

        editor.method.update({
          integrationID: "anthropic",
          method: {
            id: CLAUDE_CODE_METHOD_ID,
            type: "oauth",
            label: "Use Claude Code credentials",
            ...(currentAccounts.length > 1
              ? {
                  form: [
                    {
                      type: "string" as const,
                      key: "account",
                      title: "Claude Code account",
                      options: currentAccounts.map((a) => ({
                        value: a.source,
                        label: a.label,
                        ...(a.source === currentSource
                          ? { description: "active" }
                          : {}),
                      })),
                    },
                  ],
                }
              : {}),
          },

          async authorize(answer) {
            const latestAccounts = refreshAccountsList()
            const requested =
              typeof answer?.account === "string" ? answer.account : undefined
            const source =
              requested ?? latestAccounts[0]?.source ?? accounts[0]?.source
            const chosen =
              latestAccounts.find((a) => a.source === source) ??
              latestAccounts[0] ??
              accounts[0]

            setActiveAccountSource(chosen.source)
            const creds = (await getCachedCredentials()) ?? chosen.credentials
            saveAccountSource(chosen.source)

            return {
              url: "",
              instructions: `Using ${chosen.label} — credentials loaded from ${describeSource(chosen)}.`,
              expiresAt: creds.expiresAt,
              mode: "auto",
              callback: Promise.resolve({
                type: "oauth" as const,
                methodID: CLAUDE_CODE_METHOD_ID as Integration.MethodID,
                access: creds.accessToken,
                refresh: creds.refreshToken,
                expires: creds.expiresAt,
              }),
            }
          },

          async refresh(credential) {
            const active = getActiveAccount()
            let creds: ClaudeCredentials | null
            if (active?.credentials.accessToken === credential.access) {
              // Refresh through the shared credential state so the account store,
              // the persisted source, and our http.request hook all move to the new
              // token together. Refreshing separately here would rotate the refresh
              // token twice and invalidate one of the two results.
              creds = await forceRefreshActiveAccount()
            } else {
              // Credential that this plugin does not own (activated directly in
              // OpenCode); refresh just that token and leave our state alone.
              const outcome = await refreshViaOAuthDetailed(credential.refresh)
              creds = outcome.kind === "ok" ? outcome.creds : null
            }
            if (!creds) {
              throw new Error("Claude Code token refresh failed")
            }
            log("refresh_success", { source: "v2-integration" })
            return {
              ...credential,
              access: creds.accessToken,
              refresh: creds.refreshToken,
              expires: creds.expiresAt,
            }
          },

          label(credential) {
            if (!isClaudeOAuthCredential(credential)) return undefined
            const match = refreshAccountsList().find(
              (a) => a.credentials.accessToken === credential.access,
            )
            return (
              match?.label ?? `Claude Code (…${credential.access.slice(-6)})`
            )
          },
        })
      })

      return () => {
        if (syncTimer) clearInterval(syncTimer)
      }
    },
  })
}
