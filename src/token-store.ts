/**
 * Pasted long-lived Claude tokens as a credential source.
 *
 * `claude setup-token` mints a ~1-year, inference-only OAuth token
 * (`sk-ant-oat01-…`) and hands back nothing else — no refresh token, no
 * expiry, no store to write to. Such a credential cannot take part in any
 * refresh path: there is nothing to exchange and nothing to write back.
 *
 * It is therefore modelled as `kind: "static"` rather than as an OAuth
 * credential with an empty refresh token. The distinction has to be explicit,
 * because every refresh site in this plugin decides what to do by looking at
 * expiry and refresh-token presence, and "no refresh token" is otherwise
 * indistinguishable from "an OAuth credential we failed to parse properly" —
 * which routes into `claude` CLI spawns and cross-account borrowing that a
 * static token must never trigger.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs"
import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { ClaudeAccount, ClaudeCredentials } from "./keychain.ts"
import { log } from "./logger.ts"

/** Marks a source string as belonging to the pasted-token store. */
export const TOKEN_SOURCE_PREFIX = "token:"

/**
 * Nominal lifetime stamped on a pasted token, matching what `claude
 * setup-token` documents ("long-lived (1-year) auth token").
 *
 * This is a display and bookkeeping hint only. Nothing acts on it: a static
 * credential is always treated as usable and only a real 401 retires it. The
 * token endpoint would reject a refresh attempt anyway, so an expiry-driven
 * refresh could achieve nothing but a wasted round trip.
 */
export const STATIC_TOKEN_TTL_MS = 365 * 24 * 60 * 60 * 1000

/**
 * Shape of a `setup-token` credential. Deliberately loose on the version
 * digits and body length — Anthropic has shipped `oat01` so far, and a future
 * `oat02` should not need a plugin release to be pasteable.
 */
export const TOKEN_PATTERN = /^sk-ant-oat\d{2,}-[A-Za-z0-9_-]{16,}$/

export interface StoredToken {
  /** Stable content-derived id; re-pasting the same token is idempotent. */
  id: string
  label?: string
  token: string
  addedAt: number
  /** Lower sorts earlier. Absent entries keep insertion order, after any set. */
  priority?: number
  /** Kept in the file but excluded from the account pool. */
  disabled?: boolean
}

export interface TokenStoreFile {
  version: 1
  accounts: StoredToken[]
}

export function getTokenStorePath(): string {
  return (
    process.env.OPENCODE_CLAUDE_AUTH_TOKENS_FILE ??
    join(homedir(), ".local", "share", "opencode", "claude-auth-tokens.json")
  )
}

/** Content-derived so the same token pasted twice collapses to one entry. */
export function tokenIdFor(token: string): string {
  return createHash("sha256").update(token.trim()).digest("hex").slice(0, 8)
}

/** Last 6 characters, for identifying a token in logs and pickers. */
export function tokenFingerprint(token: string): string {
  const trimmed = token.trim()
  return `…${trimmed.slice(-6)}`
}

export function isTokenSource(source: string): boolean {
  return source.startsWith(TOKEN_SOURCE_PREFIX)
}

export function sourceForToken(entry: StoredToken): string {
  return `${TOKEN_SOURCE_PREFIX}${entry.id}`
}

function isStoredToken(value: unknown): value is StoredToken {
  if (typeof value !== "object" || value === null) return false
  const v = value as Record<string, unknown>
  return typeof v.id === "string" && typeof v.token === "string"
}

