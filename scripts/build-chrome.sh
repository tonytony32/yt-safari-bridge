#!/usr/bin/env bash
#
# Assemble the Chrome build of the YT Bridge extension into chrome/dist/.
#
# Single source of truth: the content scripts and background.js live in the Safari extension's
# Resources (YTBridge Extension/Resources/) — the very same files Safari and Firefox ship. This
# script copies them verbatim and adds the Chrome-only files: manifest.json, the service-worker
# bootstrap (sw-bootstrap.js), the namespace shim (chrome-shim.js, which aliases browser→chrome),
# and the loopback transport config (chrome-config.js).
#
# So a fix to a scraper or to the relay logic is made ONCE, in the Resources, and all three
# browsers pick it up — Safari at its next build, Firefox/Chrome at the next run of their build.
#
# Load the result in Chrome (no signing needed for development):
#   chrome://extensions  ->  enable Developer mode  ->  Load unpacked  ->  pick chrome/dist/
#
# Usage: scripts/build-chrome.sh
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RES="$REPO/YTBridge/YTBridge Extension/Resources"
SRC="$REPO/chrome/src"
DIST="$REPO/chrome/dist"

# Fail loudly if the canonical source moved, rather than shipping a half-empty bundle.
for f in "background.js" "common.js" "content/youtube.js" "content/ytmusic.js" "content/page-mediasession.js"; do
  [ -f "$RES/$f" ] || { echo "✗ missing shared source: $RES/$f" >&2; exit 1; }
done
for f in "manifest.json" "chrome-shim.js" "chrome-config.js" "sw-bootstrap.js"; do
  [ -f "$SRC/$f" ] || { echo "✗ missing Chrome source: $SRC/$f" >&2; exit 1; }
done

echo "▸ Clean chrome/dist/…"
rm -rf "$DIST"
mkdir -p "$DIST/content"

echo "▸ Copy shared sources (canonical in the Safari Resources)…"
cp "$RES/background.js"                  "$DIST/background.js"
cp "$RES/common.js"                      "$DIST/common.js"
cp "$RES/content/youtube.js"             "$DIST/content/youtube.js"
cp "$RES/content/ytmusic.js"             "$DIST/content/ytmusic.js"
# Registered dynamically (MAIN world) by background.js, so it must be in the bundle but is not
# listed in manifest content_scripts and needs no web_accessible_resources.
cp "$RES/content/page-mediasession.js"   "$DIST/content/page-mediasession.js"

echo "▸ Copy Chrome-only files…"
cp "$SRC/manifest.json"                  "$DIST/manifest.json"
cp "$SRC/chrome-shim.js"                 "$DIST/chrome-shim.js"
cp "$SRC/chrome-config.js"               "$DIST/chrome-config.js"
cp "$SRC/sw-bootstrap.js"                "$DIST/sw-bootstrap.js"

# Best-effort syntax gate so a broken copy never reaches Chrome silently.
if command -v node >/dev/null 2>&1; then
  echo "▸ Syntax-check assembled JS…"
  for j in background.js common.js chrome-shim.js chrome-config.js sw-bootstrap.js \
           content/youtube.js content/ytmusic.js content/page-mediasession.js; do
    node --check "$DIST/$j"
  done
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$DIST/manifest.json"
else
  echo "⚠ node not found — skipped the JS/JSON syntax check (install Node to enable it)" >&2
fi

echo "✅ Built $DIST"
echo "   Load it: chrome://extensions → Developer mode → Load unpacked → chrome/dist/"
echo "   The YTBridge host must be running (JellyBeat launches it) for the bridge to answer."
