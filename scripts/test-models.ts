import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { getCachedCredentials } from "../dist/credentials.js"
import { buildRequestHeaders, fetchWithRetry } from "../dist/index.js"
import { getModelBetas, isLongContextError, LONG_CONTEXT_BETAS } from "../dist/betas.js"

// ANSI color helpers
const c = {
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
}

const API_URL = "https://api.anthropic.com/v1/messages"
const SYSTEM_IDENTITY_PREFIX = "You are Claude Code, Anthropic's official CLI for Claude."

interface ModelResult {
  model: string
  status: "pass" | "fail"
  betas: string[]
  excluded: string[]
  error?: string
  timeMs: number
}

async function discoverModels(): Promise<string[]> {
  const { createOpencode } = await import("@opencode-ai/sdk")

  console.log(c.dim("Starting OpenCode server to discover models..."))

  const { client, server } = await createOpencode({ port: 0, timeout: 15000 })

  try {
    const res = await client.provider.list()
    if (!res.data) {
      throw new Error("No data returned from provider.list()")
    }

    const anthropic = res.data.all.find((p: { id: string }) => p.id === "anthropic")
    if (!anthropic) {
      throw new Error("Anthropic provider not found")
    }

    const models = Object.keys(anthropic.models)
    console.log(c.dim(`Found ${models.length} Anthropic models\n`))
    return models
  } finally {
    server.close()
  }
}

async function testModel(modelId: string, accessToken: string): Promise<ModelResult> {
  const startTime = Date.now()
  const initialBetas = getModelBetas(modelId)
  const excluded: string[] = []

  const body = JSON.stringify({
    model: modelId,
    max_tokens: 128,
    system: [{ type: "text", text: SYSTEM_IDENTITY_PREFIX }],
    messages: [{ role: "user", content: "hi" }],
  })

  const init: RequestInit = { method: "POST", body }
  const headers = buildRequestHeaders(
    new URL(API_URL),
    init,
    accessToken,
    modelId,
  )
  headers.set("content-type", "application/json")
  headers.set("anthropic-version", "2023-06-01")

  let response = await fetchWithRetry(API_URL, {
    ...init,
    headers,
  })

  // Beta fallback loop (same logic as the plugin)
  const localExcluded = new Set<string>()
  for (let attempt = 0; attempt < LONG_CONTEXT_BETAS.length; attempt++) {
    if (response.status !== 400 && response.status !== 429) {
      break
    }

    const cloned = response.clone()
    const responseBody = await cloned.text()

    if (!isLongContextError(responseBody)) {
      break
    }

    // Find next beta to exclude
    let betaToExclude: string | null = null
    for (const beta of LONG_CONTEXT_BETAS) {
      if (!localExcluded.has(beta)) {
        betaToExclude = beta
        break
      }
    }
    if (!betaToExclude) break

    localExcluded.add(betaToExclude)
    excluded.push(betaToExclude)

    // Retry with excluded betas
    const newHeaders = buildRequestHeaders(
      new URL(API_URL),
      init,
      accessToken,
      modelId,
      localExcluded,
    )
    newHeaders.set("content-type", "application/json")
    newHeaders.set("anthropic-version", "2023-06-01")

    response = await fetchWithRetry(API_URL, {
      ...init,
      headers: newHeaders,
    })
  }

  const timeMs = Date.now() - startTime
  const usedBetas = getModelBetas(modelId, localExcluded)

  if (response.ok) {
    return { model: modelId, status: "pass", betas: usedBetas, excluded, timeMs }
  }

  // Read error message
  let error = `HTTP ${response.status}`
  try {
    const errorBody = await response.text()
    const parsed = JSON.parse(errorBody) as { error?: { message?: string } }
    if (parsed.error?.message) {
      error = parsed.error.message
    }
  } catch {
    // Use HTTP status as error
  }

  return { model: modelId, status: "fail", betas: usedBetas, excluded, error, timeMs }
}

function printResult(result: ModelResult): void {
  const icon = result.status === "pass" ? c.green("✓") : c.red("✗")
  const name = result.model.padEnd(35)
  const time = c.dim(`${(result.timeMs / 1000).toFixed(1)}s`)
  const betas = c.dim(result.betas.join(", "))

  let line = `  ${icon}  ${name} ${time}  ${betas}`

  if (result.excluded.length > 0) {
    line += `  ${c.yellow("excluded:")} ${c.cyan(result.excluded.join(", "))}`
  }

  if (result.error) {
    line += `\n       ${c.red(result.error)}`
  }

  console.log(line)
}

