# opencode-claude-auth

[![npm](https://img.shields.io/npm/v/opencode-claude-auth)](https://www.npmjs.com/package/opencode-claude-auth)
[![CI](https://github.com/griffinmartin/opencode-claude-auth/actions/workflows/ci.yml/badge.svg)](https://github.com/griffinmartin/opencode-claude-auth/actions/workflows/ci.yml)
[![Socket Badge](https://socket.dev/api/badge/npm/package/opencode-claude-auth)](https://socket.dev/npm/package/opencode-claude-auth)

Self-contained Anthropic auth provider for OpenCode using your Claude Code credentials — no separate login or API key needed.

## How it works

The plugin registers its own auth provider with a custom fetch handler that intercepts all Anthropic API requests. It reads OAuth tokens from the macOS Keychain (or `~/.claude/.credentials.json` on other platforms), caches them in memory with a 30-second TTL, and handles the full request lifecycle — no builtin Anthropic auth plugin required.

It also syncs credentials to OpenCode's `auth.json` as a fallback (on Windows, it writes to both `%USERPROFILE%\.local\share\opencode\auth.json` and `%LOCALAPPDATA%\opencode\auth.json` to cover all installation methods). If a token is near expiry, it runs the Claude CLI to trigger a refresh. Background re-sync runs every 5 minutes.

## Prerequisites

- Claude Code installed and authenticated (run `claude` at least once)
- OpenCode installed

macOS is preferred (uses Keychain). Linux and Windows work via the credentials file fallback.

## Installation

### Install with AI

Paste this into your AI agent (Claude Code, Cursor, Copilot, etc.):

```
Fetch https://raw.githubusercontent.com/griffinmartin/opencode-claude-auth/main/installation.md and follow every step exactly as written.
```

### Install with Homebrew (macOS)

```bash
brew tap griffinmartin/opencode-claude-auth https://github.com/griffinmartin/opencode-claude-auth.git
brew install opencode-claude-auth
```

Then add to the `plugin` array in your `opencode.json`:

```json
{
  "plugin": ["opencode-claude-auth"]
}
```

### Manual install

```bash
npm install -g opencode-claude-auth
```

Then add to the `plugin` array in your `opencode.json`:

```json
{
  "plugin": ["opencode-claude-auth"]
}
```

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

1. macOS Keychain ("Claude Code-credentials" entry)
2. `~/.claude/.credentials.json` (fallback, works on all platforms)

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

## Long context (1M)

The `context-1m-2025-08-07` beta header is not sent by default. Without it, the API caps context at 200k tokens.

To enable 1M context (requires Claude Max or a plan with extra usage coverage):

```bash
export ANTHROPIC_ENABLE_1M_CONTEXT=true
```

The Claude CLI itself treats 1M context as opt-in (via a `[1m]` model suffix). Sending the beta without a plan that covers long context charges causes "Extra usage is required for long context requests" errors. Versions before 0.8.0 sent this beta automatically for 4.6+ models, which broke things for Pro users ([#64](https://github.com/griffinmartin/opencode-claude-auth/issues/64)).

If a long context error still occurs (e.g. from a beta flag added via `ANTHROPIC_BETA_FLAGS`), the plugin retries without the offending flag.

## Environment variable overrides

All configurable parameters can be overridden via environment variables. If Anthropic changes something before we publish an update, set an env var and keep working:

| Variable                      | Description                                                                | Default                                                                                                 |
| ----------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `ANTHROPIC_CLI_VERSION`       | Claude CLI version for user-agent and billing headers                      | `2.1.80`                                                                                                |
| `ANTHROPIC_USER_AGENT`        | Full User-Agent string (overrides CLI version)                             | `claude-cli/{version} (external, cli)`                                                                  |
| `ANTHROPIC_BETA_FLAGS`        | Comma-separated beta feature flags                                         | `claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,prompt-caching-scope-2026-01-05` |
| `ANTHROPIC_ENABLE_1M_CONTEXT` | Enable 1M token context window for 4.6+ models (requires Max subscription) | `false`                                                                                                 |

Example:

```bash
export ANTHROPIC_CLI_VERSION=2.2.0
export ANTHROPIC_ENABLE_1M_CONTEXT=true  # requires Claude Max
```

## How it works (technical)

- Registers an `auth.loader` with a custom `fetch` that intercepts all Anthropic API requests
- Sets `Authorization: Bearer` with fresh OAuth tokens (cached in memory, 30s TTL)
- Translates tool names between OpenCode and Anthropic API formats (adds/strips `mcp_` prefix)
- Buffers SSE response streams at event boundaries for reliable tool name translation
- Injects Claude Code identity into system prompts via `experimental.chat.system.transform`
- Sets required API headers (beta flags, billing, user-agent) with model-aware selection
- Syncs credentials to `auth.json` on startup and every 5 minutes as a fallback
- On Windows, writes to both `%USERPROFILE%\.local\share\opencode\auth.json` and `%LOCALAPPDATA%\opencode\auth.json`
- Retries API requests on 429 (rate limit) and 529 (overloaded) with exponential backoff, respecting `retry-after` headers
- When a token is within 60 seconds of expiry, runs `claude` CLI to trigger a refresh (with one automatic retry)
- If credentials aren't OAuth-based, the auth loader returns `{}` and falls through to API key auth
- If credentials are unavailable or unreadable, the plugin disables itself and OpenCode continues without Claude auth

## Disclaimer

This plugin uses Claude Code's OAuth credentials to authenticate with Anthropic's API. Anthropic's Terms of Service state that Claude Pro/Max subscription tokens should only be used with official Anthropic clients. This plugin exists as a community workaround and may stop working if Anthropic changes their OAuth infrastructure. Use at your own discretion.

## License

MIT
