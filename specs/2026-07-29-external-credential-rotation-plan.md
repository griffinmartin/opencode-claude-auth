# External Credential Rotation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the plugin correct when something other than itself rotates the active Claude Code credential — cswap switching accounts, the `claude` CLI in another terminal, a second OpenCode instance, or a server-side revocation.

**Architecture:** Four changes to existing files. Re-read every credential source (not just `file`) on cache miss; compare-and-swap on write-back so a refresh can never land in another account's slot; replace the single-shot 401 handler with a bounded recovery loop that wires up the already-written-but-never-called `forceRefreshActiveAccount()`; re-read once on a 429 so a resolved rate limit isn't surfaced. No cswap dependency, no subprocess, no new configuration.

**Tech Stack:** TypeScript, Node's built-in test runner (`node --test --experimental-strip-types`), oxlint/oxfmt. Tests are colocated `*.test.ts` and load rewritten copies of `src/` modules from a temp dir with stubbed `keychain.ts` / `logger.ts` / `child-process.ts`.

**Spec:** `specs/2026-07-29-external-credential-rotation-design.md`

---

## File Structure

| File                        | Responsibility                                | Change                                                       |
| --------------------------- | --------------------------------------------- | ------------------------------------------------------------ |
| `src/credentials.ts`        | Account state, caching, refresh orchestration | Re-read all sources; pass expected-prior-token to write-back |
| `src/keychain.ts`           | OS credential store I/O                       | `writeBackCredentials` gains compare-and-swap                |
| `src/index.ts`              | Plugin entry, auth loader, fetch interception | 401 recovery loop; 429 re-read                               |
| `src/credentials.test.ts`   | Harness + credential tests                    | Source-aware stub; new + repaired tests                      |
| `src/keychain.test.ts`      | Keychain tests                                | CAS tests                                                    |
| `src/index.test.ts`         | Plugin/fetch tests                            | Repaired 401 test; new recovery tests                        |
| `README.md`, `CHANGELOG.md` | Docs                                          | Behavior note                                                |

## Known-breaking existing tests

These pass today and **will fail** partway through. Each is repaired in the task that breaks it — do not "fix" them by reverting the implementation.

| File:line                     | Assertion                                                 | Why it breaks                         | Repaired in |
| ----------------------------- | --------------------------------------------------------- | ------------------------------------- | ----------- |
| `src/credentials.test.ts:315` | `__getReadCount() === 1`                                  | `getCachedCredentials` now also reads | Task 2      |
| `src/credentials.test.ts:437` | `__getReadCount() === 0`                                  | first call now reads                  | Task 2      |
| `src/credentials.test.ts:735` | `__getReadCount() === readsBefore + 1`                    | now two reads                         | Task 2      |
| `src/index.test.ts:1189`      | "does not retry a 401 when the source token is unchanged" | that is the behavior being changed    | Task 4      |

Three further Task 2 breakages were found during execution that this plan did not predict. All share the root cause above — the up-front re-read makes the stub's source blob visible to accounts whose in-memory credentials differ from it:

| Test                                                                    | Fix                                                                                                                                            |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `reloadCredentialsFromSource bypasses cache`                            | prime via `__setCredentialsForSource` so the rotation under test still lands                                                                   |
| `does not spawn the claude CLI while credentials are still usable`      | pin the source to the account's own value                                                                                                      |
| `falls back to the claude CLI once credentials reach the expiry window` | its `__setReadHook` rotated the store on read #2, which is now the pre-CLI re-read rather than the post-CLI one; move the threshold to read #3 |

The last one matters beyond bookkeeping. Left at read #2 the result-token assertion still passes while `__getExecSyncCount()` drops to 0 — the CLI fallback silently stops being exercised, and the test keeps looking meaningful. Verified by reverting the threshold: `actual: 0, expected: 1`. Relaxing that count instead of moving the threshold would have left dead coverage behind.

---

### Task 1: Make the credentials test harness source-aware

The stub `refreshAccount(source)` ignores `source` and returns one global blob (`src/credentials.test.ts:148-153`). Harmless while only `file` sources were re-read; once every source is re-read, multi-account tests get one account's credentials for every source. This is a test-only change: the suite must stay green.

**Files:**

- Modify: `src/credentials.test.ts:126-190` (the `tempKeychain` stub literal)

- [x] **Step 1: Add per-source overrides to the stub keychain**

In the `writeFile(tempKeychain, ...)` template literal, replace the `refreshAccount` and `__setCredentials` definitions and add two exports. Keep `__setCredentials` working as the default so existing tests are untouched.

```js
let bySource = {}

export function refreshAccount(source) {
  readCount += 1
  if (readError) throw new Error("Keychain read denied")
  if (readHook) readHook()
  if (Object.prototype.hasOwnProperty.call(bySource, source)) {
    return bySource[source]
  }
  return credentials
}

export function __setCredentials(c) {
  credentials = c
}

export function __setCredentialsForSource(source, c) {
  bySource[source] = c
}
```

Each test calls `loadCredentialsWithCountingKeychain` fresh, which imports a new module instance with an empty `bySource`, so no reset helper is needed.

- [x] **Step 2: Record the expected-prior-token argument on write-back**

Replace the stub `writeBackCredentials` so Task 3 can assert on it. Four parameters, matching the real signature after Task 3.

```js
export function writeBackCredentials(
  source,
  creds,
  configDir,
  expectedPriorAccessToken,
) {
  writeCount += 1
  writes.push({ source, creds, configDir, expectedPriorAccessToken })
  return true
}
```

