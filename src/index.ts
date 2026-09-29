import type { Plugin } from "@opencode-ai/plugin"
import crypto from "node:crypto"
import { config } from "./model-config.ts"
import { readAllClaudeAccounts, type ClaudeAccount } from "./keychain.ts"
import { initLogger, log } from "./logger.ts"
import {
  fetchClaudeMessages as fetchWithRetry,
  isSyntheticDeadlineAbort,
  sleepUntilStateChange,
  stateRevision,
  throwIfAborted,
} from "./http.ts"
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
  retryAfterCooldownWait,
  noteAccountSucceeded,
  chooseInitialAccount,
  type ClaudeCredentials,
} from "./credentials.ts"
import {
  activeCooldowns,
  clearWaitAttempt,
  createWaitAttemptId,
  formatRemaining,
  getCooldownUntil,
  getRotationConfig,
  getRotationWaitConfig,
  publishWaitAttempt,
  readRotationState,
  getRotationStatePath,
  cooldownFromResponse,
  markRateLimited,
} from "./rotation.ts"
import {
  addTokens,
  isTokenSource,
  listTokenEntries,
  parsePastedTokens,
  removeToken,
  tokenFingerprint,
  validateTokenInput,
  getTokenStorePath,
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

/**
 * Clock, sleeper, and entropy source for the quota-wait loop, behind a seam
 * so tests can travel time instead of napping. Production always runs on the
 * wall clock and the abort-aware sleep from http.ts.
 */
type RotationWaitDeps = {
  now: () => number
  sleep: (
    ms: number,
    signal?: AbortSignal | null,
    revision?: string,
  ) => Promise<void>
  rng: () => number
}

const availabilityPaths = () => [getRotationStatePath(), getTokenStorePath()]
const availabilitySleep: RotationWaitDeps["sleep"] = (ms, signal, revision) =>
  sleepUntilStateChange(
    Math.min(ms, 60_000),
    signal,
    availabilityPaths(),
    revision,
  )

let rotationWaitDeps: RotationWaitDeps = {
  now: () => Date.now(),
  sleep: availabilitySleep,
  rng: () => Math.random(),
}

/** Test seam: replace the wait loop's relationship with time. Pass null to reset. */
export function __setRotationWaitDepsForTests(
  deps: Partial<RotationWaitDeps> | null,
): void {
  rotationWaitDeps = {
    now: deps?.now ?? (() => Date.now()),
    sleep: deps?.sleep ?? availabilitySleep,
    rng: deps?.rng ?? (() => Math.random()),
  }
}

type AvailabilityContext = {
  cycles: number
  elapsedMs: number
  invalid: Set<string>
  signal?: AbortSignal | null
  lastEarliestUntil?: number
  lastEarliestLabel?: string
}

type AcquireResult =
  | { account: ClaudeAccount; credentials: ClaudeCredentials }
  | { deferredToOpenCodeRetry: true }
  | null

function isDeferred(
  result: unknown,
): result is { deferredToOpenCodeRetry: true } {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as { deferredToOpenCodeRetry?: unknown })
      .deferredToOpenCodeRetry === true
  )
}

/**
 * Answer a client-side 429 with an *authoritative* retry-after derived from our
 * own persisted earliest-bench (never the possibly stale header of whichever
 * account happened to 429 first). OpenCode's retry machinery then resumes at
 * the benchmark time, and on that retry the request goes through immediately.
 */
function deferred429(context: AvailabilityContext): Response {
  const until = context.lastEarliestUntil ?? rotationWaitDeps.now() + 30_000
  const seconds = Math.max(
    1,
    Math.ceil((until - rotationWaitDeps.now()) / 1000),
  )
  return new Response(
    JSON.stringify({
      type: "error",
      error: {
        type: "rate_limit_error",
        message: `Claude quota: ${seconds}s until next eligible account${context.lastEarliestLabel ? ` (${context.lastEarliestLabel})` : ""}; OpenCode will retry automatically.`,
      },
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": String(seconds),
      },
    },
  )
}

/** The sole owner of quota waiting. File events wake it early; timer ticks
 * re-read local state only. HTTP is attempted only after a candidate is eligible.
 * It never re-benches a stale response while waiting; OpenCode's own wrapper
 * abort converts to a benchmark-accurate deferred retry, never a cached 429
 * and never a fake cancellation. The caller's signal stays honest for Stop. */
