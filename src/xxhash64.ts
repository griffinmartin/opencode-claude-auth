/**
 * Pure TypeScript xxHash64 implementation using BigInt.
 * Used to compute the cch attestation hash for Claude Code billing headers.
 *
 * Reference: https://github.com/Cyan4973/xxHash/blob/dev/doc/xxhash_spec.md
 */

const PRIME1 = 0x9e3779b185ebca87n
const PRIME2 = 0xc2b2ae3d27d4eb4fn
const PRIME3 = 0x165667b19e3779f9n
const PRIME4 = 0x85ebca77c2b2ae63n
const PRIME5 = 0x27d4eb2f165667c5n
const M = 0xffffffffffffffffn // 64-bit mask

function mul(a: bigint, b: bigint): bigint {
  return (a * b) & M
}

function add(a: bigint, b: bigint): bigint {
  return (a + b) & M
}

function rotl(v: bigint, n: number): bigint {
  return ((v << BigInt(n)) | (v >> BigInt(64 - n))) & M
}

function u64le(buf: Uint8Array, i: number): bigint {
  return (
    BigInt(buf[i]) |
    (BigInt(buf[i + 1]) << 8n) |
    (BigInt(buf[i + 2]) << 16n) |
    (BigInt(buf[i + 3]) << 24n) |
    (BigInt(buf[i + 4]) << 32n) |
    (BigInt(buf[i + 5]) << 40n) |
    (BigInt(buf[i + 6]) << 48n) |
    (BigInt(buf[i + 7]) << 56n)
  )
}

function u32le(buf: Uint8Array, i: number): bigint {
  return (
    BigInt(buf[i]) |
    (BigInt(buf[i + 1]) << 8n) |
    (BigInt(buf[i + 2]) << 16n) |
    (BigInt(buf[i + 3]) << 24n)
  )
}

function round(acc: bigint, lane: bigint): bigint {
  acc = add(acc, mul(lane, PRIME2))
  acc = rotl(acc, 31)
  return mul(acc, PRIME1)
}

function mergeAccumulator(h: bigint, acc: bigint): bigint {
  const val = round(0n, acc)
  h = (h ^ val) & M
  return add(mul(h, PRIME1), PRIME4)
}

function avalanche(h: bigint): bigint {
  h = mul(h ^ (h >> 33n), PRIME2)
  h = mul(h ^ (h >> 29n), PRIME3)
  return (h ^ (h >> 32n)) & M
}

export function xxhash64(input: Uint8Array, seed: bigint): bigint {
  const len = input.length
  let h: bigint
  let off = 0

  if (len >= 32) {
    let v1 = add(add(seed, PRIME1), PRIME2)
    let v2 = add(seed, PRIME2)
    let v3 = seed & M
    let v4 = (seed - PRIME1) & M

    const limit = len - 32
    while (off <= limit) {
      v1 = round(v1, u64le(input, off))
      v2 = round(v2, u64le(input, off + 8))
      v3 = round(v3, u64le(input, off + 16))
      v4 = round(v4, u64le(input, off + 24))
      off += 32
    }

    h = add(add(rotl(v1, 1), rotl(v2, 7)), add(rotl(v3, 12), rotl(v4, 18)))
    h = mergeAccumulator(h, v1)
    h = mergeAccumulator(h, v2)
    h = mergeAccumulator(h, v3)
    h = mergeAccumulator(h, v4)
  } else {
    h = add(seed, PRIME5)
  }

  h = add(h, BigInt(len))

  // Remaining 8-byte blocks
  while (off + 8 <= len) {
    const k = round(0n, u64le(input, off))
    h = add(mul(rotl((h ^ k) & M, 27), PRIME1), PRIME4)
    off += 8
  }

  // Remaining 4-byte block
  if (off + 4 <= len) {
    h = add(
      mul(rotl((h ^ mul(u32le(input, off), PRIME1)) & M, 23), PRIME2),
      PRIME3,
    )
    off += 4
  }

  // Remaining bytes
  while (off < len) {
    h = mul(rotl((h ^ mul(BigInt(input[off]), PRIME5)) & M, 11), PRIME1)
    off++
  }

  return avalanche(h)
}

/** The seed baked into Claude Code's custom Bun binary (v2.1.37) */
export const CCH_SEED = 0x6e52736ac806831en

/**
 * Compute the cch attestation hash for a request body.
 * The body must contain the placeholder "cch=00000".
 *
 * @returns 5-character zero-padded lowercase hex string
 */
export function computeCchHash(bodyBytes: Uint8Array): string {
  const hash = xxhash64(bodyBytes, CCH_SEED)
  const truncated = hash & 0xfffffn
  return truncated.toString(16).padStart(5, "0")
}
