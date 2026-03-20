import type { Plugin } from "@opencode-ai/plugin"
import { execSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { readClaudeCredentials, type ClaudeCredentials } from "./keychain.js"

const SYSTEM_IDENTITY_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude."
const TOOL_PREFIX = "mcp_"
const DEFAULT_CC_VERSION = "2.1.80"
const DEFAULT_BETA_FLAGS = "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05"

function getCliVersion(): string {
  return process.env.ANTHROPIC_CLI_VERSION ?? DEFAULT_CC_VERSION
}

function getUserAgent(): string {
  return process.env.ANTHROPIC_USER_AGENT ?? `claude-cli/${getCliVersion()} (external, cli)`
}

function getRequiredBetas(): string[] {
  return (process.env.ANTHROPIC_BETA_FLAGS ?? DEFAULT_BETA_FLAGS)
    .split(",").map(s => s.trim()).filter(Boolean)
}
const CREDENTIAL_CACHE_TTL_MS = 30_000

// Beta flags to try removing in order when "long context" errors occur
const LONG_CONTEXT_BETAS = ["context-1m-2025-08-07", "interleaved-thinking-2025-05-14"]

let cachedCredentials: ClaudeCredentials | null = null
let cachedCredentialsAt = 0

// Session-level cache of excluded beta flags per model (resets on process restart)
const excludedBetas: Map<string, Set<string>> = new Map()

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
      const delay = retryAfter
        ? parseInt(retryAfter, 10) * 1000
        : (i + 1) * 2000
      await new Promise(r => setTimeout(r, delay))
      continue
    }
    return res
  }
  return fetchImpl(input, init)
}

function getAuthJsonPaths(): string[] {
  const xdgPath = join(homedir(), ".local", "share", "opencode", "auth.json")
  if (process.platform === "win32") {
    const appData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")
    const localAppDataPath = join(appData, "opencode", "auth.json")
    // Write to both paths on Windows: some installs (Chocolatey, npm global)
    // use the XDG-style path, others use %LOCALAPPDATA%. See #33.
    return [xdgPath, localAppDataPath]
  }
  return [xdgPath]
}

