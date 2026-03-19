import type { Plugin, AuthHook } from "@opencode-ai/plugin"
import { execSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { readClaudeCredentials, type ClaudeCredentials } from "./keychain.js"

function clearOpencodeAuth(): void {
  const authPaths = [
    join(homedir(), ".local", "share", "opencode", "auth.json"),
    join(process.env.APPDATA ?? homedir(), "opencode", "auth.json"),
    join(homedir(), ".opencode", "auth.json"),
  ]

  for (const path of authPaths) {
    try {
      if (existsSync(path)) {
        const raw = readFileSync(path, "utf-8")
        const auth = JSON.parse(raw)
        delete auth.anthropic
        writeFileSync(path, JSON.stringify(auth), "utf-8")
      }
    } catch {
      // Non-fatal: may not have write permissions
    }
  }
}

function refreshViaCli(): void {
  try {
    execSync("claude -p . --model claude-haiku-4-5-20250514", {
      timeout: 60_000,
      encoding: "utf-8",
      env: { ...process.env, TERM: "dumb" },
      stdio: "ignore",
    })
  } catch {
    // Non-fatal: Claude CLI may not be available
  }
}

function loadSessionPrompt(): string {
  try {
    const dir = dirname(fileURLToPath(import.meta.url))
    const promptPath = join(dir, "anthropic-prompt.txt")
    return readFileSync(promptPath, "utf-8")
  } catch {
    return "You are Claude Code, Anthropic's official CLI for Claude."
  }
}

function createAuthFetch(
  initial: ClaudeCredentials,
  onRefresh: (updated: ClaudeCredentials) => void,
): (...args: Parameters<typeof fetch>) => Promise<Response> {
  let current = initial

  return async (fetchInput, init): Promise<Response> => {
    if (current.expiresAt < Date.now() + 60_000) {
      const fresh = readClaudeCredentials()
      if (fresh && fresh.expiresAt > Date.now() + 60_000) {
        current = fresh
        onRefresh(current)
      } else {
        refreshViaCli()
        const afterRefresh = readClaudeCredentials()
        if (afterRefresh && afterRefresh.expiresAt > Date.now() + 60_000) {
          current = afterRefresh
          onRefresh(current)
        } else {
          throw new Error(
            "opencode-claude-auth: Token expired and refresh failed. " +
              "Re-authenticate with Claude Code by running `claude` in your terminal.",
          )
        }
      }
    }

    const headers = new Headers(init?.headers)
    headers.set("Authorization", `Bearer ${current.accessToken}`)
    return fetch(fetchInput, { ...init, headers })
  }
}

const plugin: Plugin = async (input) => {
  const creds = readClaudeCredentials()
  if (!creds) {
    return {}
  }

  const auth: AuthHook = {
    provider: "anthropic",
    loader: async (_getAuth, _provider) => {
      clearOpencodeAuth()

      const initialCreds = readClaudeCredentials()
      if (!initialCreds) {
        throw new Error(
          "opencode-claude-auth: Claude Code credentials not found. " +
            "Please authenticate with Claude Code first by running `claude` in your terminal.",
        )
      }

      await input.client.auth.set({
        path: { id: "anthropic" },
        body: {
          type: "oauth",
          access: initialCreds.accessToken,
          refresh: initialCreds.refreshToken,
          expires: initialCreds.expiresAt,
        },
      })

      return {
        apiKey: "oauth",
        fetch: createAuthFetch(initialCreds, (updated) => {
          void input.client.auth.set({
            path: { id: "anthropic" },
            body: {
              type: "oauth",
              access: updated.accessToken,
              refresh: updated.refreshToken,
              expires: updated.expiresAt,
            },
          })
        }),
      }
    },
    methods: [] as AuthHook["methods"],
  }

  return {
    auth,
    async "experimental.chat.system.transform"(hookInput, output) {
      if (hookInput.model.providerID !== "anthropic") return
      const prompt = loadSessionPrompt()
      output.system.unshift(prompt)
    },
  }
}

export default plugin
