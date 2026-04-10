# opencode-claude-auth

[![npm](https://img.shields.io/npm/v/opencode-claude-auth)](https://www.npmjs.com/package/opencode-claude-auth)
[![CI](https://github.com/griffinmartin/opencode-claude-auth/actions/workflows/ci.yml/badge.svg)](https://github.com/griffinmartin/opencode-claude-auth/actions/workflows/ci.yml)
[![Socket Badge](https://socket.dev/api/badge/npm/package/opencode-claude-auth)](https://socket.dev/npm/package/opencode-claude-auth)

Self-contained Anthropic auth provider for OpenCode using your Claude Code credentials — no separate login or API key needed.

## How it works

The plugin registers its own auth provider with a custom fetch handler that intercepts all Anthropic API requests. It reads OAuth tokens from the macOS Keychain (or `~/.claude/.credentials.json` on other platforms), caches them in memory with a 30-second TTL, and handles the full request lifecycle — no builtin Anthropic auth plugin required. On macOS, multiple Claude Code accounts are detected automatically and can be switched via `opencode auth login`.

It also syncs credentials to OpenCode's `auth.json` as a fallback (on Windows, it writes to both `%USERPROFILE%\.local\share\opencode\auth.json` and `%LOCALAPPDATA%\opencode\auth.json` to cover all installation methods). If a token is near expiry, it refreshes directly via Anthropic's OAuth endpoint (zero LLM tokens consumed), falling back to the Claude CLI if the direct refresh fails. Background re-sync runs every 5 minutes.

## Prerequisites

- Claude Code installed and authenticated (run `claude` at least once)
- OpenCode installed

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
     "plugin": ["opencode-claude-auth@latest"]
   }
   ```

   > The `@latest` tag ensures OpenCode always pulls the newest version on startup. No manual `npm install` is needed — OpenCode [automatically installs npm plugins using Bun at startup](https://opencode.ai/docs/plugins/#how-plugins-are-installed).

2. **Use it** — just run OpenCode. The plugin handles auth automatically using your Claude Code credentials.

**For LLM Agents**

See [installation.md](installation.md) for step-by-step agent instructions.

## Usage

Just run OpenCode. The plugin handles auth automatically — it reads your Claude Code credentials, provides them to the Anthropic API, and refreshes them in the background. If your credentials aren't OAuth-based, the plugin falls through to standard API key auth.

## Supported models

15 supported models. Run `pnpm run test:models` to verify against your account.

| Model                      |
| -------------------------- |
| claude-3-haiku-20240307    |
| claude-haiku-4-5           |
| claude-haiku-4-5-20251001  |
| claude-opus-4-0            |
| claude-opus-4-1            |
| claude-opus-4-1-20250805   |
| claude-opus-4-20250514     |
| claude-opus-4-5            |
| claude-opus-4-5-20251101   |
| claude-opus-4-6            |
| claude-sonnet-4-0          |
| claude-sonnet-4-20250514   |
| claude-sonnet-4-5          |
| claude-sonnet-4-5-20250929 |
| claude-sonnet-4-6          |

## Credential sources

The plugin checks these in order:

1. macOS Keychain (all `Claude Code-credentials*` entries — multiple accounts are detected automatically)
2. `~/.claude/.credentials.json` (fallback, works on all platforms)

## Multiple accounts (macOS)

If you have [multiple Claude Code accounts](https://gist.github.com/KMJ-007/0979814968722051620461ab2aa01bf2) authenticated on macOS, the plugin detects all of them from the Keychain automatically. Each account is labeled by its subscription tier (Claude Pro, Claude Max, etc.).

To switch accounts:

```bash
opencode auth login
```

Select "Switch Claude Code account" and pick the account you want to use. Your selection is persisted across sessions.

If only one account is found, the switcher is hidden and the plugin uses it directly.

## Troubleshooting

| Problem                                             | Solution                                                                                                           |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| "Credentials not found"                             | Run `claude` to authenticate with Claude Code first                                                                |
| "Keychain is locked"                                | Run `security unlock-keychain ~/Library/Keychains/login.keychain-db`                                               |
| "Token expired and refresh failed"                  | The plugin runs `claude` CLI to refresh automatically. If this fails, re-authenticate manually by running `claude` |
| Not working on Linux/Windows                        | Ensure `~/.claude/.credentials.json` exists. Run `claude` to create it                                             |
| Keychain access denied                              | Grant access when macOS prompts you                                                                                |
| Keychain read timed out                             | Restart Keychain Access (can happen on macOS Tahoe)                                                                |
| "Credentials are unavailable or expired"            | Run `claude` to refresh your Claude Code credentials                                                               |
| "Extra usage is required for long context requests" | Your conversation exceeded 200k tokens. See [Long context (1M)](#long-context-1m) below                            |
| Plugin not updating to latest version               | Delete the cached package: `rm -rf ~/.cache/opencode/packages/opencode-claude-auth@latest/` then restart OpenCode  |

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

The `context-1m-2025-08-07` beta header is not sent by default. Without it, the API caps context at 200k tokens.

To enable 1M context (requires Claude Max or a plan with extra usage coverage), use **either** of these methods:

**Option A: Config file** (recommended — no environment setup needed)

Add `enable1mContext` to any agent in your `opencode.json` (project-level or `~/.config/opencode/opencode.json`). Setting it in any one agent enables 1M context globally for all supported models — you don't need to set it for each agent:

```json
{
  "plugin": ["opencode-claude-auth@latest"],
  "agent": {
    "build": {
      "enable1mContext": true
    }
  }
}
```

**Option B: Environment variable**

```bash
export ANTHROPIC_ENABLE_1M_CONTEXT=true
```

If both are set, the environment variable takes priority.

The Claude CLI itself treats 1M context as opt-in (via a `[1m]` model suffix). Sending the beta without a plan that covers long context charges causes "Extra usage is required for long context requests" errors. Versions before 0.8.0 sent this beta automatically for 4.6+ models, which broke things for Pro users ([#64](https://github.com/griffinmartin/opencode-claude-auth/issues/64)).

If a long context error still occurs (e.g. from a beta flag added via `ANTHROPIC_BETA_FLAGS`), the plugin retries without the offending flag.

## Validating OAuth refresh

To verify the direct OAuth token refresh works with your credentials:

```bash
pnpm run validate:oauth           # refresh + write-back (safe, keeps credentials valid)
pnpm run validate:oauth -- --dry-run  # show what would be sent without making the request
```

This reads your stored credentials, calls Anthropic's OAuth token endpoint, and writes the new tokens back to storage. Refresh tokens rotate on each use, so write-back is enabled by default to keep your stored credentials valid.

## Environment variable overrides

All configurable parameters can be overridden via environment variables. If Anthropic changes something before we publish an update, set an env var and keep working:

| Variable                      | Description                                                                | Default                                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_CLI_VERSION`       | Claude CLI version for user-agent and billing headers                      | `2.1.80`                                                                                                |
| `ANTHROPIC_USER_AGENT`        | Full User-Agent string (overrides CLI version)                             | `claude-cli/{version} (external, cli)`                                                                  |
| `ANTHROPIC_BETA_FLAGS`        | Comma-separated beta feature flags                                         | `claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05` |
| `ANTHROPIC_ENABLE_1M_CONTEXT` | Enable 1M token context window for 4.6+ models (requires Max subscription) | `false`                                                                                                 |
| `CLAUDE_AUTH_DEBUG`           | Enable diagnostic logging (`1` for default path, or a custom file path)    | disabled                                                                                                |

Example:

```bash
export ANTHROPIC_CLI_VERSION=2.2.0
export ANTHROPIC_ENABLE_1M_CONTEXT=true  # requires Claude Max
```

## How it works (technical)

- Registers an `auth.loader` with a custom `fetch` that intercepts all Anthropic API requests
- Sets `Authorization: Bearer` with fresh OAuth tokens (cached in memory, 30s TTL, updated in-place after refresh)
- Translates tool names between OpenCode and Anthropic API formats (adds/strips `mcp_` prefix)
- Buffers SSE response streams at event boundaries for reliable tool name translation
- Injects Claude Code identity into system prompts via `experimental.chat.system.transform`
- Sets required API headers (beta flags, billing, user-agent) with model-aware selection
- On macOS, enumerates all `Claude Code-credentials*` Keychain entries and labels them by subscription tier
- Provides an account switcher via `opencode auth login` when multiple accounts are found; persists selection to `~/.local/share/opencode/claude-account-source.txt`
- Syncs credentials to `auth.json` on startup and every 5 minutes as a fallback (sync never triggers refresh; refresh is lazy, only on API requests)
- On Windows, writes to both `%USERPROFILE%\.local\share\opencode\auth.json` and `%LOCALAPPDATA%\opencode\auth.json`
- Retries API requests on 429 (rate limit) and 529 (overloaded) with exponential backoff, respecting `retry-after` headers
- When a token is within 60 seconds of expiry, refreshes directly via `POST https://claude.ai/v1/oauth/token` (no LLM tokens consumed). Falls back to `claude` CLI if the direct refresh fails. New tokens are written back to Keychain (macOS) or credentials file (Linux/Windows) to keep stored credentials in sync with rotated refresh tokens
- If credentials aren't OAuth-based, the auth loader returns `{}` and falls through to API key auth
- If credentials are unavailable or unreadable, the plugin disables itself and OpenCode continues without Claude auth

## Disclaimer

This plugin uses Claude Code's OAuth credentials to authenticate with Anthropic's API. Anthropic's Terms of Service state that Claude Pro/Max subscription tokens should only be used with official Anthropic clients. This plugin exists as a community workaround and may stop working if Anthropic changes their OAuth infrastructure. Use at your own discretion.

## License

MIT