- [x] **Step 3: Widen the harness return types**

In the `keychainModule` type annotation (both the declared return type at `src/credentials.test.ts:56-64` and the cast at `:226-235`), add the new members and widen `__getWrites`:

```ts
    __setCredentialsForSource: (source: string, c: Creds | null) => void
    __getWrites: () => Array<{
      source: string
      creds: Creds
      configDir?: string
      expectedPriorAccessToken?: string
    }>
```

- [x] **Step 4: Run the full suite to confirm nothing regressed**

Run: `pnpm test 2>&1 | tail -8`
Expected: `pass 249`, `fail 0`

- [x] **Step 5: Commit**

```bash
git add src/credentials.test.ts
git commit -m "test: make credentials keychain stub source-aware"
```

---

### Task 2: Re-read every credential source on cache miss

**Files:**

- Modify: `src/credentials.ts:326-334`
- Test: `src/credentials.test.ts`

- [x] **Step 1: Write the failing tests**

Append inside the existing top-level `describe` block in `src/credentials.test.ts`:

```ts
it("refreshIfNeeded adopts credentials rotated externally in a keychain source", async () => {
  const originalNow = Date.now
  const now = 1_700_000_000_000
  Date.now = () => now

  try {
    const { credentialsModule, keychainModule } =
      await loadCredentialsWithCountingKeychain(now + 10 * 60_000)

    credentialsModule.initAccounts([
      {
        label: "Account 1",
        source: "keychain",
        credentials: {
          accessToken: "before-switch",
          refreshToken: "rt-before",
          expiresAt: now + 10 * 60_000,
        },
      },
    ])

    // An external process (cswap, the claude CLI, a second OpenCode)
    // replaces the stored credential with a different account's.
    keychainModule.__setCredentials({
      accessToken: "after-switch",
      refreshToken: "rt-after",
      expiresAt: now + 10 * 60_000,
    })

    const result = await credentialsModule.refreshIfNeeded()

    assert.equal(result?.accessToken, "after-switch")
  } finally {
    Date.now = originalNow
  }
})

it("refreshIfNeeded keeps in-memory credentials when the source read throws", async () => {
  const originalNow = Date.now
  const now = 1_700_000_000_000
  Date.now = () => now

  try {
    const { credentialsModule, keychainModule } =
      await loadCredentialsWithCountingKeychain(now + 10 * 60_000)

    credentialsModule.initAccounts([
      {
        label: "Account 1",
        source: "keychain",
        credentials: {
          accessToken: "in-memory",
          refreshToken: "rt",
          expiresAt: now + 10 * 60_000,
        },
      },
    ])

    keychainModule.__setReadError(true)

    const result = await credentialsModule.refreshIfNeeded()

    assert.equal(result?.accessToken, "in-memory")
  } finally {
    Date.now = originalNow
  }
})
```

- [x] **Step 2: Run the new tests to verify they fail**

Run: `node --test --experimental-strip-types --test-name-pattern="rotated externally in a keychain source|source read throws" src/credentials.test.ts 2>&1 | tail -12`
Expected: FAIL — the first asserts `'before-switch' !== 'after-switch'`; the second throws `Keychain read denied`.

- [x] **Step 3: Implement the re-read**

In `src/credentials.ts`, replace lines 326-334 (the comment block and the `if (target.source === "file")` guard) with:

```ts
// Pick up credentials replaced externally — cswap switching accounts, the
// claude CLI in another terminal, or a second OpenCode instance. This used
// to be limited to file sources on the assumption that a keychain entry is
// only ever mutated by our own writeBackCredentials; that assumption is
// false. Bounded by getCachedCredentials's 30s TTL, so it fires at most
// ~2x/min under load.
//
// A keychain read shells out to `security`, which throws when the keychain
// is locked, access is denied, or the call times out. Degrade to the
// in-memory credentials rather than take down the request path.
try {
  const stored = refreshAccount(target.source, target.configDir)
  if (stored) target.credentials = stored
} catch (err) {
  log("source_reread_failed", {
    source: target.source,
    error: err instanceof Error ? err.message : String(err),
  })
}
```

- [x] **Step 4: Run the new tests to verify they pass**

Run: `node --test --experimental-strip-types --test-name-pattern="rotated externally in a keychain source|source read throws" src/credentials.test.ts 2>&1 | tail -8`
Expected: `pass 2`, `fail 0`

- [x] **Step 5: Repair the three read-count assertions**

Run: `pnpm test 2>&1 | grep -E "^not ok|✖" | head`
Expected: three failures, at `src/credentials.test.ts` lines ~315, ~437, ~735.

`src/credentials.test.ts:315` — one extra read now happens inside `getCachedCredentials` before `__setReadError(true)`:

```ts
assert.equal(keychainModule.__getReadCount(), 2)
```

`src/credentials.test.ts:437` — the first `getCachedCredentials()` is a cache miss and now re-reads; the second is a cache hit and does not:

```ts
assert.equal(
  keychainModule.__getReadCount(),
  1,
  "cache miss re-reads the source once; the cached call does not",
)
```

`src/credentials.test.ts:729-735` (test: `fallback uses a valid in-memory account without a keychain read`) — `refreshIfNeeded` now re-reads the target's source up front, in addition to the existing post-OAuth-failure re-read. Pin the expired account's own stored value so the up-front read is a no-op rather than swapping in the other account's blob.

Immediately after that test's `credentialsModule.initAccounts([...])` call, add:

```ts
keychainModule.__setCredentialsForSource("Claude Code-credentials-aabbccdd", {
  accessToken: "stale-suffixed",
  refreshToken: "rt-suffixed",
  expiresAt: now - 1_000,
})
```

Then update the assertion:

```ts
assert.equal(
  keychainModule.__getReadCount(),
  readsBefore + 2,
  "one up-front re-read of the target's own source, one after the failed OAuth refresh",
)
```

- [x] **Step 6: Run the full suite**

Run: `pnpm test 2>&1 | tail -8`
Expected: `pass 251`, `fail 0`

- [x] **Step 7: Commit**

```bash
git add src/credentials.ts src/credentials.test.ts
git commit -m "fix: re-read keychain sources so external credential rotation is picked up"
```

---

### Task 3: Compare-and-swap on write-back

Closes the window between reading a credential and writing its refreshed replacement — seconds wide, because an OAuth round-trip sits in the middle.

**Files:**

- Modify: `src/keychain.ts:442-503`
- Modify: `src/credentials.ts:376`, `:499`, `:622-628`
- Test: `src/keychain.test.ts`

- [x] **Step 1: Write the failing tests**

Add `credentialBlobMatches` to the existing import from `./keychain.ts` at `src/keychain.test.ts:15-23`.

Add a new top-level `describe` (place it directly above `describe("writeBackCredentials (file source)"` at line 585):

```ts
describe("credentialBlobMatches", () => {
  const blob = JSON.stringify({
    claudeAiOauth: {
      accessToken: "account-a",
      refreshToken: "rt-a",
      expiresAt: 1,
    },
  })

  it("accepts a blob still holding the expected token", () => {
    assert.equal(credentialBlobMatches(blob, "account-a"), true)
  })

  it("rejects a blob replaced by another account", () => {
    assert.equal(credentialBlobMatches(blob, "account-b"), false)
  })

  it("rejects an unparseable blob rather than assuming a match", () => {
    assert.equal(credentialBlobMatches("not json", "account-a"), false)
  })
})
```

Then add this end-to-end test **inside** the existing `describe("writeBackCredentials (file source)")` block, after the test at line 599. It mirrors that test's `HOME` isolation pattern:

```ts
it("skips the write when the stored token is no longer the expected one", async () => {
  const originalHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), "opencode-claude-auth-cas-"))
  process.env.HOME = tempHome

  try {
    const claudeDir = join(tempHome, ".claude")
    mkdirSync(claudeDir, { recursive: true })
    const credPath = join(claudeDir, ".credentials.json")
    // Another process switched accounts after we read "expected-at".
    writeFileSync(
      credPath,
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "switched-in-at",
          refreshToken: "switched-in-rt",
          expiresAt: 1000,
        },
      }),
      { encoding: "utf-8", mode: 0o600 },
    )

    const result = writeBackCredentials(
      "file",
      {
        accessToken: "our-refreshed-at",
        refreshToken: "our-refreshed-rt",
        expiresAt: 2000,
      },
      undefined,
      "expected-at",
    )

    assert.equal(result, false)
    const written = JSON.parse(readFileSync(credPath, "utf-8"))
    assert.equal(
      written.claudeAiOauth.accessToken,
      "switched-in-at",
      "the switched-in credential must survive untouched",
    )
  } finally {
    if (typeof originalHome === "string") {
      process.env.HOME = originalHome
    } else {
      delete process.env.HOME
    }
  }
})
```

- [x] **Step 2: Run to verify they fail**

Run: `node --test --experimental-strip-types --test-name-pattern="credentialBlobMatches|no longer the expected one" src/keychain.test.ts 2>&1 | tail -12`
Expected: FAIL — `credentialBlobMatches is not a function`, and the skip test writes anyway (`result` is `true`).

- [x] **Step 3: Implement the guard**

In `src/keychain.ts`, add above `writeBackCredentials` (line 442):

```ts
/**
 * Whether a stored credential blob still carries the access token we expect.
 *
 * Guards write-back against an external switch landing between the read that
 * produced the token being refreshed and the write of its replacement. An
 * unparseable blob returns false: a write into state we cannot identify is
 * exactly what this is meant to prevent.
 */
export function credentialBlobMatches(
  raw: string,
  expectedAccessToken: string,
): boolean {
  const parsed = parseCredentials(raw)
  return parsed?.accessToken === expectedAccessToken
}
```

Change the signature at line 442 to:

```ts
export function writeBackCredentials(
  source: string,
  creds: ClaudeCredentials,
  configDir?: string,
  expectedPriorAccessToken?: string,
): boolean {
```

In the `source === "file"` branch, immediately after `const raw = readFileSync(credPath, "utf-8")`:

```ts
if (
  expectedPriorAccessToken !== undefined &&
  !credentialBlobMatches(raw, expectedPriorAccessToken)
) {
  log("writeback_skipped_stale", { source, configDir: dir })
  return false
}
```

In the `process.platform === "darwin"` branch, immediately after `if (!raw) return false`:

```ts
if (
  expectedPriorAccessToken !== undefined &&
  !credentialBlobMatches(raw, expectedPriorAccessToken)
) {
  log("writeback_skipped_stale", { source })
  return false
}
```

- [x] **Step 4: Run to verify they pass**

Run: `node --test --experimental-strip-types --test-name-pattern="credentialBlobMatches|no longer the expected one" src/keychain.test.ts 2>&1 | tail -8`
Expected: `pass 4`, `fail 0`

- [x] **Step 5: Pass the expected token from all three refresh call sites**

`src/credentials.ts:376` — `creds` is the pre-refresh credential captured by `performRefresh`:

