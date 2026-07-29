# External credential rotation

Date: 2026-07-29
Status: approved, not yet implemented

## Context

The plugin assumes it is the only writer to the active Claude Code credential.
That assumption is encoded explicitly at `src/credentials.ts:328-334`:

> macOS keychain sources stay on the in-memory path; their state is mutated only
> by our own `writeBackCredentials`, so no external-update vector exists for them.

The assumption is false. Several things rotate or replace that credential:

- `claude-swap` (`cswap`), switching accounts manually or via `cswap auto`
- the `claude` CLI running in another terminal
- a second OpenCode instance
- Anthropic revoking a token server-side

This design makes the plugin correct in the presence of external mutation. It is
motivated by cswap but contains no cswap-specific code, no subprocess, no `PATH`
dependency, and no new configuration.

### Why cswap is safe to cooperate with

Verified in cswap's source rather than assumed:

- `switcher.py:4694` — the switch-time backup copies **live** credential bytes
  into the departing account's slot. A token this plugin rotates is captured by
  cswap on the way out, so it is never orphaned and the account is not
  quarantined for a dead refresh token.
- `switcher.py:5074` — cswap fails fast if it cannot read the live credential,
  rather than overwriting state that has no safety copy.

Consequence: refreshing the **active** credential is safe with no coordination.
The plugin is indistinguishable from Claude Code refreshing its own token. This
asymmetry is why the design targets the active credential only.

## Problems

1. **External rotation is invisible.** `refreshIfNeeded` re-reads only `file`
   sources (`src/credentials.ts:331`). The sole re-read of a Keychain source
   during normal operation is in the 401 handler (`src/index.ts:374`). An
   external switch produces no 401, because the previous access token is still
   valid — so the session stays pinned to the account that was active at startup
   for the life of that token (~10h).

2. **Stale-snapshot write-back.** The proactive refresh tick (`src/index.ts:224`,
   every 5 min, acting within 1h of expiry) refreshes from an in-memory snapshot
   and calls `writeBackCredentials`. If the active credential was replaced
   externally in the meantime, the plugin writes the _stale_ account's rotated
   tokens over the _current_ account's slot. Because refresh tokens rotate on
   use, the losing copy is dead.

3. **401 recovery gives up too early.** `src/index.ts:371-392` re-reads the
   source and retries only if the access token changed. When the source still
   holds the rejected token, it surfaces the 401.
   `forceRefreshActiveAccount()` (`src/credentials.ts:606`) exists for exactly
   this case and has **no non-test call sites**. `invalidateCredentialCache()`
   (`:647`) and `reloadActiveAccount()` (`:585`) are likewise dead.

4. **Rate-limit errors leak after an external switch.** When cswap switches
   because an account hit its quota, the plugin keeps using the exhausted
   account until its cache expires, surfacing 429s that a re-read would avoid.

## Goals

- An external account switch takes effect in a live session without a restart.
- A request that fails on an expired or revoked token recovers within the same
  request where possible, and always leaves the next prompt working.
- The plugin never writes one account's tokens into another account's slot.

## Non-goals

Explicitly out of scope. Each was considered and rejected:

- **cswap-aware UX** — account roster, email labels, or usage in
  `opencode auth login`. Requires cswap on `PATH`.
- **Pinning OpenCode to a non-active cswap slot** (parallel accounts). Cold
  slots carry expired access tokens; cswap exposes no "refresh slot N" command,
  so the plugin would become an unsynchronized second writer to cswap's backup
  store, needing its `fcntl.flock` and `.prev` retention semantics. All of the
  risk, only parallelism in return.
- **Plugin-driven `cswap switch`.** cswap already handles rotation; driving it
  from here would fight `cswap auto`.
- **Any env var or opt-in gate.** Nothing here is cswap-specific, so there is
  nothing to gate.

## Design

### 1. Re-read every source in `refreshIfNeeded`

`src/credentials.ts:331` — drop the `target.source === "file"` guard so Keychain
sources are re-read too.

Cost is bounded: `refreshIfNeeded` runs only on a `getCachedCredentials()` cache
miss, so at most about twice a minute under load (`CREDENTIAL_CACHE_TTL_MS`,
`src/credentials.ts:26`). A `security find-generic-password` call is ~10-50ms.

This resolves problems 1 and 2 together: the plugin refreshes and writes back
whatever is _currently_ active rather than a stale snapshot.