function syncToPath(authPath: string, creds: ClaudeCredentials): void {
  let auth: Record<string, unknown> = {}
  if (existsSync(authPath)) {
    const raw = readFileSync(authPath, "utf-8").trim()
    if (raw) {
      try {
        auth = JSON.parse(raw)
      } catch {
        // Malformed file, start fresh
      }
    }
  }
  auth.anthropic = {
    type: "oauth",
    access: creds.accessToken,
    refresh: creds.refreshToken,
    expires: creds.expiresAt,
  }
  const dir = dirname(authPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(authPath, JSON.stringify(auth, null, 2), "utf-8")
}

function syncAuthJson(creds: ClaudeCredentials): void {
  for (const authPath of getAuthJsonPaths()) {
    syncToPath(authPath, creds)
  }
}

function refreshViaCli(): void {
  const maxAttempts = 2
  for (let i = 0; i < maxAttempts; i++) {
    try {
      execSync("claude -p . --model haiku", {
        timeout: 60_000,
        encoding: "utf-8",
        env: { ...process.env, TERM: "dumb" },
        stdio: "ignore",
      })
      return
    } catch {
      // Non-fatal: retry once, then give up
    }
  }
}

function refreshIfNeeded(): ClaudeCredentials | null {
  let creds = readClaudeCredentials()
  if (creds && creds.expiresAt > Date.now() + 60_000) {
    return creds
  }
  // Token is expired or near expiry, try CLI refresh
  refreshViaCli()
  creds = readClaudeCredentials()
  if (creds && creds.expiresAt > Date.now() + 60_000) {
    return creds
  }
  return null
}

function isCredentialUsable(creds: ClaudeCredentials): boolean {
  return creds.expiresAt > Date.now() + 60_000
}

// Track the last-seen beta flags env var and model to detect changes
let lastBetaFlagsEnv: string | undefined = process.env.ANTHROPIC_BETA_FLAGS
let lastModelId: string | undefined

function getExcludedBetas(modelId: string): Set<string> {
  // Reset exclusions if user changed ANTHROPIC_BETA_FLAGS
  const currentBetaFlags = process.env.ANTHROPIC_BETA_FLAGS
  if (currentBetaFlags !== lastBetaFlagsEnv) {
    excludedBetas.clear()
    lastBetaFlagsEnv = currentBetaFlags
  }
  
  // Reset exclusions if user switched models (new model may support different betas)
  if (lastModelId !== undefined && lastModelId !== modelId) {
    excludedBetas.clear()
  }
  lastModelId = modelId
  
  return excludedBetas.get(modelId) ?? new Set()
}

function addExcludedBeta(modelId: string, beta: string): void {
  const existing = excludedBetas.get(modelId) ?? new Set()
  existing.add(beta)
  excludedBetas.set(modelId, existing)
}

export function isLongContextError(responseBody: string): boolean {
  return responseBody.includes("Extra usage is required for long context requests")
}

function getNextBetaToExclude(modelId: string): string | null {
  const excluded = getExcludedBetas(modelId)
  for (const beta of LONG_CONTEXT_BETAS) {
    if (!excluded.has(beta)) {
      return beta
    }
  }
  return null // All long-context betas already excluded
}

export function getCachedCredentials(): ClaudeCredentials | null {
  const now = Date.now()
  if (
    cachedCredentials &&
    now - cachedCredentialsAt < CREDENTIAL_CACHE_TTL_MS &&
    isCredentialUsable(cachedCredentials)
  ) {
    return cachedCredentials
  }

  const latest = refreshIfNeeded()
  if (!latest) {
    cachedCredentials = null
    cachedCredentialsAt = 0
    return null
  }

  cachedCredentials = latest
  cachedCredentialsAt = now
  return latest
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
  const mergedBetas = [...new Set([...modelBetas, ...incomingBeta.split(",").map((item) => item.trim()).filter(Boolean)])]

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

export function getModelBetas(modelId: string, excluded?: Set<string>): string[] {
  const betas = [...getRequiredBetas()]
  const lower = modelId.toLowerCase()

  // context-1m only for opus/sonnet 4.6+ models
  if (lower.includes("opus") || lower.includes("sonnet")) {
    const versionMatch = lower.match(/(opus|sonnet)-(\d+)-(\d+)/)
    if (versionMatch) {
      const major = parseInt(versionMatch[2], 10)
      const minor = parseInt(versionMatch[3], 10)
      if (major > 4 || (major === 4 && minor >= 6)) {
        betas.push("context-1m-2025-08-07")
      }
    }
    // If no version found (bare alias like "sonnet"), exclude 1M beta
  }

  // haiku doesn't get claude-code-20250219
  if (lower.includes("haiku")) {
    const idx = betas.indexOf("claude-code-20250219")
    if (idx !== -1) betas.splice(idx, 1)
  }

  // Filter out excluded betas (from previous failed requests due to long context errors)
  if (excluded && excluded.size > 0) {
    return betas.filter(beta => !excluded.has(beta))
  }

  return betas
}

export function transformBody(body: BodyInit | null | undefined): BodyInit | null | undefined {
  if (typeof body !== "string") {
    return body
  }

  try {
    const parsed = JSON.parse(body) as {
      model?: string
      system?: Array<{ type?: string; text?: string }>
      tools?: Array<{ name?: string } & Record<string, unknown>>
      messages?: Array<{ content?: Array<Record<string, unknown>> }>
    }

    if (Array.isArray(parsed.tools)) {
      parsed.tools = parsed.tools.map((tool) => ({
        ...tool,
        name: tool.name ? `${TOOL_PREFIX}${tool.name}` : tool.name,
      }))
    }

    if (Array.isArray(parsed.messages)) {
      parsed.messages = parsed.messages.map((message) => {
        if (!Array.isArray(message.content)) {
          return message
        }

        return {
          ...message,
          content: message.content.map((block) => {
            if (block.type !== "tool_use" || typeof block.name !== "string") {
              return block
            }

            return {
              ...block,
              name: `${TOOL_PREFIX}${block.name}`,
            }
          }),
        }
      })
    }

    return JSON.stringify(parsed)
  } catch {
    return body
  }
}

export function stripToolPrefix(text: string): string {
  return text.replace(/"name"\s*:\s*"mcp_([^"]+)"/g, '"name": "$1"')
}

export function transformResponseStream(response: Response): Response {
  if (!response.body) {
    return response
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ""

  const stream = new ReadableStream({
    async pull(controller) {
      for (;;) {
        const boundary = buffer.indexOf("\n\n")
        if (boundary !== -1) {
          const completeEvent = buffer.slice(0, boundary + 2)
          buffer = buffer.slice(boundary + 2)
          controller.enqueue(encoder.encode(stripToolPrefix(completeEvent)))
          return
        }

        const { done, value } = await reader.read()

        if (done) {
          if (buffer) {
            controller.enqueue(encoder.encode(stripToolPrefix(buffer)))
            buffer = ""
          }
          controller.close()
          return
        }

        buffer += decoder.decode(value, { stream: true })
      }
    },
  })

  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
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
  setInterval(() => {
    try {
      const fresh = refreshIfNeeded()
      if (fresh) {
        syncAuthJson(fresh)
      }
    } catch {
      // Non-fatal
    }
  }, SYNC_INTERVAL)

  return {
    "experimental.chat.system.transform": async (input, output) => {
      if (input.model?.providerID !== "anthropic") {
        return
      }

      const hasIdentityPrefix = output.system.some((entry) => entry.includes(SYSTEM_IDENTITY_PREFIX))
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
            const bodyStr = typeof requestInit.body === "string" ? requestInit.body : undefined
            let modelId = "unknown"
            if (bodyStr) {
              try { modelId = (JSON.parse(bodyStr) as { model?: string }).model ?? "unknown" } catch {}
            }

            // Get excluded betas for this model (from previous failed requests)
            const excluded = getExcludedBetas(modelId)
            const headers = buildRequestHeaders(input, requestInit, latest.accessToken, modelId, excluded)
            const body = transformBody(requestInit.body)

            let response = await fetchWithRetry(input, {
              ...requestInit,
              body,
              headers,
            })

            // Check for long-context beta errors and retry with betas excluded
            // Try up to LONG_CONTEXT_BETAS.length times, excluding one more beta each time
            for (let attempt = 0; attempt < LONG_CONTEXT_BETAS.length; attempt++) {
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
              const newHeaders = buildRequestHeaders(input, requestInit, latest.accessToken, modelId, newExcluded)

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
