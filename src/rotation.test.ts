import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ClaudeAccount } from "./keychain.ts"
import {
  activeCooldowns,
  clearCooldown,
  cooldownFromResponse,
  formatRemaining,
  getCooldownUntil,
  getRotationConfig,
  isCoolingDown,
  markRateLimited,
  orderAccounts,
  pickInitialAccount,
  pickNextAccount,
  readRotationState,
} from "./rotation.ts"

const NOW = 1_700_000_000_000

function isolateState(): void {
  process.env.OPENCODE_CLAUDE_AUTH_ROTATION_FILE = join(
    mkdtempSync(join(tmpdir(), "claude-auth-rotation-")),
    "rotation.json",
  )
  delete process.env.OPENCODE_CLAUDE_AUTH_ROTATE
  delete process.env.OPENCODE_CLAUDE_AUTH_ACCOUNT_ORDER
  delete process.env.OPENCODE_CLAUDE_AUTH_ROTATE_COOLDOWN_MS
  delete process.env.OPENCODE_CLAUDE_AUTH_ROTATE_MAX_COOLDOWN_MS
  delete process.env.OPENCODE_CLAUDE_AUTH_ROTATE_MAX_SWITCHES
}

function account(source: string): ClaudeAccount {
  return {
    label: source,
    source,
    credentials: {
      accessToken: `access-${source}`,
      refreshToken: `refresh-${source}`,
      expiresAt: NOW + 3_600_000,
    },
  }
}

const A = account("acct-a")
const B = account("acct-b")
const C = account("acct-c")

describe("getRotationConfig", () => {
  beforeEach(isolateState)

  it("is enabled by default", () => {
    assert.equal(getRotationConfig().enabled, true)
  })

  it("is disabled only by an explicit 0", () => {
    process.env.OPENCODE_CLAUDE_AUTH_ROTATE = "0"
    assert.equal(getRotationConfig().enabled, false)
  })

  it("reads overrides from the environment", () => {
    process.env.OPENCODE_CLAUDE_AUTH_ROTATE_COOLDOWN_MS = "5000"
    process.env.OPENCODE_CLAUDE_AUTH_ROTATE_MAX_SWITCHES = "7"
    process.env.OPENCODE_CLAUDE_AUTH_ACCOUNT_ORDER = "acct-b, acct-a"
    const config = getRotationConfig()
    assert.equal(config.defaultCooldownMs, 5000)
    assert.equal(config.maxSwitchesPerRequest, 7)
    assert.deepEqual(config.order, ["acct-b", "acct-a"])
  })

  it("ignores a non-numeric override rather than producing NaN", () => {
    process.env.OPENCODE_CLAUDE_AUTH_ROTATE_COOLDOWN_MS = "soon"
    assert.equal(getRotationConfig().defaultCooldownMs, 60_000)
  })
})

