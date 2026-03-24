import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { createServer, startServer } from "./server.ts"
import type { Server as HttpServer } from "node:http"

// Test configuration
const TEST_API_KEY = "test-api-key-12345"
const WRONG_API_KEY = "wrong-api-key-67890"

interface TestServer {
  server: HttpServer
  baseUrl: string
}

async function startTestServer(apiKey: string): Promise<TestServer> {
  const server = await startServer({ port: 0, apiKey }) // port 0 = random available port
  const address = server.address()
  if (!address || typeof address === "string") {
    throw new Error("Server address is not available")
  }
  const baseUrl = `http://localhost:${address.port}`
  return { server, baseUrl }
}

async function fetchJson(
  url: string,
  options?: RequestInit & { headers?: Record<string, string> },
): Promise<{ status: number; headers: Headers; body: Record<string, unknown> }> {
  const headers = new Headers(options?.headers)
  const response = await fetch(url, {
    method: options?.method || "GET",
    headers,
  })
  const contentType = response.headers.get("content-type") || ""
  let body: Record<string, unknown> = {}
  if (contentType.includes("application/json")) {
    body = await response.json()
  }
  return {
    status: response.status,
    headers: response.headers,
    body,
  }
}

describe("server.ts", () => {
  describe("createServer", () => {
    it("throws if apiKey is empty string", () => {
      assert.throws(
        () => createServer({ apiKey: "" }),
        { message: "API key is required" },
      )
    })

    it("throws if apiKey is missing", () => {
      // @ts-expect-error - Testing invalid input
      assert.throws(
        () => createServer({}),
        { message: "API key is required" },
      )
    })

    it("does not throw with valid apiKey", () => {
      const server = createServer({ apiKey: TEST_API_KEY })
      server.close()
    })
  })

  describe("HTTP endpoints", () => {
    let testServer: TestServer

    before(async () => {
      testServer = await startTestServer(TEST_API_KEY)
    })

    after(async () => {
      await new Promise<void>((resolve) => {
        testServer.server.close(() => resolve())
      })
    })

    describe("GET /v1/health", () => {
      it("returns 200 with status ok without auth", async () => {
        const response = await fetchJson(`${testServer.baseUrl}/v1/health`)
        assert.equal(response.status, 200)
        assert.deepStrictEqual(response.body, { status: "ok" })
      })

      it("returns correct security headers", async () => {
        const response = await fetchJson(`${testServer.baseUrl}/v1/health`)
        assert.equal(
          response.headers.get("content-type"),
          "application/json",
        )
        assert.equal(
          response.headers.get("cache-control"),
          "no-store, no-cache, must-revalidate",
        )
        assert.equal(
          response.headers.get("x-content-type-options"),
          "nosniff",
        )
      })

      it("does not require authorization header", async () => {
        const response = await fetchJson(`${testServer.baseUrl}/v1/health`, {
          headers: { Authorization: `Bearer ${TEST_API_KEY}` },
        })
        assert.equal(response.status, 200)
        assert.deepStrictEqual(response.body, { status: "ok" })
      })
    })

    describe("POST /v1/health", () => {
      it("returns 405 method not allowed", async () => {
        const response = await fetchJson(`${testServer.baseUrl}/v1/health`, {
          method: "POST",
        })
        assert.equal(response.status, 405)
        assert.deepStrictEqual(response.body, { error: "method_not_allowed" })
      })
    })

    describe("GET /v1/credentials", () => {
      it("returns 401 without authorization header", async () => {
        const response = await fetchJson(`${testServer.baseUrl}/v1/credentials`)
        assert.equal(response.status, 401)
        assert.deepStrictEqual(response.body, {
          error: "unauthorized",
          message: "Invalid or missing API key",
        })
      })

      it("returns 401 with wrong API key", async () => {
        const response = await fetchJson(
          `${testServer.baseUrl}/v1/credentials`,
          {
            headers: { Authorization: `Bearer ${WRONG_API_KEY}` },
          },
        )
        assert.equal(response.status, 401)
        assert.deepStrictEqual(response.body, {
          error: "unauthorized",
          message: "Invalid or missing API key",
        })
      })

      it("returns 401 with malformed authorization header", async () => {
        const response = await fetchJson(
          `${testServer.baseUrl}/v1/credentials`,
          {
            headers: { Authorization: "Basic abc123" },
          },
        )
        assert.equal(response.status, 401)
      })

      it("returns 401 with empty bearer token", async () => {
        const response = await fetchJson(
          `${testServer.baseUrl}/v1/credentials`,
          {
            headers: { Authorization: "Bearer " },
          },
        )
        assert.equal(response.status, 401)
      })

      it("returns correct security headers when authorized", async () => {
        const response = await fetchJson(
          `${testServer.baseUrl}/v1/credentials`,
          {
            headers: { Authorization: `Bearer ${TEST_API_KEY}` },
          },
        )
        // Even 503 responses should have security headers
        assert.equal(
          response.headers.get("content-type"),
          "application/json",
        )
        assert.equal(
          response.headers.get("cache-control"),
          "no-store, no-cache, must-revalidate",
        )
        assert.equal(
          response.headers.get("x-content-type-options"),
          "nosniff",
        )
      })

      // Note: When Claude Code is not installed, getCachedCredentials returns null
      // and the server returns 503. This is the expected behavior.
      it("returns 503 when no credentials available", async () => {
        const response = await fetchJson(
          `${testServer.baseUrl}/v1/credentials`,
          {
            headers: { Authorization: `Bearer ${TEST_API_KEY}` },
          },
        )
        assert.equal(response.status, 503)
        assert.deepStrictEqual(response.body, {
          error: "credentials_unavailable",
          message: "No Claude Code credentials found or refresh failed",
        })
      })
    })

    describe("POST /v1/credentials", () => {
      it("returns 405 method not allowed", async () => {
        const response = await fetchJson(
          `${testServer.baseUrl}/v1/credentials`,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${TEST_API_KEY}` },
          },
        )
        assert.equal(response.status, 405)
        assert.deepStrictEqual(response.body, { error: "method_not_allowed" })
      })
    })

    describe("GET /v1/unknown", () => {
      it("returns 404 for unknown routes", async () => {
        const response = await fetchJson(
          `${testServer.baseUrl}/v1/unknown`,
        )
        assert.equal(response.status, 404)
        assert.deepStrictEqual(response.body, { error: "not_found" })
      })
    })

    describe("POST /v1/unknown", () => {
      it("returns 404 for POST to unknown route (not 405)", async () => {
        const response = await fetchJson(
          `${testServer.baseUrl}/v1/unknown`,
          { method: "POST" },
        )
        assert.equal(response.status, 404)
        assert.deepStrictEqual(response.body, { error: "not_found" })
      })
    })

    describe("PUT /v1/health", () => {
      it("returns 405 for PUT to health endpoint", async () => {
        const response = await fetchJson(
          `${testServer.baseUrl}/v1/health`,
          { method: "PUT" },
        )
        assert.equal(response.status, 405)
        assert.deepStrictEqual(response.body, { error: "method_not_allowed" })
      })
    })

    describe("DELETE /v1/credentials", () => {
      it("returns 405 for DELETE to credentials endpoint", async () => {
        const response = await fetchJson(
          `${testServer.baseUrl}/v1/credentials`,
          {
            method: "DELETE",
            headers: { Authorization: `Bearer ${TEST_API_KEY}` },
          },
        )
        assert.equal(response.status, 405)
        assert.deepStrictEqual(response.body, { error: "method_not_allowed" })
      })
    })
  })

  describe("Response security headers verification", () => {
    let testServer: TestServer

    before(async () => {
      testServer = await startTestServer(TEST_API_KEY)
    })

    after(async () => {
      await new Promise<void>((resolve) => {
        testServer.server.close(() => resolve())
      })
    })

    it("all responses have Content-Type: application/json", async () => {
      const endpoints = [
        { method: "GET", path: "/v1/health" },
        { method: "POST", path: "/v1/health" },
        { method: "GET", path: "/v1/credentials" },
        { method: "POST", path: "/v1/credentials" },
        { method: "GET", path: "/v1/unknown" },
      ]

      for (const endpoint of endpoints) {
        const response = await fetchJson(
          `${testServer.baseUrl}${endpoint.path}`,
          {
            method: endpoint.method,
            headers: { Authorization: `Bearer ${TEST_API_KEY}` },
          },
        )
        assert.equal(
          response.headers.get("content-type"),
          "application/json",
          `Content-Type for ${endpoint.method} ${endpoint.path}`,
        )
      }
    })

    it("all responses have Cache-Control: no-store", async () => {
      const endpoints = [
        { method: "GET", path: "/v1/health" },
        { method: "POST", path: "/v1/health" },
        { method: "GET", path: "/v1/credentials" },
        { method: "POST", path: "/v1/credentials" },
        { method: "GET", path: "/v1/unknown" },
      ]

      for (const endpoint of endpoints) {
        const response = await fetchJson(
          `${testServer.baseUrl}${endpoint.path}`,
          {
            method: endpoint.method,
            headers: { Authorization: `Bearer ${TEST_API_KEY}` },
          },
        )
        assert.match(
          response.headers.get("cache-control") || "",
          /no-store/,
          `Cache-Control for ${endpoint.method} ${endpoint.path}`,
        )
      }
    })

    it("all responses have X-Content-Type-Options: nosniff", async () => {
      const endpoints = [
        { method: "GET", path: "/v1/health" },
        { method: "POST", path: "/v1/health" },
        { method: "GET", path: "/v1/credentials" },
        { method: "POST", path: "/v1/credentials" },
        { method: "GET", path: "/v1/unknown" },
      ]

      for (const endpoint of endpoints) {
        const response = await fetchJson(
          `${testServer.baseUrl}${endpoint.path}`,
          {
            method: endpoint.method,
            headers: { Authorization: `Bearer ${TEST_API_KEY}` },
          },
        )
        assert.equal(
          response.headers.get("x-content-type-options"),
          "nosniff",
          `X-Content-Type-Options for ${endpoint.method} ${endpoint.path}`,
        )
      }
    })
  })

  describe("API key validation edge cases", () => {
    let testServer: TestServer

    before(async () => {
      testServer = await startTestServer(TEST_API_KEY)
    })

    after(async () => {
      await new Promise<void>((resolve) => {
        testServer.server.close(() => resolve())
      })
    })

    it("rejects API key with different case", async () => {
      // The key is case-sensitive due to timingSafeEqual
      const response = await fetchJson(
        `${testServer.baseUrl}/v1/credentials`,
        {
          headers: { Authorization: `Bearer ${TEST_API_KEY.toUpperCase()}` },
        },
      )
      assert.equal(response.status, 401)
    })

    it("rejects API key with extra characters", async () => {
      const response = await fetchJson(
        `${testServer.baseUrl}/v1/credentials`,
        {
          headers: { Authorization: `Bearer ${TEST_API_KEY}extra` },
        },
      )
      assert.equal(response.status, 401)
    })

    it("rejects API key with missing characters", async () => {
      const response = await fetchJson(
        `${testServer.baseUrl}/v1/credentials`,
        {
          headers: {
            Authorization: `Bearer ${TEST_API_KEY.slice(0, -1)}`,
          },
        },
      )
      assert.equal(response.status, 401)
    })

    it("accepts valid API key with extra whitespace around", async () => {
      // The server uses regex /^Bearer\s+(.+)$/i so whitespace after Bearer is fine
      // but the key itself should match exactly
      const response = await fetchJson(
        `${testServer.baseUrl}/v1/credentials`,
        {
          headers: { Authorization: `Bearer   ${TEST_API_KEY}` },
        },
      )
      // Should not be 401 due to whitespace issue - but will be 503 if no credentials
      assert.notEqual(response.status, 401)
    })
  })
})
