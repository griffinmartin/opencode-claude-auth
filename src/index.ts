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
  getCredentialsWithBackoff,
  getActiveRefreshFailureKind,
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
  rotateAfterRateLimit,
  noteAccountSucceeded,
  chooseInitialAccount,
  type ClaudeCredentials,
} from "./credentials.ts"
import {
  activeCooldowns,
  formatRemaining,
  getCooldownUntil,
  getRotationConfig,
} from "./rotation.ts"
import {
  addTokens,
  isTokenSource,
  listTokenEntries,
  parsePastedTokens,
  removeToken,
  tokenFingerprint,
  validateTokenInput,
} from "./token-store.ts"

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

/**
 * Tell the user an account switched, without touching stdout.
 *
 * `console.warn` is not available for this: it draws over the OpenCode TUI,
 * which is why API errors were moved off it in 2.0.1 and why a test asserts a
 * quota 429 prints nothing. A toast is the supported channel, and it is
 * strictly best-effort — a failed notification must never fail the request
 * that triggered it, and `client` is absent in unit tests and headless runs.
 */
type ToastClient = {
  tui?: {
    showToast?: (options: {
      body: {
        title?: string
        message: string
        variant: "info" | "success" | "warning" | "error"
        duration?: number
      }
    }) => unknown
  }
}

function notify(
  client: ToastClient | undefined,
  message: string,
  variant: "info" | "success" | "warning" | "error",
  title = "Claude auth",
): void {
  log("notify", { message, variant })
  try {
    const result = client?.tui?.showToast?.({
      body: { title, message, variant, duration: 6000 },
    })
    void Promise.resolve(result).catch(() => {})
  } catch {
    // Never let notification failure surface as a request failure.
  }
}

/** One-line summary of which accounts are benched, for warnings. */
function describeCooldowns(now = Date.now()): string {
  const cooling = activeCooldowns(now)
  if (cooling.length === 0) return "No cooldowns are recorded."
  return cooling
    .map((c) => `${c.source} for ${formatRemaining(c.remainingMs)}`)
    .join(", ")
}

/** Picker hint combining the active marker with any rate-limit cooldown. */
function accountHint(
  source: string,
  activeSource: string | null,
  now = Date.now(),
): string | undefined {
  const until = getCooldownUntil(source, now)
  const parts: string[] = []
  if (source === activeSource) parts.push("active")
  if (until !== null) {
    parts.push(`rate-limited, ${formatRemaining(until - now)} left`)
  }
  return parts.length > 0 ? parts.join(" · ") : undefined
}

const SYNC_INTERVAL = 5 * 60 * 1000 // 5 minutes
const PROACTIVE_REFRESH_THRESHOLD_MS = 60 * 60 * 1000 // 1 hour before expiry

