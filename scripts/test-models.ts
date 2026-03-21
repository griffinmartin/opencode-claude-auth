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

interface FailedModelEntry {
  lastTested: string
  lastPassedAt: string | null
  error: string
  consecutiveFailures: number
}

interface FailedModelsCache {
  [model: string]: FailedModelEntry
}

interface SkippedModel {
  model: string
  reason: string
  lastTested: string
  lastError: string
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

function getFailedModelsCachePath(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  return join(__dirname, "..", "test-results", "failed-models.json")
}

function loadFailedModelsCache(): FailedModelsCache {
  const cachePath = getFailedModelsCachePath()
  if (!existsSync(cachePath)) return {}

  try {
    const raw = readFileSync(cachePath, "utf-8")
    return JSON.parse(raw) as FailedModelsCache
  } catch {
    return {}
  }
}

function shouldSkipModel(model: string, cache: FailedModelsCache): boolean {
  const entry = cache[model]
  if (!entry) return false
  // Skip only if the model has never passed
  return entry.lastPassedAt === null
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

function writeResultsFile(results: ModelResult[], skipped: SkippedModel[], version: string): void {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const outPath = join(__dirname, "..", "test-results", "model-smoke-test.json")

  const dir = dirname(outPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  const passed = results.filter(r => r.status === "pass").length
  const failed = results.filter(r => r.status === "fail").length

  const output = {
    version,
    date: new Date().toISOString(),
    summary: {
      tested: results.length,
      passed,
      failed,
      skipped: skipped.length,
    },
    results: results.map(r => ({
      model: r.model,
      status: r.status,
      timeMs: r.timeMs,
      betas: r.betas,
      excluded: r.excluded,
      error: r.error ?? null,
    })),
    skipped: skipped.map(s => ({
      model: s.model,
      reason: s.reason,
      lastTested: s.lastTested,
      lastError: s.lastError,
    })),
  }

  writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n", "utf-8")
  console.log(c.dim(`\nResults written to test-results/model-smoke-test.json`))
}

function writeFailedModelsCache(
  results: ModelResult[],
  skipped: SkippedModel[],
  previousCache: FailedModelsCache,
): void {
  const cachePath = getFailedModelsCachePath()
  const now = new Date().toISOString()
  const updated: FailedModelsCache = {}

  // Carry forward skipped models unchanged
  for (const s of skipped) {
    if (previousCache[s.model]) {
      updated[s.model] = previousCache[s.model]
    }
  }

  // Process tested models
  for (const r of results) {
    if (r.status === "pass") {
      // Model passed — remove from cache (don't add to updated)
      continue
    }

    // Model failed — add or update cache entry
    const previous = previousCache[r.model]
    updated[r.model] = {
      lastTested: now,
      lastPassedAt: previous?.lastPassedAt ?? null,
      error: r.error ?? `HTTP failure`,
      consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1,
    }
  }

  const dir = dirname(cachePath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }

  writeFileSync(cachePath, JSON.stringify(updated, null, 2) + "\n", "utf-8")
  console.log(c.dim(`Failed models cache written to test-results/failed-models.json`))
}

function updateReadme(results: ModelResult[]): void {
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const readmePath = join(__dirname, "..", "README.md")

  if (!existsSync(readmePath)) return

  const readme = readFileSync(readmePath, "utf-8")

  // Only include passing models, sorted alphabetically
  const supported = results
    .filter(r => r.status === "pass")
    .sort((a, b) => a.model.localeCompare(b.model))

  const rows = supported.map(r => `| ${r.model} |`)

  const section = `## Supported models

${supported.length} supported models. Run \`npm run test:models\` to verify against your account.

| Model |
|-------|
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

  // Load failed models cache
  const failedCache = loadFailedModelsCache()
  const cachedCount = Object.keys(failedCache).length
  if (cachedCount > 0) {
    console.log(c.dim(`Loaded ${cachedCount} cached failure(s) from failed-models.json\n`))
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

  // Partition models into testable and skipped
  const modelsToTest: string[] = []
  const skipped: SkippedModel[] = []

  for (const modelId of models) {
    if (shouldSkipModel(modelId, failedCache)) {
      const entry = failedCache[modelId]
      skipped.push({
        model: modelId,
        reason: "Previously unsupported (never passed)",
        lastTested: entry.lastTested,
        lastError: entry.error,
      })
    } else {
      modelsToTest.push(modelId)
    }
  }

  if (skipped.length > 0) {
    console.log(c.dim(`Skipping ${skipped.length} previously unsupported model(s)\n`))
  }

  // Test each model sequentially
  const results: ModelResult[] = []
  for (const modelId of modelsToTest) {
    const result = await testModel(modelId, creds.accessToken)
    results.push(result)
    printResult(result)
  }

  // Summary
  const passed = results.filter(r => r.status === "pass").length
  const tested = results.length
  console.log("\n" + "=".repeat(50))

  if (passed === tested) {
    console.log(c.green(c.bold(`Summary: ${passed}/${tested} passed`)))
  } else {
    console.log(c.yellow(c.bold(`Summary: ${passed}/${tested} passed`)))
  }

  if (skipped.length > 0) {
    console.log(c.dim(`         ${skipped.length} skipped (cached failures)`))
    for (const s of skipped) {
      console.log(c.dim(`           - ${s.model}: ${s.lastError}`))
    }
  }

  // Read version from package.json
  const __dirname = dirname(fileURLToPath(import.meta.url))
  const pkg = JSON.parse(
    readFileSync(join(__dirname, "..", "package.json"), "utf-8")
  ) as { version: string }

  writeResultsFile(results, skipped, pkg.version)
  writeFailedModelsCache(results, skipped, failedCache)
  updateReadme(results)
}

main().catch((err) => {
  console.error(c.red(`Fatal error: ${err instanceof Error ? err.message : err}`))
  process.exit(1)
})
