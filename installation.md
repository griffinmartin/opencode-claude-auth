# Install opencode-claude-auth

These instructions are designed for AI coding agents.

## Prerequisites

Before installing, verify you have OpenCode and Claude Code installed and authenticated.

### Check OpenCode version

```bash
opencode --version
```

You should see a version number (e.g., `1.2.28`).

### Check Claude Code credentials (macOS)

```bash
security find-generic-password -s "Claude Code-credentials" -w
```

If this returns credentials, you're authenticated. If it fails or returns nothing, try the fallback:

### Check Claude Code credentials (fallback for all platforms)

```bash
cat ~/.claude/.credentials.json
```

If this file exists and contains valid JSON, you're authenticated.

### If credentials don't exist

Run Claude Code to authenticate:

```bash
claude
```

This will prompt you to log in and store credentials in Keychain (macOS) or `~/.claude/.credentials.json` (other platforms).

## Installation

### Step 1: Add to OpenCode configuration

Edit the OpenCode configuration file at `~/.config/opencode/opencode.json`.

Add `opencode-claude-auth@latest` to the `plugin` array:

```json
{
  "plugin": ["opencode-claude-auth@latest"]
}
```

Or run this command to do it automatically:

```bash
node -e "
const fs = require('fs'), p = require('path').join(require('os').homedir(), '.config/opencode/opencode.json');
const c = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p,'utf8')) : {};
c.plugin = [...new Set([...(Array.isArray(c.plugin) ? c.plugin : []), 'opencode-claude-auth@latest'])];
fs.mkdirSync(require('path').dirname(p), {recursive:true});
fs.writeFileSync(p, JSON.stringify(c, null, 2));
console.log('Added opencode-claude-auth@latest to', p);
"
```

The `@latest` tag ensures OpenCode always pulls the newest version on startup. No manual `npm install` is needed — OpenCode [automatically installs npm plugins using Bun at startup](https://opencode.ai/docs/plugins/#how-plugins-are-installed).

### Step 2: Verification

Verify the plugin was added:

```bash
cat ~/.config/opencode/opencode.json
```

You should see `opencode-claude-auth@latest` in the `plugin` array.

## Upgrading

If you previously installed `opencode-claude-auth` without the `@latest` tag, update your config to use `opencode-claude-auth@latest` as shown above.

If the plugin isn't picking up a new version, clear the cached package and restart OpenCode:

```bash
rm -rf ~/.cache/opencode/packages/opencode-claude-auth@latest/
```

## Done

The plugin is now installed and configured. When you run OpenCode, it will automatically use your Claude Code credentials — no separate login needed.

## Troubleshooting

If you encounter issues, see the [main README troubleshooting section](README.md#troubleshooting).
