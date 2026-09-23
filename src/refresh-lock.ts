/**
 * Best-effort cross-process single-flight lock for OAuth token refreshes.
 *
 * The plugin runs inside every OpenCode process, so several instances (plus the
 * `claude` CLI) can all decide to refresh the same expired token at once and
 * bury the endpoint in duplicate requests — the token endpoint answers the pile
 * with HTTP 429. An advisory lock file lets exactly one refresher proceed; the
 * others wait briefly and adopt the winner's freshly written token from the
 * shared credential store.
 *
 * "Best-effort" is deliberate: any filesystem error degrades to running the
 * refresh without a lock rather than blocking it. A crashed holder cannot
 * wedge the system either — the lock carries a TTL and a stale one is taken
 * over.
 */
import {
  closeSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import { log } from "./logger.ts"

/** How long before a held lock is considered stale (env-overridable). */
export const DEFAULT_LOCK_TTL_MS = (() => {
  const raw = process.env.OPENCODE_CLAUDE_AUTH_REFRESH_LOCK_TTL_MS
  const parsed = raw ? Number.parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 20_000
})()

export interface RefreshLock {
  /**
   * Extend the lease before an operation that outlives the base TTL. Siblings
   * honour the recorded expiry, so a holder doing long work is not mistaken
   * for a crashed one and taken over mid-refresh.
   */
  extend(ms: number): void
  release(): void
}

export interface AcquireOptions {
  /** Directory to hold lock files in. Defaults to the OpenCode data dir. */
  dir?: string
  /** Staleness threshold in ms. Defaults to {@link DEFAULT_LOCK_TTL_MS}. */
  ttlMs?: number
  now?: () => number
}

function defaultLockDir(): string {
  // Read at call time so tests (and unusual deployments) can redirect the lock
  // directory without reloading the module.
  return (
    process.env.OPENCODE_CLAUDE_AUTH_REFRESH_LOCK_DIR ??
    join(homedir(), ".local", "share", "opencode")
  )
}

function lockPathFor(source: string, dir: string): string {
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 16)
  return join(dir, `claude-auth-refresh-${digest}.lock`)
}

const NOOP_LOCK: RefreshLock = { extend() {}, release() {} }

/**
 * Expiry recorded by the holder, or null when the file predates leases or
 * cannot be read — those fall back to the mtime comparison.
 */
function readLease(path: string): number | null {
  try {
    const { expiresAt } = JSON.parse(readFileSync(path, "utf8")) as {
      expiresAt?: unknown
    }
    return typeof expiresAt === "number" && Number.isFinite(expiresAt)
      ? expiresAt
      : null
  } catch {
    return null
  }
}

/**
 * Try to acquire the refresh lock for `source`.
 *
 * Returns a {@link RefreshLock} when this process may refresh (either it won the
 * lock, or a filesystem error made the lock unavailable and we degrade to
 * best-effort). Returns null when a live holder currently owns it — the caller
 * should wait and adopt the holder's result instead of refreshing.
 */
export function acquireRefreshLock(
  source: string,
  opts: AcquireOptions = {},
): RefreshLock | null {
  const dir = opts.dir ?? defaultLockDir()
  const ttlMs = opts.ttlMs ?? DEFAULT_LOCK_TTL_MS
  const now = opts.now ?? Date.now
  const path = lockPathFor(source, dir)

  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // Non-fatal: openSync below will surface a real problem.
  }

  // Two attempts: the second only runs after clearing a stale lock.
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number
    try {
      fd = openSync(path, "wx")
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== "EEXIST") {
        // Unexpected FS failure — never let the lock block a refresh.
        log("refresh_lock_error", { source, error: String(code ?? err) })
        return NOOP_LOCK
      }
      // Someone holds it. Take over only if it is stale.
      let stale = false
      try {
        const lease = readLease(path)
        stale =
          lease === null
            ? now() - statSync(path).mtimeMs > ttlMs
            : now() > lease
      } catch {
        // Vanished between open and stat — retry the acquire.
        stale = true
      }
      if (stale) {
        log("refresh_lock_stale_takeover", { source })
        try {
          unlinkSync(path)
        } catch {
          // Lost the race to remove it; the next attempt/stat settles it.
        }
        continue
      }
      return null
    }

    const writeLease = (expiresAt: number) => {
      try {
        ftruncateSync(fd, 0)
        writeSync(
          fd,
          JSON.stringify({ pid: process.pid, ts: now(), expiresAt }),
          0,
        )
      } catch {
        // The lock is held regardless of whether the payload wrote.
      }
    }

    writeLease(now() + ttlMs)
    log("refresh_lock_acquired", { source })
    return {
      extend(ms: number) {
        writeLease(now() + ms)
        log("refresh_lock_extended", { source, ms })
      },
      release() {
        try {
          closeSync(fd)
        } catch {
          // already closed
        }
        try {
          unlinkSync(path)
        } catch {
          // already gone (e.g. a stale-takeover removed it)
        }
      },
    }
  }

  return null
}
