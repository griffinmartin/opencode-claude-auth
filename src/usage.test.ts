import assert from "node:assert/strict"
import { describe, it, beforeEach, afterEach } from "node:test"
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir, homedir } from "node:os"
import {
  getUsageStatePaths,
  parseUsageHeaders,
  recordUsageFromHeaders,
  resetUsageWriteCache,
  writeUsageSnapshot,
  type UsageSnapshot,
} from "./usage.ts"

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

/** A response carrying the full unified rate-limit family. */
function quotaHeaders(overrides: Record<string, string> = {}): Headers {
  return new Headers({
    "anthropic-ratelimit-unified-status": "allowed",
    "anthropic-ratelimit-unified-representative-claim": "five_hour",
    "anthropic-ratelimit-unified-5h-utilization": "0.26",
    "anthropic-ratelimit-unified-5h-reset": "1775455200",
    "anthropic-ratelimit-unified-7d-utilization": "0.19",
    "anthropic-ratelimit-unified-7d-reset": "1775973600",
    ...overrides,
  })
}

describe("parseUsageHeaders", () => {
  it("reads both windows as fractions with epoch-second resets", () => {
    const snapshot = parseUsageHeaders(quotaHeaders())

    assert.ok(snapshot)
    assert.equal(snapshot.status, "allowed")
    assert.equal(snapshot.representativeClaim, "five_hour")
    assert.deepEqual(snapshot.fiveHour, {
      utilization: 0.26,
      resetsAt: 1775455200,
    })
    assert.deepEqual(snapshot.sevenDay, {
      utilization: 0.19,
      resetsAt: 1775973600,
    })
  })

  it("returns null when the response carries no quota headers", () => {
    // count_tokens calls and request-validation errors come back without the
    // family. Returning a blank snapshot would blank out a good reading.
    const snapshot = parseUsageHeaders(
      new Headers({ "content-type": "application/json" }),
    )

    assert.equal(snapshot, null)
  })

  it("keeps a window whose reset header is absent", () => {
    const headers = quotaHeaders()
    headers.delete("anthropic-ratelimit-unified-5h-reset")

    const snapshot = parseUsageHeaders(headers)

    assert.deepEqual(snapshot?.fiveHour, { utilization: 0.26, resetsAt: null })
  })

  it("reports a rejection, which is what a spent quota looks like", () => {
    const snapshot = parseUsageHeaders(
      quotaHeaders({
        "anthropic-ratelimit-unified-status": "rejected",
        "anthropic-ratelimit-unified-5h-utilization": "1",
      }),
    )

    assert.equal(snapshot?.status, "rejected")
    assert.equal(snapshot?.fiveHour?.utilization, 1)
  })

  it("survives a status header with no windows at all", () => {
    const snapshot = parseUsageHeaders(
      new Headers({ "anthropic-ratelimit-unified-status": "allowed" }),
    )

    assert.ok(snapshot)
    assert.equal(snapshot.fiveHour, null)
    assert.equal(snapshot.sevenDay, null)
  })

  it("ignores a non-numeric utilization rather than emitting NaN", () => {
    const snapshot = parseUsageHeaders(
      quotaHeaders({ "anthropic-ratelimit-unified-5h-utilization": "n/a" }),
    )

    assert.equal(snapshot?.fiveHour, null)
    assert.ok(snapshot?.sevenDay)
  })

  it("captures the overage pool when present", () => {
    const snapshot = parseUsageHeaders(
      quotaHeaders({
        "anthropic-ratelimit-unified-overage-status": "rejected",
        "anthropic-ratelimit-unified-overage-disabled-reason":
          "org_level_disabled",
      }),
    )

    assert.equal(snapshot?.overage?.status, "rejected")
    assert.equal(snapshot?.overage?.disabledReason, "org_level_disabled")
  })

  it("omits the overage pool when the account has none", () => {
    assert.equal(parseUsageHeaders(quotaHeaders())?.overage, null)
  })
})

