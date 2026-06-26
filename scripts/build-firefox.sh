#!/usr/bin/env bash
#
# Assemble the Firefox build of the YT Bridge extension into firefox/dist/.
#
# Single source of truth: the content scripts and background.js live in the Safari
# extension's Resources (YTBridge Extension/Resources/) — the very same files Safari ships.
# This script copies them verbatim and adds the two Firefox-only files: manifest.json (the
# Firefox MV3 manifest) and firefox-config.js (the loopback transport shim that points
# background.js at the host's ingest instead of a Safari containing app).
#
# So a fix to a scraper or to the relay logic is made ONCE, in the Resources, and both
# browsers pick it up — Safari at its next build, Firefox at the next run of this script.
#
# Load the result in Firefox (no signing needed, Release channel is fine):
#   about:debugging#/runtime/this-firefox  ->  Load Temporary Add-on  ->  firefox/dist/manifest.json
# The temporary add-on is dropped when Firefox restarts; re-load it each session.
#
# Usage: scripts/build-firefox.sh
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RES="$REPO/YTBridge/YTBridge Extension/Resources"
SRC="$REPO/firefox/src"
DIST="$REPO/firefox/dist"

# Fail loudly if the canonical source moved, rather than shipping a half-empty bundle.
for f in "background.js" "common.js" "content/youtube.js" "content/ytmusic.js" "content/page-mediasession.js"; do
  [ -f "$RES/$f" ] || { echo "✗ missing shared source: $RES/$f" >&2; exit 1; }
done
for f in "manifest.json" "firefox-config.js"; do
  [ -f "$SRC/$f" ] || { echo "✗ missing Firefox source: $SRC/$f" >&2; exit 1; }
done

echo "▸ Clean firefox/dist/…"
rm -rf "$DIST"
mkdir -p "$DIST/content"

echo "▸ Copy shared sources (canonical in the Safari Resources)…"
cp "$RES/background.js"                  "$DIST/background.js"
cp "$RES/common.js"                      "$DIST/common.js"
cp "$RES/content/youtube.js"             "$DIST/content/youtube.js"
cp "$RES/content/ytmusic.js"             "$DIST/content/ytmusic.js"
# Registered dynamically (MAIN world) by background.js, so it must be in the bundle but is
# not listed in manifest content_scripts.
cp "$RES/content/page-mediasession.js"   "$DIST/content/page-mediasession.js"

echo "▸ Copy Firefox-only files…"
cp "$SRC/manifest.json"                  "$DIST/manifest.json"
cp "$SRC/firefox-config.js"              "$DIST/firefox-config.js"

# Best-effort syntax gate so a broken copy never reaches Firefox silently.
if command -v node >/dev/null 2>&1; then
  echo "▸ Syntax-check assembled JS…"
  for j in background.js common.js firefox-config.js content/youtube.js content/ytmusic.js content/page-mediasession.js; do
    node --check "$DIST/$j"
  done
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$DIST/manifest.json"
else
  echo "⚠ node not found — skipped the JS/JSON syntax check (install Node to enable it)" >&2
fi

echo "✅ Built $DIST"
echo "   Load it: about:debugging#/runtime/this-firefox → Load Temporary Add-on → firefox/dist/manifest.json"
echo "   The YTBridge host must be running (JellyBeat launches it) for the bridge to answer."
