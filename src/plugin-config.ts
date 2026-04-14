import { log } from "./logger.ts"

/**
 * Plugin settings that can be set via opencode.json as an alternative
 * to environment variables.
 *
 * Priority: environment variable > opencode.json config > hardcoded default
 *
 * In opencode.json (project-level or ~/.config/opencode/opencode.json):
 *
 * ```json
 * {
 *   "agent": {
 *     "build": {
 *       "enable1mContext": true
 *     }
 *   }
 * }
 * ```
 */
export interface PluginSettings {
  enable1mContext?: boolean
}

let settings: PluginSettings = {}

const ANTHROPIC_COMPAT_MODELS = [
  "claude-3-haiku-20240307",
  "claude-haiku-4-5",
  "claude-haiku-4-5-20251001",
  "claude-opus-4-0",
  "claude-opus-4-1",
  "claude-opus-4-1-20250805",
  "claude-opus-4-20250514",
  "claude-opus-4-5",
  "claude-opus-4-5-20251101",
  "claude-opus-4-6",
  "claude-sonnet-4-0",
  "claude-sonnet-4-20250514",
  "claude-sonnet-4-5",
  "claude-sonnet-4-5-20250929",
  "claude-sonnet-4-6",
] as const

function ensureAnthropicModelCompatibility(config: unknown): void {
  if (!config || typeof config !== "object") return

  const cfg = config as Record<string, unknown>
  const providersRaw = cfg.provider
  if (!providersRaw || typeof providersRaw !== "object") return

  const providers = providersRaw as Record<string, unknown>
  const anthropicRaw = providers.anthropic

  if (!anthropicRaw || typeof anthropicRaw !== "object") {
    providers.anthropic = {}
  }

  const anthropic = providers.anthropic as Record<string, unknown>
  const modelsRaw = anthropic.models

  if (!modelsRaw || typeof modelsRaw !== "object") {
    anthropic.models = {}
  }

  const models = anthropic.models as Record<string, unknown>
  let inserted = 0

  for (const modelID of ANTHROPIC_COMPAT_MODELS) {
    if (modelID in models) continue
    models[modelID] = {
      id: modelID,
      name: modelID,
    }
    inserted += 1
  }

  if (inserted > 0) {
    log("config_anthropic_models_compat_applied", {
      inserted,
    })
  }
}

/**
 * Extract plugin settings from the opencode Config object.
 *
 * Scans all agent configs for our plugin-specific keys. AgentConfig has
 * a catch-all `[key: string]: unknown` index signature, so arbitrary
 * keys placed in agent configs are preserved through OpenCode's
 * config parser and passed to the plugin via the `config` hook.
 *
 * NOTE: OpenCode's Zod schema may relocate unknown top-level agent keys
 * into `agent.options`. We check both locations defensively so this
 * survives future config parser changes.
 *
 * The first boolean value found (in any agent) wins — even if `false`.
 */
export function applyOpencodeConfig(config: unknown): void {
  ensureAnthropicModelCompatibility(config)

  if (!config || typeof config !== "object") return

  const cfg = config as Record<string, unknown>
  const agents = cfg.agent as Record<string, unknown> | undefined

  if (!agents || typeof agents !== "object") return

  for (const agentConfig of Object.values(agents)) {
    if (!agentConfig || typeof agentConfig !== "object") continue
    const agent = agentConfig as Record<string, unknown>

    // Check top-level first, then fall back to options (where OpenCode's
    // Zod transform may relocate unknown keys)
    const val =
      agent.enable1mContext ??
      (agent.options as Record<string, unknown> | undefined)?.enable1mContext

    if (typeof val === "boolean") {
      settings.enable1mContext = val
      log("config_loaded", { enable1mContext: val })
      return
    }

    if (val !== undefined) {
      log("config_invalid_type", {
        key: "enable1mContext",
        expectedType: "boolean",
        actualType: typeof val,
      })
    }
  }

  log("config_no_plugin_keys", {
    agentCount: Object.keys(agents).length,
  })
}

/**
 * Whether 1M context should be enabled.
 *
 * Priority: ANTHROPIC_ENABLE_1M_CONTEXT env var > opencode.json > false
 */
export function isEnable1mContext(): boolean {
  const envVal = process.env.ANTHROPIC_ENABLE_1M_CONTEXT
  if (envVal !== undefined) return envVal === "true"
  return settings.enable1mContext === true
}

export function resetPluginSettings(): void {
  settings = {}
}

export function getPluginSettings(): Readonly<PluginSettings> {
  return { ...settings }
}
