#!/bin/sh
set -eu

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/home"
printf '#!/bin/sh\nexit 44\n' > "$tmp/bin/security"
chmod +x "$tmp/bin/security"

HOME="$tmp/home" CLAUDE_CONFIG_DIR="$tmp/home/.claude" \
  PATH="$tmp/bin:$PATH" pnpm test
