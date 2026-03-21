import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { readClaudeCredentials, writeClaudeCredentials, type ClaudeCredentials } from "./keychain.js"

// OAuth configuration (matches Claude Code v2.1.80)
const CLAUDE_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const CLAUDE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
const CLAUDE_SCOPES = "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"
const DEFAULT_CC_VERSION = "2.1.80"

function getUserAgent(): string {
  return process.env.ANTHROPIC_USER_AGENT ?? `claude-cli/${process.env.ANTHROPIC_CLI_VERSION ?? DEFAULT_CC_VERSION} (external, cli)`
}

// Buffer: refresh if token expires within 5 minutes (matches CC's BUFFER_BEFORE_EXPIRY_MS)
const REFRESH_BUFFER_MS = 5 * 60 * 1000
const CREDENTIAL_CACHE_TTL_MS = 30_000

let cachedCredentials: ClaudeCredentials | null = null
let cachedCredentialsAt = 0

function getAuthJsonPaths(): string[] {
  const xdgPath = join(homedir(), ".local", "share", "opencode", "auth.json")
  if (process.platform === "win32") {
    const appData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")
    const localAppDataPath = join(appData, "opencode", "auth.json")
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

export function syncAuthJson(creds: ClaudeCredentials): void {
  for (const authPath of getAuthJsonPaths()) {
    syncToPath(authPath, creds)
  }
}

interface OAuthTokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  token_type: string
  scope?: string
}

/**
 * Refresh tokens directly via the OAuth token endpoint.
 * Uses the same grant_type, client_id, scope, and User-Agent as Claude Code v2.1.80.
 *
 * CRITICAL: The User-Agent header MUST be set to "claude-cli/..." otherwise
 * the token endpoint returns HTTP 429 (Cloudflare WAF block, not a real rate limit).
 */
async function refreshOAuthToken(refreshToken: string): Promise<ClaudeCredentials | null> {
  try {
    const response = await fetch(CLAUDE_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": getUserAgent(),
      },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLAUDE_CLIENT_ID,
        scope: CLAUDE_SCOPES,
      }),
      signal: AbortSignal.timeout(15_000),
    })

    if (!response.ok) {
      const text = await response.text()
      console.warn(`opencode-claude-auth: Token refresh failed (HTTP ${response.status}): ${text.slice(0, 200)}`)
      return null
    }

    const tokens = await response.json() as OAuthTokenResponse
    if (!tokens.access_token) {
      console.warn("opencode-claude-auth: Token refresh response missing access_token")
      return null
    }

    const newCreds: ClaudeCredentials = {
      accessToken: tokens.access_token,
      // Refresh tokens may be rotated — use new one if provided, otherwise keep old
      refreshToken: tokens.refresh_token ?? refreshToken,
      expiresAt: Date.now() + (tokens.expires_in || 3600) * 1000,
    }

    // Persist refreshed tokens back to Claude Code's credential store
    // so both CC and this plugin stay in sync
    try {
      writeClaudeCredentials(newCreds)
    } catch (err) {
      console.warn("opencode-claude-auth: Failed to persist refreshed tokens:", err instanceof Error ? err.message : err)
    }

    return newCreds
  } catch (err) {
    console.warn("opencode-claude-auth: Token refresh error:", err instanceof Error ? err.message : err)
    return null
  }
}

export function refreshIfNeeded(): ClaudeCredentials | null {
  let creds = readClaudeCredentials()
  if (creds && creds.expiresAt > Date.now() + REFRESH_BUFFER_MS) {
    return creds
  }

  // Token is expired or near-expiry — attempt OAuth refresh
  if (creds?.refreshToken) {
    // refreshOAuthToken is async but we need sync here for compatibility.
    // Queue the async refresh and return current creds if still minimally usable.
    refreshOAuthTokenSync(creds.refreshToken)

    // Re-read in case a previous async refresh already completed
    creds = readClaudeCredentials()
    if (creds && creds.expiresAt > Date.now() + 60_000) {
      return creds
    }
  }

  return null
}

// Async refresh that runs in the background
let pendingRefresh: Promise<ClaudeCredentials | null> | null = null

function refreshOAuthTokenSync(refreshToken: string): void {
  if (pendingRefresh) return
  pendingRefresh = refreshOAuthToken(refreshToken).finally(() => {
    pendingRefresh = null
  })
}

/**
 * Get credentials, refreshing asynchronously if needed.
 * Prefer this over refreshIfNeeded() when in an async context.
 */
export async function refreshIfNeededAsync(): Promise<ClaudeCredentials | null> {
  let creds = readClaudeCredentials()
  if (creds && creds.expiresAt > Date.now() + REFRESH_BUFFER_MS) {
    return creds
  }

  if (creds?.refreshToken) {
    const refreshed = await refreshOAuthToken(creds.refreshToken)
    if (refreshed) return refreshed
  }

  return null
}

function isCredentialUsable(creds: ClaudeCredentials): boolean {
  return creds.expiresAt > Date.now() + 60_000
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

/**
 * Async version of getCachedCredentials — performs a real async refresh
 * instead of fire-and-forget. Use this in async contexts (e.g., fetch handlers).
 */
export async function getCachedCredentialsAsync(): Promise<ClaudeCredentials | null> {
  const now = Date.now()
  if (
    cachedCredentials &&
    now - cachedCredentialsAt < CREDENTIAL_CACHE_TTL_MS &&
    isCredentialUsable(cachedCredentials)
  ) {
    return cachedCredentials
  }

  const latest = await refreshIfNeededAsync()
  if (!latest) {
    cachedCredentials = null
    cachedCredentialsAt = 0
    return null
  }

  cachedCredentials = latest
  cachedCredentialsAt = now
  return latest
}

export type { ClaudeCredentials } from "./keychain.js"
