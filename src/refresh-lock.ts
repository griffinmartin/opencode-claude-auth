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
import { createHash, randomUUID } from "node:crypto"
import { log } from "./logger.ts"

/** How long before a held lock is considered stale (env-overridable). */
export const DEFAULT_LOCK_TTL_MS = (() => {
  const raw = process.env.OPENCODE_CLAUDE_AUTH_REFRESH_LOCK_TTL_MS
  const parsed = raw ? Number.parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 20_000
})()

export interface RefreshLock {
  /**
   * Hold the lock for `ms` from now instead of the base TTL.
   *
   * The refresh path can fall back to the `claude` CLI, which runs for far
   * longer than the base TTL and does so inside `execSync` — blocking the event
   * loop, so no heartbeat timer can fire. The lease therefore has to be
   * declared up front rather than renewed as the work proceeds.
   */
  extend(ms: number): void
  release(): void
}

interface LockPayload {
  pid: number
  ts: number
  /** Identifies this acquisition, so a release cannot delete a successor. */
  owner?: string
  /** Absolute time this lease expires. Absent in locks from older versions. */
  expiresAt?: number
}

function readPayload(path: string): LockPayload | null {
  try {
    const raw = readFileSync(path, "utf-8")
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === "object" ? (parsed as LockPayload) : null
  } catch {
    // Missing, unreadable, or malformed. Callers fall back to mtime.
    return null
  }
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
 * How close to its own expiry a lease may be and still delete its lock file.
 * Guards against the lease lapsing between the ownership check and the unlink.
 */
const RELEASE_SAFETY_MARGIN_MS = 1_000

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
      // Someone holds it. Take over only if its lease has run out.
      let stale = false
      try {
        const lease = readPayload(path)?.expiresAt
        stale =
          typeof lease === "number" && Number.isFinite(lease)
            ? now() > lease
            : // Written by a version that declared no lease, or unreadable.
              // Fall back to mtime so one such file cannot wedge refreshes.
              now() - statSync(path).mtimeMs > ttlMs
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

    const owner = randomUUID()
    let leaseExpiresAt = now() + ttlMs
    const writeLease = (expiresAt: number) => {
      leaseExpiresAt = expiresAt
      try {
        ftruncateSync(fd, 0)
        writeSync(
          fd,
          JSON.stringify({ pid: process.pid, ts: now(), owner, expiresAt }),
          0,
        )
      } catch {
        // The lock is held regardless of whether the payload wrote. A lease
        // that never landed degrades to mtime staleness, which is the old
        // behaviour rather than a new failure.
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
        // Deleting a successor's lock would free it for every waiting instance
        // at once — the exact stampede the lock exists to prevent. Two guards,
        // because reading the owner and unlinking cannot be made atomic:
        //
        // A successor can only exist once this lease has expired, so an
        // expired holder does not touch the path at all. That is what closes
        // the window between the read and the unlink, which an ownership check
        // alone leaves open. The margin covers a lease that lapses during the
        // release itself. An abandoned file ages out by its own lease, so
        // refusing to delete wedges nothing.
        if (now() > leaseExpiresAt - RELEASE_SAFETY_MARGIN_MS) {
          log("refresh_lock_release_skipped", {
            source,
            reason: "lease_lapsed",
          })
          return
        }
        // Belt and braces for the case the lease says we are fine but the file
        // has already been replaced — a clock jump, or a takeover by a peer
        // reading a different lease than the one we wrote.
        const current = readPayload(path)
        if (current && current.owner !== undefined && current.owner !== owner) {
          log("refresh_lock_release_skipped", { source, reason: "taken_over" })
          return
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