**New failure path.** `readKeychainService` throws on a locked, denied, or timed
out Keychain (`src/keychain.ts:96-142`), whereas the file path swallows errors
inside `readCredentialsFile`. The re-read must therefore be wrapped so a
transient Keychain failure degrades to the in-memory credentials instead of
propagating into the request path.

Worst-case latency for an external switch to take effect: one cache TTL (30s).

**The adopt must be validated.** Taking any non-null stored blob over valid
in-memory credentials is unsafe, because `performRefresh` ignores
`writeBackCredentials`'s return value. When the read succeeds but the write
fails — a malformed stored blob, or an ACL allowing read but not
`add-generic-password` — memory holds freshly refreshed credentials while the
store holds the pre-refresh blob. On the reactive path that blob has under 60s
left, since that window is the only reason a refresh happened. Adopting it
re-enters `performRefresh` with a refresh token the successful refresh just
rotated dead, so OAuth fails and the code falls through to two 60s `claude`
spawns — on every cache miss, indefinitely, on the authentication path.

The rule: **adopt a usable stored blob always; adopt an unusable one only when
what we already hold is also unusable.**

| stored   | in memory | action                                                             |
| -------- | --------- | ------------------------------------------------------------------ |
| usable   | usable    | adopt — this is the external-switch case                           |
| usable   | unusable  | adopt                                                              |
| unusable | usable    | decline — this is the failed-write-back case                       |
| unusable | unusable  | adopt; nothing is lost and the stored refresh token may still work |

Accepted cost: if an external switch installs an account whose stored token is
already expired while ours is still usable, the session keeps its own
credentials until they expire and adopts the switched-in account then. cswap
freshens a target before activating it, so a newly-active slot is normally
fresh, and the alternative is the failure loop above.

Second accepted residual, on the proactive path. The background timer refreshes
an hour ahead of expiry, so a write-back failure there orphans a blob with up to
~1h left — which reads as "usable" and is adopted, clobbering the fresh
credentials. The consequence is categorically milder than the reactive case: the
adopted token is genuinely valid, so requests keep succeeding, and the
`CLI_FALLBACK_THRESHOLD_MS` gate in `performRefresh` declines to spawn `claude`
while credentials remain usable. The cost is a handful of wasted background OAuth
round trips over that final hour, resolving in one CLI-fallback recovery once the
blob drops under 60s.

No guard on the re-read can close this, and that is why it is out of scope here:
the re-read cannot distinguish "the store is stale because our write failed" from
"the store changed because cswap switched" — both present as _store disagrees
with memory, store is usable_. The information exists only at the
`writeBackCredentials` call in `performRefresh`, whose return value is discarded.
See Follow-ups in the plan.

The same branch clears the borrowed-credentials flag. A read from the account's
own source returns that account's own credentials, so it is by definition no
longer running on a lender's — matching the invariant `refreshBorrowedAccount`
maintains at every other adoption site.

### 2. Compare-and-swap on write-back

`writeBackCredentials` (`src/keychain.ts:442`) gains an optional expected prior
access token. When supplied and the stored blob no longer carries that token,
the write is skipped and logged rather than performed.

This closes the residual window in problem 2: the OAuth round-trip between
re-read and write-back is seconds wide, and an external switch can land inside
it.

Nearly free — the Keychain branch already reads the existing blob at
`src/keychain.ts:475` to preserve unrelated fields, so this adds a comparison
rather than a read. Callers that legitimately have no prior token (initial
sync) omit the argument and keep today's behavior.

On mismatch the session continues from memory; the next cache miss re-reads and
converges.

### 3. Bounded 401 recovery loop

Replace the single if/else at `src/index.ts:371-392` with a loop of at most two
recovery attempts. Each attempt:

1. Re-read the source (`reloadCredentialsFromSource`). If it yields a token
   different from the one just used, retry with it.
2. Otherwise call `forceRefreshActiveAccount()` — the currently dead function —
   and retry with its result.
3. If neither produces a token different from the one just used, stop.

The no-progress check is what bounds the loop; the attempt cap is defence in
depth.

Most cases resolve on the first attempt. A switch to a slot whose access token
is cold yields _null_ from step 1, not a different token —
`reloadCredentialsFromSource` rejects anything expiring within 60s
(`src/credentials.ts:706-710`) — so step 2 runs immediately. The second attempt
exists for the narrower race where step 1 returns a token that is valid-looking
but has itself just been rotated again by a concurrent writer: the retry 401s,
and the next iteration finds the source unchanged and force-refreshes.

