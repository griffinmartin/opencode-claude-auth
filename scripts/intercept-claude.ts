/**
 * Intercept Claude CLI requests to capture the exact headers, betas, and body
 * format it sends. Compares against our plugin's model-config defaults and
 * optionally updates src/model-config.ts with any changes found.
 *
 * Usage:
 *   pnpm run intercept                  # default: claude-sonnet-4-6
 *   pnpm run intercept:all              # all supported models
 *   pnpm run intercept:update           # all models + write changes to model-config.ts
 *
 * Security: This starts a local HTTP proxy that forwards real OAuth tokens
 * to api.anthropic.com over HTTPS. The local leg is plaintext on localhost.
 * Only use in trusted dev environments.
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http"
import { request as httpsRequest } from "node:https"
import { spawn } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { config } from "../dist/model-config.js"
import { getModelBetas } from "../dist/betas.js"

const __dirname = dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------
const c = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const PORT = 18899
const TIMEOUT_MS = 30_000
const MODEL_CONFIG_PATH = join(__dirname, "..", "src", "model-config.ts")

const ALL_MODELS = [
  "claude-sonnet-4-6",
  "claude-opus-4-6",
  "claude-sonnet-4-5",
  "claude-opus-4-5",
  "claude-haiku-4-5",
]

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface CapturedRequest {
  model: string
  method: string
  path: string
  headers: Record<string, string>
  bodyKeys: string[]
  betas: string[]
  userAgent: string
  billingHeader: string
  thinking?: unknown
  metadata?: unknown
  outputConfig?: unknown
}

// ---------------------------------------------------------------------------
// Read our defaults from the built dist
// ---------------------------------------------------------------------------
function getOurBetas(modelId: string): string[] {
  return getModelBetas(modelId)
}

// ---------------------------------------------------------------------------
// Per-model intercept
// ---------------------------------------------------------------------------
function interceptModel(model: string): Promise<CapturedRequest | null> {
  return new Promise((resolve) => {
    let resolved = false

    function finish(result: CapturedRequest | null): void {
      if (resolved) return
      resolved = true
      server.close()
      resolve(result)
    }

    const timer = setTimeout(() => {
      console.log(c.red(`  Timeout after ${TIMEOUT_MS / 1000}s for ${model}`))
      finish(null)
    }, TIMEOUT_MS)

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = []
      req.on("data", (chunk: Buffer) => {
        chunks.push(chunk)
      })
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString()
        const headers: Record<string, string> = {}
        for (const [key, val] of Object.entries(req.headers)) {
          if (typeof val === "string") headers[key] = val
          else if (Array.isArray(val)) headers[key] = val.join(", ")
        }

        const betaHeader = headers["anthropic-beta"] ?? ""
        const betas = betaHeader
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)

        let parsed: Record<string, unknown> = {}
        try {
          parsed = JSON.parse(body) as Record<string, unknown>
        } catch {
          // body may not be JSON
        }

        const billingHeader = Array.isArray(parsed.system)
          ? (parsed.system
              .map((entry) => {
                if (typeof entry === "string") return entry
                if (entry && typeof entry === "object" && "text" in entry) {
                  return typeof entry.text === "string" ? entry.text : ""
                }
                return ""
              })
              .find((text) => text.startsWith("x-anthropic-billing-header")) ??
            "")
          : (headers["x-anthropic-billing-header"] ?? "")

        const captured: CapturedRequest = {
          model,
          method: req.method ?? "",
          path: req.url ?? "",
          headers,
          bodyKeys: Object.keys(parsed).sort(),
          betas,
          userAgent: headers["user-agent"] ?? "",
          billingHeader,
          thinking: parsed.thinking,
          metadata: parsed.metadata,
          outputConfig: parsed.output_config,
        }

        // Forward to real API
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
            if (req.method === "POST" && req.url?.startsWith("/v1/messages")) {
              clearTimeout(timer)
              finish(captured)
            }
          })
        })

        proxy.on("error", (err) => {
          console.log(c.red(`  Proxy error: ${err.message}`))
          res.writeHead(502)
          res.end("Proxy error")
          clearTimeout(timer)
          finish(null)
        })

        proxy.write(body)
        proxy.end()
      })
    })

    server.on("error", (err) => {
      console.log(c.red(`  Server error: ${err.message}`))
      clearTimeout(timer)
      finish(null)
    })

    server.listen(PORT, () => {
      const child = spawn("claude", ["-p", "say hi", "--model", model], {
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: "",
          ANTHROPIC_BASE_URL: `http://localhost:${PORT}`,
          TERM: "dumb",
        },
        stdio: "ignore",
      })

      child.on("error", (err) => {
        console.log(c.red(`  claude CLI error: ${err.message}`))
        clearTimeout(timer)
        finish(null)
      })

      child.on("close", () => {
        // Give the proxy response a moment to finish piping
        setTimeout(() => {
          clearTimeout(timer)
          finish(null)
        }, 3000)
      })
    })
  })
}

// ---------------------------------------------------------------------------
// Pretty-print diff for a single model capture
// ---------------------------------------------------------------------------
function printBetasDiff(
  label: string,
  ours: string[],
  theirs: string[],
): { added: string[]; removed: string[] } {
  const ourSet = new Set(ours)
  const theirSet = new Set(theirs)
  const added = theirs.filter((b) => !ourSet.has(b))
  const removed = ours.filter((b) => !theirSet.has(b))
  const unchanged = ours.filter((b) => theirSet.has(b))

  console.log(`\n  ${c.bold(label)}:`)

  if (added.length === 0 && removed.length === 0) {
    for (const b of unchanged) {
      console.log(`    ${c.dim(b)}`)
    }
  } else {
    for (const b of unchanged) {
      console.log(`    ${c.dim(b)}`)
    }
    for (const b of added) {
      console.log(`    ${c.green(`+ ${b}`)}`)
    }
    for (const b of removed) {
      console.log(`    ${c.red(`- ${b}`)}`)
    }
  }

  return { added, removed }
}

function printCapture(capture: CapturedRequest): {
  addedBetas: string[]
  removedBetas: string[]
  cliVersion: string | null
} {
  console.log(`\n${c.bold(`Model: ${capture.model}`)}`)
  console.log(`${"─".repeat(50)}`)

  // Get our effective betas for this model
  const ourBetas = getOurBetas(capture.model)

  // Betas diff
  const { added: addedBetas, removed: removedBetas } = printBetasDiff(
    "Beta flags",
    ourBetas,
    capture.betas,
  )

  // CC version from user-agent
  const versionMatch = capture.userAgent.match(/claude-cli\/([^ ]+)/)
  const cliVersion = versionMatch ? versionMatch[1] : null

  // User-Agent
  console.log(`\n  ${c.bold("User-Agent")}:`)
  console.log(`    ${c.dim(capture.userAgent)}`)

  if (cliVersion && cliVersion !== config.ccVersion) {
    console.log(
      `\n  ${c.bold("CLI Version")}: ${c.yellow(`${config.ccVersion} → ${cliVersion}`)}`,
    )
  } else if (cliVersion) {
    console.log(`\n  ${c.bold("CLI Version")}: ${c.dim(cliVersion)}`)
  }

  // Billing header
  if (capture.billingHeader) {
    console.log(`\n  ${c.bold("Billing")}: ${c.dim(capture.billingHeader)}`)
  }

  // Body structure
  console.log(
    `\n  ${c.bold("Body keys")}: ${c.dim(capture.bodyKeys.join(", "))}`,
  )

  if (capture.thinking) {
    console.log(
      `  ${c.bold("thinking")}: ${c.cyan(JSON.stringify(capture.thinking))}`,
    )
  }
  if (capture.outputConfig) {
    console.log(
      `  ${c.bold("output_config")}: ${c.cyan(JSON.stringify(capture.outputConfig))}`,
    )
  }
  if (capture.metadata) {
    console.log(
      `  ${c.bold("metadata")}: ${c.cyan(JSON.stringify(capture.metadata))}`,
    )
  }

  return { addedBetas, removedBetas, cliVersion }
}

// ---------------------------------------------------------------------------
// --update: rewrite src/model-config.ts
// ---------------------------------------------------------------------------
export function updateModelConfig(
  updates: {
    newBaseBetas?: string[]
    newCcVersion?: string
    modelBetaDiffs?: Map<string, { added: string[]; removed: string[] }>
  },
  configPath: string = MODEL_CONFIG_PATH,
): void {
  let src = readFileSync(configPath, "utf-8")

  // Update baseBetas array
  if (updates.newBaseBetas) {
    const betasStr = updates.newBaseBetas.map((b) => `    "${b}",`).join("\n")
    src = src.replace(
      /baseBetas:\s*\[[\s\S]*?\]/,
      `baseBetas: [\n${betasStr}\n  ]`,
    )
  }

  // Update ccVersion
  if (updates.newCcVersion) {
    src = src.replace(
      /ccVersion:\s*"[^"]+"/,
      `ccVersion: "${updates.newCcVersion}"`,
    )
  }

  // Update modelOverrides if model-specific differences are found
  if (updates.modelBetaDiffs) {
    for (const [modelId, diff] of updates.modelBetaDiffs) {
      // Determine which override key this model maps to
      const lower = modelId.toLowerCase()
      let overrideKey: string | null = null
      for (const key of Object.keys(config.modelOverrides)) {
        if (lower.includes(key)) {
          overrideKey = key
          break
        }
      }

      if (!overrideKey && (diff.added.length > 0 || diff.removed.length > 0)) {
        // Need to add a new override — find a short key from the model name
        // e.g. "claude-opus-4-6" → "opus"
        const keyMatch = modelId.match(/(sonnet|opus|haiku)/i)
        if (keyMatch) {
          overrideKey = keyMatch[1].toLowerCase()
        }
      }

      if (!overrideKey) continue

      // Build the override object
      const existing = config.modelOverrides[overrideKey] ?? {}
      const exclude = [
        ...(existing.exclude ?? []).filter((e) => !diff.added.includes(e)),
        ...diff.removed,
      ]
      const add = [
        ...(existing.add ?? []).filter((a) => !diff.removed.includes(a)),
        ...diff.added.filter(
          // Only add to override if it's not already in baseBetas
          (b) => !(updates.newBaseBetas ?? config.baseBetas).includes(b),
        ),
      ]

      // Only write the override if there's something to override
      if (exclude.length === 0 && add.length === 0) continue

      const parts: string[] = []
      if (exclude.length > 0) {
        parts.push(
          `      exclude: [${exclude.map((e) => `"${e}"`).join(", ")}],`,
        )
      }
      if (add.length > 0) {
        parts.push(`      add: [${add.map((a) => `"${a}"`).join(", ")}],`)
      }

      const overrideBlock = `    ${overrideKey}: {\n${parts.join("\n")}\n    },`

      // Try to replace existing override
      const overrideRegex = new RegExp(
        `    ${overrideKey}:\\s*\\{[\\s\\S]*?\\},`,
      )
      if (overrideRegex.test(src)) {
        src = src.replace(overrideRegex, overrideBlock)
      } else {
        // Insert before the closing } of modelOverrides
        src = src.replace(
          /modelOverrides:\s*\{/,
          `modelOverrides: {\n${overrideBlock}`,
        )
      }
    }
  }

  writeFileSync(configPath, src, "utf-8")
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const doUpdate = args.includes("--update")
  const runAll = args.includes("--all")
  const models = runAll
    ? ALL_MODELS
    : [args.find((a) => !a.startsWith("--")) ?? "claude-sonnet-4-6"]

  console.log(c.bold("Claude CLI Interceptor"))
  console.log(`${"=".repeat(50)}`)

  // Verify claude is available
  try {
    const which = spawn("which", ["claude"], { stdio: "pipe" })
    await new Promise<void>((resolve, reject) => {
      which.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error("not found")),
      )
      which.on("error", reject)
    })
  } catch {
    console.error(c.red("Claude CLI not found. Install it first."))
    process.exit(1)
  }

  console.log(c.dim(`\nCurrent plugin defaults:`))
  console.log(c.dim(`  CC version: ${config.ccVersion}`))
  console.log(c.dim(`  Base betas: ${config.baseBetas.join(", ")}`))
  console.log(c.dim(`  Models to intercept: ${models.join(", ")}`))

  const allAdded = new Set<string>()
  const allRemoved = new Set<string>()
  let latestVersion: string | null = null
  const modelBetaDiffs = new Map<
    string,
    { added: string[]; removed: string[] }
  >()

  for (const model of models) {
    console.log(c.dim(`\nIntercepting ${model}...`))
    const capture = await interceptModel(model)

    if (!capture) {
      console.log(c.red(`  Failed to capture request for ${model}`))
      continue
    }

    const { addedBetas, removedBetas, cliVersion } = printCapture(capture)

    for (const b of addedBetas) allAdded.add(b)
    for (const b of removedBetas) allRemoved.add(b)

    if (addedBetas.length > 0 || removedBetas.length > 0) {
      modelBetaDiffs.set(model, {
        added: addedBetas,
        removed: removedBetas,
      })
    }

    if (cliVersion) latestVersion = cliVersion
  }

  // ─── Summary ────────────────────────────────────────────────────────
  console.log(`\n${"=".repeat(50)}`)
  console.log(c.bold("Summary"))

  const hasVersionChange =
    latestVersion !== null && latestVersion !== config.ccVersion
  const hasBetaChanges = allAdded.size > 0 || allRemoved.size > 0

  if (!hasBetaChanges && !hasVersionChange) {
    console.log(
      c.green("  Plugin defaults match Claude CLI. No changes needed."),
    )
    return
  }

  if (hasBetaChanges) {
    console.log(`\n  ${c.bold("Beta changes across all models:")}`)
    for (const b of allAdded) console.log(`    ${c.green(`+ ${b}`)}`)
    for (const b of allRemoved) console.log(`    ${c.red(`- ${b}`)}`)
  }

  if (hasVersionChange) {
    console.log(
      `\n  ${c.bold("CC version")}: ${c.yellow(`${config.ccVersion} → ${latestVersion}`)}`,
    )
  }

  if (doUpdate) {
    console.log(c.dim("\n  Applying updates to src/model-config.ts..."))

    const newBaseBetas = hasBetaChanges
      ? [...config.baseBetas.filter((b) => !allRemoved.has(b)), ...allAdded]
      : undefined

    updateModelConfig({
      newBaseBetas,
      newCcVersion: hasVersionChange ? (latestVersion ?? undefined) : undefined,
      modelBetaDiffs: modelBetaDiffs.size > 0 ? modelBetaDiffs : undefined,
    })

    console.log(c.green("  Updated src/model-config.ts"))
    if (newBaseBetas) {
      console.log(c.green(`    baseBetas: [${newBaseBetas.join(", ")}]`))
    }
    if (hasVersionChange) {
      console.log(c.green(`    ccVersion: "${latestVersion}"`))
    }
  } else {
    console.log(
      c.yellow(
        "\n  Run with --update to apply these changes to src/model-config.ts",
      ),
    )
  }
}

// Only run main when executed directly, not when imported for testing
const isDirectRun =
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""))

if (isDirectRun) {
  main().catch((err) => {
    console.error(c.red(`Fatal: ${err instanceof Error ? err.message : err}`))
    process.exit(1)
  })
}