// Named to avoid shadowing the `input` parameter of the auth loader's fetch.
const plugin: Plugin = async (pluginInput) => {
  initLogger()

  // Optional by design: unit tests construct the plugin with no input, and a
  // headless server has no TUI to toast into. Rotation must work in both.
  const toastClient = (pluginInput as { client?: ToastClient } | undefined)
    ?.client

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
    // Steps over an account that is still benched from a rate limit hit in an
    // earlier session, so restarting OpenCode during a usage limit lands on a
    // working account instead of replaying the limit on the first prompt.
    const defaultAccount =
      chooseInitialAccount(accounts, persistedSource) ?? accounts[0]

    setActiveAccountSource(defaultAccount.source)

    log("plugin_init", {
      accountCount: accounts.length,
      sources: accounts.map((a) => a.source),
      activeSource: defaultAccount.source,
      pastedTokens: accounts.filter((a) => isTokenSource(a.source)).length,
      cooldowns: activeCooldowns().length,
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
            const requestInit = init ?? {}
            let latest = await getCachedCredentials()
            if (!latest) {
              // A transient refresh rate-limit must not surface as a hard error.
              // Wait (bounded, abort-aware) for our cooldown to clear or for a
              // sibling OpenCode instance / the claude CLI to write a fresh
              // token to the shared store.
              latest = await getCredentialsWithBackoff({
                signal: requestInit.signal ?? undefined,
              })
            }
            if (!latest) {
              if (getActiveRefreshFailureKind() === "transient") {
                // Retryable: let OpenCode/the AI SDK back off and retry rather
                // than telling the user to re-authenticate for a passing
                // rate-limit that the refresh token would otherwise survive.
                log("fetch_credentials_transient_exhausted", {
                  modelId: "unknown",
                })
                return new Response(
                  JSON.stringify({
                    type: "error",
                    error: {
                      type: "overloaded_error",
                      message:
                        "Claude token refresh is rate-limited; retry shortly.",
                    },
                  }),
                  {
                    status: 429,
                    headers: {
                      "content-type": "application/json",
                      "retry-after": "5",
                    },
                  },
                )
              }
              log("fetch_no_credentials", { modelId: "unknown" })
              throw new Error(
                "Claude Code credentials are unavailable or expired. Run `claude` to refresh them.",
              )
            }

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

            // Still rate-limited after the external-switch check, so this
            // account is genuinely out of allowance as far as this session can
            // tell. Bench it and walk down the priority order.
            //
            // Ordered after the external-switch block on purpose: if another
            // process already rotated us onto a healthy account, that costs no
            // cooldown and no switch. Ordered before the long-context beta loop
            // for the reason that loop documents from the other side — a
            // long-context 429 is a header problem that every account shares,
            // so rotating around it would bench the whole pool for a fault no
            // account can avoid. That case is excluded explicitly below rather
            // than by ordering alone, because reaching the beta loop first
            // would mean the account was already benched by then.
            if (response.status === 429 && getRotationConfig().enabled) {
              const rotationConfig = getRotationConfig()
              const triedSources = new Set<string>()
              const startingAccount = getActiveAccount()
              if (startingAccount) triedSources.add(startingAccount.source)

              for (
                let switchCount = 0;
                switchCount < rotationConfig.maxSwitchesPerRequest;
                switchCount++
              ) {
                if (response.status !== 429) break

                // Body is needed both to exclude long-context errors and to
                // tell an explained usage limit from a bare 429. Cloned so the
                // response stays readable if we end up returning it.
                let limitBody = ""
                try {
                  limitBody = await response.clone().text()
                } catch {
                  // An unreadable body is not a reason to skip rotation; it
                  // only costs the body-derived reason label.
                }

                if (isLongContextError(limitBody)) {
                  log("rotation_skipped_long_context", { modelId })
                  break
                }

                const limitedSource =
                  getActiveAccount()?.source ?? startingAccount?.source
                if (!limitedSource) break

                const rotated = await rotateAfterRateLimit({
                  limitedSource,
                  headers: response.headers,
                  body: limitBody,
                  triedSources,
                })
                if (!rotated) {
                  // Nothing healthy left. Return the 429 so the user sees the
                  // real limit rather than a silent stall, and say which
                  // accounts are benched and for how long — that is the one
                  // piece of information the raw API error cannot carry.
                  notify(
                    toastClient,
                    `All Claude accounts are rate-limited. ${describeCooldowns()}`,
                    "error",
                  )
                  break
                }

                triedSources.add(rotated.account.source)
                tokenInUse = rotated.credentials.accessToken
                syncAuthJson(rotated.credentials)
                notify(
                  toastClient,
                  `Rate limit reached — switched to ${rotated.account.label}.`,
                  "warning",
                )

                response = await fetchWithRetry(requestUrl, {
                  ...requestInit,
                  body,
                  headers: buildRequestHeaders(
                    input,
                    requestInit,
                    tokenInUse,
                    modelId,
                    getExcludedBetas(modelId),
                  ),
                })
                log("rotation_retry_response", {
                  modelId,
                  source: rotated.account.source,
                  status: response.status,
                  switchCount: switchCount + 1,
                })
              }
            }

            // An account that just served a request is demonstrably not
            // limited, so retire any bench it was still carrying — a cooldown
            // derived from a capped estimate should not outlive the limit it
            // was guessing at.
            if (response.ok) {
              const servingSource = getActiveAccount()?.source
              if (servingSource) noteAccountSucceeded(servingSource)
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
                // Rate-limited accounts stay selectable; the hint carries the
                // wait so the choice is informed.
                options: currentAccounts.map((a) => {
                  const hint = accountHint(a.source, currentSource)
                  // `hint: undefined` fails the server's auth-method schema,
                  // which serves GET /provider/auth for the TUI's /connect.
                  return hint
                    ? { label: a.label, value: a.source, hint }
                    : { label: a.label, value: a.source }
                }),
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
        {
          type: "oauth",
          label: "Add Claude token (paste from `claude setup-token`)",

          get prompts() {
            return [
              {
                type: "text" as const,
                key: "tokens",
                message:
                  "Paste one or more tokens from `claude setup-token` (separate multiple with a space or comma):",
                placeholder: "sk-ant-oat01-… sk-ant-oat01-…",
                validate: validateTokenInput,
              },
              {
                type: "text" as const,
                key: "label",
                message: "Label for these accounts (optional, e.g. work):",
                placeholder: "work",
              },
            ]
          },

          async authorize(inputs) {
            const { tokens, invalid } = parsePastedTokens(inputs?.tokens ?? "")
            const result = addTokens(tokens, inputs?.label)

            // Activate a newly added token straight away: pasting one is an
            // explicit statement of intent to use it, and leaving the session
            // on the old account would make the feature look inert.
            const roster = refreshAccountsList()
            const target = result.added[0]
              ? roster.find(
                  (a) => a.source === `token:${result.added[0]?.id ?? ""}`,
                )
              : undefined

            let creds: ClaudeCredentials | null = null
            if (target) {
              setActiveAccountSource(target.source)
              saveAccountSource(target.source)
              creds = await getCachedCredentials()
              if (creds) syncAuthJson(creds)
            } else {
              creds = await getCachedCredentials()
            }

            const parts: string[] = []
            if (result.added.length > 0) {
              parts.push(
                `Added ${result.added.length} token${result.added.length === 1 ? "" : "s"}`,
              )
            }
            if (result.duplicates.length > 0) {
              parts.push(`${result.duplicates.length} already stored`)
            }
            if (invalid.length > 0) {
              parts.push(`${invalid.length} ignored (not a valid token)`)
            }
            if (!result.persisted) {
              parts.push(
                "WARNING: could not write the token store — tokens apply to this session only",
              )
            }
            if (target) parts.push(`now using ${target.label}`)
            parts.push(`${roster.length} accounts available for rotation`)

            const summary = parts.join("; ")

            // A paste that produced nothing usable must not report success —
            // OpenCode would record an auth entry for an account that cannot
            // serve a request.
            if (!creds) {
              return {
                url: "",
                instructions: `${summary}. No usable credentials — run \`claude\` or paste a valid token.`,
                method: "auto",
                async callback() {
                  return { type: "failed" }
                },
              }
            }

            const activeCreds = creds
            return {
              url: "",
              instructions: `${summary}.`,
              method: "auto",
              async callback() {
                return {
                  type: "success",
                  provider: "anthropic",
                  access: activeCreds.accessToken,
                  refresh: activeCreds.refreshToken,
                  expires: activeCreds.expiresAt,
                }
              },
            }
          },
        },
        {
          type: "oauth",
          label: "Remove a stored Claude token",

          get prompts() {
            const entries = listTokenEntries().filter(
              // Environment-supplied tokens have no stored record to delete;
              // removing one means unsetting the variable.
              (e) => e.addedAt !== 0,
            )
            if (entries.length === 0) return []
            return [
              {
                type: "select" as const,
                key: "id",
                message: "Which stored token should be removed?",
                options: entries.map((e) => ({
                  label: e.label
                    ? `${e.label} (${tokenFingerprint(e.token)})`
                    : `Token ${tokenFingerprint(e.token)}`,
                  value: e.id,
                })),
              },
            ]
          },

          async authorize(inputs) {
            const id = inputs?.id
            const removed = id ? removeToken(id) : false
            const roster = refreshAccountsList()

            // The removed token may have been the active account, so re-resolve
            // rather than assuming the session still has usable credentials.
            const stillActive = getActiveAccount()
            if (!stillActive && roster[0]) {
              setActiveAccountSource(roster[0].source)
              saveAccountSource(roster[0].source)
            }
            const creds = await getCachedCredentials()

            const summary = removed
              ? `Removed the token; ${roster.length} accounts remain`
              : "No matching token was stored"

            if (!creds) {
              return {
                url: "",
                instructions: `${summary}. No usable credentials remain — run \`claude\` or paste a token.`,
                method: "auto",
                async callback() {
                  return { type: "failed" }
                },
              }
            }

            const activeCreds = creds
            return {
              url: "",
              instructions: `${summary}. Using ${getActiveAccount()?.label ?? "the remaining account"}.`,
              method: "auto",
              async callback() {
                return {
                  type: "success",
                  provider: "anthropic",
                  access: activeCreds.accessToken,
                  refresh: activeCreds.refreshToken,
                  expires: activeCreds.expiresAt,
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
