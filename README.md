# yt-safari-bridge

A Safari Web Extension (plus its macOS containing app) that exposes **YouTube** and
**YouTube Music** playback — title, artist, artwork, position, state — over a local HTTP
API on `127.0.0.1`, and accepts playback commands (play/pause/next/prev/seek/volume) back.

Personal tool. macOS 14+, Safari 17+. No App Store.

The HTTP contract that consumers (JellySleeve) code against lives in
[`docs/api.md`](docs/api.md). The full design rationale and Safari-specific constraints are
in [`PLAN.md`](PLAN.md).

## Architecture (one line)

Content scripts push state on change + heartbeat → background relay →
`SafariWebExtensionHandler` (Swift) holds latest state + a bounded command queue →
HTTP server bound to `127.0.0.1:8976` inside the extension process → JellySleeve polls
`GET /v1/now-playing` and `POST /v1/command`.

The port `8976` is a **hardcoded constant**; changing it means rebuilding.

## Status

- **Phase 0 — content scripts (pure JS): done.** No Xcode yet; the extension cannot be
  loaded into Safari until Phase 1 produces the containing app.
- **Phase 1 — done.** Xcode project via `safari-web-extension-converter`; `NWListener` bind
  spike validated **GO** (the extension sandbox permits a loopback listening socket, confirmed
  via `lsof` showing `127.0.0.1:8976 (LISTEN)`). Signed with a personal Apple Development team.
- **Phase 2 — done.** Hand-rolled HTTP/1.1 server in the extension process. Full security model
  verified (bad `Host`→403, `Origin`→403, >8 KB→413, `nosniff` present, no CORS).
- **Phase 3 — done.** Commands end-to-end: `toggle`, `seek`, `setVolume`, `next` all confirmed
  driving real playback via `POST /v1/command`.
- **Phase 4 — done.** Container-app status UI (server up/idle + current track), multi-tab
  arbitration hardening, docs handoff.

The HTTP API is live and stable on `127.0.0.1:8976`; JellySleeve can integrate against
[`docs/api.md`](docs/api.md) now.

## Repo layout

```
yt-safari-bridge/
├── PLAN.md / README.md
├── docs/
│   ├── api.md            ← HTTP contract for JellySleeve
│   └── console-test.js   ← paste into Safari Web Inspector to validate the scrapers
└── YTBridge/
    ├── YTBridge.xcodeproj
    ├── YTBridge/                       ← container app (status window)
    │   ├── ViewController.swift        ← polls the API natively, pushes status to the page
    │   └── Resources/ (Main.html, Script.js, …)
    └── YTBridge Extension/
        ├── SafariWebExtensionHandler.swift  ← native messaging entry; starts the server
        ├── StateStore.swift                 ← latest state + 3s staleness + bounded queue
        ├── HTTPServer.swift                 ← HTTP/1.1 server (loopback, security model)
        └── Resources/                       ← canonical manifest.json + JS (single source of truth)
            ├── manifest.json
            ├── background.js
            ├── common.js
            └── content/{youtube.js, ytmusic.js}
```

The top-level `extension/` folder was migrated into `YTBridge Extension/Resources/` (Phase 1)
and deleted; that copy is now the single source of truth.

## Build

Set `DEVELOPMENT_TEAM` to your own Apple Development team ID (Xcode → Settings → Accounts, or
open the project and pick a Team under **Signing & Capabilities**):

```
xcodebuild -project YTBridge/YTBridge.xcodeproj -scheme YTBridge -configuration Debug \
  -allowProvisioningUpdates DEVELOPMENT_TEAM=YOUR_TEAM_ID CODE_SIGN_STYLE=Automatic build
```

A free personal Apple ID team is enough (the extension persists across Safari sessions; no
"Allow Unsigned Extensions" needed). Then run the **YTBridge** app once (registers the
extension), enable it in Safari, and grant site access (below). The app window shows live
bridge status and a Refresh button.

## Phase 0 acceptance (do this before Phase 1)

The scrapers can be validated without Safari loading the extension at all:

1. Open `music.youtube.com` (or a `youtube.com/watch` page) and start a song/video.
2. Open the Web Inspector console for that tab (Develop → Show Web Inspector → Console).
   Enable the Develop menu in Safari → Settings → Advanced if it isn't visible.
3. Paste the contents of [`docs/console-test.js`](docs/console-test.js) and press Enter.
4. It prints the state object every second. Verify across **song change, pause, seek, and
   SPA navigation** (click another track without a full reload):
   - correct `title` / `artist` / `album` / `positionSec` / `artworkUrl`;
   - `durationSec` is `null` (never `Infinity`/`NaN`) on a livestream;
   - `state` flips between `"playing"` and `"paused"`.

## Manual Safari steps (Phase 1+, for reference)

- Safari → Settings → Extensions: enable **YT Bridge**.
- Grant access to `youtube.com` and `music.youtube.com` ("Always Allow on Every Website" is
  fine for a personal tool).
- If running unsigned: Develop → Allow Unsigned Extensions (re-do each Safari session unless
  signed with a personal Apple ID team in Xcode).
- The extension does **not** run in Private Browsing unless explicitly allowed.

## Troubleshooting

- `curl -s 127.0.0.1:8976/v1/health | jq` — `safariLastPollMs` > ~3000 means the extension
  isn't syncing (Safari closed / extension disabled / no YT tab open).
- **Connection refused means the bridge is idle**, not an error — Safari is closed or no YT
  tab is open, and the handler process was reaped. It restarts lazily on the next sync.
