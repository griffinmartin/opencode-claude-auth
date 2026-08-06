import assert from "node:assert/strict"
import { describe, it, beforeEach } from "node:test"
import {
  isRotatedAway,
  noteRotatedAway,
  resetRotatedTokens,
} from "./rotated-tokens.ts"

const SRC = "Claude Code-credentials"

describe("rotated-tokens", () => {
  beforeEach(() => {
    resetRotatedTokens()
  })

  it("recognises a token it was told was rotated away", () => {
    noteRotatedAway(SRC, "access-old")
    assert.equal(isRotatedAway(SRC, "access-old"), true)
  })

  it("does not claim an unrelated token is dead", () => {
    noteRotatedAway(SRC, "access-old")
    assert.equal(isRotatedAway(SRC, "access-new"), false)
  })

  it("keeps sources independent", () => {
    // A second Claude account's rotations say nothing about this one's store.
    noteRotatedAway(SRC, "access-old")
    assert.equal(
      isRotatedAway("Claude Code-credentials-2", "access-old"),
      false,
    )
  })

  it("treats a missing token as not rotated", () => {
    assert.equal(isRotatedAway(SRC, undefined), false)
    assert.equal(isRotatedAway(SRC, ""), false)
  })

  it("ignores an empty token rather than remembering it", () => {
    noteRotatedAway(SRC, "")
    assert.equal(isRotatedAway(SRC, ""), false)
  })

  it("is idempotent", () => {
    noteRotatedAway(SRC, "access-old")
    noteRotatedAway(SRC, "access-old")
    assert.equal(isRotatedAway(SRC, "access-old"), true)
  })

  it("remembers several rotations, since a store may lag by more than one", () => {
    noteRotatedAway(SRC, "a")
    noteRotatedAway(SRC, "b")
    noteRotatedAway(SRC, "c")
    for (const token of ["a", "b", "c"]) {
      assert.equal(isRotatedAway(SRC, token), true, `expected ${token} dead`)
    }
  })

  it("bounds what it retains so a long-lived process cannot grow forever", () => {
    for (let i = 0; i < 20; i++) noteRotatedAway(SRC, `token-${i}`)
    assert.equal(isRotatedAway(SRC, "token-19"), true, "keeps the newest")
    assert.equal(isRotatedAway(SRC, "token-0"), false, "drops the oldest")
  })

  it("forgets everything on reset", () => {
    noteRotatedAway(SRC, "access-old")
    resetRotatedTokens()
    assert.equal(isRotatedAway(SRC, "access-old"), false)
  })
})
