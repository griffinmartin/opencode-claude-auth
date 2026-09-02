/**
 * Tokens this process has rotated away, per credential source.
 *
 * Anthropic's refresh tokens rotate: a successful refresh mints a new pair and
 * kills the one it was issued against. That makes a failed write-back far more
 * dangerous than a stale cache. The store is left holding a pair whose refresh
 * token is already dead, and every subsequent read of it — including the
 * "adopt credentials replaced externally" re-read, which cannot otherwise tell
 * "our write failed" from "a sibling rotated" — looks like perfectly good
 * credentials, because the access token has not expired yet.
 *
 * Adopting that blob discards the only live refresh token in existence, and no
 * amount of retrying recovers it: the OAuth endpoint answers invalid_grant and
 * the `claude` CLI fallback reads the same dead store. The user has to log in
 * by hand.
 *
 * Remembering which access tokens we rotated away is the missing evidence. It
 * lets a reader reject a known-dead blob, and lets a writer overwrite one
 * rather than refusing on a compare-and-swap it is guaranteed to lose.
 */

/**
 * Bounded because only the most recent rotations can plausibly still be sitting
 * in a store, and this is never persisted — a restart legitimately forgets.
 */
const MAX_REMEMBERED_PER_SOURCE = 5

const rotatedAway = new Map<string, string[]>()

/**
 * Record that `accessToken`'s credential pair has been rotated away by a
 * successful refresh, and that its refresh token is therefore dead.
 */
export function noteRotatedAway(source: string, accessToken: string): void {
  if (!accessToken) return
  const seen = rotatedAway.get(source) ?? []
  if (seen.includes(accessToken)) return
  seen.push(accessToken)
  while (seen.length > MAX_REMEMBERED_PER_SOURCE) seen.shift()
  rotatedAway.set(source, seen)
}

/** Whether `accessToken` belongs to a pair this process already rotated away. */
export function isRotatedAway(source: string, accessToken?: string): boolean {
  if (!accessToken) return false
  return rotatedAway.get(source)?.includes(accessToken) === true
}

/** Test seam: drop all remembered rotations. */
export function resetRotatedTokens(): void {
  rotatedAway.clear()
}