async function acquireAvailableAccount(
  context: AvailabilityContext,
  client?: ToastClient,
): Promise<AcquireResult> {
  const options = getRotationWaitConfig()
  const id = createWaitAttemptId()
  let startedAt: number | undefined
  let nextProgressAt = 0
  try {
    for (;;) {
      throwIfAborted(context.signal)
      const revision = stateRevision(availabilityPaths())
      const now = rotationWaitDeps.now()
      const roster = refreshAccountsList()
      const state = readRotationState()
      const usable = roster.filter(
        (account) => !context.invalid.has(account.source),
      )
      if (
        usable.some(
          (account) => !(state.cooldowns[account.source]?.until > now),
        )
      ) {
        const candidate = await retryAfterCooldownWait({
          triedSources: new Set(),
          invalidSources: context.invalid,
          signal: context.signal,
          now,
        })
        throwIfAborted(context.signal)
        if (candidate) {
          if (startedAt !== undefined)
            log("rotation_wait_wake", {
              source: candidate.account.source,
              cycle: context.cycles,
            })
          return candidate
        }
        continue // failed candidates were excluded, not given imaginary cooldowns
      }
      const limited = usable
        .map((account) => ({ account, entry: state.cooldowns[account.source] }))
        .filter((item) => item.entry?.until > now)
        .sort((a, b) => a.entry.until - b.entry.until)
      const earliest = limited[0]
      context.lastEarliestUntil = earliest?.entry?.until
      context.lastEarliestLabel = earliest?.account.label
      if (!earliest) return null
      if (!options.enabled) return null
      if (options.maxCycles > 0 && context.cycles >= options.maxCycles)
        return null
      if (startedAt === undefined) startedAt = now
      context.cycles++

      // Keep this deadline fixed across progress ticks: neither the safety
      // margin nor the jitter should disappear or be redrawn on each tick.
      const deadline =
        earliest.entry.until +
        options.marginMs +
        Math.floor(rotationWaitDeps.rng() * options.jitterMs)
      log("rotation_wait_start", {
        cycle: context.cycles,
        earliestSource: earliest.account.source,
        earliestAt: earliest.entry.until,
        waitMs: Math.max(0, deadline - now),
      })
      if (context.cycles === 1) {
        notify(
          client,
          `Claude quota wait: next eligible account ${earliest.account.label} at ${new Date(deadline).toISOString()}; re-evaluating automatically.`,
          "warning",
        )
        nextProgressAt = now + options.progressMs
      }
      const budgetLeft =
        options.maxWaitTotalMs > 0
          ? options.maxWaitTotalMs - context.elapsedMs
          : Infinity
      if (budgetLeft <= 0) return null
      publishWaitAttempt(
        id,
        {
          cycle: context.cycles,
          startedAt,
          plannedSource: earliest.account.source,
          plannedLabel: earliest.account.label,
          until: deadline,
          waitMs: Math.max(0, deadline - now),
        },
        now,
      )

      const sleepDelta = async (ms: number): Promise<void> => {
        const t0 = rotationWaitDeps.now()
        try {
          await rotationWaitDeps.sleep(ms, context.signal, revision)
        } finally {
          context.elapsedMs += Math.max(0, rotationWaitDeps.now() - t0)
        }
      }

      for (;;) {
        const tickAt = rotationWaitDeps.now()
        const leftMs = deadline - tickAt
        if (leftMs <= 0) break
        const remainingBudget =
          options.maxWaitTotalMs > 0
            ? options.maxWaitTotalMs - context.elapsedMs
            : Infinity
        if (remainingBudget <= 0) return null
        if (options.progressMs > 0 && tickAt >= nextProgressAt) {
          publishWaitAttempt(
            id,
            {
              cycle: context.cycles,
              startedAt,
              plannedSource: earliest.account.source,
              plannedLabel: earliest.account.label,
              until: deadline,
              waitMs: leftMs,
            },
            tickAt,
          )
          notify(
            client,
            `Next attempt in ~${formatRemaining(leftMs)} via ${earliest.account.label}.`,
            "info",
          )
          nextProgressAt = tickAt + options.progressMs
        }
        await sleepDelta(
          Math.min(leftMs, options.progressMs || Infinity, remainingBudget),
        )
        throwIfAborted(context.signal)
        // Re-plan immediately on a roster/bench change. Reusing the old
        // revision in another watcher would otherwise cause a tight loop of
        // already-changed revisions until the entire chunk count ran out.
        if (stateRevision(availabilityPaths()) !== revision) break
        // A frozen test clock (or a clock adjustment) must not bypass an
        // explicit cycle cap. Real timers normally advance the wall clock.
        if (rotationWaitDeps.now() <= tickAt) break
      }
    }
  } catch (error) {
    if (context.signal?.aborted && isSyntheticDeadlineAbort(context.signal)) {
      // OpenCode's outer window (default 300 s) closed before the bench reset.
      // That is not a user cancellation: hand the flow back so we can defer
      // resumption to OpenCode's retry policy with an accurate retry-after,
      // instead of killing this turn with an abort it cannot distinguish.
      log("rotation_wait_outer_timeout", {
        cycle: context.cycles,
        elapsedMs: context.elapsedMs,
      })
      return { deferredToOpenCodeRetry: true }
    }
    if (context.signal?.aborted)
      log("rotation_wait_aborted", {
        cycle: context.cycles,
        elapsedMs: context.elapsedMs,
      })
    throw error
  } finally {
    clearWaitAttempt(id)
  }
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
          // OpenCode's header deadline wraps this entire fetch, including the
          // quota sleep. Actual network attempts have their own deadline below.
          ...(getRotationConfig().enabled && getRotationWaitConfig().enabled
            ? { headerTimeout: false, timeout: false }
            : {}),
          async fetch(input: RequestInfo | URL, init?: RequestInit) {
            const requestInit = {
              ...init,
              signal:
                init?.signal ??
                (input instanceof Request ? input.signal : undefined),
            }
            throwIfAborted(requestInit.signal)
            const availability: AvailabilityContext = {
              cycles: 0,
              elapsedMs: 0,
              invalid: new Set(),
              signal: requestInit.signal,
            }
            let selectedAccount = getActiveAccount()
            // The sticky source may have been benched by another concurrent
            // request. Skip it before sending anything if a healthy source is
            // already available — no unnecessary 429 just to trigger rotation.
            if (
              getRotationConfig().enabled &&
              selectedAccount &&
              getCooldownUntil(
                selectedAccount.source,
                rotationWaitDeps.now(),
              ) !== null
            ) {
              const eligible = await acquireAvailableAccount(
                availability,
                toastClient,
              )
              if (isDeferred(eligible)) {
                log("rotation_deferred_retry", {
                  phase: "preflight",
                  deferredAt: availability.lastEarliestUntil,
                })
                return deferred429(availability)
              }
              if (eligible) {
                selectedAccount = eligible.account
                syncAuthJson(eligible.credentials)
              } else if (getRotationWaitConfig().enabled) {
                throw new Error(
                  "Claude quota wait budget exhausted or no usable accounts remain.",
                )
              }
            }
            // Account selection is shared process state; another concurrent
            // turn can switch it during our HTTP call. Attribute this request's
            // response to the source whose token it actually sent.
            let servingSource = selectedAccount?.source ?? null
            let latest = await getCachedCredentials(selectedAccount)
            throwIfAborted(requestInit.signal)
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
                candidate = reloadCredentialsFromSource(
                  servingSource ?? undefined,
                )
              } catch (err) {
                log("auth_recovery_reload_threw", {
                  modelId,
                  attempt: attempt + 1,
                  error: err instanceof Error ? err.message : String(err),
                })
              }

              if (!candidate || candidate.accessToken === tokenInUse) {
                try {
                  candidate = await forceRefreshActiveAccount(
                    undefined,
                    servingSource ?? undefined,
                  )
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
                rotated = reloadCredentialsFromSource(
                  servingSource ?? undefined,
                )
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
            //
            // When every account is benched, tried, or broken, the loop does
            // NOT fail: it sleeps until the soonest recorded bench expires
            // (a real sleep — no polling, no probe requests), re-evaluates the
            // pool, and resends this identical request. A long-running task
            // survives a quota window however long it is; the abort signal is
            // the escape hatch, and OPENCODE_CLAUDE_AUTH_ROTATE_WAIT* can
            // bound or disable the waiting for callers that prefer to fail.
            if (response.status === 429 && getRotationConfig().enabled) {
              const rotationConfig = getRotationConfig()
              let switches = 0
              while (response.status === 429) {
                throwIfAborted(requestInit.signal)

                // Body is needed both to exclude long-context errors and to
                // tell an explained usage limit from a bare 429. Cloned so
                // the response stays readable if we end up returning it.
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

                const limitedSource = servingSource
                if (!limitedSource) break

                const { ms, reason } = cooldownFromResponse(
                  response.headers,
                  limitBody,
                  rotationConfig,
                  rotationWaitDeps.now(),
                )
                markRateLimited(
                  limitedSource,
                  ms,
                  reason,
                  rotationWaitDeps.now(),
                )
                // Automatic mode must visit every configured account. The
                // legacy switch cap remains only for explicit fail-fast mode.
                if (
                  !getRotationWaitConfig().enabled &&
                  switches >= rotationConfig.maxSwitchesPerRequest
                )
                  break
                const rotated = await acquireAvailableAccount(
                  availability,
                  toastClient,
                )
                if (isDeferred(rotated)) {
                  // OpenCode's wrapper aborted mid-sleep at its own deadline:
                  // answer with an authoritative retry-after so its retry
                  // machinery resumes exactly when the bench becomes eligible.
                  void response.body?.cancel().catch(() => {})
                  response = deferred429(availability)
                  switches++
                  log("rotation_deferred_retry", {
                    modelId,
                    limitedSource,
                    deferredAt: availability.lastEarliestUntil,
                    remainingMs: availability.lastEarliestUntil
                      ? Math.max(
                          0,
                          availability.lastEarliestUntil -
                            rotationWaitDeps.now(),
                        )
                      : null,
                  })
                  break
                }
                throwIfAborted(requestInit.signal)
                if (!rotated) break
                void response.body?.cancel().catch(() => {})

                servingSource = rotated.account.source
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
                  switchCount: ++switches,
                })
              }
            }

            // An account that just served a request is demonstrably not
            // limited, so retire any bench it was still carrying — a cooldown
            // derived from a capped estimate should not outlive the limit it
            // was guessing at.
            if (response.ok) {
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
