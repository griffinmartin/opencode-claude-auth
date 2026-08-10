export function getCliVersion(): string {
  return process.env.ANTHROPIC_CLI_VERSION ?? config.ccVersion
}

/**
 * Identifies us to Anthropic. Required on every request, including the OAuth
 * token endpoint: claude.ai sits behind bot protection that answers a request
 * with no User-Agent with 429 `rate_limit_error` — a rejection that reads as a
 * rate limit but is really "unidentified client". Node and Bun both supply a
 * default when run directly, so this only bites inside a compiled host that
 * sends none, which is precisely where this plugin runs.
 */
export function getUserAgent(): string {
  return (
    process.env.ANTHROPIC_USER_AGENT ??
    `claude-cli/${getCliVersion()} (external, sdk-cli)`
  )
}

export interface ModelOverride {
  exclude?: string[]
  add?: string[]
  disableEffort?: boolean
}

export interface ModelConfig {
  ccVersion: string
  baseBetas: string[]
  longContextBetas: string[]
  modelOverrides: Record<string, ModelOverride>
}

export const config: ModelConfig = {
  ccVersion: "2.1.217",
  baseBetas: [
    "claude-code-20250219",
    "oauth-2025-04-20",
    "interleaved-thinking-2025-05-14",
    "prompt-caching-scope-2026-01-05",
    "context-management-2025-06-27",
    "advisor-tool-2026-03-01",
    "thinking-token-count-2026-05-13",
    "extended-cache-ttl-2025-04-11",
  ],
  longContextBetas: [
    "context-1m-2025-08-07",
    "interleaved-thinking-2025-05-14",
  ],
  // NOTE: getModelOverride is first-match-wins. The "sonnet" key must stay
  // ahead of "4-6"/"4-7": it shields claude-sonnet-4-6 from the "4-6"
  // effort add-override, and its exclude strips effort if a user supplies
  // it via ANTHROPIC_BETA_FLAGS. Do not remove it as inert — the split is
  // pinned by the "effort beta" test in betas.test.ts.
  modelOverrides: {
    sonnet: {
      exclude: ["effort-2025-11-24"],
    },
    haiku: {
      exclude: ["effort-2025-11-24"],
      disableEffort: true,
    },
    "4-6": {
      add: ["effort-2025-11-24"],
    },
    "4-7": {
      add: ["effort-2025-11-24"],
    },
  },
}

/**
 * Find the override entry matching a model ID.
 * Keys are matched via includes() against the lowercased model ID.
 *
 * First-match-wins: if multiple keys match, only the first (by insertion
 * order) is returned. List more specific keys before broader ones
 * (e.g. "opus-4-6" before "opus") so they take priority.
 */
export function getModelOverride(modelId: string): ModelOverride | null {
  const lower = modelId.toLowerCase()
  for (const [pattern, override] of Object.entries(config.modelOverrides)) {
    if (lower.includes(pattern)) return override
  }
  return null
}
