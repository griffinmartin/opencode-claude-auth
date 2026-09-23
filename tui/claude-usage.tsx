/** @jsxImportSource @opentui/solid */
import type {
  TuiPlugin,
  TuiPluginModule,
  TuiThemeCurrent,
} from "@opencode-ai/plugin/tui"
import type { JSX } from "@opentui/solid"
import { appendFileSync, existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createMemo, createSignal, onCleanup } from "solid-js"
import type { UsageSnapshot, UsageWindow } from "../src/usage.ts"

/**
 * The TUI runs in its own process and OpenCode swallows a plugin's console
 * output, so a failure here is otherwise completely silent.
 *
 * Tracing turns on by the presence of the log file itself, not just an env var:
 * OpenCode's TUI is launched by the user's terminal, so there is no reliable
 * moment to export one. Create the file to enable, delete it to disable.
 */
const DEBUG_LOG_PATH = join(
  homedir(),
  ".local",
  "share",
  "opencode",
  "claude-usage-tui.log",
)
const DEBUG_LOG =
  process.env.CLAUDE_AUTH_DEBUG || existsSync(DEBUG_LOG_PATH)
    ? DEBUG_LOG_PATH
    : null

function debug(event: string, detail?: unknown): void {
  if (!DEBUG_LOG) return
  try {
    const payload =
      detail instanceof Error
        ? `${detail.message}\n${detail.stack ?? ""}`
        : detail === undefined
          ? ""
          : JSON.stringify(detail)
    appendFileSync(
      DEBUG_LOG,
      `${new Date().toISOString()} ${event} ${payload}\n`,
      "utf-8",
    )
  } catch {
    // Tracing must never be the reason the plugin fails.
  }
}

debug("module_evaluated", { platform: process.platform })

/**
 * Renders the Claude subscription quota the server half of this plugin records
 * off every Anthropic response.
 *
 * The two halves cannot talk directly — a server plugin and a TUI plugin are
 * separate modules loaded into separate processes — so they meet at the JSON
 * file written by src/usage.ts. This side only ever reads it.
 */

const USAGE_FILENAME = "claude-usage.json"
const POLL_INTERVAL_MS = 5_000

/**
 * Beyond this the snapshot predates the current 7-day window, so even the
 * reset-derived zero below would be a guess. Show nothing instead.
 */
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000

/** Must stay in step with getUsageStatePaths() in src/usage.ts. */
function usageStatePaths(): string[] {
  const xdg = join(homedir(), ".local", "share", "opencode", USAGE_FILENAME)
  if (process.platform !== "win32") return [xdg]
  const appData =
    process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")
  return [xdg, join(appData, "opencode", USAGE_FILENAME)]
}

/**
 * Both candidate paths are read and the newer wins. Which one the server half
 * wrote depends on how OpenCode was installed, and this side has no way to
 * know — reading both is cheaper than being wrong.
 */
function readSnapshot(): UsageSnapshot | null {
  let newest: UsageSnapshot | null = null
  for (const path of usageStatePaths()) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as UsageSnapshot
      if (typeof parsed?.updatedAt !== "number") continue
      if (!newest || parsed.updatedAt > newest.updatedAt) newest = parsed
    } catch {
      // Missing until the first request of the first ever session, and
      // momentarily unreadable if caught mid-write. Both are normal.
    }
  }
  if (!newest) return null
  return Date.now() - newest.updatedAt > STALE_AFTER_MS ? null : newest
}

/**
 * A window whose reset time has passed is empty, whatever the last response
 * said it was. Deriving that here is what lets the server half get away with
 * recording quota only from responses: an idle session stops sending requests,
 * but its window still empties, and the display follows without a single extra
 * API call.
 */
function currentWindow(window: UsageWindow | null): UsageWindow | null {
  if (!window) return null
  if (window.resetsAt !== null && window.resetsAt * 1000 <= Date.now()) {
    return { utilization: 0, resetsAt: null }
  }
  return window
}

function percent(utilization: number): number {
  return Math.round(utilization * 100)
}

/** "2h13m", "47m", "<1m" — narrow enough to sit in the prompt bar. */
function countdown(resetsAtSeconds: number | null): string | null {
  if (resetsAtSeconds === null) return null
  const remainingMs = resetsAtSeconds * 1000 - Date.now()
  if (remainingMs <= 0) return null
  const minutes = Math.floor(remainingMs / 60_000)
  if (minutes < 1) return "<1m"
  const hours = Math.floor(minutes / 60)
  return hours > 0 ? `${hours}h${minutes % 60}m` : `${minutes}m`
}

