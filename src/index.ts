import type { Plugin } from "@opencode-ai/plugin"
import { execSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { readClaudeCredentials, type ClaudeCredentials } from "./keychain.js"

function getAuthJsonPath(): string {
  if (process.platform === "win32") {
    const appData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")
    return join(appData, "opencode", "auth.json")
  }
  return join(homedir(), ".local", "share", "opencode", "auth.json")
}

function syncAuthJson(creds: ClaudeCredentials): void {
  const authPath = getAuthJsonPath()
  let auth: Record<string, unknown> = {}
  if (existsSync(authPath)) {
    const raw = readFileSync(authPath, "utf-8").trim()
    if (raw) {
      try {
        auth = JSON.parse(raw)
      } catch {
        // Malformed file, start fresh
      }
    }
  }
  auth.anthropic = {
    type: "oauth",
    access: creds.accessToken,
    refresh: creds.refreshToken,
    expires: creds.expiresAt,
  }
  const dir = dirname(authPath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(authPath, JSON.stringify(auth, null, 2), "utf-8")
}

function refreshViaCli(): void {
  try {
    execSync("claude -p . --model haiku", {
      timeout: 60_000,
      encoding: "utf-8",
      env: { ...process.env, TERM: "dumb" },
      stdio: "ignore",
    })
  } catch {
    // Non-fatal: Claude CLI may not be available
  }
}

function refreshIfNeeded(): ClaudeCredentials | null {
  let creds = readClaudeCredentials()
  if (creds && creds.expiresAt > Date.now() + 60_000) {
    return creds
  }
  // Token is expired or near expiry, try CLI refresh
  refreshViaCli()
  creds = readClaudeCredentials()
  if (creds && creds.expiresAt > Date.now() + 60_000) {
    return creds
  }
  return null
}

const SYNC_INTERVAL = 5 * 60 * 1000 // 5 minutes

const plugin: Plugin = async () => {
  let creds: ClaudeCredentials | null = null
  try {
    creds = readClaudeCredentials()
  } catch (err) {
    console.warn(
      "opencode-claude-auth: Failed to read Claude Code credentials:",
      err instanceof Error ? err.message : err,
    )
    return {}
  }
  if (!creds) {
    console.warn(
      "opencode-claude-auth: No Claude Code credentials found. " +
        "Plugin disabled. Run `claude` to authenticate.",
    )
    return {}
  }

  // Sync credentials to auth.json on startup
  syncAuthJson(creds)

  // Keep auth.json synced, refreshing via CLI if token is near expiry
  setInterval(() => {
    try {
      const fresh = refreshIfNeeded()
      if (fresh) {
        syncAuthJson(fresh)
      }
    } catch {
      // Non-fatal
    }
  }, SYNC_INTERVAL)

  return {}
}

export default plugin