describe("cooldownFromResponse", () => {
  beforeEach(isolateState)

  const config = () => getRotationConfig()

  it("uses retry-after seconds when present", () => {
    const headers = new Headers({ "retry-after": "120" })
    const result = cooldownFromResponse(headers, undefined, config(), NOW)
    assert.equal(result.ms, 120_000)
    assert.equal(result.reason, "retry-after")
  })

  it("accepts retry-after as an HTTP date", () => {
    const when = new Date(NOW + 90_000).toUTCString()
    const result = cooldownFromResponse(
      new Headers({ "retry-after": when }),
      undefined,
      config(),
      NOW,
    )
    // Whole-second precision in the header format.
    assert.ok(Math.abs(result.ms - 90_000) < 1_000)
    assert.equal(result.reason, "retry-after-date")
  })

  it("falls back to the unified reset header", () => {
    const result = cooldownFromResponse(
      new Headers({
        "anthropic-ratelimit-unified-reset": String((NOW + 300_000) / 1000),
      }),
      undefined,
      config(),
      NOW,
    )
    assert.equal(result.ms, 300_000)
    assert.equal(result.reason, "anthropic-ratelimit-unified-reset")
  })

  it("ignores a reset header already in the past", () => {
    const result = cooldownFromResponse(
      new Headers({
        "anthropic-ratelimit-unified-reset": String((NOW - 300_000) / 1000),
      }),
      undefined,
      config(),
      NOW,
    )
    assert.equal(result.reason, "unspecified-429")
  })

  it("recognises a usage limit from the body when no header says so", () => {
    const result = cooldownFromResponse(
      new Headers(),
      JSON.stringify({ error: { message: "usage limit reached" } }),
      config(),
      NOW,
    )
    assert.equal(result.reason, "usage-limit-body")
  })

  it("benches a bare 429 for the short default rather than for hours", () => {
    const result = cooldownFromResponse(new Headers(), "", config(), NOW)
    assert.equal(result.ms, 60_000)
    assert.equal(result.reason, "unspecified-429")
  })

  it("caps an absurdly long retry-after", () => {
    const result = cooldownFromResponse(
      new Headers({ "retry-after": String(30 * 24 * 3600) }),
      undefined,
      config(),
      NOW,
    )
    assert.equal(result.ms, 6 * 60 * 60 * 1000)
  })

  it("survives missing headers entirely", () => {
    const result = cooldownFromResponse(undefined, undefined, config(), NOW)
    assert.equal(result.ms, 60_000)
  })
})

describe("cooldown bookkeeping", () => {
  beforeEach(isolateState)

  it("persists a bench and reports it as active", () => {
    markRateLimited("acct-a", 60_000, "retry-after", NOW)
    assert.equal(getCooldownUntil("acct-a", NOW), NOW + 60_000)
    assert.ok(isCoolingDown("acct-a", NOW))
    assert.equal(readRotationState().cooldowns["acct-a"]?.reason, "retry-after")
  })

  it("treats a bench as over once its time passes", () => {
    markRateLimited("acct-a", 60_000, "retry-after", NOW)
    assert.equal(getCooldownUntil("acct-a", NOW + 61_000), null)
    assert.equal(isCoolingDown("acct-a", NOW + 61_000), false)
  })

  it("never shortens a longer bench already in place", () => {
    markRateLimited("acct-a", 3_600_000, "retry-after", NOW)
    const until = markRateLimited("acct-a", 1_000, "unspecified-429", NOW)
    assert.equal(until, NOW + 3_600_000)
  })

  it("extends a bench when the new one is longer", () => {
    markRateLimited("acct-a", 1_000, "unspecified-429", NOW)
    const until = markRateLimited("acct-a", 3_600_000, "retry-after", NOW)
    assert.equal(until, NOW + 3_600_000)
  })

  it("clears a bench when the account proves itself", () => {
    markRateLimited("acct-a", 3_600_000, "retry-after", NOW)
    clearCooldown("acct-a", NOW)
    assert.equal(getCooldownUntil("acct-a", NOW), null)
  })

  it("reports no cooldown for an unknown account", () => {
    assert.equal(getCooldownUntil("nobody", NOW), null)
  })

  it("lists live benches, soonest first", () => {
    markRateLimited("acct-a", 3_600_000, "retry-after", NOW)
    markRateLimited("acct-b", 60_000, "retry-after", NOW)
    const cooling = activeCooldowns(NOW)
    assert.deepEqual(
      cooling.map((c) => c.source),
      ["acct-b", "acct-a"],
    )
  })

  it("omits expired benches from the list", () => {
    markRateLimited("acct-a", 60_000, "retry-after", NOW)
    assert.deepEqual(activeCooldowns(NOW + 61_000), [])
  })
})

describe("orderAccounts", () => {
  beforeEach(isolateState)

  it("keeps discovery order when no order is configured", () => {
    const ordered = orderAccounts([A, B, C])
    assert.deepEqual(
      ordered.map((a) => a.source),
      ["acct-a", "acct-b", "acct-c"],
    )
  })

  it("respects a configured order and appends the rest", () => {
    process.env.OPENCODE_CLAUDE_AUTH_ACCOUNT_ORDER = "acct-c,acct-b"
    const ordered = orderAccounts([A, B, C])
    assert.deepEqual(
      ordered.map((a) => a.source),
      ["acct-c", "acct-b", "acct-a"],
    )
  })

  it("ignores a configured source that does not exist", () => {
    process.env.OPENCODE_CLAUDE_AUTH_ACCOUNT_ORDER = "ghost,acct-b"
    const ordered = orderAccounts([A, B])
    assert.deepEqual(
      ordered.map((a) => a.source),
      ["acct-b", "acct-a"],
    )
  })
})

