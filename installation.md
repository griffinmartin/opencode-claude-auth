# Install opencode-claude-auth

These instructions are designed for AI coding agents. This version requires **OpenCode 2** — it will not load on OpenCode 1.

## Prerequisites

Before installing, verify you have OpenCode 2 and Claude Code installed and authenticated.

### Check OpenCode version

```bash
opencode --version
```

You need an OpenCode 2 build. See the [OpenCode 2 migration guide](https://opencode.ai/v2/docs/migrate-v1) if you're still on an OpenCode 1 build (`1.x`).

### Check Claude Code credentials (macOS)

```bash
security find-generic-password -s "Claude Code-credentials" -w
```

If this returns credentials, you're authenticated. If it fails or returns nothing, try the fallback:

### Check Claude Code credentials (fallback for all platforms)

```bash
cat ~/.claude/.credentials.json
```

If this file exists and contains valid JSON, you're authenticated. If `CLAUDE_CONFIG_DIR` is set, check `$CLAUDE_CONFIG_DIR/.credentials.json` instead.

### If credentials don't exist

Run Claude Code to authenticate:

```bash
claude
```

This will prompt you to log in and store credentials in Keychain (macOS) or `~/.claude/.credentials.json` (other platforms; `$CLAUDE_CONFIG_DIR/.credentials.json` if `CLAUDE_CONFIG_DIR` is set).

## Installation

### Step 1: Add to OpenCode configuration

Edit the OpenCode configuration file at `~/.config/opencode/opencode.json`.

Add `opencode-claude-auth@latest` to the `plugins` array:

```json
{
  "plugins": ["opencode-claude-auth@latest"]
}
```

> OpenCode 2 uses the `plugins` key (plural). OpenCode 1 used `plugin` (singular) — using the wrong key for your OpenCode version means the plugin silently never loads.

Or run this command to do it automatically:

```bash
node -e "
const fs = require('fs'), p = require('path').join(require('os').homedir(), '.config/opencode/opencode.json');
const c = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p,'utf8')) : {};
c.plugins = [...new Set([...(Array.isArray(c.plugins) ? c.plugins : []), 'opencode-claude-auth@latest'])];
fs.mkdirSync(require('path').dirname(p), {recursive:true});
fs.writeFileSync(p, JSON.stringify(c, null, 2));
console.log('Added opencode-claude-auth@latest to', p);
"
```

The `@latest` tag ensures OpenCode always pulls the newest version on startup. No manual `npm install` is needed — OpenCode [automatically installs npm plugins using Bun at startup](https://opencode.ai/docs/plugins/#how-plugins-are-installed).

### Step 2: Connect it

Restart OpenCode, then in the TUI run `/connect`, choose **Anthropic**, and select **Import Claude Code subscription**. Existing Claude Code credentials in the Keychain, `~/.claude/.credentials.json`, or `$CLAUDE_CONFIG_DIR/.credentials.json` are imported without another browser login.

Use `/models` and pick a model under **Anthropic**.

### Step 3: Verification

Verify the plugin was added:

```bash
cat ~/.config/opencode/opencode.json
```

You should see `opencode-claude-auth@latest` in the `plugins` array. You can also confirm the plugin loaded with:

```bash
opencode plugin list
```

The list should contain `griffinmartin.claude-auth`.

## Upgrading

If the plugin isn't picking up a new version, clear the cached package and restart OpenCode:

```bash
rm -rf ~/.cache/opencode/packages/opencode-claude-auth@latest/
```

## Migrating from OpenCode 1

If you were previously running this plugin under OpenCode 1, this version drops OpenCode 1 support entirely — it targets OpenCode 2's plugin and auth APIs, which are not compatible with OpenCode 1. If you still need OpenCode 1, pin `opencode-claude-auth` to a version prior to this change instead of tracking `@latest`.

The old OpenCode 1 connection isn't reused. Run `claude` if Claude Code isn't already signed in, restart OpenCode 2, then follow [Step 2](#step-2-connect-it) above to reconnect.

## Done

The plugin is now installed and connected. When you run OpenCode, it will automatically use your Claude Code subscription credentials — no separate login needed.

## Troubleshooting

If you encounter issues, see the [main README troubleshooting section](README.md#troubleshooting).
