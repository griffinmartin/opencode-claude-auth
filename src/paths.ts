import { homedir } from "node:os"
import { join } from "node:path"

/**
 * XDG base directory for user-specific data files.
 *
 * Resolved at call time, not module load, so tests (and unusual deployments)
 * can redirect the data dir without reloading the module.
 *
 * An empty `XDG_DATA_HOME` is treated as unset, per the XDG Base Directory
 * spec: "If $XDG_DATA_HOME is either not set or empty, a default equal to
 * $HOME/.local/share should be used."
 */
export function getDataHome(): string {
  return process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
}

/**
 * The OpenCode data directory, matching OpenCode's own XDG-based resolution.
 *
 * Everything this plugin persists lives here: the active-account marker, the
 * synced `auth.json`, the debug log, and the cross-process refresh locks.
 * Pointing `XDG_DATA_HOME` at a per-instance directory is what lets several
 * OpenCode instances run in parallel on different Claude accounts.
 */
export function getOpencodeDataDir(): string {
  return join(getDataHome(), "opencode")
}
