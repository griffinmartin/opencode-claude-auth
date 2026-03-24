/**
 * Tests for remote-credentials module
 * Uses Bun's test runner with mock HTTP server
 */

import { createServer } from "node:http"
import { fetchRemoteCredentials, clearRemoteCache } from "./remote-credentials.js"

// Helper to create a mock server that returns specific responses
function createMockServer(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void): Promise<{ server: import("node:http").Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port
      resolve({ server, port })
    })
  })
}

// Helper to create JSON response
function jsonResponse(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(body))
}

describe("fetchRemoteCredentials", () => {
  beforeEach(() => {
    clearRemoteCache()
  })

  afterEach(() => {
    clearRemoteCache()
  })

  test("returns {accessToken, expiresAt} on successful fetch from server", async () => {
    const { server, port } = await createMockServer((req, res) => {
      jsonResponse(res, 200, {
        accessToken: "test-token-abc123",
        expiresAt: Date.now() + 3600_000,
      })
    })

    try {
      const result = await fetchRemoteCredentials(`http://127.0.0.1:${port}`, "test-api-key")

      expect(result).toEqual({
        accessToken: "test-token-abc123",
        expiresAt: expect.any(Number),
      })
      expect(typeof result?.accessToken).toBe("string")
      expect(typeof result?.expiresAt).toBe("number")
    } finally {
      server.close()
    }
  })

  test("caches credentials — second call within 30s returns cached result without HTTP request", async () => {
    let requestCount = 0
    const { server, port } = await createMockServer((req, res) => {
      requestCount++
      jsonResponse(res, 200, {
        accessToken: "cached-token",
        expiresAt: Date.now() + 3600_000,
      })
    })

    try {
      const result1 = await fetchRemoteCredentials(`http://127.0.0.1:${port}`, "test-api-key")
      const result2 = await fetchRemoteCredentials(`http://127.0.0.1:${port}`, "test-api-key")

      expect(result1?.accessToken).toBe("cached-token")
      expect(result2?.accessToken).toBe("cached-token")
      expect(requestCount).toBe(1) // Second call should use cache
    } finally {
      server.close()
    }
  })

  test("cache expires after 30s — makes new HTTP request", async () => {
    let requestCount = 0
    const { server, port } = await createMockServer((req, res) => {
      requestCount++
      jsonResponse(res, 200, {
        accessToken: `token-${requestCount}`,
        expiresAt: Date.now() + 3600_000,
      })
    })

    try {
      const result1 = await fetchRemoteCredentials(`http://127.0.0.1:${port}`, "test-api-key")
      expect(result1?.accessToken).toBe("token-1")

      // Clear cache to force new request
      clearRemoteCache()

      const result2 = await fetchRemoteCredentials(`http://127.0.0.1:${port}`, "test-api-key")
      expect(result2?.accessToken).toBe("token-2")
      expect(requestCount).toBe(2)
    } finally {
      server.close()
    }
  })

  test("cache invalidated when token is within 60s of expiry", async () => {
    let requestCount = 0
    const { server, port } = await createMockServer((req, res) => {
      requestCount++
      // Token expires in 30 seconds (within the 60s buffer)
      jsonResponse(res, 200, {
        accessToken: `token-${requestCount}`,
        expiresAt: Date.now() + 30_000, // 30 seconds from now - within 60s buffer
      })
    })

    try {
      const result1 = await fetchRemoteCredentials(`http://127.0.0.1:${port}`, "test-api-key")
      expect(result1?.accessToken).toBe("token-1")

      // Should make new request because token is near expiry
      const result2 = await fetchRemoteCredentials(`http://127.0.0.1:${port}`, "test-api-key")
      expect(result2?.accessToken).toBe("token-2")
      expect(requestCount).toBe(2) // New request made due to near-expiry
    } finally {
      server.close()
    }
  })

  test("returns null on 401 response (bad API key)", async () => {
    const { server, port } = await createMockServer((req, res) => {
      jsonResponse(res, 401, { error: "Unauthorized" })
    })

    try {
      const result = await fetchRemoteCredentials(`http://127.0.0.1:${port}`, "bad-api-key")

      expect(result).toBe(null)
    } finally {
      server.close()
    }
  })

  test("returns null on 429 response (rate limited)", async () => {
    const { server, port } = await createMockServer((req, res) => {
      res.writeHead(429, { "Retry-After": "30" })
      res.end()
    })

    try {
      const result = await fetchRemoteCredentials(`http://127.0.0.1:${port}`, "test-api-key")

      expect(result).toBe(null)
    } finally {
      server.close()
    }
  })

  test("returns null on 503 response (no credentials)", async () => {
    const { server, port } = await createMockServer((req, res) => {
      jsonResponse(res, 503, { error: "Service Unavailable" })
    })

    try {
      const result = await fetchRemoteCredentials(`http://127.0.0.1:${port}`, "test-api-key")

      expect(result).toBe(null)
    } finally {
      server.close()
    }
  })

  test("returns null on network error (server unreachable)", async () => {
    // Use a port that's unlikely to have a server
    const result = await fetchRemoteCredentials("http://127.0.0.1:59999", "test-api-key")

    expect(result).toBe(null)
  })

  test("returns null on invalid JSON response", async () => {
    const { server, port } = await createMockServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end("not valid json {{{")
    })

    try {
      const result = await fetchRemoteCredentials(`http://127.0.0.1:${port}`, "test-api-key")

      expect(result).toBe(null)
    } finally {
      server.close()
    }
  })

  test("returns null on response missing required fields", async () => {
    const { server, port } = await createMockServer((req, res) => {
      jsonResponse(res, 200, {
        // missing accessToken
        expiresAt: Date.now() + 3600_000,
      })
    })

    try {
      const result = await fetchRemoteCredentials(`http://127.0.0.1:${port}`, "test-api-key")

      expect(result).toBe(null)
    } finally {
      server.close()
    }
  })

  test("returns null on response with wrong field types", async () => {
    const { server, port } = await createMockServer((req, res) => {
      jsonResponse(res, 200, {
        accessToken: 12345, // should be string
        expiresAt: "not a number", // should be number
      })
    })

    try {
      const result = await fetchRemoteCredentials(`http://127.0.0.1:${port}`, "test-api-key")

      expect(result).toBe(null)
    } finally {
      server.close()
    }
  })

  test("clearRemoteCache() clears the cache", async () => {
    let requestCount = 0
    const { server, port } = await createMockServer((req, res) => {
      requestCount++
      jsonResponse(res, 200, {
        accessToken: `token-${requestCount}`,
        expiresAt: Date.now() + 3600_000,
      })
    })

    try {
      const result1 = await fetchRemoteCredentials(`http://127.0.0.1:${port}`, "test-api-key")
      expect(result1?.accessToken).toBe("token-1")
      expect(requestCount).toBe(1)

      clearRemoteCache()

      const result2 = await fetchRemoteCredentials(`http://127.0.0.1:${port}`, "test-api-key")
      expect(result2?.accessToken).toBe("token-2")
      expect(requestCount).toBe(2) // New request after cache clear
    } finally {
      server.close()
    }
  })

  test("handles server URL with trailing slash correctly", async () => {
    const { server, port } = await createMockServer((req, res) => {
      // Verify the URL path is correct (should not have double slash)
      expect(req.url).toBe("/v1/credentials")
      jsonResponse(res, 200, {
        accessToken: "token-no-double-slash",
        expiresAt: Date.now() + 3600_000,
      })
    })

    try {
      const result = await fetchRemoteCredentials(`http://127.0.0.1:${port}/`, "test-api-key")

      expect(result?.accessToken).toBe("token-no-double-slash")
    } finally {
      server.close()
    }
  })

  test("sends Authorization: Bearer header correctly", async () => {
    let receivedAuthHeader: string | undefined
    const { server, port } = await createMockServer((req, res) => {
      receivedAuthHeader = req.headers.authorization
      jsonResponse(res, 200, {
        accessToken: "token-with-auth",
        expiresAt: Date.now() + 3600_000,
      })
    })

    try {
      const result = await fetchRemoteCredentials(`http://127.0.0.1:${port}`, "my-secret-api-key")

      expect(receivedAuthHeader).toBe("Bearer my-secret-api-key")
      expect(result?.accessToken).toBe("token-with-auth")
    } finally {
      server.close()
    }
  })

  test("returns null on empty response body", async () => {
    const { server, port } = await createMockServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end("")
    })

    try {
      const result = await fetchRemoteCredentials(`http://127.0.0.1:${port}`, "test-api-key")

      expect(result).toBe(null)
    } finally {
      server.close()
    }
  })

  test("returns null when server returns null values in response", async () => {
    const { server, port } = await createMockServer((req, res) => {
      jsonResponse(res, 200, {
        accessToken: null,
        expiresAt: null,
      })
    })

    try {
      const result = await fetchRemoteCredentials(`http://127.0.0.1:${port}`, "test-api-key")

      expect(result).toBe(null)
    } finally {
      server.close()
    }
  })

  test("returns null on response with only accessToken (missing expiresAt)", async () => {
    const { server, port } = await createMockServer((req, res) => {
      jsonResponse(res, 200, {
        accessToken: "some-token",
      })
    })

    try {
      const result = await fetchRemoteCredentials(`http://127.0.0.1:${port}`, "test-api-key")

      expect(result).toBe(null)
    } finally {
      server.close()
    }
  })

  test("handles very large access token", async () => {
    const largeToken = "x".repeat(100_000)
    const { server, port } = await createMockServer((req, res) => {
      jsonResponse(res, 200, {
        accessToken: largeToken,
        expiresAt: Date.now() + 3600_000,
      })
    })

    try {
      const result = await fetchRemoteCredentials(`http://127.0.0.1:${port}`, "test-api-key")

      expect(result?.accessToken).toBe(largeToken)
      expect(result?.accessToken.length).toBe(100_000)
    } finally {
      server.close()
    }
  })

  test("handles concurrent requests — returns consistent results", async () => {
    const { server, port } = await createMockServer((req, res) => {
      // Add small delay to simulate network latency
      setTimeout(() => {
        jsonResponse(res, 200, {
          accessToken: "concurrent-token",
          expiresAt: Date.now() + 3600_000,
        })
      }, 50)
    })

    try {
      // Fire multiple concurrent requests
      const results = await Promise.all([
        fetchRemoteCredentials(`http://127.0.0.1:${port}`, "test-api-key"),
        fetchRemoteCredentials(`http://127.0.0.1:${port}`, "test-api-key"),
        fetchRemoteCredentials(`http://127.0.0.1:${port}`, "test-api-key"),
      ])

      // All should get the same token
      for (const result of results) {
        expect(result?.accessToken).toBe("concurrent-token")
      }
    } finally {
      server.close()
    }
  })

  test("returns null on HTTP 500 error", async () => {
    const { server, port } = await createMockServer((req, res) => {
      jsonResponse(res, 500, { error: "Internal Server Error" })
    })

    try {
      const result = await fetchRemoteCredentials(`http://127.0.0.1:${port}`, "test-api-key")

      expect(result).toBe(null)
    } finally {
      server.close()
    }
  })

  test("returns null on HTTP 502 error", async () => {
    const { server, port } = await createMockServer((req, res) => {
      jsonResponse(res, 502, { error: "Bad Gateway" })
    })

    try {
      const result = await fetchRemoteCredentials(`http://127.0.0.1:${port}`, "test-api-key")

      expect(result).toBe(null)
    } finally {
      server.close()
    }
  })
})
