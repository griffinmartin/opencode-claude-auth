import type { Plugin } from "@opencode-ai/plugin"
import { config } from "./model-config.ts"
import { readAllClaudeAccounts, type ClaudeAccount } from "./keychain.ts"
import { initLogger, log } from "./logger.ts"
import {
  addExcludedBeta,
  getExcludedBetas,
  getModelBetas,
  getNextBetaToExclude,
  isLongContextError,
  LONG_CONTEXT_BETAS,
} from "./betas.ts"
import { transformBody, transformResponseStream } from "./transforms.ts"
import {
  getCachedCredentials,
  getCredentialsForSync,
  syncAuthJson,
  initAccounts,
  setActiveAccountSource,
  loadPersistedAccountSource,
  saveAccountSource,
  refreshAccountsList,
  type ClaudeCredentials,
} from "./credentials.ts"

export {
  addExcludedBeta,
  getExcludedBetas,
  getModelBetas,
  getNextBetaToExclude,
  isLongContextError,
  LONG_CONTEXT_BETAS,
} from "./betas.ts"
export { resetExcludedBetas } from "./betas.ts"
export {
  stripToolPrefix,
  transformBody,
  transformResponseStream,
} from "./transforms.ts"
export {
  getCachedCredentials,
  syncAuthJson,
  refreshAccountsList,
  type ClaudeCredentials,
} from "./credentials.ts"

const SYSTEM_IDENTITY_PREFIX =
  "You are Claude Code, Anthropic's official CLI for Claude."

function getCliVersion(): string {
  return process.env.ANTHROPIC_CLI_VERSION ?? config.ccVersion
}

function getUserAgent(): string {
  return (
    process.env.ANTHROPIC_USER_AGENT ??
    `claude-cli/${getCliVersion()} (external, cli)`
  )
}

type FetchFn = typeof fetch

export async function fetchWithRetry(
  input: RequestInfo | URL,
  init?: RequestInit,
  retries = 3,
  fetchImpl: FetchFn = fetch,
): Promise<Response> {
  for (let i = 0; i < retries; i++) {
    const res = await fetchImpl(input, init)
    if ((res.status === 429 || res.status === 529) && i < retries - 1) {
      const retryAfter = res.headers.get("retry-after")
      const parsed = retryAfter ? parseInt(retryAfter, 10) : NaN
      const delay = Number.isNaN(parsed) ? (i + 1) * 2000 : parsed * 1000
      await new Promise((r) => setTimeout(r, delay))
      continue
    }
    return res
  }
  return fetchImpl(input, init)
}

export function buildRequestHeaders(
  input: RequestInfo | URL,
  init: RequestInit,
  accessToken: string,
  modelId = "unknown",
  excludedBetas?: Set<string>,
): Headers {
  const headers = new Headers()

  if (input instanceof Request) {
    input.headers.forEach((value, key) => {
      headers.set(key, value)
    })
  }

  if (init.headers instanceof Headers) {
    init.headers.forEach((value, key) => {
      headers.set(key, value)
    })
  } else if (Array.isArray(init.headers)) {
    for (const [key, value] of init.headers) {
      if (typeof value !== "undefined") {
        headers.set(key, String(value))
      }
    }
  } else if (init.headers) {
    for (const [key, value] of Object.entries(init.headers)) {
      if (typeof value !== "undefined") {
        headers.set(key, String(value))
      }
    }
  }

  const modelBetas = getModelBetas(modelId, excludedBetas)
  const incomingBeta = headers.get("anthropic-beta") ?? ""
  const mergedBetas = [
    ...new Set([
      ...modelBetas,
      ...incomingBeta
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ]),
  ]

  headers.set("authorization", `Bearer ${accessToken}`)
  headers.set("anthropic-beta", mergedBetas.join(","))
  headers.set("x-app", "cli")
  headers.set("user-agent", getUserAgent())
  headers.set("x-anthropic-billing-header", getBillingHeader(modelId))
  headers.delete("x-api-key")

  return headers
}

export function getBillingHeader(modelId: string): string {
  const entrypoint = "cli"
  return `cc_version=${getCliVersion()}.${modelId}; cc_entrypoint=${entrypoint}; cch=00000;`
}

const SYNC_INTERVAL = 5 * 60 * 1000 // 5 minutes

