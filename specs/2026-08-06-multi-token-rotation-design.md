# Pasted OAuth tokens and automatic rotation on rate limits

Date: 2026-08-06
Status: implemented (fork)

## Context

The plugin sources credentials from Claude Code's own storage: every
`Claude Code-credentials*` Keychain entry on macOS, or
`$CLAUDE_CONFIG_DIR/.credentials.json` elsewhere (`src/keychain.ts`). That
covers the case it was built for — reuse the login you already have — but it
makes two things impossible.

**Several subscriptions require several Claude Code logins.** Holding more than
one account in the Keychain means the multi-login dance the README links out to.
`claude setup-token` already mints exactly what is needed here — a long-lived
(1-year), inference-only OAuth token — and there was no way to hand one to the
plugin.

**Nothing recovers from a usage limit.** Rate-limit handling stops at detecting
that _someone else_ switched accounts. `src/http.ts:52` retries transient 429s
and returns immediately when `retry-after` exceeds the cap; `src/index.ts:519`
re-reads the source once in case an external tool (cswap, the `claude` CLI)
rotated the credential. Neither switches accounts on its own, so a session that
exhausts its account stays exhausted, even with three healthy subscriptions
available.

## Goals

- Paste one or more `claude setup-token` tokens and have them work as accounts,
  with no Keychain entry and no Claude Code login on the machine.
- On a rate limit, move to the next healthy account automatically, within the
  same request where possible.
- A limited account is remembered as limited across restarts.

## Non-goals

- **Replacing Keychain discovery.** Pasted tokens are additive; the existing
  sources keep working and keep priority.
- **Usage prediction or quota accounting.** The plugin learns an account is
  limited by being told so with a 429. It does not model consumption.
- **Round-robin load spreading.** Fixed priority with cooldowns was chosen
  instead, so the preferred subscription stays the default and behaviour is
  reproducible across sessions.

## Design

### 1. Static credentials (`src/token-store.ts`)

A `setup-token` value has no refresh token, no store to write back to, and an
expiry that is a nominal one-year stamp rather than a deadline. Modelling it as
an OAuth credential with `refreshToken: ""` would be wrong in a specific and
expensive way: every refresh site decides what to do from expiry and
refresh-token presence, so an empty refresh token is indistinguishable from a
credential that failed to parse — which routes into `claude` CLI spawns (60s
each) and cross-account borrowing, on every cache miss, forever.

`ClaudeCredentials` therefore gains `kind?: "oauth" | "static"`. Absent means
`"oauth"`, so every existing credential keeps its behaviour. `isCredentialUsable`
(`src/keychain.ts`) treats static credentials as always usable, and
`refreshIfNeeded` short-circuits them before any refresh machinery runs.

Storage is `~/.local/share/opencode/claude-auth-tokens.json`, mode 0600, written
via write-then-rename — a truncated write would destroy the only copy of a token
that exists nowhere else on the machine. Ids are content-derived
(`sha256(token)[0..8]`), which makes re-pasting the same token idempotent and
gives cooldowns a stable key.

Tokens also arrive from `OPENCODE_CLAUDE_AUTH_TOKENS` and Claude Code's own
`CLAUDE_CODE_OAUTH_TOKEN`, for headless and CI use where there is no TUI to
paste into. Environment tokens sort ahead of stored ones and are never persisted,
so unsetting the variable removes the account.

### 2. Rotation policy (`src/rotation.ts`)

Pure bookkeeping over source strings. It deliberately does **not** decide when to
rotate and does **not** touch credentials.

`fetchWithRetry` is shared with the OAuth token endpoint (`src/credentials.ts`),
and a 429 from _that_ must never bench a subscription — the same reasoning that
kept the external-rotation design out of `http.ts`. So the trigger lives at the
one call site in `src/index.ts` that can see an API response, and this module
only answers "which account next".

Cooldown duration comes from whatever the response was willing to say, in order
of directness: `retry-after` (seconds or HTTP date), then
`anthropic-ratelimit-unified-*-reset` (the account-level quota clock Claude Code
itself reads), then a configured default. Body text only distinguishes an
explained usage limit from a bare 429; it never sets the duration.

Two bounds matter:

- **Benches are capped** (default 6h). A cooldown is only ever "when to
  reconsider", so capping costs at most one extra 429, whereas an uncapped
  weekly-limit reset would park an account for seven days even after the limit
  lifts early.
- **A bare 429 gets the short default** (60s), not a quota-length bench. An
  unexplained 429 is more likely a burst limit than an exhausted subscription,
  and writing an account off for hours on that evidence would be wrong.

State is `~/.local/share/opencode/claude-auth-rotation.json`. Losing it costs one
wasted request; it is a cache, not a source of truth, so every read failure
degrades to "nothing is benched".

### 3. The trigger (`src/index.ts`)

Ordering inside the 429 handling is load-bearing in three ways:

1. **After the existing external-switch check.** If another process already
   rotated this session onto a healthy account, that costs no cooldown and no
   switch.