function severityColor(theme: TuiThemeCurrent, utilization: number) {
  const pct = percent(utilization)
  if (pct >= 90) return theme.error
  if (pct >= 70) return theme.warning
  return theme.text
}

/**
 * Where the readout is rendered. Configurable because none of these is
 * obviously right and the trade-offs are visual, not technical:
 *
 * - `sidebar_title`   top of the sidebar, directly above Context. Replaces the
 *                     host title block, so this plugin re-renders the title.
 * - `sidebar_content` bottom of the sidebar, below Models.
 * - `sidebar_footer`  the sidebar's last line — note this is `single_winner`,
 *                     so choosing it hides OpenCode's own "Open Code" footer.
 * - `session_prompt_right` / `home_prompt_right`
 *                     right edge of the prompt bar; can be clipped on a narrow
 *                     terminal, since it shares that edge with other readouts.
 */
type TuiSlotCtx = { theme: { current: TuiThemeCurrent } }
type SidebarTitleProps = { title: string; share_url?: string }

const SLOT_NAMES = [
  "sidebar_title",
  "sidebar_content",
  "sidebar_footer",
  "session_prompt_right",
  "home_prompt_right",
] as const
type SlotName = (typeof SLOT_NAMES)[number]

const DEFAULT_SLOTS: SlotName[] = ["sidebar_title"]
const DEFAULT_LABEL = "Claude quota"

/**
 * The sidebar placements sit among the host's own labelled sections, so they
 * get a heading to match. The prompt-bar placements are a single line with no
 * room for one.
 */
const LABELLED_SLOTS: ReadonlySet<SlotName> = new Set<SlotName>([
  "sidebar_title",
  "sidebar_content",
])

function resolveLabel(options: unknown): string {
  const requested = (options as { label?: unknown } | undefined)?.label
  return typeof requested === "string" && requested.trim().length > 0
    ? requested
    : DEFAULT_LABEL
}

function resolveSlots(options: unknown): SlotName[] {
  const requested = (options as { slots?: unknown } | undefined)?.slots
  if (!Array.isArray(requested)) return DEFAULT_SLOTS
  const valid = requested.filter((name): name is SlotName =>
    SLOT_NAMES.includes(name as SlotName),
  )
  const rejected = requested.filter((name) => !valid.includes(name as SlotName))
  if (rejected.length > 0) debug("unknown_slots_ignored", { rejected })
  return valid.length > 0 ? valid : DEFAULT_SLOTS
}