```ts
writeBackCredentials(
  target.source,
  oauthCreds,
  target.configDir,
  creds.accessToken,
)
```

`src/credentials.ts:499` — inside `refreshBorrowedAccount`, `own` is this account's own stored credential:

```ts
writeBackCredentials(
  target.source,
  oauthCreds,
  target.configDir,
  own.accessToken,
)
```

`src/credentials.ts:606-628` — in `forceRefreshActiveAccount`, capture the token **before** the await, because `account.credentials` is reassigned on success:

```ts
  const priorAccessToken = account.credentials.accessToken
  const oauthCreds = await refresh(account.credentials.refreshToken)
  if (oauthCreds && oauthCreds.expiresAt > Date.now() + 60_000) {
    account.credentials = oauthCreds
    if (
      !writeBackCredentials(
        account.source,
        oauthCreds,
        account.configDir,
        priorAccessToken,
      )
    ) {
```

- [x] **Step 6: Add the write-back assertion test**

Append inside the top-level `describe` in `src/credentials.test.ts`:

```ts
it("performRefresh passes the pre-refresh token as the write-back guard", async () => {
  const originalNow = Date.now
  const now = 1_700_000_000_000
  Date.now = () => now
  const originalFetch = globalThis.fetch

  try {
    const { credentialsModule, keychainModule } =
      await loadCredentialsWithCountingKeychain(now - 60_000)

    keychainModule.__setCredentials({
      accessToken: "stale-token",
      refreshToken: "rt-stale",
      expiresAt: now - 60_000,
    })

    credentialsModule.initAccounts([
      {
        label: "Account 1",
        source: "keychain",
        credentials: {
          accessToken: "stale-token",
          refreshToken: "rt-stale",
          expiresAt: now - 60_000,
        },
      },
    ])

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          access_token: "rotated-token",
          refresh_token: "rt-rotated",
          expires_in: 36_000,
        }),
        { status: 200 },
      )) as typeof fetch

    await credentialsModule.refreshIfNeeded()

    const writes = keychainModule.__getWrites()
    assert.equal(writes.length, 1)
    assert.equal(writes[0].creds.accessToken, "rotated-token")
    assert.equal(writes[0].expectedPriorAccessToken, "stale-token")
  } finally {
    Date.now = originalNow
    globalThis.fetch = originalFetch
  }
})
```

- [x] **Step 7: Run the full suite**

Run: `pnpm test 2>&1 | tail -8`
Expected: `pass 259`, `fail 0` (later extended to 263 by review follow-ups)

- [x] **Step 8: Commit**

```bash
git add src/keychain.ts src/keychain.test.ts src/credentials.ts src/credentials.test.ts
git commit -m "fix: guard credential write-back against an external switch"
```

---

### Task 4: Bounded 401 recovery loop

**Files:**

- Modify: `src/index.ts:368-392` (401 block), `:462-464` (return), imports at `:20-31`
- Test: `src/index.test.ts:1189-1251`

- [x] **Step 1: Import the currently-dead force-refresh helper**

In the `from "./credentials.ts"` import block in `src/index.ts` (around line 20-31), add:

```ts
  forceRefreshActiveAccount,
```

- [x] **Step 2: Replace the 401 block with the recovery loop**

Replace `src/index.ts:368-392` in full:

```ts
// Recover from a rejected token: first by adopting credentials
// rotated externally (cswap switching accounts, the claude CLI,
// another OpenCode instance), then by forcing an OAuth refresh
// when the store still holds the token that was just rejected.
//
// Most cases resolve on the first attempt: a cold or unreadable
// store yields null from the reload (reloadCredentialsFromSource
// rejects anything expiring within 60s), so the force refresh runs
// immediately. The second attempt covers the narrower race where
// the reload returns a valid-looking token that a concurrent
// writer has itself just rotated again. The no-progress break is
// what actually bounds this — the cap is defence in depth.
const MAX_AUTH_RECOVERY_ATTEMPTS = 2
let tokenInUse = latest.accessToken

for (
  let attempt = 0;
  response.status === 401 && attempt < MAX_AUTH_RECOVERY_ATTEMPTS;
  attempt++
) {
  let candidate: ClaudeCredentials | null = null
  try {
    candidate = reloadCredentialsFromSource()
  } catch {}

  if (!candidate || candidate.accessToken === tokenInUse) {
    try {
      candidate = await forceRefreshActiveAccount()
    } catch {}
  }

  if (!candidate || candidate.accessToken === tokenInUse) {
    log("auth_recovery_exhausted", {
      modelId,
      attempt: attempt + 1,
    })
    break
  }

  tokenInUse = candidate.accessToken
  log("auth_recovery_retry", { modelId, attempt: attempt + 1 })
  response = await fetchWithRetry(requestUrl, {
    ...requestInit,
    body,
    headers: buildRequestHeaders(
      input,
      requestInit,
      tokenInUse,
      modelId,
      excluded,
    ),
  })
}
```

- [x] **Step 3: Derive the stream-transform decision from the final status**

Replace `src/index.ts:462-464`:

```ts
// A 401 that survived recovery carries an error body, not an SSE
// stream. Deciding here rather than from a flag set mid-flight
// makes the retried and non-retried paths behave identically.
return response.status === 401 ? response : transformResponseStream(response)
```

- [x] **Step 4: Run the suite to see the expected failure**

Run: `pnpm test 2>&1 | grep -E "^not ok|✖" | head`
Expected: **two** failures.

