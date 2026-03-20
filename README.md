# opencode-claude-auth

[![npm](https://img.shields.io/npm/v/opencode-claude-auth)](https://www.npmjs.com/package/opencode-claude-auth)
[![CI](https://github.com/griffinmartin/opencode-claude-auth/actions/workflows/ci.yml/badge.svg)](https://github.com/griffinmartin/opencode-claude-auth/actions/workflows/ci.yml)
[![Socket Badge](https://socket.dev/api/badge/npm/package/opencode-claude-auth)](https://socket.dev/npm/package/opencode-claude-auth)

OpenCode plugin that uses your existing Claude Code credentials — no separate login needed.

## How it works

Claude Code stores OAuth tokens in the macOS Keychain (or `~/.claude/.credentials.json` on other platforms). This plugin reads those tokens and writes them to OpenCode's `~/.local/share/opencode/auth.json`, so you don't need to log in twice. It re-syncs every 5 minutes to pick up token refreshes. If a token is near expiry, it runs the Claude CLI to trigger a refresh.

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

Just run OpenCode. The plugin syncs your Claude Code credentials to OpenCode's auth.json and refreshes them in the background.

## Credential sources

The plugin checks these in order:

1. macOS Keychain ("Claude Code-credentials" entry)
2. `~/.claude/.credentials.json` (fallback, works on all platforms)

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Credentials not found" | Run `claude` to authenticate with Claude Code first |
| "Keychain is locked" | Run `security unlock-keychain ~/Library/Keychains/login.keychain-db` |
| "Token expired and refresh failed" | The plugin runs `claude` CLI to refresh automatically. If this fails, re-authenticate manually by running `claude` |
| Not working on Linux/Windows | Ensure `~/.claude/.credentials.json` exists. Run `claude` to create it |
| Keychain access denied | Grant access when macOS prompts you |
| Keychain read timed out | Restart Keychain Access (can happen on macOS Tahoe) |

## How it works (technical)

- Reads OAuth tokens from macOS Keychain (`Claude Code-credentials` entry) or `~/.claude/.credentials.json` fallback
- Writes an `anthropic` entry to `~/.local/share/opencode/auth.json` in OpenCode's native OAuth format
- Preserves other provider entries already in auth.json
- Re-syncs credentials every 5 minutes in the background
- When a token is within 60 seconds of expiry, runs `claude` CLI to trigger a refresh
- If credentials are unavailable or unreadable, the plugin disables itself and OpenCode continues without Claude auth

## License

MIT
