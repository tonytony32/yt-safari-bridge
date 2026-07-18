#!/usr/bin/env bash
#
# Package the Firefox build into a distributable add-on.
#
# Firefox (and Zen) only install a SIGNED add-on permanently — the "Load Temporary Add-on" you
# use in development vanishes on restart. Signing is free but only Mozilla can do it, so the
# signed route needs YOUR addons.mozilla.org (AMO) API credentials. Two ways:
#
#   1) Unsigned package (default) — produces a .zip you upload once at addons.mozilla.org
#      ("Developer Hub" -> Submit -> "On your own" for self-distribution); Mozilla signs it in
#      the browser and hands you back a signed .xpi. No API keys needed.
#        scripts/package-firefox.sh
#
#   2) Signed .xpi straight from the CLI — needs API credentials in the environment
#      (addons.mozilla.org -> Developer Hub -> "Manage API Keys"):
#        AMO_JWT_ISSUER='user:12345:67' AMO_JWT_SECRET='deadbeef…' scripts/package-firefox.sh --sign
#
# Either way the result lands in firefox/artifacts/. Bump "version" in firefox/src/manifest.json
# before each new release — Mozilla rejects a version it has already seen.
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$REPO/firefox/dist"
ART="$REPO/firefox/artifacts"

# Always reassemble dist first so we package the latest shared sources, not a stale copy.
echo "▸ Assembling firefox/dist/ …"
"$REPO/scripts/build-firefox.sh" >/dev/null
mkdir -p "$ART"

if [ "${1:-}" = "--sign" ]; then
  : "${AMO_JWT_ISSUER:?set AMO_JWT_ISSUER — addons.mozilla.org -> Developer Hub -> Manage API Keys}"
  : "${AMO_JWT_SECRET:?set AMO_JWT_SECRET — addons.mozilla.org -> Developer Hub -> Manage API Keys}"
  echo "▸ Signing via Mozilla AMO (unlisted channel)…"
  npx --yes web-ext@latest sign \
    --source-dir "$DIST" \
    --artifacts-dir "$ART" \
    --channel unlisted \
    --api-key "$AMO_JWT_ISSUER" \
    --api-secret "$AMO_JWT_SECRET"
  echo "✅ Signed .xpi in firefox/artifacts/ — send it to a user; they open it in Firefox/Zen"
  echo "   (or drag it onto the window) to install it permanently."
else
  echo "▸ Building an UNSIGNED package…"
  npx --yes web-ext@latest build \
    --source-dir "$DIST" \
    --artifacts-dir "$ART" \
    --overwrite-dest
  echo "✅ Unsigned package in firefox/artifacts/. To make it installable by others, EITHER:"
  echo "     • upload that .zip at addons.mozilla.org (Developer Hub → Submit → self-distribution);"
  echo "       Mozilla signs it and gives you a .xpi, OR"
  echo "     • run:  AMO_JWT_ISSUER=… AMO_JWT_SECRET=… scripts/package-firefox.sh --sign"
fi