1. `auth fetch does not retry a 401 when the source token is unchanged` — its name describes the behavior being replaced.
2. `auth fetch preserves the original 401 when credential reload throws` — fails **only** on its request-count assertion. Its mock counts every `fetch` without discriminating the OAuth token endpoint, so the new force-refresh call inflates the count from 1 to 2. Every behavioral assertion (status, statusText, `content-type`, `x-request-id`, body) still passes, and the API is still hit exactly once. Fix by splitting the mock into `apiCalls` / `oauthCalls`, keeping all existing assertions and adding `oauthCalls === 1` — a thrown reload must still force a refresh.

The neighbouring test that recovers a 401 via an externally rotated token must still pass — the loop preserves that path. If it fails, the loop is wrong, not the test.

- [x] **Step 5: Replace that test with the two behaviors that supersede it**

Replace the whole `it(...)` block at `src/index.test.ts:1189-1251` with:

```ts
it("auth fetch force-refreshes on a 401 when the source token is unchanged", async () => {
  const originalNow = Date.now
  const originalSetInterval = globalThis.setInterval
  const originalHome = process.env.HOME
  const originalFetch = globalThis.fetch
  const tempHome = await mkdtemp(join(tmpdir(), "opencode-claude-auth-home-"))
  process.env.HOME = tempHome
  Date.now = () => 1_700_000_000_000
  globalThis.setInterval = (() => ({
    unref() {},
  })) as unknown as typeof setInterval

  let apiCalls = 0
  let oauthCalls = 0

  try {
    const { helpersModule } = await loadHelpersWithCountingKeychain(
      Date.now() + 10 * 60_000,
    )

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : String(input)
      if (url.includes("/oauth/token")) {
        oauthCalls += 1
        return new Response(
          JSON.stringify({
            access_token: "recovered-token",
            refresh_token: "rt-recovered",
            expires_in: 36_000,
          }),
          { status: 200 },
        )
      }
      apiCalls += 1
      return apiCalls === 1
        ? new Response('{"error":"expired"}', { status: 401 })
        : new Response("data: {}\n\n", { status: 200 })
    }) as typeof fetch

    const plugin = await helpersModule.default({} as never)
    const typedPlugin = plugin as { auth?: { loader?: TestAuthLoader } }
    const authConfig = await typedPlugin.auth!.loader!(
      async () => ({
        type: "oauth",
        refresh: "refresh",
        access: "access",
        expires: Date.now() + 60_000,
      }),
      { models: {} },
    )

    const response = await authConfig.fetch(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        body: JSON.stringify({ model: "claude-haiku-4-5", messages: [] }),
      },
    )

    assert.equal(response.status, 200)
    assert.equal(oauthCalls, 1, "the unchanged token must force a refresh")
    assert.equal(apiCalls, 2, "the refreshed token must be retried once")
  } finally {
    Date.now = originalNow
    globalThis.setInterval = originalSetInterval
    globalThis.fetch = originalFetch
    if (typeof originalHome === "string") {
      process.env.HOME = originalHome
    } else {
      delete process.env.HOME
    }
  }
})

it("auth fetch surfaces the 401 unchanged when recovery cannot progress", async () => {
  const originalNow = Date.now
  const originalSetInterval = globalThis.setInterval
  const originalHome = process.env.HOME
  const originalFetch = globalThis.fetch
  const tempHome = await mkdtemp(join(tmpdir(), "opencode-claude-auth-home-"))
  process.env.HOME = tempHome
  Date.now = () => 1_700_000_000_000
  globalThis.setInterval = (() => ({
    unref() {},
  })) as unknown as typeof setInterval

  let apiCalls = 0
  const errorBody = '{"name":"mcp_UnchangedToken"}'

  try {
    const { helpersModule } = await loadHelpersWithCountingKeychain(
      Date.now() + 10 * 60_000,
    )

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : String(input)
      if (url.includes("/oauth/token")) {
        // A 429 from the token endpoint must read as a failed refresh, not
        // as something that loops account recovery. retry-after beyond the
        // 30s cap makes fetchWithRetry return instead of backing off.
        return new Response('{"error":"rate_limited"}', {
          status: 429,
          headers: { "retry-after": "3600" },
        })
      }
      apiCalls += 1
      return new Response(errorBody, {
        status: 401,
        headers: { "x-request-id": "unchanged-token-401" },
      })
    }) as typeof fetch

    const plugin = await helpersModule.default({} as never)
    const typedPlugin = plugin as { auth?: { loader?: TestAuthLoader } }
    const authConfig = await typedPlugin.auth!.loader!(
      async () => ({
        type: "oauth",
        refresh: "refresh",
        access: "access",
        expires: Date.now() + 60_000,
      }),
      { models: {} },
    )

    const response = await authConfig.fetch(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        body: JSON.stringify({ model: "claude-haiku-4-5", messages: [] }),
      },
    )

    assert.equal(response.status, 401)
    assert.equal(response.headers.get("x-request-id"), "unchanged-token-401")
    assert.equal(await response.text(), errorBody)
    assert.equal(apiCalls, 1, "no retry without a different token")
  } finally {
    Date.now = originalNow
    globalThis.setInterval = originalSetInterval
    globalThis.fetch = originalFetch
    if (typeof originalHome === "string") {
      process.env.HOME = originalHome
    } else {
      delete process.env.HOME
    }
  }
})
```

- [x] **Step 6: Add the test that justifies a second attempt**

This is the only scenario where one attempt is insufficient: the reload returns a valid-looking token that a concurrent writer has itself just rotated again, so the first retry is also rejected. Append after the two tests from Step 5:

