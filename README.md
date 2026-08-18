# opencode-claude-auth

[![npm](https://img.shields.io/npm/v/opencode-claude-auth)](https://www.npmjs.com/package/opencode-claude-auth)
[![CI](https://github.com/griffinmartin/opencode-claude-auth/actions/workflows/ci.yml/badge.svg)](https://github.com/griffinmartin/opencode-claude-auth/actions/workflows/ci.yml)
[![Socket Badge](https://socket.dev/api/badge/npm/package/opencode-claude-auth)](https://socket.dev/npm/package/opencode-claude-auth)

Self-contained Anthropic auth provider for OpenCode 2 using your Claude Code subscription credentials — no separate login or API key needed.

> **Requires OpenCode 2.** This version targets OpenCode 2's plugin and auth APIs and will not load on OpenCode 1. If you're still on OpenCode 1, pin `opencode-claude-auth` to a version prior to this change instead of tracking `@latest`.

## How it works

The plugin registers a Claude Code subscription auth method on OpenCode's built-in Anthropic provider. Run `/connect`, choose **Anthropic**, then **Import Claude Code subscription** — it reads OAuth tokens directly from the macOS Keychain (or `~/.claude/.credentials.json` — or `$CLAUDE_CONFIG_DIR/.credentials.json` if that env var is set — on other platforms) and hands them to OpenCode.

A custom `fetch` wraps every Anthropic API request to set `Authorization: Bearer` with the current access token (and strip `x-api-key`), translate tool names, and inject the Claude Code identity into the system prompt. OpenCode owns the credential's lifecycle from there and calls back into the plugin to refresh it as needed. Refreshes go directly to Anthropic's OAuth endpoint (zero LLM tokens consumed); the plugin always checks the keychain first and adopts whatever is there if it differs from what OpenCode handed back, so an independent `claude` re-login or refresh doesn't leave OpenCode stuck retrying a dead token. It falls back to the `claude` CLI only in the narrow window where Claude Code will actually rotate the token.

## Prerequisites

- OpenCode 2 installed — see the [OpenCode 2 migration guide](https://opencode.ai/v2/docs/migrate-v1) for installation instructions
- Claude Code installed and authenticated (run `claude` at least once)

macOS is preferred (uses Keychain). Linux and Windows work via the credentials file fallback.

## Installation

**For Humans**

**Option A: Let an LLM do it**

Paste this into any LLM agent (Claude Code, OpenCode, Cursor, etc.):

```
Install the opencode-claude-auth plugin and configure it by following: https://raw.githubusercontent.com/griffinmartin/opencode-claude-auth/main/installation.md
```

**Option B: Manual setup**

1. **Add the plugin** to `~/.config/opencode/opencode.json`:

   ```json
   {
     "plugins": ["opencode-claude-auth@latest"]
   }
   ```

   > OpenCode 2 uses the `plugins` key (plural) — OpenCode 1 used `plugin` (singular). The `@latest` tag ensures OpenCode always pulls the newest version on startup. No manual `npm install` is needed — OpenCode [automatically installs npm plugins using Bun at startup](https://opencode.ai/docs/plugins/#how-plugins-are-installed).

2. **Connect it** — restart OpenCode, run `/connect`, choose **Anthropic**, then **Import Claude Code subscription**. Use `/models` and pick a model under **Anthropic**.

**For LLM Agents**

See [installation.md](installation.md) for step-by-step agent instructions.

## Usage

Run `/connect` once to import your Claude Code subscription, then use OpenCode normally — the plugin refreshes credentials automatically and provides them to the Anthropic API. If your credentials aren't OAuth-based, the connection falls through to standard API key auth.

## Supported models

13 supported models. Run `pnpm run test:models` to verify against your account.

| Model                      |
| -------------------------- |
| claude-fable-5             |
| claude-haiku-4-5           |
| claude-haiku-4-5-20251001  |
| claude-opus-4-5            |
| claude-opus-4-5-20251101   |
| claude-opus-4-6            |
| claude-opus-4-7            |
| claude-opus-4-8            |
| claude-opus-5              |
| claude-sonnet-4-5          |
| claude-sonnet-4-5-20250929 |
| claude-sonnet-4-6          |
| claude-sonnet-5            |

## Credential sources

The plugin checks these in order:

1. macOS Keychain (all `Claude Code-credentials*` entries — multiple accounts are detected automatically)
2. `~/.claude/.credentials.json` (fallback, works on all platforms; if `CLAUDE_CONFIG_DIR` is set, reads `$CLAUDE_CONFIG_DIR/.credentials.json` instead)

## Multiple accounts (macOS)

If you have [multiple Claude Code accounts](https://gist.github.com/KMJ-007/0979814968722051620461ab2aa01bf2) authenticated on macOS, they're all detected from the Keychain automatically and offered as a selection prompt when you run `/connect`. Each account is labeled by its subscription tier (Claude Pro, Claude Max, etc.).

To switch accounts, re-run `/connect` and pick a different one. Your selection is persisted across sessions.

If only one account is found, the selection prompt is skipped and the plugin uses it directly.

## Troubleshooting

| Problem                                                        | Solution                                                                                                                                                                                                      |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Credentials not found"                                        | Run `claude` to authenticate with Claude Code first                                                                                                                                                           |
| "Keychain is locked"                                           | Run `security unlock-keychain ~/Library/Keychains/login.keychain-db`                                                                                                                                          |
| "Token expired and refresh failed"                             | The plugin runs `claude` CLI to refresh automatically. If this fails, re-authenticate manually by running `claude`                                                                                            |
| Not working on Linux/Windows                                   | Ensure `~/.claude/.credentials.json` exists (or `$CLAUDE_CONFIG_DIR/.credentials.json` if that env var is set). Run `claude` to create it                                                                     |
| Keychain access denied                                         | Grant access when macOS prompts you                                                                                                                                                                           |
| Keychain read timed out                                        | Restart Keychain Access (can happen on macOS Tahoe)                                                                                                                                                           |
| "Credentials are unavailable or expired"                       | Run `claude` to refresh your Claude Code credentials                                                                                                                                                          |
| Auth keeps failing right after re-authenticating with `claude` | OpenCode may still be holding a refresh token from a previous `/connect` that's now stale. The plugin re-syncs from the keychain automatically on the next refresh; if it's still stuck, run `/connect` again |
| "Extra usage is required for long context requests"            | Your conversation exceeded 200k tokens. See [Long context (1M)](#long-context-1m) below                                                                                                                       |
| Plugin not updating to latest version                          | Delete the cached package: `rm -rf ~/.cache/opencode/packages/opencode-claude-auth@latest/` then restart OpenCode                                                                                             |

### Diagnostic logging

If you're hitting auth errors that are hard to reproduce, enable debug logging to capture the full auth flow:

```bash
export CLAUDE_AUTH_DEBUG=1
```

Restart OpenCode and reproduce the issue. The plugin writes structured JSON logs to `~/.local/share/opencode/claude-auth-debug.log`. All secrets (tokens, API keys) are automatically redacted — the log file is safe to paste into a GitHub issue.

To write logs to a custom path:

```bash
export CLAUDE_AUTH_DEBUG=/tmp/claude-auth-debug.log
```

Disable when done:

```bash
unset CLAUDE_AUTH_DEBUG
```

## Long context (1M)

1M token context is supported natively — the API no longer requires a beta flag for it, so the plugin doesn't send the legacy `context-1m-2025-08-07` header.

If your plan doesn't cover long context billing, requests beyond the standard window fail with "Extra usage is required for long context requests". When a long context error is caused by a beta flag (e.g. one added via `ANTHROPIC_BETA_FLAGS`), the plugin retries without the offending flag.

## Validating OAuth refresh

To verify the direct OAuth token refresh works with your credentials:

```bash
pnpm run validate:oauth           # refresh + write-back (safe, keeps credentials valid)
pnpm run validate:oauth -- --dry-run  # show what would be sent without making the request
```

This reads your stored credentials, calls Anthropic's OAuth token endpoint, and writes the new tokens back to storage. Refresh tokens rotate on each use, so write-back is enabled by default to keep your stored credentials valid.

## Environment variable overrides

All configurable parameters can be overridden via environment variables. If Anthropic changes something before we publish an update, set an env var and keep working:

| Variable                                   | Description                                                                                                                                                                                                                                                                       | Default                                                            |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `ANTHROPIC_CLI_VERSION`                    | Claude CLI version for user-agent and billing headers                                                                                                                                                                                                                             | `config.ccVersion` in [`src/model-config.ts`](src/model-config.ts) |
| `ANTHROPIC_USER_AGENT`                     | Full User-Agent string (overrides CLI version)                                                                                                                                                                                                                                    | `claude-cli/{version} (external, sdk-cli)`                         |
| `ANTHROPIC_BETA_FLAGS`                     | Comma-separated beta feature flags                                                                                                                                                                                                                                                | `baseBetas` list in [`src/model-config.ts`](src/model-config.ts)   |
| `CLAUDE_AUTH_DEBUG`                        | Enable diagnostic logging (`1` for default path, or a custom file path)                                                                                                                                                                                                           | disabled                                                           |
| `CLAUDE_CONFIG_DIR`                        | Claude Code config directory used for the credentials-file fallback (reads `$CLAUDE_CONFIG_DIR/.credentials.json`). macOS still checks the Keychain first.                                                                                                                        | `~/.claude`                                                        |
| `OPENCODE_CLAUDE_AUTH_MAX_RETRY_MS`        | Max ms the plugin waits when honouring a 429/529 `retry-after` header. Beyond this cap the response surfaces immediately so OpenCode doesn't appear to hang on hour-long quota resets.                                                                                            | `30000`                                                            |
| `OPENCODE_CLAUDE_AUTH_TOOL_REPAIR`         | Strategy for reconciling `tool_use`/`tool_result` adjacency broken by OpenCode auto-compaction. `placeholder` synthesizes a paired result for orphaned `tool_use` blocks (lossless, preserves `thinking` blocks); `drop` removes orphaned blocks (omitting whole thinking turns). | `placeholder`                                                      |
| `OPENCODE_CLAUDE_AUTH_REFRESH_WAIT_MS`     | Max ms a single request waits through a transient token-refresh rate-limit (429) before returning a retryable error instead of a hard "run `claude`".                                                                                                                             | `45000`                                                            |
| `OPENCODE_CLAUDE_AUTH_REFRESH_COOLDOWN_MS` | Base per-account cooldown after a rate-limited refresh, before the plugin retries the token endpoint. Escalates with consecutive failures and is jittered; capped at 60s.                                                                                                         | `15000`                                                            |
| `OPENCODE_CLAUDE_AUTH_REFRESH_LOCK_TTL_MS` | TTL for the cross-process refresh lock. A held lock older than this is treated as stale (crashed holder) and taken over.                                                                                                                                                          | `20000`                                                            |
| `OPENCODE_CLAUDE_AUTH_REFRESH_LOCK_DIR`    | Directory for the advisory cross-process refresh lock files.                                                                                                                                                                                                                      | OpenCode data dir (`~/.local/share/opencode`)                      |

Example:

```bash
export ANTHROPIC_CLI_VERSION=2.2.0
```

## How it works (technical)

- Registers a Claude Code subscription auth method on OpenCode's built-in Anthropic integration (`ctx.integration.transform`), surfaced as **Import Claude Code subscription** under `/connect`
- Points the Anthropic provider's model package at a small AI-SDK-compatible provider (`src/provider.ts`) built on `@ai-sdk/anthropic`'s `createAnthropic`, wired in via `ctx.catalog.transform`
- That provider's custom `fetch` sets `Authorization: Bearer` with the current OAuth access token and strips `x-api-key`, translates tool names between OpenCode and Anthropic API formats (adds/strips `mcp_` prefix), buffers SSE response streams at event boundaries for reliable tool name translation, and sets required API headers (beta flags, billing, user-agent) with model-aware selection
- Injects the Claude Code identity into system prompts via a `session.hook("context", ...)` hook
- On macOS, enumerates all `Claude Code-credentials*` Keychain entries and labels them by subscription tier; multiple accounts are offered as a selection prompt during `/connect`
- OpenCode persists the resulting OAuth credential (access + refresh token) itself and calls back into the plugin's `refresh` hook whenever it decides one is needed — the plugin doesn't run its own background timer
- Before ever attempting a network refresh, re-reads the keychain directly and adopts whatever is there if it differs from the token OpenCode handed back. This keeps things working if `claude` rotated credentials independently of this connection (an interactive re-login, its own periodic refresh, ...) — otherwise OpenCode would keep retrying the same now-dead refresh token on every call, forever
- Refreshes directly via `POST https://claude.ai/v1/oauth/token` using the runtime's own `fetch` (no LLM tokens consumed, no subprocess); falls back to the `claude` CLI only within the window where Claude Code will actually rotate the token, and writes new tokens back to Keychain (macOS) or the credentials file (Linux/Windows) to keep stored credentials in sync
- Retries API requests on 429 (rate limit) and 529 (overloaded) with exponential backoff, respecting `retry-after` headers
- On a 401, recovers in place rather than surfacing it: adopts an externally rotated token if the keychain now holds one, otherwise forces an OAuth refresh, then retries the request
- If credentials aren't OAuth-based, the connection falls through to standard API key auth
- If credentials are unavailable or unreadable, the plugin logs the error and OpenCode continues without a Claude Code auth connection

## Disclaimer

This plugin uses Claude Code's OAuth credentials to authenticate with Anthropic's API. Anthropic's Terms of Service state that Claude Pro/Max subscription tokens should only be used with official Anthropic clients. This plugin exists as a community workaround and may stop working if Anthropic changes their OAuth infrastructure. Use at your own discretion.

## License

MIT
