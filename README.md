# yt-safari-bridge

A Safari Web Extension (plus its macOS containing app) that exposes **YouTube** and
**YouTube Music** playback — title, artist, artwork, position, state — over a local HTTP
API on `127.0.0.1`, and accepts playback commands (play/pause/next/prev/seek/volume) back.

Personal tool. macOS 14+, Safari 17+. No App Store.

The HTTP contract that consumers (JellyBeat) code against lives in
[`docs/api.md`](docs/api.md). The full design rationale and Safari-specific constraints are
in [`PLAN.md`](PLAN.md).

## Architecture (one line)

Content scripts push state on change + heartbeat → background relay →
`SafariWebExtensionHandler` (Swift) **forwards** the state over a loopback channel to the
**container app**, which owns the HTTP server on `127.0.0.1:8976`, holds the latest state + a
bounded command queue → JellyBeat polls `GET /v1/now-playing` and `POST /v1/command`.

The **container app** hosts the socket (not the on-demand extension process, which the system
reaps), so the bridge survives Safari quit/relaunch. **JellyBeat owns the host's lifecycle**:
it launches the app when JellyBeat opens and quits it when JellyBeat closes, so the bridge runs
exactly while JellyBeat runs — no login item, no resident process. (Earlier builds bound the
socket inside the extension and needed an extension off/on toggle after every cold Safari
launch; that's what this design fixes.) The port `8976` is a **hardcoded
constant**; changing it means rebuilding.

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
- **Phase 5 — done.** Moved the HTTP server out of the on-demand `.appex` into the container
  app (a **headless host** — no Dock icon, no window, no menu bar), with the extension
  forwarding state to it over a loopback ingest. Root-fixes the "must toggle the extension
  after each cold Safari launch" bug: the socket lives in a process the system doesn't reap.
- **Phase 6 — done.** Anchored the host's lifecycle to **JellyBeat**: JellyBeat launches the
  host when it opens and quits it when it closes, so the bridge runs exactly while JellyBeat
  runs — **no login item, no resident process**. The on/off control lives in JellyBeat's
  settings (the consumer owns the source), not in the extension. The host watches JellyBeat and
  self-quits if it goes away.

The HTTP API is live and stable on `127.0.0.1:8976`; JellyBeat can integrate against
[`docs/api.md`](docs/api.md) now.

## Repo layout

```
yt-safari-bridge/
├── PLAN.md / README.md
├── docs/
│   ├── api.md            ← HTTP contract for JellyBeat
│   └── console-test.js   ← paste into Safari Web Inspector to validate the scrapers
└── YTBridge/
    ├── YTBridge.xcodeproj
    ├── YTBridge/                       ← container app (headless agent, owns the socket)
    │   ├── main.swift                  ← programmatic entry point (no storyboard); .accessory agent
    │   ├── AppDelegate.swift           ← binds the socket; quits when JellyBeat quits
    │   ├── HTTPServer.swift            ← HTTP/1.1 server (loopback, security model + ingest)
    │   └── StateStore.swift            ← latest state + 3s staleness + bounded queue
    └── YTBridge Extension/
        ├── SafariWebExtensionHandler.swift  ← native messaging entry; forwards state to the app
        ├── BridgeClient.swift               ← loopback POST to the app's /_internal/sync ingest
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
"Allow Unsigned Extensions" needed). Install the **YTBridge** app once (it registers the Safari
extension), enable the extension in Safari, and grant site access (below). The app is a
**headless host** (no Dock icon, no window, no menu bar) with **no UI by design** — you don't
launch it yourself: **JellyBeat launches it when it opens and quits it when it closes**, so the
bridge runs exactly while JellyBeat runs (no login item, no resident process). The on/off
control lives in **JellyBeat's settings** ("YouTube (Safari) source"), since the consumer owns
the source. Check liveness with `GET /v1/health`.

For local development you can launch the host standalone (no JellyBeat) with
`open /Applications/YTBridge.app --args --standalone` — `scripts/dev-reinstall.sh` does this so
you can verify the socket without running JellyBeat.

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

- `curl -s 127.0.0.1:8976/v1/health | jq` — a reply (even `safariLastPollMs` > ~3000) means
  the **container app** is up and serving; a large `safariLastPollMs` just means Safari isn't
  currently syncing (Safari closed / extension disabled / no YT tab open), and `/v1/now-playing`
  returns `{"active":false}`.
- **Connection refused now means the host isn't running** — i.e. JellyBeat is closed (it
  launches the host) or the YouTube source is toggled off in JellyBeat. Not "Safari is closed".
  Open JellyBeat to bring the bridge up. Consumers still treat connection-refused the same as
  `{"active":false}`.
- `lsof -nP -iTCP:8976` should show **`YTBridge`** (the app) holding the `LISTEN` socket — not
  `YTBridge Extension`. If it shows the extension, you're on an old build.

## License

GNU Affero General Public License v3.0 — see [LICENSE](LICENSE).

Copyright (C) 2026 tonytony32.

This program is free software: you can redistribute it and/or modify it under the terms of the
GNU Affero General Public License as published by the Free Software Foundation, either version 3
of the License, or (at your option) any later version. In particular, if you run a modified
version of this program as a network service, you must make the Corresponding Source of your
modified version available to its users (AGPL §13). It is distributed WITHOUT ANY WARRANTY;
without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