```ts
it("auth fetch makes a second recovery attempt when the first retry is also rejected", async () => {
  const originalNow = Date.now
  const originalSetInterval = globalThis.setInterval
  const originalHome = process.env.HOME
  const originalFetch = globalThis.fetch
  const tempHome = await mkdtemp(join(tmpdir(), "opencode-claude-auth-home-"))
  process.env.HOME = tempHome
  Date.now = () => 1_700_000_000_000
  globalThis.setInterval = (() => ({
    unref() {},
  })) as unknown as typeof setInterval

  let apiCalls = 0
  let oauthCalls = 0

  try {
    const { helpersModule, keychainModule } =
      await loadHelpersWithCountingKeychain(Date.now() + 10 * 60_000)

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : String(input)
      if (url.includes("/oauth/token")) {
        oauthCalls += 1
        return new Response(
          JSON.stringify({
            access_token: "second-stage-token",
            refresh_token: "rt-second-stage",
            expires_in: 36_000,
          }),
          { status: 200 },
        )
      }
      apiCalls += 1
      // Calls 1 and 2 are rejected; only the force-refreshed token works.
      return apiCalls <= 2
        ? new Response('{"error":"expired"}', { status: 401 })
        : new Response("data: {}\n\n", { status: 200 })
    }) as typeof fetch

    const plugin = await helpersModule.default({} as never)
    const typedPlugin = plugin as { auth?: { loader?: TestAuthLoader } }
    const authConfig = await typedPlugin.auth!.loader!(
      async () => ({
        type: "oauth",
        refresh: "refresh",
        access: "access",
        expires: Date.now() + 60_000,
      }),
      { models: {} },
    )

    // Attempt 1's reload finds a different, still-valid-looking token.
    keychainModule.__setCredentials({
      accessToken: "concurrently-rotated",
      refreshToken: "rt-concurrent",
      expiresAt: Date.now() + 10 * 60_000,
    })

    const response = await authConfig.fetch(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        body: JSON.stringify({ model: "claude-haiku-4-5", messages: [] }),
      },
    )

    assert.equal(response.status, 200)
    assert.equal(apiCalls, 3, "original, reload retry, force-refresh retry")
    assert.equal(oauthCalls, 1, "only the second attempt force-refreshes")
  } finally {
    Date.now = originalNow
    globalThis.setInterval = originalSetInterval
    globalThis.fetch = originalFetch
    if (typeof originalHome === "string") {
      process.env.HOME = originalHome
    } else {
      delete process.env.HOME
    }
  }
})
```

- [x] **Step 7: Run the full suite**

Run: `pnpm test 2>&1 | tail -8`
Expected: `pass 265`, `fail 0` (actual, measured — earlier tasks landed extra tests)

- [x] **Step 8: Commit**

```bash
git add src/index.ts src/index.test.ts
git commit -m "fix: recover from a rejected token by forcing an OAuth refresh"
```

---

### Task 5: Re-read the source on a 429

**Files:**

- Modify: `src/index.ts` — insert after the 401 recovery loop, before the long-context beta loop (`:396`)
- Test: `src/index.test.ts`

- [x] **Step 1: Write the failing test**

Append inside the same `describe` as Task 4's tests:

```ts
it("auth fetch retries a 429 once when the source token changed", async () => {
  const originalNow = Date.now
  const originalSetInterval = globalThis.setInterval
  const originalHome = process.env.HOME
  const originalFetch = globalThis.fetch
  const tempHome = await mkdtemp(join(tmpdir(), "opencode-claude-auth-home-"))
  process.env.HOME = tempHome
  Date.now = () => 1_700_000_000_000
  globalThis.setInterval = (() => ({
    unref() {},
  })) as unknown as typeof setInterval

  let apiCalls = 0

  try {
    const { helpersModule, keychainModule } =
      await loadHelpersWithCountingKeychain(Date.now() + 10 * 60_000)

    globalThis.fetch = (async () => {
      apiCalls += 1
      if (apiCalls === 1) {
        // retry-after beyond the 30s cap: quota exhaustion, not a
        // transient limit, so fetchWithRetry returns immediately.
        return new Response('{"error":"rate_limited"}', {
          status: 429,
          headers: { "retry-after": "3600" },
        })
      }
      return new Response("data: {}\n\n", { status: 200 })
    }) as typeof fetch

    const plugin = await helpersModule.default({} as never)
    const typedPlugin = plugin as { auth?: { loader?: TestAuthLoader } }
    const authConfig = await typedPlugin.auth!.loader!(
      async () => ({
        type: "oauth",
        refresh: "refresh",
        access: "access",
        expires: Date.now() + 60_000,
      }),
      { models: {} },
    )

    // An external switch lands while this session is still on the
    // exhausted account.
    keychainModule.__setCredentials({
      accessToken: "switched-token",
      refreshToken: "rt-switched",
      expiresAt: Date.now() + 10 * 60_000,
    })

    const response = await authConfig.fetch(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        body: JSON.stringify({ model: "claude-haiku-4-5", messages: [] }),
      },
    )

    assert.equal(response.status, 200)
    assert.equal(apiCalls, 2, "the rotated token must be retried once")
  } finally {
    Date.now = originalNow
    globalThis.setInterval = originalSetInterval
    globalThis.fetch = originalFetch
    if (typeof originalHome === "string") {
      process.env.HOME = originalHome
    } else {
      delete process.env.HOME
    }
  }
})

it("auth fetch does not retry a 429 when the source token is unchanged", async () => {
  const originalNow = Date.now
  const originalSetInterval = globalThis.setInterval
  const originalHome = process.env.HOME
  const originalFetch = globalThis.fetch
  const tempHome = await mkdtemp(join(tmpdir(), "opencode-claude-auth-home-"))
  process.env.HOME = tempHome
  Date.now = () => 1_700_000_000_000
  globalThis.setInterval = (() => ({
    unref() {},
  })) as unknown as typeof setInterval

  let apiCalls = 0

  try {
    const { helpersModule } = await loadHelpersWithCountingKeychain(
      Date.now() + 10 * 60_000,
    )

    globalThis.fetch = (async () => {
      apiCalls += 1
      return new Response('{"error":"rate_limited"}', {
        status: 429,
        headers: { "retry-after": "3600" },
      })
    }) as typeof fetch

    const plugin = await helpersModule.default({} as never)
    const typedPlugin = plugin as { auth?: { loader?: TestAuthLoader } }
    const authConfig = await typedPlugin.auth!.loader!(
      async () => ({
        type: "oauth",
        refresh: "refresh",
        access: "access",
        expires: Date.now() + 60_000,
      }),
      { models: {} },
    )

    const response = await authConfig.fetch(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        body: JSON.stringify({ model: "claude-haiku-4-5", messages: [] }),
      },
    )

    assert.equal(response.status, 429)
    assert.equal(apiCalls, 1, "an unchanged token must not be retried")
  } finally {
    Date.now = originalNow
    globalThis.setInterval = originalSetInterval
    globalThis.fetch = originalFetch
    if (typeof originalHome === "string") {
      process.env.HOME = originalHome
    } else {
      delete process.env.HOME
    }
  }
})
```

