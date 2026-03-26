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

/**
 * Extract plugin settings from the opencode Config object.
 *
 * Scans all agent configs for our plugin-specific keys. AgentConfig has
 * a catch-all `[key: string]: unknown` index signature, so arbitrary
 * keys placed in agent configs are preserved through OpenCode's
 * config parser and passed to the plugin via the `config` hook.
 *
 * The first truthy value found (in any agent) wins.
 */
export function applyOpencodeConfig(config: unknown): void {
  if (!config || typeof config !== "object") return

  const cfg = config as Record<string, unknown>
  const agents = cfg.agent as Record<string, unknown> | undefined

  if (!agents || typeof agents !== "object") return

  for (const agentConfig of Object.values(agents)) {
    if (!agentConfig || typeof agentConfig !== "object") continue
    const agent = agentConfig as Record<string, unknown>

    if (typeof agent.enable1mContext === "boolean") {
      settings.enable1mContext = agent.enable1mContext
      log("config_loaded", { enable1mContext: agent.enable1mContext })
      return
    }
  }
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
