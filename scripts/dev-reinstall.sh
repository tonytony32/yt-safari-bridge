#!/usr/bin/env bash
#
# Clean rebuild + reinstall of YTBridge.
#
# The golden rule that keeps Safari from showing duplicate extensions:
#   there must be exactly ONE YTBridge.app on disk that LaunchServices knows
#   about — the one in /Applications. Every xcodebuild leaves a second copy in
#   the build/ dir and registers it, which is what spawns the duplicate
#   "YT Bridge" entries. So this script installs the fresh build into
#   /Applications and then deletes the build/ copy entirely.
#
# Usage:
#   scripts/dev-reinstall.sh            # Release (default)
#   scripts/dev-reinstall.sh Debug      # Debug build instead
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJ="$REPO/YTBridge/YTBridge.xcodeproj"
CONFIG="${1:-Release}"
DERIVED="$REPO/YTBridge/build"
APP_SRC="$DERIVED/Build/Products/$CONFIG/YTBridge.app"
APP_DST="/Applications/YTBridge.app"
LSREG="/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister"
LOG="/tmp/ytbridge-build.log"

echo "▸ Quitting the running app…"
osascript -e 'quit app "YTBridge"' 2>/dev/null || true
sleep 1

echo "▸ Building $CONFIG (log: $LOG)…"
if ! xcodebuild -project "$PROJ" -scheme YTBridge -configuration "$CONFIG" \
      -derivedDataPath "$DERIVED" -allowProvisioningUpdates \
      clean build >"$LOG" 2>&1; then
  echo "✗ BUILD FAILED — last 25 lines:"
  tail -25 "$LOG"
  exit 1
fi

echo "▸ Installing into /Applications (clean replace, no stale files)…"
rm -rf "$APP_DST"
ditto "$APP_SRC" "$APP_DST"

echo "▸ Removing the build copy so Safari only ever sees the /Applications one…"
"$LSREG" -u "$APP_SRC" 2>/dev/null || true
rm -rf "$DERIVED"

echo "▸ Registering & launching the installed copy…"
"$LSREG" -f "$APP_DST"
# In normal use JellyBeat launches the host (and quits it on exit). Here we launch it with
# --standalone so it stays up for local verification without JellyBeat running.
open "$APP_DST" --args --standalone
sleep 2

echo "▸ Verifying…"
codesign --verify --strict "$APP_DST" && echo "  ✓ signature valid"
COUNT=$(pluginkit -mAv 2>/dev/null | grep -c "com.trypwood.ytbridge.Extension" || true)
echo "  registered extension copies: $COUNT  (must be 1)"
pluginkit -mAv 2>/dev/null | grep "com.trypwood.ytbridge.Extension" || true

cat <<'EOF'

✅ Installed. The YTBridge app is a headless host (no Dock icon, no window, no menu bar) that
   owns the bridge socket. It is NOT a login item — in normal use JellyBeat launches it when
   JellyBeat opens and quits it when JellyBeat closes, so the bridge runs exactly while
   JellyBeat runs. (This script launched it with --standalone so you can verify now.)

   Reload the extension in Safari so it picks up the new appex code:
   Safari ▸ Settings ▸ Extensions ▸ toggle "YT Bridge" OFF then ON.
   (A full Safari ⌘Q + reopen also works.)

Verify the standalone instance is live:
   lsof -nP -iTCP:8976                       # should show "YTBridge" (the app), (LISTEN)
   curl -s 127.0.0.1:8976/v1/health | jq     # { "ok": true, ... }

In real use you won't run this by hand: open JellyBeat and the bridge comes up with it; close
JellyBeat and it goes away. No login item, no "toggle the extension after a cold Safari launch".
EOF
