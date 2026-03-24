import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
  type Server as HttpServer,
} from "node:http"
import { timingSafeEqual } from "node:crypto"
import { getCachedCredentials, refreshIfNeeded } from "./credentials.js"
import type { ClaudeCredentials } from "./keychain.js"

export interface ServerOptions {
  port?: number
  bind?: string
  apiKey: string
  rateLimitRpm?: number
}

interface RateLimitResult {
  allowed: boolean
  limit: number
  remaining: number
  resetTime: number
  retryAfter: number | null
}

class RateLimiter {
  private timestamps: number[] = []
  private readonly maxRequests: number
  private readonly windowMs: number = 60000 // 1 minute sliding window

  constructor(maxRequests: number) {
    this.maxRequests = maxRequests
  }

  check(): RateLimitResult {
    const now = Date.now()
    const windowStart = now - this.windowMs

    // Remove timestamps outside the window (sliding window)
    this.timestamps = this.timestamps.filter((ts) => ts > windowStart)

    // Calculate remaining slots (accounting for current request if allowed)
    const currentCount = this.timestamps.length

    if (currentCount >= this.maxRequests) {
      // Rate limited - calculate retry after based on oldest request in window
      const oldestInWindow = this.timestamps[0]
      const retryAfter = Math.ceil(
        (oldestInWindow + this.windowMs - now) / 1000,
      )
      return {
        allowed: false,
        limit: this.maxRequests,
        remaining: 0,
        resetTime: Math.floor((oldestInWindow + this.windowMs) / 1000),
        retryAfter,
      }
    }

    // Add current request timestamp
    this.timestamps.push(now)

    return {
      allowed: true,
      limit: this.maxRequests,
      remaining: this.maxRequests - this.timestamps.length,
      resetTime: Math.floor((now + this.windowMs) / 1000),
      retryAfter: null,
    }
  }
}

function createRateLimiter(options: ServerOptions): RateLimiter {
  const rpm =
    options.rateLimitRpm ??
    parseInt(process.env.OPENAUTH_RATE_LIMIT_RPM ?? "60", 10)
  return new RateLimiter(rpm)
}

interface LogEntry {
  timestamp: string
  method: string
  path: string
  status: number
  durationMs: number
}

type LogLevel = "debug" | "info" | "warn" | "error"

function getLogLevel(): LogLevel {
  const level = process.env.OPENAUTH_LOG_LEVEL
  if (
    level === "debug" ||
    level === "info" ||
    level === "warn" ||
    level === "error"
  ) {
    return level
  }
  return "info"
}

function shouldLog(level: LogLevel): boolean {
  const levels: LogLevel[] = ["debug", "info", "warn", "error"]
  const currentLevel = getLogLevel()
  return levels.indexOf(level) >= levels.indexOf(currentLevel)
}

function redactAuthHeader(
  headers: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const redacted: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "authorization") {
      redacted[key] = value ? "Bearer [REDACTED]" : undefined
    } else {
      redacted[key] = value
    }
  }
  return redacted
}

function logRequest(
  method: string,
  path: string,
  status: number,
  durationMs: number,
  headers?: Record<string, string | undefined>,
): void {
  const entry: LogEntry = {
    timestamp: new Date().toISOString(),
    method,
    path,
    status,
    durationMs,
  }
  const logLine = JSON.stringify(entry)
  if (shouldLog("info")) {
    console.log(logLine)
  }
  if (shouldLog("debug") && headers) {
    const redactedHeaders = redactAuthHeader(headers)
    console.log(
      JSON.stringify({ timestamp: entry.timestamp, headers: redactedHeaders }),
    )
  }
}

function sendJson(
  res: ServerResponse,
  status: number,
  data: Record<string, unknown>,
  additionalHeaders?: Record<string, string>,
): void {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Cache-Control": "no-store, no-cache, must-revalidate",
    "X-Content-Type-Options": "nosniff",
  }
  if (additionalHeaders) {
    Object.assign(headers, additionalHeaders)
  }
  res.writeHead(status, headers)
  res.end(JSON.stringify(data))
}

function validateApiKey(
  authHeader: string | undefined,
  expectedKey: string,
): boolean {
  if (!authHeader) {
    return false
  }
  const match = authHeader.match(/^Bearer\s+(.+)$/i)
  if (!match) {
    return false
  }
  const providedKey = match[1]
  if (!providedKey || !expectedKey) {
    return false
  }
  // timingSafeEqual requires equal length buffers
  if (providedKey.length !== expectedKey.length) {
    return false
  }
  try {
    const providedBuffer = Buffer.from(providedKey, "utf-8")
    const expectedBuffer = Buffer.from(expectedKey, "utf-8")
    return timingSafeEqual(providedBuffer, expectedBuffer)
  } catch {
    return false
  }
}

// Mutex for credential refresh - prevents concurrent refresh operations
let refreshLock: Promise<ClaudeCredentials | null> | null = null

async function getCredentialsWithMutex(): Promise<ClaudeCredentials | null> {
  // If there's an ongoing refresh, wait for it and return its result
  if (refreshLock) {
    return refreshLock
  }

  // Try cached credentials first
  const cached = getCachedCredentials()
  if (cached) {
    return cached
  }

  // Need to refresh - acquire lock by creating a promise
  refreshLock = (async () => {
    try {
      const refreshed = refreshIfNeeded()
      return refreshed
    } finally {
      // Release lock after refresh completes (success or failure)
      refreshLock = null
    }
  })()

  return refreshLock
}

function handleHealth(res: ServerResponse): void {
  sendJson(res, 200, { status: "ok" })
}

