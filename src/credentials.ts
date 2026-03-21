import { execSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { readClaudeCredentials, type ClaudeCredentials } from "./keychain.js"

const CREDENTIAL_CACHE_TTL_MS = 30_000

let cachedCredentials: ClaudeCredentials | null = null
let cachedCredentialsAt = 0

function getAuthJsonPaths(): string[] {
  const xdgPath = join(homedir(), ".local", "share", "opencode", "auth.json")
  if (process.platform === "win32") {
    const appData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")
    const localAppDataPath = join(appData, "opencode", "auth.json")
    return [xdgPath, localAppDataPath]
  }
  return [xdgPath]
}

function syncToPath(authPath: string, creds: ClaudeCredentials): void {
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

export function syncAuthJson(creds: ClaudeCredentials): void {
  for (const authPath of getAuthJsonPaths()) {
    syncToPath(authPath, creds)
  }
}

function refreshViaCli(): void {
  const maxAttempts = 2
  for (let i = 0; i < maxAttempts; i++) {
    try {
      execSync("claude -p . --model haiku", {
        timeout: 60_000,
        encoding: "utf-8",
        env: { ...process.env, TERM: "dumb" },
        stdio: "ignore",
      })
      return
    } catch {
      // Non-fatal: retry once, then give up
    }
  }
}

export function refreshIfNeeded(): ClaudeCredentials | null {
  let creds = readClaudeCredentials()
  if (creds && creds.expiresAt > Date.now() + 60_000) {
    return creds
  }
  refreshViaCli()
  creds = readClaudeCredentials()
  if (creds && creds.expiresAt > Date.now() + 60_000) {
    return creds
  }
  return null
}

function isCredentialUsable(creds: ClaudeCredentials): boolean {
  return creds.expiresAt > Date.now() + 60_000
}

export function getCachedCredentials(): ClaudeCredentials | null {
  const now = Date.now()
  if (
    cachedCredentials &&
    now - cachedCredentialsAt < CREDENTIAL_CACHE_TTL_MS &&
    isCredentialUsable(cachedCredentials)
  ) {
    return cachedCredentials
  }

  const latest = refreshIfNeeded()
  if (!latest) {
    cachedCredentials = null
    cachedCredentialsAt = 0
    return null
  }

  cachedCredentials = latest
  cachedCredentialsAt = now
  return latest
}

export type { ClaudeCredentials } from "./keychain.js"
