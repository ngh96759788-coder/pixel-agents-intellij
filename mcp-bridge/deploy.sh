#!/bin/bash
# Build the bridge AND push it straight into Claude Desktop's installed
# extension directory, so the running Desktop widget picks up new code
# on its next restart.
#
# Why this exists: `npm run pack` only produces the .mcpb. Re-installing
# that .mcpb through the Desktop UI is unreliable when the version number
# hasn't changed — Desktop treats "same version" as "already installed"
# and skips overwriting the extracted copy under
# ~/Library/Application Support/.../Claude Extensions/. The widget then
# keeps running stale code no matter how many times you rebuild, which
# wasted a lot of debugging cycles. Copying the freshly-built artifacts
# in directly removes that whole class of "fixed it but nothing changed"
# confusion.
#
# After running this you STILL must restart Claude Desktop (Cmd+Q then
# reopen) so it respawns the MCP server process with the new code on
# disk — a running Node process won't hot-reload.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
EXTDIR="$HOME/Library/Application Support/Claude/Claude Extensions/local.mcpb.pixel-agents.pixel-agents-bridge"

npm --prefix "$DIR" run pack

if [ ! -d "$EXTDIR" ]; then
  echo "⚠ Extension dir not found — is the bridge installed in Claude Desktop?"
  echo "  Expected: $EXTDIR"
  exit 1
fi

cp -f "$DIR/server/index.mjs" "$EXTDIR/server/index.mjs"
# --delete drops hashed bundles from earlier syncs; index.html only
# references the current one.
rsync -a --delete "$DIR/web/" "$EXTDIR/web/"

EXT_SHA=$(shasum -a 256 "$EXTDIR/server/index.mjs" | cut -c1-16)
SRC_SHA=$(shasum -a 256 "$DIR/server/index.mjs" | cut -c1-16)
VERSION=$(node -p "require('$DIR/package.json').version")
echo ""
echo "version: $VERSION"
echo "ext SHA: $EXT_SHA"
echo "src SHA: $SRC_SHA"
if [ "$EXT_SHA" != "$SRC_SHA" ]; then
  echo "✗ SHA mismatch after copy — check permissions on $EXTDIR"
  exit 1
fi
echo "✓ Extension dir synced (file-level)."

# Critical warning the user keeps forgetting: a direct file sync is
# only valid until the next Claude Desktop restart, because Desktop
# re-extracts its registered .mcpb back into the Extension Dir on
# startup. The ONLY way to make new code stick across restarts is to
# bump version + properly install the .mcpb via the Desktop UI.
echo ""
echo "──────────────────────────────────────────────────────────────────"
echo "⚠ This direct sync is TEMPORARY — Claude Desktop will roll it"
echo "  back on its next restart unless the installed registration is"
echo "  updated. For a permanent install:"
echo ""
echo "    1. Claude Desktop > Settings > Extensions"
echo "    2. \"Pixel Office Bridge\" → Remove"
echo "    3. Finder: double-click the new .mcpb file:"
echo "       $DIR/pixel-agents-bridge-$VERSION.mcpb"
echo "    4. Quit Claude Desktop completely (Cmd+Q) and reopen."
echo ""
echo "After restart, verify the running process matches by either:"
echo "  • calling the office_diagnose MCP tool, or"
echo "  • tailing ~/Library/Logs/Claude/\"mcp-server-Pixel Office Bridge.log\""
echo "    and looking for: '[pixel-bridge] boot v$VERSION pid=… started=…'"
echo "──────────────────────────────────────────────────────────────────"