const plugin: Plugin = async () => {
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
    return {}
  }

  if (accounts.length === 0) {
    log("plugin_init_no_accounts", { reason: "no credentials found" })
    console.warn(
      "opencode-claude-auth: No Claude Code credentials found. " +
        "Plugin disabled. Run `claude` to authenticate.",
    )
    return {}
  }

  initAccounts(accounts)

  const persistedSource = loadPersistedAccountSource()
  const defaultAccount =
    (persistedSource && accounts.find((a) => a.source === persistedSource)) ||
    accounts[0]

  setActiveAccountSource(defaultAccount.source)

  log("plugin_init", {
    accountCount: accounts.length,
    sources: accounts.map((a) => a.source),
    activeSource: defaultAccount.source,
  })

  const initialCreds = getCachedCredentials()
  if (initialCreds) {
    syncAuthJson(initialCreds)
  } else {
    console.warn(
      "opencode-claude-auth: Claude credentials are expired and could not be refreshed. Run `claude` to re-authenticate.",
    )
  }

  // Keep auth.json synced with current credentials (no refresh triggered)
  const syncTimer = setInterval(() => {
    try {
      const creds = getCredentialsForSync()
      if (creds) syncAuthJson(creds)
    } catch {
      // Non-fatal
    }
  }, SYNC_INTERVAL)
  syncTimer.unref()

  return {
    "experimental.chat.system.transform": async (input, output) => {
      if (input.model?.providerID !== "anthropic") {
        return
      }

      const hasIdentityPrefix = output.system.some((entry) =>
        entry.includes(SYSTEM_IDENTITY_PREFIX),
      )
      if (!hasIdentityPrefix) {
        output.system.unshift(SYSTEM_IDENTITY_PREFIX)
      }
    },
    auth: {
      provider: "anthropic",
      async loader(getAuth, provider) {
        const auth = await getAuth()
        log("auth_loader_called", { authType: auth.type })
        if (auth.type !== "oauth") {
          log("auth_loader_skipped", {
            authType: auth.type,
            reason: "auth type is not oauth",
          })
          return {}
        }

        for (const model of Object.values(provider.models)) {
          model.cost = {
            input: 0,
            output: 0,
            cache: { read: 0, write: 0 },
          }
        }

        log("auth_loader_ready", {
          modelCount: Object.keys(provider.models).length,
        })

        return {
          apiKey: "",
          async fetch(input: RequestInfo | URL, init?: RequestInit) {
            const latest = getCachedCredentials()
            if (!latest) {
              log("fetch_no_credentials", { modelId: "unknown" })
              throw new Error(
                "Claude Code credentials are unavailable or expired. Run `claude` to refresh them.",
              )
            }

            const requestInit = init ?? {}
            const bodyStr =
              typeof requestInit.body === "string"
                ? requestInit.body
                : undefined
            let modelId = "unknown"
            if (bodyStr) {
              try {
                modelId =
                  (JSON.parse(bodyStr) as { model?: string }).model ?? "unknown"
              } catch {}
            }

            log("fetch_credentials", {
              modelId,
              accessToken: latest.accessToken,
              expiresAt: latest.expiresAt,
            })

            // Get excluded betas for this model (from previous failed requests)
            const excluded = getExcludedBetas(modelId)
            const headers = buildRequestHeaders(
              input,
              requestInit,
              latest.accessToken,
              modelId,
              excluded,
            )
            const body = transformBody(requestInit.body)

            const headerKeys: string[] = []
            headers.forEach((_, key) => headerKeys.push(key))
            const betas = (headers.get("anthropic-beta") ?? "")
              .split(",")
              .filter(Boolean)
            log("fetch_headers_built", { headerKeys, betas, modelId })

            let response = await fetchWithRetry(input, {
              ...requestInit,
              body,
              headers,
            })

            log("fetch_response", {
              status: response.status,
              modelId,
              retryAttempt: 0,
            })

            // Check for long-context beta errors and retry with betas excluded
            // Try up to LONG_CONTEXT_BETAS.length times, excluding one more beta each time
            for (
              let attempt = 0;
              attempt < LONG_CONTEXT_BETAS.length;
              attempt++
            ) {
              if (response.status !== 400 && response.status !== 429) {
                break
              }

              const cloned = response.clone()
              const responseBody = await cloned.text()

              if (!isLongContextError(responseBody)) {
                break
              }

              const betaToExclude = getNextBetaToExclude(modelId)
              if (!betaToExclude) {
                break // All long-context betas already excluded
              }

              addExcludedBeta(modelId, betaToExclude)
              log("fetch_beta_excluded", {
                modelId,
                excludedBeta: betaToExclude,
              })

              // Rebuild headers without the excluded beta and retry
              const newExcluded = getExcludedBetas(modelId)
              const newHeaders = buildRequestHeaders(
                input,
                requestInit,
                latest.accessToken,
                modelId,
                newExcluded,
              )

              response = await fetchWithRetry(input, {
                ...requestInit,
                body,
                headers: newHeaders,
              })
            }

            return transformResponseStream(response)
          },
        }
      },
      methods: [
        {
          type: "oauth",
          label: "Switch Claude Code account",

          get prompts() {
            const currentAccounts = refreshAccountsList()
            const currentSource =
              loadPersistedAccountSource() ?? defaultAccount.source
            if (currentAccounts.length <= 1) return []
            return [
              {
                type: "select" as const,
                key: "account",
                message: "Select which Claude Code account to use:",
                options: currentAccounts.map((a) => ({
                  label: a.label,
                  value: a.source,
                  hint:
                    a.source === currentSource
                      ? `${a.source} (active)`
                      : a.source,
                })),
              },
            ]
          },

          async authorize(inputs) {
            const latestAccounts = refreshAccountsList()

            const source =
              inputs?.account ?? latestAccounts[0]?.source ?? accounts[0].source
            const chosen =
              latestAccounts.find((a) => a.source === source) ??
              accounts.find((a) => a.source === source) ??
              latestAccounts[0] ??
              accounts[0]

            setActiveAccountSource(chosen.source)
            const creds = getCachedCredentials() ?? chosen.credentials

            syncAuthJson(creds)
            saveAccountSource(chosen.source)

            const sourceDescription =
              chosen.source === "file"
                ? "credentials file (~/.claude/.credentials.json)"
                : "macOS Keychain"

            return {
              url: "",
              instructions: `Using ${chosen.label} — credentials loaded from ${sourceDescription}.`,
              method: "auto",
              async callback() {
                return {
                  type: "success",
                  provider: "anthropic",
                  access: creds.accessToken,
                  refresh: creds.refreshToken,
                  expires: creds.expiresAt,
                }
              },
            }
          },
        },
      ],
    },
  }
}

export const ClaudeAuthPlugin = plugin
export default plugin
