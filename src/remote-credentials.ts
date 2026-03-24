/**
 * Remote credentials module for fetching credentials from a remote server.
 * This is the CLIENT side of the credential proxy.
 */

/** Credentials returned by the remote server (subset of ClaudeCredentials — no refreshToken) */
export interface RemoteCredentials {
  accessToken: string
  expiresAt: number
}

/** Cache entry for remote credentials */
interface CacheEntry {
  creds: RemoteCredentials
  cachedAt: number
}

/** Default cache TTL: 30 seconds (matching local mode's CREDENTIAL_CACHE_TTL_MS) */
const CACHE_TTL_MS = 30_000

/** Token expiry buffer: 60 seconds before actual expiry */
const EXPIRY_BUFFER_MS = 60_000

/** Request timeout: 10 seconds */
const REQUEST_TIMEOUT_MS = 10_000

/** In-memory cache for remote credentials */
let cache: CacheEntry | null = null

/**
 * Check if cached credentials are still valid.
 * Valid if: within TTL AND not within 60 seconds of expiry.
 */
function isCacheValid(): boolean {
  if (!cache) return false

  const now = Date.now()
  const withinTtl = now - cache.cachedAt < CACHE_TTL_MS
  const notNearExpiry = cache.creds.expiresAt > now + EXPIRY_BUFFER_MS

  return withinTtl && notNearExpiry
}

/**
 * Fetch credentials from a remote server.
 *
 * @param serverUrl - The base URL of the remote credential server
 * @param apiKey - The API key for authentication
 * @returns Remote credentials if successful, null on any error
 */
export async function fetchRemoteCredentials(
  serverUrl: string,
  apiKey: string,
): Promise<RemoteCredentials | null> {
  // Check cache first
  if (isCacheValid()) {
    return cache!.creds
  }

  // Build request URL
  const url = `${serverUrl.replace(/\/$/, "")}/v1/credentials`

  // Set up timeout using AbortController
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
    })

    // Handle HTTP errors
    if (!response.ok) {
      return handleHttpError(response)
    }

    // Parse JSON response
    let data: unknown
    try {
      data = await response.json()
    } catch {
      console.warn("opencode-claude-auth: Invalid response from remote server")
      return null
    }

    // Validate response shape
    if (
      typeof data !== "object" ||
      data === null ||
      !("accessToken" in data) ||
      !("expiresAt" in data) ||
      typeof (data as Record<string, unknown>).accessToken !== "string" ||
      typeof (data as Record<string, unknown>).expiresAt !== "number"
    ) {
      console.warn("opencode-claude-auth: Invalid response from remote server")
      return null
    }

    const creds: RemoteCredentials = {
      accessToken: (data as Record<string, unknown>).accessToken as string,
      expiresAt: (data as Record<string, unknown>).expiresAt as number,
    }

    // Cache the result
    cache = { creds, cachedAt: Date.now() }

    return creds
  } catch (error) {
    // Handle network errors (fetch throws)
    const message =
      error instanceof Error ? error.message : "Unknown network error"
    console.warn(
      `opencode-claude-auth: Failed to reach remote server at ${serverUrl}: ${message}`,
    )
    return null
  } finally {
    clearTimeout(timeout)
  }
}

/**
 * Handle HTTP error responses.
 * Returns cached credentials if still valid for 429, otherwise null.
 */
function handleHttpError(response: Response): null {
  const status = response.status

  if (status === 401) {
    console.warn(
      "opencode-claude-auth: Remote server rejected API key (401 Unauthorized)",
    )
    return null
  }

  if (status === 429) {
    const retryAfter = response.headers.get("Retry-After")
    const retrySeconds = retryAfter ? parseInt(retryAfter, 10) : NaN

    if (!Number.isNaN(retrySeconds)) {
      console.warn(
        `opencode-claude-auth: Remote server rate limited. Retry after ${retrySeconds}s`,
      )
    } else {
      console.warn("opencode-claude-auth: Remote server rate limited")
    }

    // Return cached credentials if still valid
    if (isCacheValid()) {
      return null // Caller should check cache before making request
    }
    return null
  }

  if (status === 503) {
    console.warn(
      "opencode-claude-auth: Remote server has no credentials available (503)",
    )
    return null
  }

  console.warn(`opencode-claude-auth: Remote server returned ${status}`)
  return null
}

/**
 * Clear the remote credentials cache.
 * Useful for testing and account switching.
 */
export function clearRemoteCache(): void {
  cache = null
}
