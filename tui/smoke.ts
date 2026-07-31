/**
 * Load-and-render smoke test for the TUI plugin.
 *
 * OpenCode transpiles plugin `.tsx` at import time with OpenTUI's Solid
 * transform; this reproduces that, then actually renders the registered slot
 * into a test terminal, so a JSX or reactivity error surfaces here rather than
 * on the user's next restart.
 *
 *   bun tui/smoke.ts
 */
import "@opentui/solid/runtime-plugin-support"

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
let registered: Record<string, SlotFn> = {}

// Exercise every placement, not just the default, so a broken renderer for an
// opt-in slot is caught here rather than by whoever opts into it.
const requestedSlots = [
  "sidebar_title",
  "sidebar_content",
  "sidebar_footer",
  "session_prompt_right",
  "home_prompt_right",
]

await (plugin.tui as (api: unknown, options: unknown) => Promise<void>)(
  {
    lifecycle: { onDispose: () => () => {} },
    slots: {
      register: (input: { slots: Record<string, SlotFn> }) => {
        registered = input.slots
        return plugin.id as string
      },
    },
  },
  { slots: requestedSlots },
)

const slots = Object.keys(registered)
console.log("id:", plugin.id)
console.log("slots registered:", slots.join(", "))
if (slots.length === 0) throw new Error("registered no slots")

const theme = {
  current: {
    text: "#e6e6e6",
    textMuted: "#8a8a8a",
    warning: "#e5c07b",
    error: "#e06c75",
  },
}

if (slots.length !== requestedSlots.length) {
  throw new Error(
    `expected ${requestedSlots.length} slots, registered ${slots.join(", ")}`,
  )
}

for (const name of slots) {
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
  const frame = setup
    .captureCharFrame()
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
  console.log(`[${name}] ${JSON.stringify(frame)}`)
  if (frame.length === 0) throw new Error(`${name} rendered nothing`)
  // Every placement must show the readout itself, not just its surroundings.
  if (!frame.some((line) => line.includes("5h"))) {
    throw new Error(`${name} rendered no usage readout`)
  }
  // The sidebar placements sit among the host's labelled sections and must
  // carry a heading; the prompt-bar ones have no room and must not.
  const labelled = name === "sidebar_title" || name === "sidebar_content"
  const hasLabel = frame.some((line) => line.includes("Claude quota"))
  if (labelled !== hasLabel) {
    throw new Error(
      `${name}: expected label ${labelled}, got ${hasLabel} — ${JSON.stringify(frame)}`,
    )
  }
}

console.log("OK")
