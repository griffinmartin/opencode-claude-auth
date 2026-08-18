import crypto from "node:crypto"
import { createAnthropic } from "@ai-sdk/anthropic"
import {
  addExcludedBeta,
  getExcludedBetas,
  getModelBetas,
  getNextBetaToExclude,
  isLongContextError,
  LONG_CONTEXT_BETAS,
} from "./betas.ts"
import {
  forceRefreshActiveAccount,
  getActiveRefreshFailureKind,
  getCachedCredentials,
  getCredentialsWithBackoff,
  reloadCredentialsFromSource,
  type ClaudeCredentials,
} from "./credentials.ts"
import { fetchWithRetry } from "./http.ts"
import { log } from "./logger.ts"
import { config } from "./model-config.ts"
import { transformBody, transformResponseStream } from "./transforms.ts"

const sessionID = crypto.randomUUID()

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

function getCliVersion() {
  return process.env.ANTHROPIC_CLI_VERSION ?? config.ccVersion
}

function getUserAgent() {
  return (
    process.env.ANTHROPIC_USER_AGENT ??
    `claude-cli/${getCliVersion()} (external, sdk-cli)`
  )
}

function buildRequestURL(input: RequestInfo | URL) {
  const raw =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url
  const url = new URL(raw)
  if (url.pathname === "/v1/messages" && !url.searchParams.has("beta"))
    url.searchParams.set("beta", "true")
  return typeof input === "string" ? url.href : url
}

export { fetchWithRetry } from "./http.ts"

export function buildRequestHeaders(
  input: RequestInfo | URL,
  init: RequestInit,
  accessToken: string,
  modelID = "unknown",
  excludedBetas?: Set<string>,
) {
  const headers = new Headers(
    input instanceof Request ? input.headers : undefined,
  )
  new Headers(init.headers).forEach((value, key) => headers.set(key, value))
  const incoming = (headers.get("anthropic-beta") ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)

  headers.set("authorization", `Bearer ${accessToken}`)
  headers.set("anthropic-version", "2023-06-01")
  headers.set(
    "anthropic-beta",
    [...new Set([...getModelBetas(modelID, excludedBetas), ...incoming])].join(
      ",",
    ),
  )
  headers.set("anthropic-dangerous-direct-browser-access", "true")
  headers.set("x-app", "cli")
  headers.set("user-agent", getUserAgent())
  headers.set("x-client-request-id", crypto.randomUUID())
  headers.set("x-claude-code-session-id", sessionID)
  const stainless = {
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
  for (const [key, value] of Object.entries(stainless)) {
    if (!headers.has(key)) headers.set(key, value)
  }
  headers.delete("x-api-key")
  return headers
}

export function claudeSubscriptionFetch(
  accessToken: string,
  upstream?: Fetch,
): Fetch {
  const send = upstream ?? fetch
  return async (input, init = {}) => {
    const requestBody =
      input instanceof Request && init.body === undefined
        ? await input.clone().text()
        : init.body
    const requestInit = {
      ...(input instanceof Request
        ? { method: input.method, headers: input.headers, signal: input.signal }
        : {}),
      ...init,
      body: requestBody,
    }
    let modelID = "unknown"
    if (typeof requestBody === "string") {
      try {
        modelID =
          (JSON.parse(requestBody) as { model?: string }).model ?? "unknown"
      } catch {}
    }
    const requestURL = buildRequestURL(input)
    const transformedBody = transformBody(requestBody)
    const excluded = getExcludedBetas(modelID)
    let credentials = await getCachedCredentials()
    if (!credentials) credentials = await getCredentialsWithBackoff()
    let token = credentials?.accessToken ?? accessToken
    if (!token)
      throw new Error(
        "Claude subscription credentials are unavailable. Run /connect in OpenCode 2.",
      )

    const sendWithToken = (currentToken: string, excludedBetas = excluded) =>
      fetchWithRetry(
        requestURL,
        {
          ...requestInit,
          body: transformedBody,
          headers: buildRequestHeaders(
            input,
            requestInit,
            currentToken,
            modelID,
            excludedBetas,
          ),
        },
        3,
        send,
      )

    let response = await sendWithToken(token)

    for (let attempt = 0; response.status === 401 && attempt < 2; attempt++) {
      let candidate: ClaudeCredentials | null = reloadCredentialsFromSource()
      if (!candidate || candidate.accessToken === token)
        candidate = await forceRefreshActiveAccount()
      if (!candidate || candidate.accessToken === token) break
      token = candidate.accessToken
      log("auth_recovery_retry", { modelID, attempt: attempt + 1 })
      response = await sendWithToken(token)
    }

    if (response.status === 429) {
      const rotated = reloadCredentialsFromSource()
      if (rotated && rotated.accessToken !== token) {
        token = rotated.accessToken
        log("rate_limit_token_changed", { modelID })
        response = await sendWithToken(token)
      } else if (getActiveRefreshFailureKind() === "transient") {
        log("fetch_credentials_transient_exhausted", { modelID })
      }
    }

    for (let attempt = 0; attempt < LONG_CONTEXT_BETAS.length; attempt++) {
      if (response.status !== 400 && response.status !== 429) break
      if (!isLongContextError(await response.clone().text())) break
      const beta = getNextBetaToExclude(modelID)
      if (!beta) break
      addExcludedBeta(modelID, beta)
      response = await fetchWithRetry(
        requestURL,
        {
          ...requestInit,
          body: transformedBody,
          headers: buildRequestHeaders(
            input,
            requestInit,
            token,
            modelID,
            getExcludedBetas(modelID),
          ),
        },
        3,
        send,
      )
    }

    if (!response.ok)
      log("fetch_error_response", { status: response.status, modelID })
    return response.status === 401
      ? response
      : transformResponseStream(response)
  }
}

export function createClaudeSubscription(options: Record<string, unknown>) {
  const accessToken = typeof options.apiKey === "string" ? options.apiKey : ""
  const upstream =
    typeof options.fetch === "function" ? (options.fetch as Fetch) : undefined
  return createAnthropic({
    ...options,
    apiKey: "",
    fetch: claudeSubscriptionFetch(accessToken, upstream),
  })
}
