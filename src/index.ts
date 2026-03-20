import type { Plugin } from "@opencode-ai/plugin"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { readClaudeCredentials, type ClaudeCredentials } from "./keychain.js"

function getAuthJsonPath(): string {
  if (process.platform === "win32") {
    return join(process.env.USERPROFILE ?? homedir(), ".local", "share", "opencode", "auth.json")
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

  // Keep auth.json synced in the background
  setInterval(() => {
    try {
      const fresh = readClaudeCredentials()
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