function handleRateLimited(
  res: ServerResponse,
  rateLimitResult: RateLimitResult,
): void {
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(rateLimitResult.limit),
    "X-RateLimit-Remaining": String(rateLimitResult.remaining),
    "X-RateLimit-Reset": String(rateLimitResult.resetTime),
    "Retry-After": String(rateLimitResult.retryAfter),
  }
  sendJson(
    res,
    429,
    {
      error: "rate_limited",
      message: "Too many requests",
    },
    headers,
  )
}

async function handleCredentials(
  res: ServerResponse,
  rateLimitResult: RateLimitResult,
): Promise<void> {
  const headers: Record<string, string> = {
    "X-RateLimit-Limit": String(rateLimitResult.limit),
    "X-RateLimit-Remaining": String(rateLimitResult.remaining),
    "X-RateLimit-Reset": String(rateLimitResult.resetTime),
  }
  try {
    const creds = await getCredentialsWithMutex()
    if (!creds) {
      sendJson(
        res,
        503,
        {
          error: "credentials_unavailable",
          message: "No Claude Code credentials found or refresh failed",
        },
        headers,
      )
      return
    }
    // NEVER expose refreshToken
    sendJson(
      res,
      200,
      {
        accessToken: creds.accessToken,
        expiresAt: creds.expiresAt,
      },
      headers,
    )
  } catch (error) {
    const errorDetail = error instanceof Error ? error.message : "Unknown error"
    if (shouldLog("error")) {
      console.error(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          event: "credential_error",
          error: errorDetail,
        }),
      )
    }
    sendJson(
      res,
      503,
      {
        error: "credentials_unavailable",
        message: "Failed to retrieve credentials",
      },
      headers,
    )
  }
}

function handleNotFound(res: ServerResponse): void {
  sendJson(res, 404, { error: "not_found" })
}

function handleMethodNotAllowed(res: ServerResponse): void {
  sendJson(res, 405, { error: "method_not_allowed" })
}

function handleUnauthorized(res: ServerResponse): void {
  sendJson(res, 401, {
    error: "unauthorized",
    message: "Invalid or missing API key",
  })
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  apiKey: string,
  rateLimiter: RateLimiter,
): Promise<void> {
  const startTime = Date.now()
  const method = req.method ?? "GET"
  const path = req.url ?? "/"

  try {
    // Route: GET /v1/health (no auth required, no rate limit)
    if (method === "GET" && path === "/v1/health") {
      handleHealth(res)
      logRequest(
        method,
        path,
        200,
        Date.now() - startTime,
        req.headers as Record<string, string | undefined>,
      )
      return
    }

    // Route: GET /v1/credentials (auth required, rate limited)
    if (method === "GET" && path === "/v1/credentials") {
      const authHeader = req.headers.authorization
      if (!validateApiKey(authHeader, apiKey)) {
        handleUnauthorized(res)
        logRequest(
          method,
          path,
          401,
          Date.now() - startTime,
          req.headers as Record<string, string | undefined>,
        )
        return
      }

      // Check rate limit AFTER auth validation
      const rateLimitResult = rateLimiter.check()
      if (!rateLimitResult.allowed) {
        handleRateLimited(res, rateLimitResult)
        logRequest(
          method,
          path,
          429,
          Date.now() - startTime,
          req.headers as Record<string, string | undefined>,
        )
        return
      }

      await handleCredentials(res, rateLimitResult)
      logRequest(
        method,
        path,
        res.statusCode,
        Date.now() - startTime,
        req.headers as Record<string, string | undefined>,
      )
      return
    }

    // Known routes with wrong method → 405
    if (path === "/v1/health" || path === "/v1/credentials") {
      handleMethodNotAllowed(res)
      logRequest(
        method,
        path,
        405,
        Date.now() - startTime,
        req.headers as Record<string, string | undefined>,
      )
      return
    }

    // Unknown route → 404
    handleNotFound(res)
    logRequest(
      method,
      path,
      404,
      Date.now() - startTime,
      req.headers as Record<string, string | undefined>,
    )
  } catch (error) {
    const errorDetail =
      error instanceof Error ? error.message : "Internal server error"
    if (shouldLog("error")) {
      console.error(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          event: "request_error",
          error: errorDetail,
        }),
      )
    }
    sendJson(res, 500, {
      error: "internal_error",
      message: "Internal server error",
    })
    logRequest(
      method,
      path,
      500,
      Date.now() - startTime,
      req.headers as Record<string, string | undefined>,
    )
  }
}

export function createServer(options: ServerOptions): HttpServer {
  const { apiKey } = options

  if (!apiKey) {
    throw new Error("API key is required")
  }

  const rateLimiter = createRateLimiter(options)

  const server = createHttpServer(
    (req: IncomingMessage, res: ServerResponse) => {
      handleRequest(req, res, apiKey, rateLimiter)
    },
  )

  return server
}

export function startServer(options: ServerOptions): Promise<HttpServer> {
  const { port = 8765, bind = "127.0.0.1" } = options
  const server = createServer(options)

  return new Promise((resolve, reject) => {
    server.listen(port, bind, () => {
      if (shouldLog("info")) {
        console.log(
          JSON.stringify({
            timestamp: new Date().toISOString(),
            event: "server_started",
            bind,
            port,
          }),
        )
      }
      resolve(server)
    })

    server.on("error", (error) => {
      if (shouldLog("error")) {
        console.error(
          JSON.stringify({
            timestamp: new Date().toISOString(),
            event: "server_error",
            error: error.message,
          }),
        )
      }
      reject(error)
    })
  })
}
