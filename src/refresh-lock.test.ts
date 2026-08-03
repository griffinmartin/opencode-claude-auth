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