export function readTokenStore(): TokenStoreFile {
  const path = getTokenStorePath()
  let raw: string
  try {
    if (!existsSync(path)) return { version: 1, accounts: [] }
    raw = readFileSync(path, "utf-8")
  } catch (err) {
    log("token_store_read_failed", {
      error: err instanceof Error ? err.message : String(err),
    })
    return { version: 1, accounts: [] }
  }

  if (!raw.trim()) return { version: 1, accounts: [] }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // A hand-edited file with a trailing comma must not take the session down;
    // surface it in the log and behave as though no tokens are configured.
    log("token_store_malformed", { path })
    return { version: 1, accounts: [] }
  }

  const accounts = (parsed as Record<string, unknown>)?.accounts
  if (!Array.isArray(accounts)) {
    log("token_store_malformed", { path, reason: "accounts is not an array" })
    return { version: 1, accounts: [] }
  }

  // Tolerate individually broken entries rather than discarding the file: a
  // store holding several subscriptions should not be lost to one bad record.
  const valid = accounts.filter(isStoredToken).map((entry) => {
    // Repair an id that a hand-edit desynchronised from the token it names,
    // otherwise dedupe and cooldown keying would drift apart.
    entry.id ||= tokenIdFor(entry.token)
    if (typeof entry.addedAt !== "number") entry.addedAt = Date.now()
    return entry
  })

  if (valid.length !== accounts.length) {
    log("token_store_entries_skipped", {
      skipped: accounts.length - valid.length,
    })
  }

  return { version: 1, accounts: valid }
}