`loadHelpersWithCountingKeychain` already returns `keychainModule` with `__setCredentials` (`src/index.test.ts:264-273`), so no harness change is needed.

- [x] **Step 2: Run to verify the first fails and the second passes**

Run: `node --test --experimental-strip-types --test-name-pattern="429" src/index.test.ts 2>&1 | tail -12`
Expected: the "token changed" test FAILS with `apiCalls` 1 ≠ 2; the "unchanged" test passes (no retry exists yet).

- [x] **Step 3: Implement the 429 re-read**

Insert in `src/index.ts` directly after the 401 recovery loop from Task 4 and before the long-context beta loop:

```ts
// An external switch — cswap rotating off an exhausted account —
// leaves this session on the old token until the 30s credential
// cache expires. Re-read once so a rate limit that has already
// been resolved elsewhere is not surfaced. A changed token is the
// signal that a switch happened; when nothing changed this costs
// one source read and no retry.
if (response.status === 429) {
  let rotated: ClaudeCredentials | null = null
  try {
    rotated = reloadCredentialsFromSource()
  } catch {}

  if (rotated && rotated.accessToken !== tokenInUse) {
    log("rate_limit_credentials_rotated", { modelId })
    tokenInUse = rotated.accessToken
    response = await fetchWithRetry(requestUrl, {
      ...requestInit,
      body,
      headers: buildRequestHeaders(
        input,
        requestInit,
        tokenInUse,
        modelId,
        excluded,
      ),
    })
  }
}
```

- [x] **Step 4: Run to verify both pass**

Run: `node --test --experimental-strip-types --test-name-pattern="429" src/index.test.ts 2>&1 | tail -8`
Expected: `fail 0`

- [x] **Step 5: Run the full suite**

Run: `pnpm test 2>&1 | tail -8`
Expected: `pass 260`, `fail 0`

- [x] **Step 6: Commit**

```bash
git add src/index.ts src/index.test.ts
git commit -m "fix: re-read credentials on a 429 so a resolved rate limit is not surfaced"
```

---

### Task 6: Lint, format, and document

**Files:**

- Modify: `README.md`, `CHANGELOG.md`

- [x] **Step 1: Lint and format**

Run: `pnpm run lint:fix && pnpm run lint`
Expected: clean exit, no diagnostics.

- [x] **Step 2: Add the behavior to the README technical list**

In `README.md`, under `## How it works (technical)`, insert after the bullet beginning "Syncs credentials to `auth.json`":

```markdown
- Re-reads the credential source on each cache miss (~every 30s under load), so an account switched externally — by [claude-swap](https://github.com/realiti4/claude-swap), the `claude` CLI in another terminal, or a second OpenCode instance — is picked up in a live session without a restart
- Guards credential write-back with the token it refreshed from, so a switch landing mid-refresh can never write one account's tokens into another's slot
- On a rejected token, adopts an externally rotated credential and otherwise forces an OAuth refresh, retrying the request in place rather than surfacing the 401
```

- [x] **Step 3: Add a CHANGELOG entry**

Add under the topmost unreleased heading in `CHANGELOG.md` (create `## Unreleased` above the newest release heading if absent):

```markdown
### Bug Fixes

- Pick up credentials rotated by another process (claude-swap, the `claude` CLI, a second OpenCode instance) in a live session instead of staying pinned to the account that was active at startup
- Never write a refreshed token into a slot that was switched underneath us
- Force an OAuth refresh when a request is rejected and the store still holds the rejected token, so the request recovers in place
- Write refreshed credentials back to the account's own config directory on the force-refresh path, which previously fell back to the default directory and could write to the wrong file for a file-source account with a custom `CLAUDE_CONFIG_DIR`

### Behavior Changes

- A 401 that survives recovery is now returned without SSE stream transformation, matching what a non-retried 401 already did
```

