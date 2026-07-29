import type { Plugin } from "@opencode-ai/plugin"
import crypto from "node:crypto"
import { config } from "./model-config.ts"
import { readAllClaudeAccounts, type ClaudeAccount } from "./keychain.ts"
import { initLogger, log } from "./logger.ts"
import { fetchWithRetry } from "./http.ts"
import {
  addExcludedBeta,
  getExcludedBetas,
  getModelBetas,
  getNextBetaToExclude,
  isLongContextError,
  LONG_CONTEXT_BETAS,
} from "./betas.ts"
import {
  SYSTEM_IDENTITY,
  transformBody,
  transformResponseStream,
} from "./transforms.ts"
import {
  getCachedCredentials,
  reloadCredentialsFromSource,
  forceRefreshActiveAccount,
  getActiveAccount,
  syncAuthJson,
  initAccounts,
  setActiveAccountSource,
  loadPersistedAccountSource,
  saveAccountSource,
  refreshAccountsList,
  refreshIfNeeded,
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
export { fetchWithRetry, type FetchFn } from "./http.ts"
export {
  stripToolPrefix,
  SYSTEM_IDENTITY,
  transformBody,
  transformResponseStream,
} from "./transforms.ts"
export {
  getCachedCredentials,
  syncAuthJson,
  refreshAccountsList,
  type ClaudeCredentials,
} from "./credentials.ts"
export {
  buildBillingHeaderValue,
  computeCch,
  computeVersionSuffix,
  extractFirstUserMessageText,
} from "./signing.ts"

function getCliVersion(): string {
  return process.env.ANTHROPIC_CLI_VERSION ?? config.ccVersion
}

function getUserAgent(): string {
  return (
    process.env.ANTHROPIC_USER_AGENT ??
    `claude-cli/${getCliVersion()} (external, sdk-cli)`
  )
}

function getStainlessHeaders(): Record<string, string> {
  return {
    "x-stainless-arch": process.arch === "arm64" ? "arm64" : process.arch,
    "x-stainless-lang": "js",
    "x-stainless-os":
      process.platform === "darwin" ? "MacOS" : process.platform,
    "x-stainless-package-version": "0.81.0",
    "x-stainless-retry-count": "0",
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": process.version,
    "x-stainless-timeout": "600",
  }
}

function buildRequestUrl(input: RequestInfo | URL): string | URL {
  const raw =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url

  const url = new URL(raw)
  if (url.pathname === "/v1/messages" && !url.searchParams.has("beta")) {
    url.searchParams.set("beta", "true")
  }

  return typeof input === "string" ? url.toString() : url
}

// Stable per-process session ID, matching Claude Code's X-Claude-Code-Session-Id
const sessionId = crypto.randomUUID()

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
  headers.set("anthropic-version", "2023-06-01")
  headers.set("anthropic-beta", mergedBetas.join(","))
  headers.set("anthropic-dangerous-direct-browser-access", "true")
  headers.set("x-app", "cli")
  headers.set("user-agent", getUserAgent())
  headers.set("x-client-request-id", crypto.randomUUID())
  headers.set("X-Claude-Code-Session-Id", sessionId)
  for (const [key, value] of Object.entries(getStainlessHeaders())) {
    if (!headers.has(key)) headers.set(key, value)
  }
  headers.delete("x-api-key")

  return headers
}