function writeResultsFile(results: ModelResult[], version: string): void {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const outPath = join(__dirname, "..", "test-results", "model-smoke-test.md")

  const dir = dirname(outPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  const passed = results.filter(r => r.status === "pass").length
  const total = results.length
  const date = new Date().toISOString()

  const rows = results.map(r => {
    const status = r.status === "pass" ? "pass" : "**FAIL**"
    const time = `${(r.timeMs / 1000).toFixed(1)}s`
    const betas = r.betas.join(", ")
    const excluded = r.excluded.join(", ") || ""
    const error = r.error ?? ""
    return `| ${r.model} | ${status} | ${time} | ${betas} | ${excluded} | ${error} |`
  })

  const md = `# Model Smoke Test Results

**Version:** ${version}
**Date:** ${date}
**Summary:** ${passed}/${total} passed

| Model | Status | Time | Betas | Excluded | Error |
|-------|--------|------|-------|----------|-------|
${rows.join("\n")}
`

  writeFileSync(outPath, md, "utf-8")
  console.log(c.dim(`\nResults written to test-results/model-smoke-test.md`))
}

function updateReadme(results: ModelResult[]): void {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const readmePath = join(__dirname, "..", "README.md")

  if (!existsSync(readmePath)) return

  const readme = readFileSync(readmePath, "utf-8")

  // Sort: passing models first, then failing; alphabetical within each group
  const sorted = [...results].sort((a, b) => {
    if (a.status !== b.status) return a.status === "pass" ? -1 : 1
    return a.model.localeCompare(b.model)
  })

  const rows = sorted.map(r => {
    const status = r.status === "pass" ? "Supported" : "Not supported"
    return `| ${r.model} | ${status} |`
  })

  const passed = results.filter(r => r.status === "pass").length
  const total = results.length

  const section = `## Supported models

${passed}/${total} models supported. Run \`npm run test:models\` to verify against your account.

| Model | Status |
|-------|--------|
${rows.join("\n")}`

  // Replace existing section or insert before "## Credential sources"
  const sectionStart = readme.indexOf("## Supported models")
  const nextSection = readme.indexOf("\n## ", sectionStart + 1)

  let updated: string
  if (sectionStart !== -1 && nextSection !== -1) {
    updated = readme.slice(0, sectionStart) + section + "\n\n" + readme.slice(nextSection + 1)
  } else if (sectionStart !== -1) {
    updated = readme.slice(0, sectionStart) + section + "\n"
  } else {
    // Insert before "## Credential sources"
    const insertPoint = readme.indexOf("## Credential sources")
    if (insertPoint !== -1) {
      updated = readme.slice(0, insertPoint) + section + "\n\n" + readme.slice(insertPoint)
    } else {
      return // Can't find insertion point
    }
  }

  writeFileSync(readmePath, updated, "utf-8")
  console.log(c.dim(`README.md updated with supported models`))
}

async function main(): Promise<void> {
  console.log(c.bold("Model Smoke Test"))
  console.log("=".repeat(50) + "\n")

  // Get credentials
  const creds = getCachedCredentials()
  if (!creds) {
    console.error(c.red("No Claude Code credentials found. Run `claude` to authenticate."))
    process.exit(1)
  }

  // Discover models from OpenCode
  let models: string[]
  try {
    models = await discoverModels()
  } catch (err) {
    console.error(c.red(`Failed to discover models: ${err instanceof Error ? err.message : err}`))
    console.error(c.yellow("Is OpenCode installed? The script uses `opencode serve` to discover models."))
    process.exit(1)
  }

  // Test each model sequentially
  const results: ModelResult[] = []
  for (const modelId of models) {
    const result = await testModel(modelId, creds.accessToken)
    results.push(result)
    printResult(result)
  }

  // Summary
  const passed = results.filter(r => r.status === "pass").length
  const total = results.length
  console.log("\n" + "=".repeat(50))

  if (passed === total) {
    console.log(c.green(c.bold(`Summary: ${passed}/${total} passed`)))
  } else {
    console.log(c.yellow(c.bold(`Summary: ${passed}/${total} passed`)))
  }

  // Read version from package.json
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf-8")
  ) as { version: string }

  writeResultsFile(results, pkg.version)
  updateReadme(results)
}

main().catch((err) => {
  console.error(c.red(`Fatal error: ${err instanceof Error ? err.message : err}`))
  process.exit(1)
})
