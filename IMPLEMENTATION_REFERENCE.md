# Implementation Reference: Proactive Token Refresh

> This file documents the correct implementation pattern for the proactive
> token refresh fix (PR #238). It references the working solution from
> `opencode-anthropic-dark-auth` (our independent plugin).

## What griffinmartin flagged in PR #238

1. **No refresh in (60s, 1h) window** — `getCachedCredentials()` → `refreshIfNeeded()`
   early-returns when `expiresAt > now + 60_000` (credentials.ts:287).
   The 1-hour threshold check is never actually used for triggering a refresh.

2. **Wrong account** — `accounts[0]` vs `getActiveAccount()`. Stale after
   `refreshAccountsList()` replaces the module-level list.

3. **Warn spam** — failure path warns every 5 minutes forever.

4. **No tests** — timer callback not exercised with near-expiry fixtures.

---

## Correct pattern (from opencode-anthropic-dark-auth/src/)

### accounts.ts — parametrize the threshold in `refreshIfNeeded`

```ts
/**
 * Refresh credentials if needed (proactive or reactive).
 * @param account   - account to refresh
 * @param force     - skip threshold check (e.g., after a 401)
 */
export async function refreshIfNeeded(
  account: Account,
  force = false
): Promise<OAuthCredentials | null> {
  const now = Date.now()
  const expiresIn = account.credentials.expiresAt - now

  // Use the configured threshold so callers can pass a proactive window
  const shouldRefresh = force || expiresIn < config.proactiveRefreshThresholdMs

  if (!shouldRefresh) {
    return account.credentials   // ← early-return only when truly fresh
  }

  const refreshed = await refreshToken(account.credentials.refreshToken)
  if (!refreshed) return null

  account.credentials = refreshed
  return refreshed
}
```

Key difference vs PR #238: `shouldRefresh` uses the caller's threshold,
not the hardcoded 60s. So calling `refreshIfNeeded(account, false)` with
`proactiveRefreshThresholdMs = 3_600_000` actually refreshes 1h early.

### index.ts — timer uses `getActiveAccount()` + no warn spam

```ts
const PROACTIVE_REFRESH_INTERVAL   = 5 * 60 * 1000   // 5 min
const PROACTIVE_REFRESH_THRESHOLD  = 60 * 60 * 1000  // 1 hour

// One-shot warn latch — avoids spamming every 5 minutes
let proactiveRefreshFailWarned = false

const refreshTimer = setInterval(async () => {
  try {
    const current = getActiveAccount()    // ← not accounts[0]
    if (!current) return

    const expiresIn = current.credentials.expiresAt != null
      ? current.credentials.expiresAt - Date.now()
      : Infinity                          // ← handles expiresAt === 0

    if (expiresIn < PROACTIVE_REFRESH_THRESHOLD) {
      log("proactive_refresh_triggered", { expiresInMs: expiresIn })

      const refreshed = await refreshIfNeeded(current, false)  // threshold handles it
      if (refreshed) {
        syncAuthJson(refreshed)
        log("proactive_refresh_success", {})
        proactiveRefreshFailWarned = false  // reset latch on success
      } else if (!proactiveRefreshFailWarned) {
        console.warn(
          "opencode-claude-auth: Proactive token refresh failed. Run `claude` to re-authenticate.",
        )
        proactiveRefreshFailWarned = true   // ← only warn once
      }
    } else {
      const creds = getCredentialsForSync()
      if (creds) syncAuthJson(creds)
    }
  } catch {
    // Non-fatal: timer keeps running
  }
}, PROACTIVE_REFRESH_INTERVAL)
refreshTimer.unref()
```

### index.test.ts — test the timer callback

```ts
it("proactively refreshes when token expires within threshold", async () => {
  const nearExpiry = Date.now() + 30 * 60 * 1000  // 30 min from now

  vi.mocked(getActiveAccount).mockReturnValue({
    credentials: { expiresAt: nearExpiry, refreshToken: "rt", accessToken: "at" },
  })
  vi.mocked(refreshIfNeeded).mockResolvedValue({
    expiresAt: Date.now() + 10 * 60 * 60 * 1000,
    refreshToken: "rt2",
    accessToken: "at2",
  })

  // Advance timer by one tick
  await vi.advanceTimersByTimeAsync(PROACTIVE_REFRESH_INTERVAL)

  expect(refreshIfNeeded).toHaveBeenCalledWith(expect.objectContaining({
    credentials: expect.objectContaining({ expiresAt: nearExpiry }),
  }), false)
  expect(syncAuthJson).toHaveBeenCalled()
})

it("does not refresh when token is still fresh", async () => {
  vi.mocked(getActiveAccount).mockReturnValue({
    credentials: { expiresAt: Date.now() + 3 * 60 * 60 * 1000 },  // 3h away
  })

  await vi.advanceTimersByTimeAsync(PROACTIVE_REFRESH_INTERVAL)

  expect(refreshIfNeeded).not.toHaveBeenCalled()
  expect(getCredentialsForSync).toHaveBeenCalled()
})
```

---

## Summary of changes needed for PR #238

| Archivo | Cambio |
|---|---|
| `src/credentials.ts` | `refreshIfNeeded(account, thresholdMs = 60_000)` — acepta threshold dinámico |
| `src/index.ts` | Usar `getActiveAccount()`, warn latcheado, `expiresAt != null` |
| `src/index.test.ts` | 2 tests del timer: near-expiry (refresh) + fresh (no-op) |

Reference implementation: `github.com/JDis03/opencode-anthropic-dark-auth`
