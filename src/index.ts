import type { Plugin } from "@opencode-ai/plugin"
import {
  addExcludedBeta,
  getExcludedBetas,
  getModelBetas,
  getNextBetaToExclude,
  isLongContextError,
  LONG_CONTEXT_BETAS,
} from "./betas.js"
import {
  type ClaudeCredentials,
  getCachedCredentials,
  refreshIfNeeded,
  syncAuthJson,
} from "./credentials.js"
import { readClaudeCredentials } from "./keychain.js"
import { transformBody, transformResponseStream } from "./transforms.js"

export {
  addExcludedBeta,
  getExcludedBetas,
  getModelBetas,
  getNextBetaToExclude,
  isLongContextError,
  LONG_CONTEXT_BETAS,
} from "./betas.js"
export {
  type ClaudeCredentials,
  getCachedCredentials,
  refreshIfNeeded,
  syncAuthJson,
} from "./credentials.js"
export {
  stripToolPrefix,
  transformBody,
  transformResponseStream,
} from "./transforms.js"

const SYSTEM_IDENTITY_PREFIX =
  "You are Claude Code, Anthropic's official CLI for Claude."
const DEFAULT_CC_VERSION = "2.1.80"

function getCliVersion(): string {
  return process.env.ANTHROPIC_CLI_VERSION ?? DEFAULT_CC_VERSION
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
  let creds: ClaudeCredentials | null = null
  try {
    creds = readClaudeCredentials()
  } catch (err) {
    console.warn(
      "opencode-claude-auth: Failed to read Claude Code credentials:",
      err instanceof Error ? err.message : err,
    )
    return {}
  }
  if (!creds) {
    console.warn(
      "opencode-claude-auth: No Claude Code credentials found. " +
        "Plugin disabled. Run `claude` to authenticate.",
    )
    return {}
  }

  const freshCreds = getCachedCredentials()
  if (freshCreds) {
    syncAuthJson(freshCreds)
  } else {
    console.warn(
      "opencode-claude-auth: Claude credentials are expired and could not be refreshed via Claude CLI.",
    )
  }

  // Keep auth.json synced, refreshing via CLI if token is near expiry
  const syncTimer = setInterval(() => {
    try {
      const fresh = refreshIfNeeded()
      if (fresh) {
        syncAuthJson(fresh)
      }
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
        if (auth.type !== "oauth") {
          return {}
        }

        for (const model of Object.values(provider.models)) {
          model.cost = {
            input: 0,
            output: 0,
            cache: { read: 0, write: 0 },
          }
        }

        return {
          apiKey: "",
          async fetch(input: RequestInfo | URL, init?: RequestInit) {
            const latest = getCachedCredentials()
            if (!latest) {
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

            let response = await fetchWithRetry(input, {
              ...requestInit,
              body,
              headers,
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
          provider: "anthropic",
          label: "Manually enter API Key",
          type: "api",
        },
      ],
    },
  }
}

export const ClaudeAuthPlugin = plugin
export default plugin