const SYNC_INTERVAL = 5 * 60 * 1000 // 5 minutes
const PROACTIVE_REFRESH_THRESHOLD_MS = 60 * 60 * 1000 // 1 hour before expiry

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

  initAccounts(accounts)

  const defaultAccountSource = accounts[0]?.source ?? null

  if (accounts.length > 0) {
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

    const initialCreds = await getCachedCredentials()
    if (initialCreds) {
      syncAuthJson(initialCreds)
    } else {
      console.warn(
        "opencode-claude-auth: Claude credentials are expired and could not be refreshed. Run `claude` to re-authenticate.",
      )
    }

    // Keep auth.json synced and proactively refresh before expiry.
    // refreshIfNeeded() always resolves the currently ACTIVE account
    // (via getActiveAccount() internally) — not a closure-captured account
    // list — so this stays correct across account switches. Passing
    // PROACTIVE_REFRESH_THRESHOLD_MS (1 hour) means it triggers a real
    // OAuth refresh once the token is within that window of expiry, and
    // simply returns the untouched credentials otherwise (no-op refresh).
    // This prevents the "run `claude` to re-authenticate" message from
    // appearing mid-session when the token silently expires.
    let proactiveRefreshWarned = false
    const syncTimer = setInterval(async () => {
      try {
        const account = getActiveAccount()
        log("proactive_refresh_check", {
          source: account?.source ?? null,
          expiresAt: account?.credentials?.expiresAt ?? null,
          thresholdMs: PROACTIVE_REFRESH_THRESHOLD_MS,
        })

        const creds = await refreshIfNeeded(
          undefined,
          PROACTIVE_REFRESH_THRESHOLD_MS,
        )
        if (creds) {
          syncAuthJson(creds)
          if (proactiveRefreshWarned) {
            log("proactive_refresh_recovered", { source: account?.source })
          }
          proactiveRefreshWarned = false
        } else {
          log("proactive_refresh_failed", { source: account?.source })
          // Only warn once per outage — otherwise this fires every
          // SYNC_INTERVAL (5 min) for as long as refresh keeps failing.
          if (!proactiveRefreshWarned) {
            proactiveRefreshWarned = true
            console.warn(
              "opencode-claude-auth: Proactive token refresh failed. Run `claude` to re-authenticate.",
            )
          }
        }
      } catch {
        // Non-fatal
      }
    }, SYNC_INTERVAL)
    syncTimer.unref()
  } else {
    log("plugin_init_no_accounts", { reason: "no credentials found" })
    console.warn(
      "opencode-claude-auth: No Claude Code credentials found. Running in API key mode with transform hook enabled.",
    )
  }

  return {
    "experimental.chat.system.transform": async (input, output) => {
      if (input.model?.providerID !== "anthropic") {
        return
      }

      const hasIdentityPrefix = output.system.some((entry) =>
        entry.includes(SYSTEM_IDENTITY),
      )
      if (!hasIdentityPrefix) {
        output.system.unshift(SYSTEM_IDENTITY)
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
          baseURL: "https://api.anthropic.com/v1",
          async fetch(input: RequestInfo | URL, init?: RequestInit) {
            const latest = await getCachedCredentials()
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
            const requestUrl = buildRequestUrl(input)
            const headers = buildRequestHeaders(
              input,
              requestInit,
              latest.accessToken,
              modelId,
              excluded,
            )
            const body = transformBody(requestInit.body)

            const headerKeys: string[] = []
            headers.forEach((_, key) => {
              headerKeys.push(key)
            })
            const betas = (headers.get("anthropic-beta") ?? "")
              .split(",")
              .filter(Boolean)
            log("fetch_headers_built", { headerKeys, betas, modelId })

            let response = await fetchWithRetry(requestUrl, {
              ...requestInit,
              body,
              headers,
            })

            log("fetch_response", {
              status: response.status,
              modelId,
              retryAttempt: 0,
            })

            // Recover from a rejected token: first by adopting credentials
            // rotated externally (cswap switching accounts, the claude CLI,
            // another OpenCode instance), then by forcing an OAuth refresh
            // when the store still holds the token that was just rejected.
            //
            // Most cases resolve on the first attempt: a cold or unreadable
            // store yields null from the reload (reloadCredentialsFromSource
            // rejects anything expiring within 60s), so the force refresh runs
            // immediately. The second attempt covers the narrower race where
            // the reload returns a valid-looking token that a concurrent
            // writer has itself just rotated again.
            //
            // The cap is the real bound. Against a store being rotated on
            // every read, every candidate differs from tokenInUse, so the
            // no-progress break never fires and the cap alone stops the loop.
            // The break is the fast path out of the common cases, not the
            // guarantee of termination.
            //
            // tokenInUse deliberately tracks only the last token tried rather
            // than the set of all of them: a store cycling A->B->A wastes one
            // request on the second attempt, which is a better trade than
            // threading extra state through a loop whose whole virtue is a
            // hard ceiling of three API calls.
            const MAX_AUTH_RECOVERY_ATTEMPTS = 2
            let tokenInUse = latest.accessToken

            for (
              let attempt = 0;
              response.status === 401 && attempt < MAX_AUTH_RECOVERY_ATTEMPTS;
              attempt++
            ) {
              let candidate: ClaudeCredentials | null = null
              // reloadCredentialsFromSource already catches its own source
              // read and returns null, so this is unreachable today. It stays
              // because the guarantee worth keeping is that no reload failure
              // turns a well-formed 401 into an exception thrown out of
              // fetch() — degrading to the original response beats crashing
              // the request. It logs so a future reload that does throw is
              // diagnosable rather than silently null-coalesced.
              try {
                candidate = reloadCredentialsFromSource()
              } catch (err) {
                log("auth_recovery_reload_threw", {
                  modelId,
                  attempt: attempt + 1,
                  error: err instanceof Error ? err.message : String(err),
                })
              }

              if (!candidate || candidate.accessToken === tokenInUse) {
                try {
                  candidate = await forceRefreshActiveAccount()
                } catch (err) {
                  // A rejected refresh and a refresh that returned null are
                  // different operator-facing diagnoses; auth_recovery_
                  // exhausted below collapses them, so record this one here.
                  log("auth_recovery_force_refresh_threw", {
                    modelId,
                    attempt: attempt + 1,
                    error: err instanceof Error ? err.message : String(err),
                  })
                }
              }

              // Re-checked, not copy-pasted: the guard above decides whether
              // to force a refresh, this one decides whether that refresh
              // actually produced a token worth retrying with.
              if (!candidate || candidate.accessToken === tokenInUse) {
                log("auth_recovery_exhausted", {
                  modelId,
                  attempt: attempt + 1,
                })
                break
              }

              tokenInUse = candidate.accessToken
              log("auth_recovery_retry", { modelId, attempt: attempt + 1 })
              response = await fetchWithRetry(requestUrl, {
                ...requestInit,
                body,
                headers: buildRequestHeaders(
                  input,
                  requestInit,
                  tokenInUse,
                  modelId,
                  excluded,
                ),
              })
            }

            // An external switch — cswap rotating off an exhausted account —
            // leaves this session on the old token until the 30s credential
            // cache expires. Re-read once so a rate limit that has already
            // been resolved elsewhere is not surfaced. A changed token is the
            // signal that a switch happened; when nothing changed this costs
            // one source read and no retry.
            //
            // Ordered AFTER the 401 recovery loop, and that is a real
            // dependency, not incidental sequencing: it must compare against
            // the token the loop last tried, so a 401 recovered into a 429 is
            // measured against the recovered token rather than the rejected
            // one. Only half of this is compiler-enforced — hoisting the block
            // above `let tokenInUse` is a TDZ error, but moving it between
            // that declaration and the loop still compiles and still passes,
            // while silently comparing against a stale token on the
            // 401 -> retry -> 429 path.
            //
            // Ordered before the long-context beta loop deliberately. A
            // long-context 429 is a header problem, not an account one, so it
            // rotates no token and falls through here untouched. In the rare
            // case a switch lands on the same 429, this spends one retry that
            // comes back with the same long-context error and the beta loop
            // then handles it off the fresh response — one wasted request,
            // same outcome.
            if (response.status === 429) {
              let rotated: ClaudeCredentials | null = null
              // Unreachable today for the same reason as the 401 loop's
              // reload catch: reloadCredentialsFromSource swallows its own
              // source read and returns null. Kept, and logged, on the same
              // grounds — no reload failure should turn a readable 429 into
              // an exception thrown out of fetch(), and a future reload that
              // does throw should be diagnosable rather than silently
              // coalesced to "nothing rotated".
              try {
                rotated = reloadCredentialsFromSource()
              } catch (err) {
                log("rate_limit_reload_threw", {
                  modelId,
                  error: err instanceof Error ? err.message : String(err),
                })
              }

              if (rotated && rotated.accessToken !== tokenInUse) {
                // Named for what was observed, not for what it implies. A
                // changed token is not proof of an account switch: a routine
                // refresh of this same exhausted account by another instance
                // or the claude CLI changes the token too, and that retry hits
                // the same quota. Accepted cost — one request — but the log
                // must not tell a quota investigation "we switched accounts"
                // when all it saw was a different token.
                log("rate_limit_token_changed", { modelId })
                tokenInUse = rotated.accessToken
                response = await fetchWithRetry(requestUrl, {
                  ...requestInit,
                  body,
                  headers: buildRequestHeaders(
                    input,
                    requestInit,
                    tokenInUse,
                    modelId,
                    excluded,
                  ),
                })
                // Whether rotating resolved the limit is the question this
                // whole block exists to answer, so record it outright rather
                // than leaving success to be inferred from the absence of a
                // fetch_error_response line.
                log("rate_limit_retry_response", {
                  modelId,
                  status: response.status,
                })
              }
            }

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
              // Falls back to tokenInUse, not latest: after a 401 recovery the
              // latter is the token the API already rejected.
              const currentCreds = await getCachedCredentials()
              const retryToken = currentCreds?.accessToken ?? tokenInUse
              const newExcluded = getExcludedBetas(modelId)
              const newHeaders = buildRequestHeaders(
                input,
                requestInit,
                retryToken,
                modelId,
                newExcluded,
              )

              response = await fetchWithRetry(requestUrl, {
                ...requestInit,
                body,
                headers: newHeaders,
              })
            }

            // Record non-200 responses without writing over OpenCode's terminal UI.
            if (!response.ok) {
              const status = response.status
              const cloned = response.clone()
              cloned
                .text()
                .then((errorBody) => {
                  let message = errorBody
                  try {
                    const parsed = JSON.parse(errorBody) as {
                      error?: { type?: string; message?: string }
                    }
                    message =
                      parsed.error?.message ?? parsed.error?.type ?? errorBody
                  } catch {}
                  log("fetch_error_response", { status, modelId, message })
                })
                .catch(() => {})
            }

            // A 401 that survived recovery carries an error body, not an SSE
            // stream. Deciding here rather than from a flag set mid-flight
            // makes the retried and non-retried paths behave identically.
            return response.status === 401
              ? response
              : transformResponseStream(response)
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
              loadPersistedAccountSource() ?? defaultAccountSource
            if (currentAccounts.length <= 1) return []
            return [
              {
                type: "select" as const,
                key: "account",
                message: "Select which Claude Code account to use:",
                options: currentAccounts.map((a) => ({
                  label: a.label,
                  value: a.source,
                  hint: a.source === currentSource ? "active" : undefined,
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
            const creds = (await getCachedCredentials()) ?? chosen.credentials

            syncAuthJson(creds)
            saveAccountSource(chosen.source)

            const sourceDescription =
              chosen.source === "file"
                ? `credentials file (${chosen.configDir ?? "~/.claude"}/.credentials.json)`
                : `macOS Keychain (${chosen.source})`

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
