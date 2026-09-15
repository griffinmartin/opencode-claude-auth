/**
 * Load-and-render smoke test for the TUI plugin.
 *
 * OpenCode transpiles plugin `.tsx` at import time with OpenTUI's Solid
 * transform; this reproduces that, then actually renders the registered slots
 * into a test terminal, so a JSX or reactivity error surfaces here rather than
 * on the user's next restart.
 *
 *   bun tui/smoke.ts
 *
 * Runs against a synthetic snapshot in a temporary HOME rather than the real
 * one, so it neither depends on this machine having used the plugin before nor
 * reports whatever the developer's live quota happens to be.
 */
import "@opentui/solid/runtime-plugin-support"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const home = mkdtempSync(join(tmpdir(), "claude-usage-smoke-"))
// homedir() reads USERPROFILE on Windows and HOME elsewhere. Set before the
// plugin is imported: it resolves its state and log paths from them.
process.env.HOME = home
process.env.USERPROFILE = home
process.env.LOCALAPPDATA = join(home, "AppData", "Local")

const FIVE_HOUR_UTILIZATION = 0.26
const SEVEN_DAY_UTILIZATION = 0.19

function seedSnapshot(): void {
  const dir = join(home, ".local", "share", "opencode")
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, "claude-usage.json"),
    JSON.stringify({
      updatedAt: Date.now(),
      status: "allowed",
      representativeClaim: "five_hour",
      fiveHour: {
        utilization: FIVE_HOUR_UTILIZATION,
        // Far enough out that the countdown cannot expire mid-run.
        resetsAt: Math.floor(Date.now() / 1000) + 2 * 3600 + 13 * 60,
      },
      sevenDay: {
        utilization: SEVEN_DAY_UTILIZATION,
        resetsAt: Math.floor(Date.now() / 1000) + 5 * 24 * 3600,
      },
      overage: null,
    }),
    "utf-8",
  )
}

const { testRender } = (await import("@opentui/solid")) as {
  testRender: (
    node: () => unknown,
    config?: { width?: number; height?: number },
  ) => Promise<{
    renderOnce: () => Promise<void>
    captureCharFrame: () => string
  }>
}

const mod = (await import("./claude-usage.tsx")) as {
  default?: { id?: string; tui?: unknown }
}
const plugin = mod.default

if (!plugin) throw new Error("no default export")
if (typeof plugin.id !== "string") throw new Error("missing string id")
if (typeof plugin.tui !== "function") throw new Error("tui is not a function")

type SlotFn = (ctx: unknown, props: unknown) => unknown

// Exercise every placement, not just the default, so a broken renderer for an
// opt-in slot is caught here rather than by whoever opts into it.
const requestedSlots = [
  "sidebar_title",
  "sidebar_content",
  "sidebar_footer",
  "session_prompt_right",
  "home_prompt_right",
]

const theme = {
  current: {
    text: "#e6e6e6",
    textMuted: "#8a8a8a",
    warning: "#e5c07b",
    error: "#e06c75",
  },
}

async function renderSlots(): Promise<Record<string, string[]>> {
  let registered: Record<string, SlotFn> = {}
  await (plugin!.tui as (api: unknown, options: unknown) => Promise<void>)(
    {
      lifecycle: { onDispose: () => () => {} },
      slots: {
        register: (input: { slots: Record<string, SlotFn> }) => {
          registered = input.slots
          return plugin!.id as string
        },
      },
    },
    { slots: requestedSlots },
  )

  const names = Object.keys(registered)
  if (names.length !== requestedSlots.length) {
    throw new Error(
      `expected ${requestedSlots.length} slots, registered ${names.join(", ")}`,
    )
  }

  const frames: Record<string, string[]> = {}
  for (const name of names) {
    const setup = await testRender(
      () =>
        registered[name]!(
          { theme },
          {
            session_id: "ses_abcdef123456",
            title: "Display session status in opencode",
          },
        ),
      { width: 60, height: 4 },
    )
    await setup.renderOnce()
    frames[name] = setup
      .captureCharFrame()
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0)
  }
  return frames
}

try {
  console.log("id:", plugin.id)

  // Phase 1: no snapshot on disk — the readout must stay out of the way rather
  // than render a half-empty row of labels.
  const empty = await renderSlots()
  for (const [name, frame] of Object.entries(empty)) {
    const showsQuota = frame.some((line) => line.includes("5h"))
    if (showsQuota) {
      throw new Error(`${name} rendered a quota with no snapshot on disk`)
    }
  }
  console.log("no-snapshot: every slot renders no readout (ok)")

  // Phase 2: with a snapshot, every placement must show the readout, and only
  // the sidebar ones carry the heading.
  seedSnapshot()
  const seeded = await renderSlots()
  for (const [name, frame] of Object.entries(seeded)) {
    console.log(`[${name}] ${JSON.stringify(frame)}`)
    if (frame.length === 0) throw new Error(`${name} rendered nothing`)

    const expected = `5h ${Math.round(FIVE_HOUR_UTILIZATION * 100)}%`
    if (!frame.some((line) => line.includes(expected))) {
      throw new Error(`${name} is missing "${expected}"`)
    }
    // Shape, not an exact value: the countdown floors to the minute, so the
    // second that passes between seeding and rendering turns 2h13m into 2h12m.
    if (!frame.some((line) => /\b\d+h\d+m\b/.test(line))) {
      throw new Error(`${name} is missing the reset countdown`)
    }
    // A countdown that lost a race against the minute boundary renders as the
    // string "null" rather than disappearing, so assert it never appears.
    if (frame.some((line) => line.includes("null"))) {
      throw new Error(`${name} rendered a null countdown`)
    }

    const labelled = name === "sidebar_title" || name === "sidebar_content"
    const hasLabel = frame.some((line) => line.includes("Claude quota"))
    if (labelled !== hasLabel) {
      throw new Error(
        `${name}: expected label ${labelled}, got ${hasLabel} — ${JSON.stringify(frame)}`,
      )
    }
  }

  console.log("OK")
} catch (error) {
  // An unhandled top-level rejection does not set a non-zero exit code here,
  // which would leave this passing however badly it failed.
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  rmSync(home, { recursive: true, force: true })
}
