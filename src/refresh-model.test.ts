import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, it } from "node:test"

describe("refreshViaCli model selection", () => {
  it("uses stable haiku alias", () => {
    const source = readFileSync(
      new URL("./credentials.ts", import.meta.url),
      "utf-8",
    )

    assert.match(source, /claude -p \. --model haiku/)
    assert.doesNotMatch(source, /claude-haiku-4-5-20250514/)
  })
})
