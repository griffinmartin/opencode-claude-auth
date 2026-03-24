import { createServer } from "./server.ts"
import type { AddressInfo } from "node:net"

const TEST_API_KEY = "test-api-key-12345"

let portCounter = 49100

function getNextPort(): number {
  return portCounter++
}

async function withServer(
  rateLimitRpm: number,
  testFn: (baseUrl: string, server: ReturnType<typeof createServer>) => Promise<void>,
): Promise<void> {
  const port = getNextPort()
  const server = createServer({
    apiKey: TEST_API_KEY,
    port,
    rateLimitRpm,
  })

  await new Promise<void>((resolve, reject) => {
    server.on("listening", resolve)
    server.on("error", reject)
    server.listen(port, "127.0.0.1")
  })

  // Wait a small amount to ensure the server is fully ready
  await new Promise((resolve) => setTimeout(resolve, 10))

  const address = server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}`

  try {
    await testFn(baseUrl, server)
  } finally {
    server.close()
    await new Promise<void>((resolve) => server.on("close", resolve))
    // Wait for port to be fully released
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

async function makeRequest(
  baseUrl: string,
  path: string,
  options?: { apiKey?: string },
): Promise<{
  status: number
  headers: Headers
  body: Record<string, unknown>
}> {
  const headers: HeadersInit = {}
  if (options?.apiKey) {
    headers["Authorization"] = `Bearer ${options.apiKey}`
  }

  const response = await fetch(`${baseUrl}${path}`, { headers })
  const body = (await response.json()) as Record<string, unknown>

  return {
    status: response.status,
    headers: response.headers,
    body,
  }
}

// Test 1: First N requests succeed, 61st returns 429
async function testRateLimitEnforcement(): Promise<void> {
  const RATE_LIMIT = 5

  await withServer(RATE_LIMIT, async (baseUrl) => {
    // Make exactly RATE_LIMIT successful requests
    for (let i = 0; i < RATE_LIMIT; i++) {
      const result = await makeRequest(baseUrl, "/v1/credentials", {
        apiKey: TEST_API_KEY,
      })
      // Should be 200 or 503 (credentials unavailable is still a successful response from rate limit perspective)
      if (result.status !== 200 && result.status !== 503) {
        throw new Error(
          `Request ${i + 1} returned ${result.status}, expected 200 or 503`,
        )
      }
    }

    // 61st request should be rate limited (but we only need to test RATE_LIMIT + 1 = 6th)
    const result = await makeRequest(baseUrl, "/v1/credentials", {
      apiKey: TEST_API_KEY,
    })

    if (result.status !== 429) {
      throw new Error(
        `6th request returned ${result.status}, expected 429 (rate limited)`,
      )
    }

    if (result.body.error !== "rate_limited") {
      throw new Error(
        `Expected error "rate_limited", got "${result.body.error}"`,
      )
    }

    if (result.body.message !== "Too many requests") {
      throw new Error(
        `Expected message "Too many requests", got "${result.body.message}"`,
      )
    }
  })
}

// Test 2: 429 response includes Retry-After header
async function testRetryAfterHeader(): Promise<void> {
  const RATE_LIMIT = 3

  await withServer(RATE_LIMIT, async (baseUrl) => {
    // Exhaust rate limit
    for (let i = 0; i < RATE_LIMIT; i++) {
      await makeRequest(baseUrl, "/v1/credentials", {
        apiKey: TEST_API_KEY,
      })
    }

    // 4th request should be rate limited with Retry-After
    const result = await makeRequest(baseUrl, "/v1/credentials", {
      apiKey: TEST_API_KEY,
    })

    if (result.status !== 429) {
      throw new Error(`Expected 429, got ${result.status}`)
    }

    const retryAfter = result.headers.get("Retry-After")
    if (!retryAfter) {
      throw new Error("Missing Retry-After header")
    }

    const retryAfterValue = parseInt(retryAfter, 10)
    if (isNaN(retryAfterValue) || retryAfterValue <= 0) {
      throw new Error(
        `Retry-After should be numeric > 0, got "${retryAfter}"`,
      )
    }
  })
}

// Test 3: All /v1/credentials responses include rate limit headers
async function testRateLimitHeadersPresent(): Promise<void> {
  const RATE_LIMIT = 5

  await withServer(RATE_LIMIT, async (baseUrl) => {
    // Make one request
    const result = await makeRequest(baseUrl, "/v1/credentials", {
      apiKey: TEST_API_KEY,
    })

    // Should include all rate limit headers regardless of status
    const limitHeader = result.headers.get("X-RateLimit-Limit")
    const remainingHeader = result.headers.get("X-RateLimit-Remaining")
    const resetHeader = result.headers.get("X-RateLimit-Reset")

    if (!limitHeader) {
      throw new Error("Missing X-RateLimit-Limit header")
    }
    if (!remainingHeader) {
      throw new Error("Missing X-RateLimit-Remaining header")
    }
    if (!resetHeader) {
      throw new Error("Missing X-RateLimit-Reset header")
    }

    if (parseInt(limitHeader, 10) !== RATE_LIMIT) {
      throw new Error(
        `X-RateLimit-Limit should be ${RATE_LIMIT}, got "${limitHeader}"`,
      )
    }
  })
}

// Test 4: X-RateLimit-Remaining decreases with each request
async function testRateLimitRemainingDecreases(): Promise<void> {
  const RATE_LIMIT = 5

  await withServer(RATE_LIMIT, async (baseUrl) => {
    const remainingValues: number[] = []

    for (let i = 0; i < RATE_LIMIT; i++) {
      const result = await makeRequest(baseUrl, "/v1/credentials", {
        apiKey: TEST_API_KEY,
      })

      const remainingHeader = result.headers.get("X-RateLimit-Remaining")
      if (!remainingHeader) {
        throw new Error("Missing X-RateLimit-Remaining header")
      }

      remainingValues.push(parseInt(remainingHeader, 10))
    }

    // Verify remaining decreases: 4, 3, 2, 1, 0
    for (let i = 0; i < remainingValues.length - 1; i++) {
      if (remainingValues[i] - remainingValues[i + 1] !== 1) {
        throw new Error(
          `Remaining should decrease by 1 each request. Got: ${remainingValues.join(", ")}`,
        )
      }
    }
  })
}

// Test 5: X-RateLimit-Limit matches configured limit
async function testRateLimitHeaderMatchesConfig(): Promise<void> {
  const RATE_LIMIT = 7

  await withServer(RATE_LIMIT, async (baseUrl) => {
    const result = await makeRequest(baseUrl, "/v1/credentials", {
      apiKey: TEST_API_KEY,
    })

    const limitHeader = result.headers.get("X-RateLimit-Limit")
    if (!limitHeader) {
      throw new Error("Missing X-RateLimit-Limit header")
    }

    if (parseInt(limitHeader, 10) !== RATE_LIMIT) {
      throw new Error(
        `X-RateLimit-Limit should be ${RATE_LIMIT}, got "${limitHeader}"`,
      )
    }
  })
}

// Test 6: /v1/health is NOT rate limited
async function testHealthNotRateLimited(): Promise<void> {
  const RATE_LIMIT = 2 // Very low limit

  await withServer(RATE_LIMIT, async (baseUrl) => {
    // Make many requests to /v1/health - all should succeed
    const NUM_REQUESTS = 10

    for (let i = 0; i < NUM_REQUESTS; i++) {
      const result = await makeRequest(baseUrl, "/v1/health")

      if (result.status !== 200) {
        throw new Error(
          `/v1/health request ${i + 1} returned ${result.status}, expected 200`,
        )
      }
    }
  })
}

// Test 7: Unauthenticated requests do NOT count against rate limit
async function testUnauthenticatedNotCounted(): Promise<void> {
  const RATE_LIMIT = 3

  await withServer(RATE_LIMIT, async (baseUrl) => {
    // Make unauthenticated requests (should get 401)
    for (let i = 0; i < RATE_LIMIT + 2; i++) {
      const result = await makeRequest(baseUrl, "/v1/credentials")
      if (result.status !== 401) {
        throw new Error(
          `Unauthenticated request ${i + 1} returned ${result.status}, expected 401`,
        )
      }
    }

    // Now make an authenticated request - should still have full quota
    const result = await makeRequest(baseUrl, "/v1/credentials", {
      apiKey: TEST_API_KEY,
    })

    // Should NOT be rate limited because unauth requests don't count
    if (result.status === 429) {
      throw new Error(
        "Authenticated request was rate limited after unauthenticated requests - unauth should not count against limit",
      )
    }

    const remainingHeader = result.headers.get("X-RateLimit-Remaining")
    if (!remainingHeader) {
      throw new Error("Missing X-RateLimit-Remaining header")
    }

    // Remaining should be RATE_LIMIT - 1 (one authenticated request made)
    const remaining = parseInt(remainingHeader, 10)
    if (remaining !== RATE_LIMIT - 1) {
      throw new Error(
        `After one authenticated request, remaining should be ${RATE_LIMIT - 1}, got ${remaining}`,
      )
    }
  })
}

// Test 8: Verify rate limit via env var works
async function testEnvVarConfig(): Promise<void> {
  // This test verifies that the env var is read by the server
  // We can't easily test the env var directly without mocking,
  // but we can verify that rateLimitRpm option works
  const RATE_LIMIT = 10

  await withServer(RATE_LIMIT, async (baseUrl) => {
    // Make 10 requests
    for (let i = 0; i < RATE_LIMIT; i++) {
      const result = await makeRequest(baseUrl, "/v1/credentials", {
        apiKey: TEST_API_KEY,
      })
      if (result.status === 429) {
        throw new Error(
          `Request ${i + 1} was rate limited, but limit should be ${RATE_LIMIT}`,
        )
      }
    }

    // 11th request should be rate limited
    const result = await makeRequest(baseUrl, "/v1/credentials", {
      apiKey: TEST_API_KEY,
    })

    if (result.status !== 429) {
      throw new Error(
        `11th request returned ${result.status}, expected 429`,
      )
    }
  })
}

// Test 9: 61st request returns 429 with correct structure (comprehensive)
async function test61stRequestReturns429(): Promise<void> {
  const RATE_LIMIT = 60

  await withServer(RATE_LIMIT, async (baseUrl) => {
    // Make 60 requests
    for (let i = 0; i < RATE_LIMIT; i++) {
      const result = await makeRequest(baseUrl, "/v1/credentials", {
        apiKey: TEST_API_KEY,
      })
      // Should not be rate limited
      if (result.status === 429) {
        throw new Error(
          `Request ${i + 1} was incorrectly rate limited at limit ${RATE_LIMIT}`,
        )
      }
    }

    // 61st request should be rate limited
    const result = await makeRequest(baseUrl, "/v1/credentials", {
      apiKey: TEST_API_KEY,
    })

    if (result.status !== 429) {
      throw new Error(
        `61st request returned ${result.status}, expected 429`,
      )
    }

    if (result.body.error !== "rate_limited") {
      throw new Error(`Expected error "rate_limited", got "${result.body.error}"`)
    }

    if (result.body.message !== "Too many requests") {
      throw new Error(
        `Expected message "Too many requests", got "${result.body.message}"`,
      )
    }
  })
}

// Test 10: Verify Retry-After header is numeric and > 0
async function testRetryAfterIsNumeric(): Promise<void> {
  const RATE_LIMIT = 2

  await withServer(RATE_LIMIT, async (baseUrl) => {
    // Exhaust rate limit
    for (let i = 0; i < RATE_LIMIT; i++) {
      await makeRequest(baseUrl, "/v1/credentials", {
        apiKey: TEST_API_KEY,
      })
    }

    // Get 429 response
    const result = await makeRequest(baseUrl, "/v1/credentials", {
      apiKey: TEST_API_KEY,
    })

    if (result.status !== 429) {
      throw new Error(`Expected 429, got ${result.status}`)
    }

    const retryAfter = result.headers.get("Retry-After")
    if (!retryAfter) {
      throw new Error("Missing Retry-After header")
    }

    const retryAfterNum = parseInt(retryAfter, 10)
    if (isNaN(retryAfterNum) || retryAfterNum <= 0) {
      throw new Error(
        `Retry-After should be a positive integer > 0, got "${retryAfter}"`,
      )
    }
  })
}

// Run all tests
console.log("Starting rate limiter tests...")

const tests = [
  { name: "Rate limit enforcement (first N succeed, N+1 returns 429)", fn: testRateLimitEnforcement },
  { name: "429 response includes Retry-After header", fn: testRetryAfterHeader },
  { name: "All /v1/credentials responses include rate limit headers", fn: testRateLimitHeadersPresent },
  { name: "X-RateLimit-Remaining decreases with each request", fn: testRateLimitRemainingDecreases },
  { name: "X-RateLimit-Limit matches configured limit", fn: testRateLimitHeaderMatchesConfig },
  { name: "/v1/health is NOT rate limited", fn: testHealthNotRateLimited },
  { name: "Unauthenticated requests do NOT count against rate limit", fn: testUnauthenticatedNotCounted },
  { name: "Rate limit is configurable via rateLimitRpm option", fn: testEnvVarConfig },
  { name: "61st request returns 429 with correct structure", fn: test61stRequestReturns429 },
  { name: "Retry-After header is numeric and > 0", fn: testRetryAfterIsNumeric },
]

let passed = 0
let failed = 0
const failures: string[] = []

for (const test of tests) {
  try {
    await test.fn()
    console.log(`✓ ${test.name}`)
    passed++
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.log(`✗ ${test.name}: ${message}`)
    failed++
    failures.push(`${test.name}: ${message}`)
  }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`)

if (failed > 0) {
  console.log("\nFailures:")
  for (const f of failures) {
    console.log(`  - ${f}`)
  }
  process.exit(1)
}

process.exit(0)
