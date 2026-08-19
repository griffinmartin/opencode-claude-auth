import assert from "node:assert/strict"
import { describe, it } from "node:test"
import plugin from "./index.ts"

describe("OpenCode 2 plugin", () => {
  it("exports the V2 plugin module shape", () => {
    assert.equal(plugin.id, "griffinmartin.claude-auth")
    assert.equal(typeof plugin.setup, "function")
  })
})
