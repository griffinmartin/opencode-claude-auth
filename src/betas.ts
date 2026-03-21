const DEFAULT_BETA_FLAGS = "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05"

// Beta flags to try removing in order when "long context" errors occur
export const LONG_CONTEXT_BETAS = ["context-1m-2025-08-07", "interleaved-thinking-2025-05-14"]

function getRequiredBetas(): string[] {
  return (process.env.ANTHROPIC_BETA_FLAGS ?? DEFAULT_BETA_FLAGS)
    .split(",").map(s => s.trim()).filter(Boolean)
}

// Session-level cache of excluded beta flags per model (resets on process restart)
const excludedBetas: Map<string, Set<string>> = new Map()

// Track the last-seen beta flags env var and model to detect changes
let lastBetaFlagsEnv: string | undefined = process.env.ANTHROPIC_BETA_FLAGS
let lastModelId: string | undefined

export function getExcludedBetas(modelId: string): Set<string> {
  // Reset exclusions if user changed ANTHROPIC_BETA_FLAGS
  const currentBetaFlags = process.env.ANTHROPIC_BETA_FLAGS
  if (currentBetaFlags !== lastBetaFlagsEnv) {
    excludedBetas.clear()
    lastBetaFlagsEnv = currentBetaFlags
  }
  
  // Reset exclusions if user switched models (new model may support different betas)
  if (lastModelId !== undefined && lastModelId !== modelId) {
    excludedBetas.clear()
  }
  lastModelId = modelId
  
  return excludedBetas.get(modelId) ?? new Set()
}

export function addExcludedBeta(modelId: string, beta: string): void {
  const existing = excludedBetas.get(modelId) ?? new Set()
  existing.add(beta)
  excludedBetas.set(modelId, existing)
}

export function isLongContextError(responseBody: string): boolean {
  return responseBody.includes("Extra usage is required for long context requests")
    || responseBody.includes("long context beta is not yet available")
}

export function getNextBetaToExclude(modelId: string): string | null {
  const excluded = getExcludedBetas(modelId)
  for (const beta of LONG_CONTEXT_BETAS) {
    if (!excluded.has(beta)) {
      return beta
    }
  }
  return null // All long-context betas already excluded
}

export function getModelBetas(modelId: string, excluded?: Set<string>): string[] {
  const betas = [...getRequiredBetas()]
  const lower = modelId.toLowerCase()

  // context-1m only for opus/sonnet 4.6+ models
  if (lower.includes("opus") || lower.includes("sonnet")) {
    const versionMatch = lower.match(/(opus|sonnet)-(\d+)-(\d+)/)
    if (versionMatch) {
      const major = parseInt(versionMatch[2], 10)
      const minor = parseInt(versionMatch[3], 10)
      // Date suffixes like 20250514 are not minor versions — treat as x.0
      const effectiveMinor = minor > 99 ? 0 : minor
      if (major > 4 || (major === 4 && effectiveMinor >= 6)) {
        betas.push("context-1m-2025-08-07")
      }
    }
    // If no version found (bare alias like "sonnet"), exclude 1M beta
  }

  // haiku doesn't get claude-code-20250219
  if (lower.includes("haiku")) {
    const idx = betas.indexOf("claude-code-20250219")
    if (idx !== -1) betas.splice(idx, 1)
  }

  // Filter out excluded betas (from previous failed requests due to long context errors)
  if (excluded && excluded.size > 0) {
    return betas.filter(beta => !excluded.has(beta))
  }

  return betas
}