describe("pickNextAccount", () => {
  beforeEach(isolateState)

  it("returns the first account when nothing is benched", () => {
    assert.equal(pickNextAccount([A, B, C], [], NOW)?.source, "acct-a")
  })

  it("skips accounts already tried in this request", () => {
    assert.equal(pickNextAccount([A, B, C], ["acct-a"], NOW)?.source, "acct-b")
  })

  it("skips a benched account", () => {
    markRateLimited("acct-a", 3_600_000, "retry-after", NOW)
    assert.equal(pickNextAccount([A, B, C], [], NOW)?.source, "acct-b")
  })

  it("returns a benched account again once its time is up", () => {
    markRateLimited("acct-a", 60_000, "retry-after", NOW)
    assert.equal(pickNextAccount([A, B], [], NOW + 61_000)?.source, "acct-a")
  })

  it("returns null when every account is benched or tried", () => {
    markRateLimited("acct-a", 3_600_000, "retry-after", NOW)
    markRateLimited("acct-b", 3_600_000, "retry-after", NOW)
    assert.equal(pickNextAccount([A, B], [], NOW), null)
  })

  it("follows the configured priority order", () => {
    process.env.OPENCODE_CLAUDE_AUTH_ACCOUNT_ORDER = "acct-c"
    assert.equal(pickNextAccount([A, B, C], [], NOW)?.source, "acct-c")
  })

  it("returns null for an empty pool", () => {
    assert.equal(pickNextAccount([], [], NOW), null)
  })
})

describe("pickInitialAccount", () => {
  beforeEach(isolateState)

  it("honours the persisted selection when it is healthy", () => {
    assert.equal(pickInitialAccount([A, B], "acct-b", NOW)?.source, "acct-b")
  })

  it("steps over a persisted selection that is still benched", () => {
    markRateLimited("acct-b", 3_600_000, "retry-after", NOW)
    assert.equal(pickInitialAccount([A, B], "acct-b", NOW)?.source, "acct-a")
  })

  it("keeps the persisted selection when rotation is disabled", () => {
    process.env.OPENCODE_CLAUDE_AUTH_ROTATE = "0"
    markRateLimited("acct-b", 3_600_000, "retry-after", NOW)
    assert.equal(pickInitialAccount([A, B], "acct-b", NOW)?.source, "acct-b")
  })

  it("falls back to the persisted account when every account is benched", () => {
    markRateLimited("acct-a", 3_600_000, "retry-after", NOW)
    markRateLimited("acct-b", 3_600_000, "retry-after", NOW)
    assert.equal(pickInitialAccount([A, B], "acct-b", NOW)?.source, "acct-b")
  })

  it("uses the first account when nothing was persisted", () => {
    assert.equal(pickInitialAccount([A, B], null, NOW)?.source, "acct-a")
  })

  it("ignores a persisted account that no longer exists", () => {
    assert.equal(pickInitialAccount([A, B], "removed", NOW)?.source, "acct-a")
  })

  it("returns null for an empty pool", () => {
    assert.equal(pickInitialAccount([], "acct-a", NOW), null)
  })
})

describe("formatRemaining", () => {
  it("renders minutes, hours and the ready state", () => {
    assert.equal(formatRemaining(0), "ready")
    assert.equal(formatRemaining(-5), "ready")
    assert.equal(formatRemaining(60_000), "1m")
    assert.equal(formatRemaining(90_000), "2m")
    assert.equal(formatRemaining(3_600_000), "1h")
    assert.equal(formatRemaining(3_600_000 + 600_000), "1h 10m")
  })
})
