import { describe, it, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readdirSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { acquireRefreshLock } from "./refresh-lock.ts"

const SRC = "Claude Code-credentials"

describe("refresh-lock", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "opencode-claude-auth-lock-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("grants the lock to the first caller and denies a second holder", () => {
    const first = acquireRefreshLock(SRC, { dir })
    assert.ok(first, "first caller acquires the lock")
    const second = acquireRefreshLock(SRC, { dir })
    assert.equal(second, null, "a live holder blocks a second acquirer")
    first!.release()
  })

  it("releases the lock so a later caller can acquire it", () => {
    const first = acquireRefreshLock(SRC, { dir })
    assert.ok(first)
    first!.release()
    const second = acquireRefreshLock(SRC, { dir })
    assert.ok(second, "the lock is available again after release")
    second!.release()
  })

  it("takes over a stale lock past its TTL", () => {
    const held = acquireRefreshLock(SRC, { dir, ttlMs: 20_000 })
    assert.ok(held)
    // The holder "crashes" without releasing; the lock file lingers. A later
    // acquirer looking from far enough in the future treats it as stale.
    const future = Date.now() + 60_000
    const takeover = acquireRefreshLock(SRC, {
      dir,
      ttlMs: 20_000,
      now: () => future,
    })
    assert.ok(takeover, "a stale lock is taken over")
    takeover!.release()
  })

  it("does not take over a lock that is still within its TTL", () => {
    const held = acquireRefreshLock(SRC, { dir, ttlMs: 60_000 })
    assert.ok(held)
    const soon = Date.now() + 1_000
    const denied = acquireRefreshLock(SRC, {
      dir,
      ttlMs: 60_000,
      now: () => soon,
    })
    assert.equal(denied, null, "a fresh lock is respected")
    held!.release()
  })

  it("keeps locks for different sources independent", () => {
    const a = acquireRefreshLock("source-a", { dir })
    const b = acquireRefreshLock("source-b", { dir })
    assert.ok(a, "source-a acquires")
    assert.ok(b, "source-b acquires independently")
    a!.release()
    b!.release()
  })

  it("removes the lock file on release", () => {
    const lock = acquireRefreshLock(SRC, { dir })
    assert.ok(lock)
    assert.equal(readdirSync(dir).length, 1, "a lock file exists while held")
    lock!.release()
    assert.equal(
      readdirSync(dir).filter((f) => f.endsWith(".lock")).length,
      0,
      "the lock file is removed on release",
    )
  })

  it("does not delete a lock that was taken over while it was held", () => {
    // The cascade this guards: a holder whose work outlives the TTL gets its
    // lock taken over, then releases and deletes the *new* holder's file,
    // leaving the lock free for everyone at once.
    const stalled = acquireRefreshLock(SRC, { dir, ttlMs: 20_000 })
    assert.ok(stalled)

    const takeover = acquireRefreshLock(SRC, {
      dir,
      ttlMs: 20_000,
      now: () => Date.now() + 60_000,
    })
    assert.ok(takeover, "the stalled holder's lock is taken over")

    stalled!.release()

    assert.equal(
      readdirSync(dir).filter((f) => f.endsWith(".lock")).length,
      1,
      "the new holder's lock survives the previous holder's release",
    )
    assert.equal(
      acquireRefreshLock(SRC, { dir, ttlMs: 20_000 }),
      null,
      "and it still excludes a third acquirer",
    )
    takeover!.release()
  })

  it("extends its lease so long work is not mistaken for a crash", () => {
    // The refresh path can fall back to the `claude` CLI, which runs far
    // longer than the base TTL. Extending must hold off takeover for the
    // whole extended window, since execSync blocks the event loop and no
    // heartbeat timer can fire during it.
    const held = acquireRefreshLock(SRC, { dir, ttlMs: 20_000 })
    assert.ok(held)
    held!.extend(150_000)

    const during = acquireRefreshLock(SRC, {
      dir,
      ttlMs: 20_000,
      now: () => Date.now() + 60_000,
    })
    assert.equal(during, null, "an extended lease is respected past the TTL")

    const after = acquireRefreshLock(SRC, {
      dir,
      ttlMs: 20_000,
      now: () => Date.now() + 200_000,
    })
    assert.ok(after, "but it still ages out once the extension elapses")
    after!.release()
  })

  it("ages out a lock written without a lease (older plugin version)", () => {
    // Back-compat: a lock file from a version that wrote no expiry must still
    // be reclaimable, or one stale file wedges refreshes permanently.
    const path = join(dir, readdirSync(dir)[0] ?? "")
    const held = acquireRefreshLock(SRC, { dir })
    assert.ok(held)
    const lockFile = join(
      dir,
      readdirSync(dir).find((f) => f.endsWith(".lock"))!,
    )
    writeFileSync(lockFile, JSON.stringify({ pid: 1, ts: Date.now() }))
    void path

    const takeover = acquireRefreshLock(SRC, {
      dir,
      ttlMs: 20_000,
      now: () => Date.now() + 60_000,
    })
    assert.ok(takeover, "a lease-less lock falls back to mtime staleness")
    takeover!.release()
  })

  it("treats an unreadable lease as stale rather than wedging", () => {
    const held = acquireRefreshLock(SRC, { dir })
    assert.ok(held)
    const lockFile = join(
      dir,
      readdirSync(dir).find((f) => f.endsWith(".lock"))!,
    )
    writeFileSync(lockFile, "{ not json")

    const takeover = acquireRefreshLock(SRC, {
      dir,
      ttlMs: 20_000,
      now: () => Date.now() + 60_000,
    })
    assert.ok(takeover, "a corrupt lock never blocks refreshes forever")
    takeover!.release()
  })

  it("degrades to best-effort (grants) when the lock dir is unusable", () => {
    // Point at a path whose parent is a file, so mkdir/open cannot create the
    // lock. The lock must never block a refresh — it grants a no-op handle.
    const filePath = join(dir, "not-a-dir")
    // create a regular file, then use a path underneath it as the lock dir
    writeFileSync(filePath, "x")
    const lock = acquireRefreshLock(SRC, { dir: join(filePath, "sub") })
    assert.ok(lock, "an unusable lock dir degrades to a granted no-op lock")
    lock!.release()
    assert.ok(!existsSync(join(filePath, "sub")))
  })
})
