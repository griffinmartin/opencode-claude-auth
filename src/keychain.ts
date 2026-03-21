import { execSync } from "node:child_process"
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

export interface ClaudeCredentials {
  accessToken: string
  refreshToken: string
  expiresAt: number
}

const SERVICE_NAME = "Claude Code-credentials"

function readCredentialsFile(): ClaudeCredentials | null {
  try {
    const credPath = join(homedir(), ".claude", ".credentials.json")
    const raw = readFileSync(credPath, "utf-8")
    const parsed = JSON.parse(raw) as { claudeAiOauth?: Record<string, unknown> }
    const data = parsed.claudeAiOauth ?? parsed
    const creds = data as { accessToken?: unknown; refreshToken?: unknown; expiresAt?: unknown }

    if (
      typeof creds.accessToken !== "string" ||
      typeof creds.refreshToken !== "string" ||
      typeof creds.expiresAt !== "number"
    ) {
      return null
    }

    return {
      accessToken: creds.accessToken,
      refreshToken: creds.refreshToken,
      expiresAt: creds.expiresAt,
    }
  } catch {
    return null
  }
}

export function readClaudeCredentials(): ClaudeCredentials | null {
  if (process.platform !== "darwin") {
    return readCredentialsFile()
  }

  let raw: string
  try {
    raw = execSync(`security find-generic-password -s "${SERVICE_NAME}" -w`, {
      timeout: 2000,
      encoding: "utf-8",
    }).trim()
  } catch (err: unknown) {
    const error = err as { status?: number; code?: string; killed?: boolean }

    if (error.killed || error.code === "ETIMEDOUT") {
      throw new Error(
        "Keychain read timed out. This can happen on macOS Tahoe. Try restarting Keychain Access."
      )
    }

    if (error.status === 44) {
      return readCredentialsFile()
    }

    if (error.status === 36) {
      throw new Error(
        "macOS Keychain is locked. Please unlock it or run: security unlock-keychain ~/Library/Keychains/login.keychain-db"
      )
    }

    if (error.status === 128) {
      throw new Error(
        "Keychain access was denied. Please grant access when prompted by macOS."
      )
    }

    throw new Error(
      `Failed to read Claude Code credentials from Keychain (exit ${error.status ?? "unknown"}). Try re-authenticating with Claude Code.`
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(
      "Claude Code credentials exist but contain invalid JSON. Try re-authenticating with Claude Code."
    )
  }

  const data = (parsed as { claudeAiOauth?: unknown }).claudeAiOauth ?? parsed
  const creds = data as {
    accessToken?: unknown
    refreshToken?: unknown
    expiresAt?: unknown
  }

  if (typeof creds.accessToken !== "string") {
    throw new Error(
      "Claude Code credentials are incomplete (missing accessToken). Try re-authenticating with Claude Code."
    )
  }
  if (typeof creds.refreshToken !== "string") {
    throw new Error(
      "Claude Code credentials are incomplete (missing refreshToken). Try re-authenticating with Claude Code."
    )
  }
  if (typeof creds.expiresAt !== "number") {
    throw new Error(
      "Claude Code credentials are incomplete (missing expiresAt). Try re-authenticating with Claude Code."
    )
  }

  return {
    accessToken: creds.accessToken,
    refreshToken: creds.refreshToken,
    expiresAt: creds.expiresAt,
  }
}

function writeCredentialsFile(creds: ClaudeCredentials): void {
  const credPath = join(homedir(), ".claude", ".credentials.json")
  let existing: Record<string, unknown> = {}
  try {
    existing = JSON.parse(readFileSync(credPath, "utf-8"))
  } catch {
    // Start fresh
  }
  existing.claudeAiOauth = {
    ...(existing.claudeAiOauth as Record<string, unknown> ?? {}),
    accessToken: creds.accessToken,
    refreshToken: creds.refreshToken,
    expiresAt: creds.expiresAt,
  }
  const dir = join(homedir(), ".claude")
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  writeFileSync(credPath, JSON.stringify(existing, null, 2), "utf-8")
}

export function writeClaudeCredentials(creds: ClaudeCredentials): void {
  if (process.platform !== "darwin") {
    writeCredentialsFile(creds)
    return
  }

  // Update macOS Keychain — read existing, merge, write back
  let existing: Record<string, unknown> = {}
  try {
    const raw = execSync(`security find-generic-password -s "${SERVICE_NAME}" -w`, {
      timeout: 2000,
      encoding: "utf-8",
    }).trim()
    existing = JSON.parse(raw) as Record<string, unknown>
  } catch {
    // No existing entry or parse error — start fresh
  }

  existing.claudeAiOauth = {
    ...(existing.claudeAiOauth as Record<string, unknown> ?? {}),
    accessToken: creds.accessToken,
    refreshToken: creds.refreshToken,
    expiresAt: creds.expiresAt,
  }

  const jsonStr = JSON.stringify(existing)
  try {
    // Delete old entry first (security add-generic-password fails if it exists)
    try {
      execSync(`security delete-generic-password -s "${SERVICE_NAME}"`, {
        timeout: 2000,
        stdio: "ignore",
      })
    } catch {
      // Entry may not exist
    }
    execSync(`security add-generic-password -s "${SERVICE_NAME}" -a "Claude Code" -w "${jsonStr.replace(/"/g, '\\"')}"`, {
      timeout: 2000,
      stdio: "ignore",
    })
  } catch {
    // Fall back to file-based storage
    writeCredentialsFile(creds)
  }
}
