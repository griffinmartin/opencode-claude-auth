import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

// Keep the cross-process refresh lock off the real OpenCode data dir in tests.
process.env.OPENCODE_CLAUDE_AUTH_REFRESH_LOCK_DIR = mkdtempSync(
  join(tmpdir(), "opencode-claude-auth-v2test-"),
)

const { shouldSignClaudeRequest } = await import("./v2.ts")

function anthropicRequest(headers: Record<string, string>): Request {
  return new Request("https://api.anthropic.com/v1/messages", { headers })
}

describe("shouldSignClaudeRequest", () => {
  it("signs a request that carries a Claude Code OAuth token", () => {
    assert.equal(
      shouldSignClaudeRequest(
        anthropicRequest({ authorization: "Bearer sk-ant-oat01-abc" }),
      ),
      true,
    )
  })

  it("leaves API-key requests untouched", () => {
    assert.equal(
      shouldSignClaudeRequest(
        anthropicRequest({ "x-api-key": "sk-ant-api03-abc" }),
      ),
      false,
    )
    assert.equal(
      shouldSignClaudeRequest(
        anthropicRequest({ authorization: "Bearer sk-ant-api03-abc" }),
      ),
      false,
    )
  })

  it("signs a request with no credential yet attached", () => {
    assert.equal(shouldSignClaudeRequest(anthropicRequest({})), true)
  })
})
