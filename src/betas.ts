import { config, getModelOverride } from "./model-config.ts"
import { isEnable1mContext } from "./plugin-config.ts"

// Beta flags to try removing in order when "long context" errors occur
export const LONG_CONTEXT_BETAS = config.longContextBetas

function getRequiredBetas(): string[] {
  return (process.env.ANTHROPIC_BETA_FLAGS ?? config.baseBetas.join(","))
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
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

export function resetExcludedBetas(): void {
  excludedBetas.clear()
  lastModelId = undefined
}

export function isLongContextError(responseBody: string): boolean {
  return (
    responseBody.includes(
      "Extra usage is required for long context requests",
    ) || responseBody.includes("long context beta is not yet available")
  )
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

export function supports1mContext(modelId: string): boolean {
  const lower = modelId.toLowerCase()
  if (!lower.includes("opus") && !lower.includes("sonnet")) return false
  const versionMatch = lower.match(/(opus|sonnet)-(\d+)-(\d+)/)
  if (!versionMatch) return false
  const major = parseInt(versionMatch[2], 10)
  const minor = parseInt(versionMatch[3], 10)
  // Date suffixes like 20250514 are not minor versions — treat as x.0
  const effectiveMinor = minor > 99 ? 0 : minor
  return major > 4 || (major === 4 && effectiveMinor >= 6)
}

export function getModelBetas(
  modelId: string,
  excluded?: Set<string>,
): string[] {
  const betas = [...getRequiredBetas()]

  // context-1m is OPT-IN only, matching the official Claude CLI behavior.
  // The CLI only sends this beta when the model ID has a [1m] suffix.
  // Without it, the API enforces a 200k context limit. Sending the beta
  // without a subscription that covers long context billing causes
  // "Extra usage is required for long context requests" errors.
  //
  // Users who want 1M context should set ANTHROPIC_ENABLE_1M_CONTEXT=true
  // (requires a Claude Max subscription or a plan that covers extra usage).
  if (isEnable1mContext() && supports1mContext(modelId)) {
    betas.push(config.longContextBetas[0])
  }

  // Apply per-model overrides (e.g. haiku excludes claude-code-20250219)
  const override = getModelOverride(modelId)
  if (override) {
    if (override.exclude) {
      for (const ex of override.exclude) {
        const idx = betas.indexOf(ex)
        if (idx !== -1) betas.splice(idx, 1)
      }
    }
    if (override.add) {
      for (const add of override.add) {
        if (!betas.includes(add)) betas.push(add)
      }
    }
  }

  // Filter out excluded betas (from previous failed requests due to long context errors)
  if (excluded && excluded.size > 0) {
    return betas.filter((beta) => !excluded.has(beta))
  }

  return betas
}
