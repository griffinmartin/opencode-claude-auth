import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

describe("OAuth token refresh", () => {
  it("uses direct OAuth refresh instead of CLI hack", () => {
    const source = readFileSync(new URL("./credentials.ts", import.meta.url), "utf-8")

    // Must use direct OAuth token endpoint, not CLI spawning
    assert.match(source, /platform\.claude\.com\/v1\/oauth\/token/)
    assert.match(source, /grant_type.*refresh_token/)
    assert.match(source, /User-Agent/)
    assert.doesNotMatch(source, /claude -p \. --model haiku/)
  })

  it("includes required User-Agent header", () => {
    const source = readFileSync(new URL("./credentials.ts", import.meta.url), "utf-8")

    // Without User-Agent: claude-cli/..., the token endpoint returns 429
    assert.match(source, /claude-cli\//)
  })
})
