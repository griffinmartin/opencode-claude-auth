/**
 * Automatic account rotation on rate limits.
 *
 * When an account hits a usage limit the plugin benches it for a cooldown and
 * moves the session to the next healthy account in priority order. The bench
 * is persisted, because the limits worth rotating around reset in hours — a
 * cooldown held only in memory would be forgotten on the next OpenCode start
 * and the exhausted account would be picked first again.
 *
 * Two deliberate choices about what this module does NOT do:
 *
 * - It never decides *when* to rotate. `src/index.ts` owns that, at the one
 *   call site that can see a response. `fetchWithRetry` is shared with the
 *   OAuth token endpoint (`src/credentials.ts`), and a 429 from *that* must
 *   never bench a subscription, so rotation logic stays out of the shared
 *   fetch path entirely.
 * - It never refreshes or writes credentials. Selection is pure bookkeeping
 *   over sources; the caller asks `credentials.ts` for the chosen account's
 *   tokens afterwards.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { ClaudeAccount } from "./keychain.ts"
import { log } from "./logger.ts"

export interface CooldownEntry {
  /** Epoch ms until which this source is benched. */
  until: number
  /** Why it was benched — for `opencode auth login` display and debugging. */
  reason: string
  /** When the bench was applied. */
  at: number
}

export interface RotationStateFile {
  version: 1
  cooldowns: Record<string, CooldownEntry>
}

