import { execSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

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
    const parsed = JSON.parse(raw) as {
      claudeAiOauth?: Record<string, unknown>
    }
    const data = parsed.claudeAiOauth ?? parsed
    const creds = data as {
      accessToken?: unknown
      refreshToken?: unknown
      expiresAt?: unknown
    }

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
        "Keychain read timed out. This can happen on macOS Tahoe. Try restarting Keychain Access.",
        { cause: err },
      )
    }

    if (error.status === 44) {
      return readCredentialsFile()
    }

    if (error.status === 36) {
      throw new Error(
        "macOS Keychain is locked. Please unlock it or run: security unlock-keychain ~/Library/Keychains/login.keychain-db",
        { cause: err },
      )
    }

    if (error.status === 128) {
      throw new Error(
        "Keychain access was denied. Please grant access when prompted by macOS.",
        { cause: err },
      )
    }

    throw new Error(
      `Failed to read Claude Code credentials from Keychain (exit ${error.status ?? "unknown"}). Try re-authenticating with Claude Code.`,
      { cause: err },
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(
      "Claude Code credentials exist but contain invalid JSON. Try re-authenticating with Claude Code.",
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
      "Claude Code credentials are incomplete (missing accessToken). Try re-authenticating with Claude Code.",
    )
  }
  if (typeof creds.refreshToken !== "string") {
    throw new Error(
      "Claude Code credentials are incomplete (missing refreshToken). Try re-authenticating with Claude Code.",
    )
  }
  if (typeof creds.expiresAt !== "number") {
    throw new Error(
      "Claude Code credentials are incomplete (missing expiresAt). Try re-authenticating with Claude Code.",
    )
  }

  return {
    accessToken: creds.accessToken,
    refreshToken: creds.refreshToken,
    expiresAt: creds.expiresAt,
  }
}