describe("getUsageStatePaths", () => {
  it("covers every root OpenCode may have been installed under", () => {
    const paths = getUsageStatePaths()

    assert.ok(paths.length >= 1)
    assert.ok(paths.every((path) => path.endsWith("claude-usage.json")))
    assert.ok(
      paths.includes(
        join(homedir(), ".local", "share", "opencode", "claude-usage.json"),
      ),
    )
    if (process.platform === "win32") {
      // Different Windows install methods read different roots, and the TUI
      // that consumes this has no say in which one it got.
      assert.equal(paths.length, 2)
    }
  })
})

describe("writeUsageSnapshot", () => {
  let tmpDir: string
  let originalUserProfile: string | undefined
  let originalHome: string | undefined
  let originalLocalAppData: string | undefined

  const snapshot: UsageSnapshot = {
    updatedAt: 1,
    status: "allowed",
    representativeClaim: "five_hour",
    fiveHour: { utilization: 0.26, resetsAt: 1775455200 },
    sevenDay: { utilization: 0.19, resetsAt: 1775973600 },
    overage: null,
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "claude-auth-usage-test-"))
    originalUserProfile = process.env.USERPROFILE
    originalHome = process.env.HOME
    originalLocalAppData = process.env.LOCALAPPDATA
    // homedir() reads USERPROFILE on Windows and HOME elsewhere, so both have
    // to move or this suite writes to the developer's real state file.
    process.env.USERPROFILE = tmpDir
    process.env.HOME = tmpDir
    process.env.LOCALAPPDATA = join(tmpDir, "AppData", "Local")
    resetUsageWriteCache()
  })

  afterEach(() => {
    restore("USERPROFILE", originalUserProfile)
    restore("HOME", originalHome)
    restore("LOCALAPPDATA", originalLocalAppData)
    rmSync(tmpDir, { recursive: true, force: true })
    resetUsageWriteCache()
  })

  it("creates the directory and writes readable JSON", () => {
    writeUsageSnapshot(snapshot)

    const written = getUsageStatePaths().filter((path) => existsSync(path))
    assert.ok(written.length > 0, "expected at least one snapshot on disk")
    for (const path of written) {
      assert.deepEqual(JSON.parse(readFileSync(path, "utf-8")), snapshot)
    }
  })

  it("leaves no .tmp file behind, so a reader never sees a torn write", () => {
    writeUsageSnapshot(snapshot)

    for (const path of getUsageStatePaths()) {
      assert.ok(!existsSync(`${path}.tmp`))
    }
  })

  it("skips a write when only updatedAt differs", () => {
    writeUsageSnapshot(snapshot)
    const path = getUsageStatePaths().find((candidate) => existsSync(candidate))
    assert.ok(path)
    const first = readFileSync(path, "utf-8")

    // updatedAt changes on every single response; deduplicating on it would
    // defeat the check entirely and rewrite both files continuously.
    writeUsageSnapshot({ ...snapshot, updatedAt: 999 })

    assert.equal(readFileSync(path, "utf-8"), first)
  })

  it("writes again once a reading actually changes", () => {
    writeUsageSnapshot(snapshot)
    writeUsageSnapshot({
      ...snapshot,
      updatedAt: 999,
      fiveHour: { utilization: 0.5, resetsAt: 1775455200 },
    })

    const path = getUsageStatePaths().find((candidate) => existsSync(candidate))
    assert.ok(path)
    const stored = JSON.parse(readFileSync(path, "utf-8")) as UsageSnapshot
    assert.equal(stored.fiveHour?.utilization, 0.5)
  })

  it("recordUsageFromHeaders persists a parsed response", () => {
    recordUsageFromHeaders(quotaHeaders())

    const path = getUsageStatePaths().find((candidate) => existsSync(candidate))
    assert.ok(path)
    const stored = JSON.parse(readFileSync(path, "utf-8")) as UsageSnapshot
    assert.equal(stored.fiveHour?.utilization, 0.26)
  })

  it("recordUsageFromHeaders writes nothing for a quota-less response", () => {
    recordUsageFromHeaders(new Headers({ "content-type": "application/json" }))

    assert.ok(getUsageStatePaths().every((path) => !existsSync(path)))
  })
})