export interface RotationConfig {
  enabled: boolean
  /** Bench length for a 429 that carries no reset signal at all. */
  defaultCooldownMs: number
  /** Ceiling on any bench, however long the server says to wait. */
  maxCooldownMs: number
  /** Accounts a single request may walk through before giving up. */
  maxSwitchesPerRequest: number
  /** Explicit source order; unlisted sources follow, in discovery order. */
  order: string[]
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function getRotationConfig(): RotationConfig {
  const order = (process.env.OPENCODE_CLAUDE_AUTH_ACCOUNT_ORDER ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)

  return {
    enabled: process.env.OPENCODE_CLAUDE_AUTH_ROTATE !== "0",
    // A 429 with no reset hint is more likely a short burst limit than an
    // exhausted subscription, so the default bench is short: long enough to
    // move the request along, short enough that the preferred account is back
    // in the pool within a minute rather than being written off for hours.
    defaultCooldownMs: envInt(
      "OPENCODE_CLAUDE_AUTH_ROTATE_COOLDOWN_MS",
      60_000,
    ),
    // A bench is only ever "when to reconsider". Capping it costs at most one
    // extra 429 (which re-benches), whereas an uncapped weekly-limit reset
    // would park an account for seven days even after the user tops up or the
    // limit is lifted early.
    maxCooldownMs: envInt(
      "OPENCODE_CLAUDE_AUTH_ROTATE_MAX_COOLDOWN_MS",
      6 * 60 * 60 * 1000,
    ),
    maxSwitchesPerRequest: envInt(
      "OPENCODE_CLAUDE_AUTH_ROTATE_MAX_SWITCHES",
      3,
    ),
    order,
  }
}

export function getRotationStatePath(): string {
  return (
    process.env.OPENCODE_CLAUDE_AUTH_ROTATION_FILE ??
    join(homedir(), ".local", "share", "opencode", "claude-auth-rotation.json")
  )
}

export function readRotationState(): RotationStateFile {
  const path = getRotationStatePath()
  try {
    if (!existsSync(path)) return { version: 1, cooldowns: {} }
    const raw = readFileSync(path, "utf-8")
    if (!raw.trim()) return { version: 1, cooldowns: {} }
    const parsed = JSON.parse(raw) as Partial<RotationStateFile>
    const cooldowns = parsed?.cooldowns
    if (typeof cooldowns !== "object" || cooldowns === null) {
      return { version: 1, cooldowns: {} }
    }
    const clean: Record<string, CooldownEntry> = {}
    for (const [source, entry] of Object.entries(cooldowns)) {
      if (entry && typeof (entry as CooldownEntry).until === "number") {
        clean[source] = entry as CooldownEntry
      }
    }
    return { version: 1, cooldowns: clean }
  } catch (err) {
    // Rotation state is a cache, not a source of truth. Losing it costs one
    // wasted request against an account that is still limited.
    log("rotation_state_read_failed", {
      error: err instanceof Error ? err.message : String(err),
    })
    return { version: 1, cooldowns: {} }
  }
}

export function writeRotationState(state: RotationStateFile): boolean {
  const path = getRotationStatePath()
  try {
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    })
    renameSync(tmp, path)
    if (process.platform !== "win32") chmodSync(path, 0o600)
    return true
  } catch (err) {
    log("rotation_state_write_failed", {
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}

/**
 * How long to bench an account, from whatever the response was willing to say.
 *
 * Checked in order of directness. `retry-after` is the explicit instruction;
 * the unified reset header is the account-level quota clock Claude Code itself
 * reads; absent both, the configured default applies.
 */
export function cooldownFromResponse(
  headers: Headers | undefined,
  body: string | undefined,
  config: RotationConfig,
  now = Date.now(),
): { ms: number; reason: string } {
  const cap = (ms: number) =>
    Math.min(Math.max(ms, 1_000), config.maxCooldownMs)

  const retryAfter = headers?.get("retry-after")
  if (retryAfter) {
    const seconds = Number.parseInt(retryAfter, 10)
    if (Number.isFinite(seconds) && seconds > 0) {
      return { ms: cap(seconds * 1000), reason: "retry-after" }
    }
    // The header also permits an HTTP date.
    const asDate = Date.parse(retryAfter)
    if (Number.isFinite(asDate) && asDate > now) {
      return { ms: cap(asDate - now), reason: "retry-after-date" }
    }
  }

  for (const name of [
    "anthropic-ratelimit-unified-reset",
    "anthropic-ratelimit-unified-5h-reset",
    "anthropic-ratelimit-unified-7d-reset",
  ]) {
    const value = headers?.get(name)
    if (!value) continue
    const epochSeconds = Number.parseInt(value, 10)
    if (Number.isFinite(epochSeconds) && epochSeconds * 1000 > now) {
      return { ms: cap(epochSeconds * 1000 - now), reason: name }
    }
  }

  // Body text is the least reliable signal, so it only distinguishes a real
  // usage limit from an unexplained 429 — it never sets the duration.
  if (body && /usage limit|quota|limit reached|rate_limit/i.test(body)) {
    return { ms: cap(config.defaultCooldownMs), reason: "usage-limit-body" }
  }

  return { ms: cap(config.defaultCooldownMs), reason: "unspecified-429" }
}

export function markRateLimited(
  source: string,
  cooldownMs: number,
  reason: string,
  now = Date.now(),
): number {
  const state = readRotationState()
  const until = now + cooldownMs
  // Never shorten a bench that is already longer: a 429 arriving from an
  // in-flight request started before the bench must not undo it.
  const existing = state.cooldowns[source]
  if (existing && existing.until > until) return existing.until

  state.cooldowns[source] = { until, reason, at: now }
  writeRotationState(state)
  log("rotation_marked_limited", {
    source,
    until,
    cooldownMs,
    reason,
  })
  return until
}

export function clearCooldown(source: string, now = Date.now()): void {
  const state = readRotationState()
  if (!state.cooldowns[source]) return
  delete state.cooldowns[source]
  writeRotationState(state)
  log("rotation_cooldown_cleared", { source, at: now })
}

export function getCooldownUntil(
  source: string,
  now = Date.now(),
): number | null {
  const entry = readRotationState().cooldowns[source]
  if (!entry) return null
  return entry.until > now ? entry.until : null
}

export function isCoolingDown(source: string, now = Date.now()): boolean {
  return getCooldownUntil(source, now) !== null
}

/**
 * Accounts in the order rotation should prefer them.
 *
 * `order` names sources explicitly and wins; everything else keeps the order
 * discovery produced (keychain entries as listed, then pasted tokens), which
 * is what makes "fixed priority" predictable across restarts.
 */
export function orderAccounts(
  accounts: ClaudeAccount[],
  config: RotationConfig = getRotationConfig(),
): ClaudeAccount[] {
  if (config.order.length === 0) return [...accounts]

  const rank = new Map(config.order.map((s, i) => [s, i]))
  return [...accounts].sort((a, b) => {
    const ra = rank.get(a.source) ?? Number.MAX_SAFE_INTEGER
    const rb = rank.get(b.source) ?? Number.MAX_SAFE_INTEGER
    if (ra !== rb) return ra - rb
    return accounts.indexOf(a) - accounts.indexOf(b)
  })
}

/**
 * The highest-priority account that is neither benched nor already tried.
 *
 * Returns null when every account is spoken for, which the caller surfaces as
 * the original rate-limit error rather than inventing a wait.
 */
export function pickNextAccount(
  accounts: ClaudeAccount[],
  excludeSources: Iterable<string>,
  now = Date.now(),
  config: RotationConfig = getRotationConfig(),
): ClaudeAccount | null {
  const excluded = new Set(excludeSources)
  const state = readRotationState()
  const ordered = orderAccounts(accounts, config)

  for (const account of ordered) {
    if (excluded.has(account.source)) continue
    const entry = state.cooldowns[account.source]
    if (entry && entry.until > now) continue
    return account
  }
  return null
}

/**
 * The account a fresh session should start on.
 *
 * Prefers the persisted manual selection, but steps over it when it is still
 * benched — restarting OpenCode during a usage limit should land on a working
 * account, not replay the limit. Falls back to the first account when every
 * one is benched, so a session always has somewhere to send its first request.
 */
export function pickInitialAccount(
  accounts: ClaudeAccount[],
  persistedSource: string | null,
  now = Date.now(),
  config: RotationConfig = getRotationConfig(),
): ClaudeAccount | null {
  if (accounts.length === 0) return null

  const preferred = persistedSource
    ? accounts.find((a) => a.source === persistedSource)
    : undefined

  if (preferred && (!config.enabled || !isCoolingDown(preferred.source, now))) {
    return preferred
  }

  if (!config.enabled) return preferred ?? accounts[0]

  const next = pickNextAccount(accounts, [], now, config)
  if (next) {
    if (preferred && next.source !== preferred.source) {
      log("rotation_initial_skipped_cooldown", {
        skipped: preferred.source,
        chosen: next.source,
      })
    }
    return next
  }

  log("rotation_all_cooling_down", { accounts: accounts.length })
  return preferred ?? orderAccounts(accounts, config)[0]
}

export interface CooldownStatus {
  source: string
  until: number
  remainingMs: number
  reason: string
}

/** Live benches, for display in the account picker. */
export function activeCooldowns(now = Date.now()): CooldownStatus[] {
  const state = readRotationState()
  return Object.entries(state.cooldowns)
    .filter(([, entry]) => entry.until > now)
    .map(([source, entry]) => ({
      source,
      until: entry.until,
      remainingMs: entry.until - now,
      reason: entry.reason,
    }))
    .sort((a, b) => a.remainingMs - b.remainingMs)
}

export function formatRemaining(ms: number): string {
  if (ms <= 0) return "ready"
  const totalMinutes = Math.ceil(ms / 60_000)
  if (totalMinutes < 60) return `${totalMinutes}m`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`
}
