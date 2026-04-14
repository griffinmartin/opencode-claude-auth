/**
 * Extract the cch value from a real Claude CLI request and compare
 * with our xxHash64 implementation to verify seed correctness.
 *
 * Usage: pnpm run build && node --experimental-strip-types scripts/extract-cch.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { request as httpsRequest } from "node:https"
import { spawn } from "node:child_process"
import { writeFileSync } from "node:fs"
import { computeCchHash } from "../dist/xxhash64.js"

const PORT = 18899
const TIMEOUT_MS = 30_000

console.log("Starting intercept proxy on port", PORT)
console.log("Will capture one request from Claude CLI and compare cch...\n")

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  // Handle health checks — respond 200 and wait for the real request
  if (req.method === "HEAD" || !req.url?.includes("/v1/messages")) {
    console.log(`>>> ${req.method} ${req.url} (skipping, not /v1/messages)`)
    res.writeHead(200)
    res.end()
    return
  }

  const chunks: Buffer[] = []
  req.on("data", (chunk: Buffer) => chunks.push(chunk))
  req.on("end", () => {
    console.log(`\n>>> ${req.method} ${req.url}`)
    const bodyStr = Buffer.concat(chunks).toString()

    // Extract the cch from the billing header in the body
    const cchMatch = bodyStr.match(/cch=([0-9a-f]{5})/)
    const realCch = cchMatch ? cchMatch[1] : null

    console.log("=== CAPTURED REQUEST ===")
    console.log("Body length:", bodyStr.length)
    console.log("Real cch from Claude CLI:", realCch)

    // Now compute what our implementation produces
    // Replace the real cch with 00000 placeholder to simulate what Bun hashes
    const bodyWithPlaceholder = bodyStr.replace(
      /cch=[0-9a-f]{5}/,
      "cch=00000",
    )
    const encoder = new TextEncoder()
    const fullBodyHash = computeCchHash(encoder.encode(bodyWithPlaceholder))
    console.log("Our xxHash64 (full body):", fullBodyHash)
    console.log("Match (full body):", fullBodyHash === realCch ? "YES ✓" : "NO ✗")

    // Also try hashing with system stripped to billing-only
    try {
      const parsed = JSON.parse(bodyWithPlaceholder) as {
        system?: Array<{ type?: string; text?: string }>
      }
      if (Array.isArray(parsed.system)) {
        const billingOnly = parsed.system.filter(
          (e) =>
            typeof e.text === "string" &&
            e.text.startsWith("x-anthropic-billing-header"),
        )
        const strippedBody = { ...parsed, system: billingOnly }
        const strippedHash = computeCchHash(
          encoder.encode(JSON.stringify(strippedBody)),
        )
        console.log("Our xxHash64 (billing-only system):", strippedHash)
        console.log(
          "Match (billing-only):",
          strippedHash === realCch ? "YES ✓" : "NO ✗",
        )

        // Also try with no system at all
        const noSystem = { ...parsed }
        delete (noSystem as Record<string, unknown>).system
        const noSystemHash = computeCchHash(
          encoder.encode(JSON.stringify(noSystem)),
        )
        console.log("Our xxHash64 (no system):", noSystemHash)
        console.log(
          "Match (no system):",
          noSystemHash === realCch ? "YES ✓" : "NO ✗",
        )
      }
    } catch {
      console.log("Failed to parse body for stripped test")
    }

    // Save body with placeholder for seed brute-forcing
    writeFileSync("/tmp/claude-body-placeholder.json", bodyWithPlaceholder, "utf-8")
    writeFileSync("/tmp/claude-cch-real.txt", realCch ?? "", "utf-8")
    console.log("\nSaved body to /tmp/claude-body-placeholder.json")
    console.log("Saved real cch to /tmp/claude-cch-real.txt")

    // Extract version info
    const versionMatch = bodyStr.match(
      /cc_version=([^;]+)/,
    )
    const entrypointMatch = bodyStr.match(
      /cc_entrypoint=([^;]+)/,
    )
    console.log("\nBilling header details:")
    console.log("  cc_version:", versionMatch?.[1])
    console.log("  cc_entrypoint:", entrypointMatch?.[1])

    // Extract system block count
    try {
      const p = JSON.parse(bodyStr) as {
        system?: unknown[]
      }
      console.log("  system block count:", p.system?.length)
      if (Array.isArray(p.system)) {
        for (let i = 0; i < p.system.length; i++) {
          const entry = p.system[i] as { text?: string; cache_control?: unknown }
          const text = typeof entry.text === "string" ? entry.text.slice(0, 80) : "?"
          const cc = entry.cache_control ? JSON.stringify(entry.cache_control) : "none"
          console.log(`  system[${i}]: cache_control=${cc} text="${text}..."`)
        }
      }
    } catch {}

    // Forward to real API so claude doesn't error
    const proxyOpts = {
      hostname: "api.anthropic.com",
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: "api.anthropic.com" },
    }
    const proxy = httpsRequest(proxyOpts, (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers)
      proxyRes.pipe(res)
      proxyRes.on("end", () => {
        server.close()
        process.exit(0)
      })
    })
    proxy.on("error", () => {
      res.writeHead(502)
      res.end()
      server.close()
      process.exit(1)
    })
    proxy.write(bodyStr)
    proxy.end()
  })
})

const timer = setTimeout(() => {
  console.log("Timeout - no request captured")
  server.close()
  process.exit(1)
}, TIMEOUT_MS)

server.listen(PORT, () => {
  const child = spawn("claude", ["-p", "say hi", "--model", "claude-haiku-4-5"], {
    env: {
      ...process.env,
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_BASE_URL: `http://localhost:${PORT}`,
      TERM: "dumb",
    },
    stdio: "ignore",
  })

  child.on("error", (err) => {
    console.log("Claude CLI error:", err.message)
    clearTimeout(timer)
    server.close()
    process.exit(1)
  })

  child.on("close", () => {
    setTimeout(() => {
      clearTimeout(timer)
      server.close()
    }, 3000)
  })
})
