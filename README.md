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
- Phase 1 — Xcode project via `safari-web-extension-converter` + the `NWListener` bind spike.
- Phase 2 — HTTP server in the handler process.
- Phase 3 — commands end-to-end.
- Phase 4 — hardening + handoff.

## Repo layout (Phase 0)

```
yt-safari-bridge/
├── PLAN.md
├── README.md
├── docs/
│   ├── api.md            ← HTTP contract for JellySleeve
│   └── console-test.js   ← paste into Safari Web Inspector to validate the scrapers
└── extension/
    ├── manifest.json
    ├── background.js      ← event-driven relay (no timers)
    ├── common.js          ← shared helpers + the push/command engine
    └── content/
        ├── youtube.js
        └── ytmusic.js
```

After Phase 1, the converter copies `extension/` into the Xcode project's extension target
Resources and **the top-level `extension/` folder is deleted in the same commit** — from then
on the copy inside `YTBridge Extension/Resources/` is the single source of truth.

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