2. **Before the long-context beta loop**, but with long-context 429s excluded
   explicitly rather than by ordering. A long-context 429 is a header problem
   every account shares; rotating around it would bench the whole pool for a
   fault no account can avoid. Reaching the beta loop first would mean the
   account had already been benched by then, so the exclusion cannot be left
   implicit.
3. **`triedSources` accumulates across one request**, so a prompt cannot bounce
   between two exhausted accounts. Combined with `maxSwitchesPerRequest`, the
   walk is bounded twice over.

On any successful response the serving account's bench is cleared, so an account
whose limit reset earlier than the capped estimate stops being skipped as soon as
it proves itself.

### 4. Notification

Rotation is invisible otherwise, so it toasts via `client.tui.showToast`.

`console.warn` was not an option: it draws over the OpenCode TUI, which is why
API errors were moved off it in 2.0.1 and why a test asserts that a quota 429
prints nothing. The toast is best-effort and the client is optional — unit tests
construct the plugin with no input and a headless server has no TUI — so a failed
notification can never fail the request that triggered it.

### 5. Secret hygiene (`src/logger.ts`)

The debug log is documented as safe to attach to a GitHub issue. Its redaction
covered `accessToken`, `refreshToken`, `x-api-key`, and JWT-shaped values —
but `sk-ant-oat…` tokens are not JWT-shaped, so a pasted token logged under any
other key would have landed in that file in the clear. Redaction now also matches
`sk-ant-*` by value, keeping the last 6 characters so a log line stays matchable
to an account shown in the picker without carrying a usable secret.

## Error handling

| Failure                              | Behaviour                                                                    |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| Malformed or hand-broken token store | Individually invalid entries are skipped; the rest of the file still loads   |
| Token store unwritable               | Paste applies to the session; the summary says it was not persisted          |
| Rotation state unreadable            | Treated as "nothing benched" — costs one wasted request                      |
| Every account benched                | The 429 is returned, with a toast naming each bench and its remaining time   |
| Pasted token removed while active    | `refreshAccount` returns null, the account drops out on the next cache miss  |
| Static token actually rejected (401) | Existing 401 recovery runs; nothing tries to refresh it, because nothing can |
| No TUI client (headless, tests)      | Notification is skipped; rotation itself is unaffected                       |

## Configuration

All environment-variable driven, matching the repo's existing convention.

| Variable                                      | Default                        |
| --------------------------------------------- | ------------------------------ |
| `OPENCODE_CLAUDE_AUTH_ROTATE`                 | enabled; `0` disables          |
| `OPENCODE_CLAUDE_AUTH_ACCOUNT_ORDER`          | discovery order                |
| `OPENCODE_CLAUDE_AUTH_ROTATE_COOLDOWN_MS`     | `60000`                        |
| `OPENCODE_CLAUDE_AUTH_ROTATE_MAX_COOLDOWN_MS` | `21600000` (6h)                |
| `OPENCODE_CLAUDE_AUTH_ROTATE_MAX_SWITCHES`    | `3`                            |
| `OPENCODE_CLAUDE_AUTH_TOKENS`                 | unset                          |
| `CLAUDE_CODE_OAUTH_TOKEN`                     | unset (Claude Code's own name) |
| `OPENCODE_CLAUDE_AUTH_TOKENS_FILE`            | data dir                       |
| `OPENCODE_CLAUDE_AUTH_ROTATION_FILE`          | data dir                       |

## Testing

Follows the existing convention: colocated `*.test.ts`, run via
`node --test --experimental-strip-types`.

`src/token-store.test.ts` — paste parsing (multi-token, dedupe, partial-invalid,
future `oat` versions), validation messages never echoing the secret, content-
derived ids, store CRUD, 0600 permissions, environment tokens and their
precedence, and resilience to malformed or partially broken files.

`src/rotation.test.ts` — cooldown derivation from each signal and the cap,
bench persistence and the never-shorten rule, ordering and candidate selection,
initial-account choice stepping over a benched selection, and disabled-rotation
behaviour.

`src/index.test.ts` — the integration path: a 429 rotating onto the next account
with the retry carrying that account's token; rotating onto a pasted token;
surfacing the limit once every account is exhausted (bounded, no loop);
no rotation when disabled; no rotation on a long-context 429; and a configured
order deciding both the starting account and the rotation target.

## Risks and residuals

- **Cooldowns are estimates.** An account may be benched while it is actually
  fine (capped estimate, or a 429 caused by something account-independent). The
  clear-on-success rule bounds the cost to one skipped selection, and an explicit
  pick in the account switcher always overrides a bench.
- **Rotation state is not locked.** Two OpenCode instances can interleave
  read-modify-write on the cooldown file and lose one bench. The consequence is
  one wasted request. A `refresh-lock`-style advisory lock is available if this
  proves to matter, and was left out rather than added speculatively.
- **A static token's expiry is a guess.** If Anthropic shortens the 1-year
  lifetime, the nominal stamp drifts. Nothing acts on it, so the only effect is
  the display value; a genuinely dead token surfaces as a 401.
- **Toast availability is unverified against a running OpenCode.** The call is
  typed against the SDK (`tui.showToast`) and fully guarded, so the worst case is
  a silent rotation rather than a failure.