- [x] **Step 4: Verify the full suite and a clean tree**

Run: `pnpm test 2>&1 | tail -8 && git status --short`
Expected: `fail 0`; only `README.md` and `CHANGELOG.md` modified.

- [x] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: document external credential rotation handling"
```

---

## Follow-ups (deliberately out of scope)

**The post-OAuth file-source exclusion in `performRefresh` is now unjustified.** `src/credentials.ts` re-reads the source after a failed OAuth refresh, to catch credentials a sibling instance wrote during the round trip — but skips that read for `file` sources. That guard was coherent while the up-front re-read was file-only; Task 2 removed that rationale and left nothing in its place. A sibling can write a file source mid-round-trip exactly as it can a keychain entry, a file read is cheaper than shelling out to `security`, and the block is already try/catch-wrapped, so including file sources would add no throw path.

Consequence today: a file-source account whose OAuth refresh fails goes straight to `refreshViaCli` without checking whether a sibling already wrote usable credentials — the very race the block exists to handle.

Not fixed here because it changes behavior on the file path, which no current test covers, and it is outside the guard replacement this feature specified. The comment at the guard says so plainly rather than implying the asymmetry is principled.

**`performRefresh` discards `writeBackCredentials`'s return value.** A failed write-back is therefore invisible: memory holds freshly refreshed credentials while the store keeps the pre-refresh blob. On the proactive path that orphaned blob can still have ~1h left, so the validated re-read reads it as usable and adopts it, clobbering the fresh credentials and wasting background OAuth attempts until it drops under 60s.

This cannot be fixed at the re-read — it cannot distinguish "the store is stale because our write failed" from "the store changed because cswap switched"; both look like _store disagrees with memory, store is usable_. The information exists only at the write-back call site. `forceRefreshActiveAccount` already models the fix, checking the return and logging `force_refresh_writeback_failed`; `performRefresh` does neither. Pre-existing, not introduced by this feature.

Partially closed in review: `performRefresh` now checks the return and logs `refresh_writeback_failed`, so the failure is no longer invisible. The remaining half — not re-adopting an orphaned-but-still-usable blob on the proactive path — is a control-flow change that interacts with the adoption logic this feature introduced, and stays deferred.

**`transformResponseStream` is applied to non-401 error responses.** Task 4 scopes the bypass to 401 only, matching the prior behavior for that status. But 4xx and 5xx responses other than 401 still flow through the SSE transform, which strips tool-name prefixes from the body. The transform's `!ok` branch already passes status and headers through intact, so the practical difference for a 401 is only that prefix stripping — the carve-out is narrower than "the transform mangles errors". Still asymmetric: the comment's rationale ("carries an error body, not an SSE stream") applies equally to 400/429/500, which do go through it. Pre-existing and unchanged by this feature. Worth deciding whether the bypass should cover all `!ok` statuses rather than 401 alone.

**~~`configDir` is honored on one re-read path but not the others.~~ Closed in review.** `refreshIfNeeded` passed `target.configDir` to `refreshAccount`; `reloadCredentialsFromSource` and `reloadActiveAccount` did not. Never reachable — every file account is assigned `CLAUDE_CONFIG_DIR ?? ~/.claude`, exactly what `readCredentialsFile` recomputes by default — but the compare-and-swap guard makes the read and the write agreeing on one file load-bearing, so both paths now forward it by construction rather than by coincidence. Pinned by a test per path.

**`reloadActiveAccount` and `invalidateCredentialCache` are still dead.** Both docstrings claimed to be "used on 401"; `reloadActiveAccount`'s now records that it has no call sites, `invalidateCredentialCache`'s is still wrong. The 401 path uses `reloadCredentialsFromSource` instead. This feature revived the third of the three dead functions the design doc identified and left these two behind. Either wire them up or delete them.

**No negative caching of a terminal auth failure.** On a server-side-revoked credential the store keeps returning a locally-unexpired token, so every request pays the full recovery loop — three API calls plus an OAuth exchange plus `security` spawns — indefinitely, where before it paid one request. Worst-case cost per `fetch()` is now roughly 18 Anthropic requests and several minutes of capped backoff, bounded by the caller's abort signal but with no deadline of the plugin's own.

**The log redactor protects structured fields only.** `logger.ts` redacts by key name or an anchored `^eyJ` whole-value match, so a token embedded mid-string in an `err.message` would pass through. Unreachable today — every callee either catches internally or throws fixed strings — but two new sites log `err.message`.

**Narrow in-memory orphaned-rotation race.** If the proactive timer's refresh is in flight while a request-path re-read adopts an externally written blob, the timer's OAuth result overwrites `target.credentials` while its write-back guard correctly refuses. Both tokens are usable so nothing breaks, but a rotation is consumed and stored nowhere. Requires an external write inside a 15s OAuth round trip plus two concurrent callers. The store-side variant is covered above; this in-memory one is distinct.

## Manual verification

Automated tests stub the Keychain. Verify against real cswap state once:

- [ ] Confirm at least two cswap accounts and note the active one: `cswap list`
- [ ] Start OpenCode and send a prompt so credentials are cached
- [ ] Switch in another terminal: `cswap switch`
- [ ] Wait 30s, send another prompt in the **same** OpenCode session
- [ ] With `CLAUDE_AUTH_DEBUG=1`, confirm `~/.local/share/opencode/claude-auth-debug.log` shows the new account's token and no `writeback_skipped_stale` storm
- [ ] Confirm `cswap list` still shows both accounts healthy — no slot quarantined for a dead refresh token
