import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { log } from "./logger.ts"

/**
 * Claude subscription quota, read off the `anthropic-ratelimit-unified-*`
 * headers Anthropic returns on every /v1/messages response.
 *
 * Deliberately the only source. Anthropic also exposes the numbers at
 * GET /api/oauth/usage, but polling that spends a request per refresh on an
 * undocumented endpoint to learn what the responses already carry for free.
 * A window whose reset time has passed is re-derived as empty by the reader
 * instead, which is what that poll was really for.
 */
export type UsageWindow = {
  /** 0..1 */
  utilization: number
  /** Unix epoch SECONDS, or null when the window has never been entered. */
  resetsAt: number | null
}

export type UsageSnapshot = {
  /** Unix epoch MILLISECONDS this snapshot was produced. */
  updatedAt: number
  /** allowed | allowed_warning | rejected */
  status: string | null
  /** Which window is currently the binding constraint. */
  representativeClaim: string | null
  fiveHour: UsageWindow | null
  sevenDay: UsageWindow | null
  overage: {
    status: string | null
    utilization: number | null
    resetsAt: number | null
    disabledReason: string | null
  } | null
}

const USAGE_FILENAME = "claude-usage.json"

/**
 * Mirrors getAuthJsonPaths() in credentials.ts. The same Windows split applies:
 * different OpenCode installation methods read from different roots, and the
 * TUI process that renders this has no say in which one it got.
 */
export function getUsageStatePaths(): string[] {
  const xdgPath = join(homedir(), ".local", "share", "opencode", USAGE_FILENAME)
  if (process.platform !== "win32") return [xdgPath]
  const appData =
    process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local")
  return [xdgPath, join(appData, "opencode", USAGE_FILENAME)]
}

function num(raw: string | null): number | null {
  if (raw === null) return null
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

function readWindow(headers: Headers, abbrev: "5h" | "7d"): UsageWindow | null {
  const utilization = num(
    headers.get(`anthropic-ratelimit-unified-${abbrev}-utilization`),
  )
  if (utilization === null) return null
  return {
    utilization,
    resetsAt: num(headers.get(`anthropic-ratelimit-unified-${abbrev}-reset`)),
  }
}

/**
 * Reads the `anthropic-ratelimit-unified-*` family off a live response.
 *
 * Returns null when the family is absent rather than an empty snapshot —
 * count_tokens calls and request-validation errors carry no quota headers,
 * and overwriting a good snapshot with blanks would make the display flicker
 * to nothing on every such call.
 */
export function parseUsageHeaders(headers: Headers): UsageSnapshot | null {
  const fiveHour = readWindow(headers, "5h")
  const sevenDay = readWindow(headers, "7d")
  const status = headers.get("anthropic-ratelimit-unified-status")
  if (!fiveHour && !sevenDay && !status) return null

  const overageStatus = headers.get(
    "anthropic-ratelimit-unified-overage-status",
  )
  const overageUtilization = num(
    headers.get("anthropic-ratelimit-unified-overage-utilization"),
  )

  return {
    updatedAt: Date.now(),
    status,
    representativeClaim: headers.get(
      "anthropic-ratelimit-unified-representative-claim",
    ),
    fiveHour,
    sevenDay,
    overage:
      overageStatus || overageUtilization !== null
        ? {
            status: overageStatus,
            utilization: overageUtilization,
            resetsAt: num(
              headers.get("anthropic-ratelimit-unified-overage-reset"),
            ),
            disabledReason: headers.get(
              "anthropic-ratelimit-unified-overage-disabled-reason",
            ),
          }
        : null,
  }
}

/**
 * Serialised form of the last write, used to skip no-op writes. Compared
 * without `updatedAt`, since that changes on every single response and would
 * defeat the check entirely.
 */
let lastWritten: string | null = null

function comparable(snapshot: UsageSnapshot): string {
  const { updatedAt: _ignored, ...rest } = snapshot
  return JSON.stringify(rest)
}

export function writeUsageSnapshot(snapshot: UsageSnapshot): void {
  const key = comparable(snapshot)
  if (key === lastWritten) return

  const serialized = JSON.stringify(snapshot, null, 2)
  for (const path of getUsageStatePaths()) {
    try {
      const dir = dirname(path)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      // Written aside then renamed: the TUI polls this file on a timer and a
      // torn read would surface as a parse error exactly when usage is highest.
      const tmp = `${path}.tmp`
      writeFileSync(tmp, serialized, "utf-8")
      renameSync(tmp, path)
    } catch (err) {
      log("usage_write_error", {
        path,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  lastWritten = key
}

/** Parse-and-persist in one call, for the fetch path. Never throws. */
export function recordUsageFromHeaders(headers: Headers): void {
  try {
    const snapshot = parseUsageHeaders(headers)
    if (!snapshot) return
    log("usage_recorded", {
      status: snapshot.status,
      fiveHour: snapshot.fiveHour?.utilization ?? null,
      sevenDay: snapshot.sevenDay?.utilization ?? null,
      representativeClaim: snapshot.representativeClaim,
    })
    writeUsageSnapshot(snapshot)
  } catch (err) {
    log("usage_record_threw", {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/** Test seam: clears the write-deduplication cache. */
export function resetUsageWriteCache(): void {
  lastWritten = null
}
