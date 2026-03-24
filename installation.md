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

### Add to OpenCode configuration

Run this command to add the plugin to your `opencode.json`:

```bash
node -e "
const fs = require('fs'), p = require('path').join(require('os').homedir(), '.config/opencode/opencode.json');
const c = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p,'utf8')) : {};
c.plugin = [...new Set([...(Array.isArray(c.plugin) ? c.plugin : []), 'opencode-claude-auth'])];
fs.mkdirSync(require('path').dirname(p), {recursive:true});
fs.writeFileSync(p, JSON.stringify(c, null, 2));
console.log('Added opencode-claude-auth to', p);
"
```

This command:

- Reads your existing `opencode.json` (or creates a new one)
- Adds `opencode-claude-auth` to the `plugin` array
- Deduplicates plugins using a Set
- Writes the updated config back

No manual `npm install` is needed — OpenCode [automatically installs npm plugins using Bun at startup](https://opencode.ai/docs/plugins/#how-plugins-are-installed).

## Verification

Verify the plugin was added:

```bash
cat ~/.config/opencode/opencode.json
```

You should see `opencode-claude-auth` in the `plugin` array:

```json
{
  "plugin": ["opencode-claude-auth"]
}
```

## Done

The plugin is now installed and configured. When you run OpenCode, it will automatically use your Claude Code credentials — no separate login needed.

## Troubleshooting

If you encounter issues, see the [main README troubleshooting section](README.md#troubleshooting).