const plugin: TuiPluginModule & { id: string } = {
  id: "claude-auth-usage",
  tui: (async (api, options) => {
    debug("tui_setup_start")
    const initial = readSnapshot()
    debug("initial_snapshot", { found: initial !== null })
    const [snapshot, setSnapshot] = createSignal<UsageSnapshot | null>(initial)

    // One poller for the whole plugin rather than one per slot: the prompt-right
    // slot remounts on every session switch, and a per-slot interval would make
    // the read rate a function of how much the user navigates.
    let lastSeen = ""
    const poll = () => {
      const next = readSnapshot()
      const key = JSON.stringify(next)
      // Signals compare by identity, so re-setting an equal-but-new object every
      // 5s would re-render the prompt bar forever on an idle session.
      if (key === lastSeen) return
      lastSeen = key
      setSnapshot(next)
    }
    const timer = setInterval(poll, POLL_INTERVAL_MS)
    timer.unref?.()
    api.lifecycle.onDispose(() => clearInterval(timer))

    const label = resolveLabel(options)
    const rendersTraced = new Map<string, number>()
    const Usage = (props: { theme: TuiThemeCurrent; slot: SlotName }) => {
      const seen = rendersTraced.get(props.slot) ?? 0
      if (seen < 2) {
        rendersTraced.set(props.slot, seen + 1)
        debug("slot_render", {
          slot: props.slot,
          hasSnapshot: snapshot() !== null,
        })
      }
      // The countdown has to move without the file changing, so it gets its own
      // clock rather than riding on the poll signal.
      const [tick, setTick] = createSignal(0)
      const clock = setInterval(() => setTick((n) => n + 1), 30_000)
      clock.unref?.()
      onCleanup(() => clearInterval(clock))

      const current = () => snapshot()
      const fiveHour = () => currentWindow(current()?.fiveHour ?? null)
      const sevenDay = () => currentWindow(current()?.sevenDay ?? null)

      /**
       * Reading tick() is what makes the clock above do anything: setting a
       * signal nothing reads schedules no re-render, so without this the
       * countdown would only advance when a response happened to rewrite the
       * snapshot — that is, never on the idle session it exists for.
       *
       * A memo rather than a plain accessor so the two reads below cannot
       * straddle a minute boundary and disagree about whether there is any
       * time left to show.
       */
      const fiveHourCountdown = createMemo(() => {
        tick()
        const window = fiveHour()
        return window ? countdown(window.resetsAt) : null
      })

      // A recorded rejection expires with the window that caused it, so it is
      // read off the raw reset time rather than the derived window — which has
      // already been zeroed by then and could no longer tell us.
      const rejected = () => {
        const snap = current()
        if (snap?.status !== "rejected") return false
        const raw = snap.fiveHour
        return !raw?.resetsAt || raw.resetsAt * 1000 > Date.now()
      }

      const readout = () => (
        <text fg={props.theme.textMuted}>
          {rejected() ? (
            <span style={{ fg: props.theme.error }}>limit </span>
          ) : (
            ""
          )}
          {fiveHour() ? (
            <>
              5h{" "}
              <span
                style={{
                  fg: severityColor(props.theme, fiveHour()!.utilization),
                }}
              >
                {percent(fiveHour()!.utilization)}%
              </span>
              {fiveHourCountdown() ? ` ${fiveHourCountdown()}` : ""}
            </>
          ) : (
            ""
          )}
          {fiveHour() && sevenDay() ? " · " : ""}
          {sevenDay() ? (
            <>
              7d{" "}
              <span
                style={{
                  fg: severityColor(props.theme, sevenDay()!.utilization),
                }}
              >
                {percent(sevenDay()!.utilization)}%
              </span>
            </>
          ) : (
            ""
          )}
        </text>
      )

      if (!LABELLED_SLOTS.has(props.slot)) return readout()

      // paddingTop keeps this off the line above it, matching the gap the host
      // puts between its own sidebar sections.
      return (
        <box paddingTop={1}>
          <text fg={props.theme.text}>{label}</text>
          {readout()}
        </box>
      )
    }

    const enabled = resolveSlots(options)

    const renderers: Record<
      SlotName,
      (ctx: TuiSlotCtx, props: never) => JSX.Element
    > = {
      /**
       * `sidebar_title` is `single_winner`, so winning it means the host's
       * title block stops rendering and this has to stand in for it — hence
       * the title and share URL below. That is the price of the only slot
       * that sits above Context.
       */
      sidebar_title: (ctx, props) => {
        const title = props as SidebarTitleProps
        return (
          <box paddingRight={1}>
            <text fg={ctx.theme.current.text}>
              <b>{title.title}</b>
            </text>
            {/* null, not "": a bare string child of a <box> is an orphan text
                node in OpenTUI and throws. Inside <text> the empty-string
                fallbacks are fine, which is why only this one differs. */}
            {title.share_url ? (
              <text fg={ctx.theme.current.textMuted}>{title.share_url}</text>
            ) : null}
            <Usage theme={ctx.theme.current} slot="sidebar_title" />
          </box>
        )
      },
      sidebar_content: (ctx) => (
        <Usage theme={ctx.theme.current} slot="sidebar_content" />
      ),
      sidebar_footer: (ctx) => (
        <Usage theme={ctx.theme.current} slot="sidebar_footer" />
      ),
      session_prompt_right: (ctx) => (
        <Usage theme={ctx.theme.current} slot="session_prompt_right" />
      ),
      home_prompt_right: (ctx) => (
        <Usage theme={ctx.theme.current} slot="home_prompt_right" />
      ),
    }

    const slots = Object.fromEntries(
      enabled.map((name) => [name, renderers[name]]),
    )
    const registeredAs = api.slots.register({ slots })
    debug("slots_registered", { registeredAs, slots: enabled })
  }) satisfies TuiPlugin,
}

export default plugin