export function writeTokenStore(file: TokenStoreFile): boolean {
  const path = getTokenStorePath()
  try {
    const dir = dirname(path)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })

    // Write-then-rename so an interrupted write cannot leave a truncated file
    // where the only copy of a pasted token used to be. `setup-token` values
    // are not recoverable from anywhere else on the machine.
    const tmp = `${path}.tmp`
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    })
    if (process.platform !== "win32") chmodSync(tmp, 0o600)
    renameSync(tmp, path)
    if (process.platform !== "win32") chmodSync(path, 0o600)
    log("token_store_written", { count: file.accounts.length })
    return true
  } catch (err) {
    log("token_store_write_failed", {
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}

/**
 * Split a pasted blob into candidate tokens.
 *
 * Accepts one token or several at once, separated by whitespace, commas, or
 * semicolons, because a single-line TUI prompt is the only input channel
 * available and pasting three subscriptions in one go is the point of this
 * feature. Order is preserved and duplicates collapse to the first occurrence.
 */
export function parsePastedTokens(raw: string): {
  tokens: string[]
  invalid: string[]
} {
  const parts = raw
    .split(/[\s,;]+/)
    .map((p) => p.trim())
    .filter(Boolean)

  const tokens: string[] = []
  const invalid: string[] = []
  const seen = new Set<string>()

  for (const part of parts) {
    if (!TOKEN_PATTERN.test(part)) {
      invalid.push(part)
      continue
    }
    if (seen.has(part)) continue
    seen.add(part)
    tokens.push(part)
  }

  return { tokens, invalid }
}

/**
 * Validator for the `opencode auth login` text prompt. Returns an error
 * message, or undefined when the input is acceptable.
 *
 * Never echoes the offending value: prompt errors are rendered in the TUI and
 * may be scrolled back to, and a mistyped token is still a live secret.
 */
export function validateTokenInput(raw: string): string | undefined {
  if (!raw.trim()) return "Paste at least one token"
  const { tokens, invalid } = parsePastedTokens(raw)
  if (tokens.length === 0) {
    return "No valid token found — expected sk-ant-oat…, from `claude setup-token`"
  }
  if (invalid.length > 0) {
    return `${invalid.length} of ${tokens.length + invalid.length} entries are not valid tokens`
  }
  return undefined
}

export interface AddTokensResult {
  added: StoredToken[]
  duplicates: StoredToken[]
  persisted: boolean
}

export function addTokens(tokens: string[], label?: string): AddTokensResult {
  const store = readTokenStore()
  const byId = new Map(store.accounts.map((a) => [a.id, a]))
  const added: StoredToken[] = []
  const duplicates: StoredToken[] = []
  const now = Date.now()

  tokens.forEach((token, i) => {
    const id = tokenIdFor(token)
    const existing = byId.get(id)
    if (existing) {
      duplicates.push(existing)
      return
    }
    // Number a multi-token paste so the entries stay tellable apart; a single
    // token keeps the label verbatim.
    const entryLabel = label?.trim()
      ? tokens.length > 1
        ? `${label.trim()} ${i + 1}`
        : label.trim()
      : undefined
    const entry: StoredToken = { id, token, addedAt: now }
    if (entryLabel) entry.label = entryLabel
    store.accounts.push(entry)
    byId.set(id, entry)
    added.push(entry)
  })

  const persisted = added.length > 0 ? writeTokenStore(store) : true
  log("token_store_add", {
    added: added.length,
    duplicates: duplicates.length,
    persisted,
  })
  return { added, duplicates, persisted }
}

export function removeToken(id: string): boolean {
  const store = readTokenStore()
  const next = store.accounts.filter((a) => a.id !== id)
  if (next.length === store.accounts.length) return false
  const ok = writeTokenStore({ version: 1, accounts: next })
  log("token_store_remove", { id, persisted: ok })
  return ok
}

export function setTokenDisabled(id: string, disabled: boolean): boolean {
  const store = readTokenStore()
  const entry = store.accounts.find((a) => a.id === id)
  if (!entry) return false
  entry.disabled = disabled
  return writeTokenStore(store)
}

/**
 * Tokens supplied by environment variable, for headless and CI use where
 * there is no TUI to paste into and no writable state directory.
 *
 * `CLAUDE_CODE_OAUTH_TOKEN` is Claude Code's own variable for exactly this
 * value, so it is honoured as-is rather than inventing a parallel name for it.
 * These are never written to the store — the environment stays the source of
 * truth, so unsetting the variable removes the account.
 */
export function readEnvTokens(): StoredToken[] {
  const raw = [
    process.env.OPENCODE_CLAUDE_AUTH_TOKENS,
    process.env.CLAUDE_CODE_OAUTH_TOKEN,
  ]
    .filter((v): v is string => Boolean(v?.trim()))
    .join(",")

  if (!raw) return []

  const { tokens, invalid } = parsePastedTokens(raw)
  if (invalid.length > 0) {
    log("token_env_invalid", { skipped: invalid.length })
  }
  return tokens.map((token, i) => ({
    id: tokenIdFor(token),
    label: `env ${i + 1}`,
    token,
    addedAt: 0,
    // Environment tokens sort ahead of stored ones: setting the variable is an
    // explicit, session-scoped override of whatever the file holds.
    priority: -1,
  }))
}

export function staticCredentialsFor(entry: StoredToken): ClaudeCredentials {
  return {
    accessToken: entry.token,
    refreshToken: "",
    expiresAt: (entry.addedAt || Date.now()) + STATIC_TOKEN_TTL_MS,
    kind: "static",
  }
}

/**
 * Every pasted token, environment first, then the stored file, with
 * explicitly-prioritised entries ahead of unprioritised ones.
 */
export function listTokenEntries(): StoredToken[] {
  const env = readEnvTokens()
  const seen = new Set(env.map((e) => e.id))
  const stored = readTokenStore().accounts.filter(
    (a) => !a.disabled && !seen.has(a.id),
  )
  return [...env, ...stored].sort(
    (a, b) =>
      (a.priority ?? Number.MAX_SAFE_INTEGER) -
      (b.priority ?? Number.MAX_SAFE_INTEGER),
  )
}

/** Pasted tokens as accounts, ready to append to the discovered pool. */
export function readTokenAccounts(): ClaudeAccount[] {
  const entries = listTokenEntries()
  return entries.map((entry, i) => ({
    label: entry.label
      ? `Claude token: ${entry.label}`
      : `Claude token ${i + 1} (${tokenFingerprint(entry.token)})`,
    source: sourceForToken(entry),
    credentials: staticCredentialsFor(entry),
  }))
}

/**
 * Re-read one pasted token from its backing store.
 *
 * Mirrors `refreshAccount` for keychain sources so the generic re-read paths
 * work unchanged: a token removed from the file returns null and the account
 * drops out, exactly as a deleted keychain entry does.
 */
export function readStaticCredentials(
  source: string,
): ClaudeCredentials | null {
  if (!isTokenSource(source)) return null
  const id = source.slice(TOKEN_SOURCE_PREFIX.length)
  const entry = listTokenEntries().find((e) => e.id === id)
  return entry ? staticCredentialsFor(entry) : null
}