One consequence to note: when step 1 returns null it does **not** update
`account.credentials`, so the force refresh runs against whatever account was
in memory. If a switch has landed, that is the previous account. The refresh
succeeds and the request recovers, but the write-back is correctly suppressed
by the compare-and-swap from change 2, since the store now holds a different
account. The session continues from memory and the next cache miss converges on
the switched-in account.

`forceRefreshActiveAccount` already guards borrowed credentials
(`src/credentials.ts:617`), writes back on success, and updates the cache, so it
is drop-in.

**Intentional behavior change.** `preserveResponseUnchanged` (`src/index.ts:462`)
decides whether the response bypasses `transformResponseStream()`. Today a
non-retried 401 bypasses it but a retried-then-still-401 does not. After this
change the flag is set from the status after the loop exits
(`response.status === 401`), so both surface the raw error body consistently and
a recovered request is still stream-transformed.

### 4. Re-read on 429 with a changed token

After the 401 block, if the response is 429, re-read the source once. Retry only
if the access token changed — which is true exactly when an external switch
happened, and false otherwise, making this free in the common case.

No `src/http.ts` change is needed. `fetchWithRetry` already returns immediately
when `retry-after` exceeds the cap (`src/http.ts:59-66`), which is the
quota-exhaustion signal.

This must sit **after** the 401 block and **before** the long-context beta loop
(`src/index.ts:396`). A long-context 429 produces no token change, so it falls
through to the beta loop untouched.

### Rejected: triggering rotation inside `http.ts`

`fetchWithRetry` is shared with the OAuth refresh path
(`src/credentials.ts:233`). A 429 from the token endpoint must never trigger
account recovery. All recovery logic therefore stays at the `src/index.ts` call
sites.

## Error handling

| Failure                                       | Behavior                                                                          |
| --------------------------------------------- | --------------------------------------------------------------------------------- |
| Keychain locked/denied/timeout during re-read | Caught; fall back to in-memory credentials. Never propagates to the request path. |
| CAS mismatch on write-back                    | Skip the write, log, continue from memory. Next cache miss converges.             |
| `forceRefreshActiveAccount` returns null      | Recovery loop stops; the 401 surfaces with the raw body.                          |
| Borrowed credentials active                   | `forceRefreshActiveAccount` already declines (`src/credentials.ts:617`).          |
| Both recovery attempts exhausted              | Return the 401 unchanged, as today.                                               |

## Testing

Follows existing convention: colocated `*.test.ts`, run via
`node --test --experimental-strip-types`.

`src/credentials.test.ts`

- `refreshIfNeeded` re-reads a Keychain source and adopts an externally rotated token
- a throwing `refreshAccount` degrades to in-memory credentials rather than propagating
- write-back is skipped when the stored token no longer matches the expected prior token

`src/keychain.test.ts`

- `writeBackCredentials` honors the expected-prior-token argument and is unchanged when omitted

`src/index.test.ts`

- 401, external rotation present → retry succeeds, response is stream-transformed
- 401, source yields no better token (unchanged, or null because it is expiring)
  → force refresh on the first attempt → retry succeeds
- 401, first retry also rejected → second attempt force-refreshes → retry succeeds
- 401, unrecoverable → response returned raw, no stream transformation
- 429 with a changed token → retried once
- 429 with an unchanged token → not retried, falls through to the beta loop
- a 429 from the OAuth token endpoint surfaces as a failed refresh and does not
  loop account recovery

## Risks

- **Keychain read volume.** Up to ~2 subprocesses/minute per session. Acceptable,
  and the cache TTL is unchanged.
- **30s convergence window.** An external switch is invisible for up to one cache
  TTL. Change 4 keeps that window from surfacing rate-limit errors; the residual
  is up to 30s of usage landing on the previous account. Shortening the TTL would
  cost a subprocess per request and is not worth it.
- **Behavior change to `preserveResponseUnchanged`.** Described in change 3.
  Low blast radius, but it is a change and should be called out in the changelog.
- **Coupling to cswap internals.** None. This design reads and writes only the
  active Claude Code credential, which is a Claude Code interface, not a cswap
  one.
