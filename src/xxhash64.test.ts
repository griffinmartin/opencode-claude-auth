import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { xxhash64, computeCchHash, CCH_SEED } from "./xxhash64.ts"

describe("xxhash64", () => {
  it("returns known spec vector for empty input with seed 0", () => {
    const result = xxhash64(new Uint8Array(0), 0n)
    assert.equal(result, 0xef46db3751d8e999n)
  })

  it("returns a bigint for short input (<32 bytes)", () => {
    const input = new TextEncoder().encode("hello")
    const result = xxhash64(input, 0n)
    assert.equal(typeof result, "bigint")
    assert.ok(result >= 0n, "hash should be non-negative")
    assert.ok(result <= 0xffffffffffffffffn, "hash should fit in 64 bits")
  })

  it("exercises 4-lane accumulator for long input (>32 bytes)", () => {
    // 120 chars to ensure we hit the 32-byte stripe loop multiple times
    const longStr = "The quick brown fox jumps over the lazy dog. " +
      "Pack my box with five dozen liquor jugs. Sphinx of black quartz, judge my vow!"
    const input = new TextEncoder().encode(longStr)
    assert.ok(input.length > 32, "input must exceed 32 bytes")
    const result = xxhash64(input, 0n)
    assert.equal(typeof result, "bigint")
    assert.ok(result >= 0n)
    assert.ok(result <= 0xffffffffffffffffn)
  })

  it("produces different hashes for different seeds", () => {
    const input = new TextEncoder().encode("test")
    const h1 = xxhash64(input, 0n)
    const h2 = xxhash64(input, 1n)
    assert.notEqual(h1, h2, "different seeds should produce different hashes")
  })
})

describe("computeCchHash", () => {
  it("returns a 5-char lowercase hex string", () => {
    const body = new TextEncoder().encode("{\"prompt\":\"hello\",\"cch\":\"00000\"}")
    const result = computeCchHash(body)
    assert.match(result, /^[0-9a-f]{5}$/, "must be 5-char hex")
  })

  it("is deterministic (same input produces same output)", () => {
    const body = new TextEncoder().encode("{\"prompt\":\"hello\",\"cch\":\"00000\"}")
    const r1 = computeCchHash(body)
    const r2 = computeCchHash(body)
    assert.equal(r1, r2, "same input must produce same hash")
  })

  it("uses CCH_SEED consistently", () => {
    const body = new TextEncoder().encode("{\"model\":\"claude\",\"cch\":\"00000\"}")
    const fromComputeCch = computeCchHash(body)
    // Manually compute using xxhash64 with CCH_SEED
    const hash = xxhash64(body, CCH_SEED)
    const expected = (hash & 0xfffffn).toString(16).padStart(5, "0")
    assert.equal(fromComputeCch, expected, "computeCchHash must use CCH_SEED internally")
  })

  it("produces different hashes for different inputs", () => {
    const body1 = new TextEncoder().encode("{\"a\":1,\"cch\":\"00000\"}")
    const body2 = new TextEncoder().encode("{\"b\":2,\"cch\":\"00000\"}")
    const r1 = computeCchHash(body1)
    const r2 = computeCchHash(body2)
    assert.notEqual(r1, r2, "different inputs should produce different hashes")
  })
})
