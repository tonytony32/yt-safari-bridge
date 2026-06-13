# Plan: `yt-safari-bridge` — Safari extension exposing YouTube / YouTube Music playback to JellySleeve

> Execution plan for Claude Code. Build in a **new standalone repo** (`yt-safari-bridge`). JellySleeve is a separate local process that will consume the HTTP API defined here.
> Rev 3: architecture + security audited. Sync is content-script-driven (Safari unloads background timers), socket bind is de-risked in Phase 1, the localhost API is hardened against drive-by browser requests, and all scraped strings are treated as untrusted content.

## Goal

A Safari Web Extension (plus its required macOS containing app) that:

1. Detects what is playing on `youtube.com` and `music.youtube.com` (title, artist, artwork, position, state).
2. Exposes that state via a local HTTP API on `127.0.0.1` so JellySleeve can read it.
3. Accepts commands over the same API (play/pause, next/previous, seek, volume) and executes them in the tab.

Personal tool. No App Store. macOS 14+, Safari 17+.

## Architecture (read carefully — Safari-specific constraints)

```
YouTube tab ──content script: push state on change + heartbeat──▶ background.js (event-driven relay, NO timers)
                (500ms playing / 1s paused / silent when idle)        │ browser.runtime.sendNativeMessage
                                                                      ▼
                                              SafariWebExtensionHandler (Swift, extension process)
                                                │  StateStore: latest state + bounded command queue
                                                └─▶ HTTP server on 127.0.0.1:8976 (Host-validated, no CORS)
                                                      ▲
                                                JellySleeve (GET state / POST commands)
```

Key constraints that dictate this design — do NOT "simplify" around them:

- A JS extension **cannot open a server socket**. The native side must host the API.
- Safari **blocks `fetch`/WebSocket from extension contexts to `http://localhost`** (mixed content / CSP; WebKit does not exempt loopback — see webkit.org bug 171934). So the extension cannot push directly to a JellySleeve-owned server. Native messaging is the supported channel.
- Safari native messaging only talks to the extension's **own containing app**, and content scripts cannot call it directly — they must relay through the background script.
- **Sync is driven by content scripts, never by background timers.** Safari unloads non-persistent background pages after idle and `setInterval` callbacks are NOT invoked after unload (Apple-documented). Incoming `runtime.sendMessage` calls DO wake the background page. So: content scripts push state; the background's `onMessage` handler relays each push via `sendNativeMessage` and dispatches whatever commands come back in the reply. One round trip carries both directions. No keep-alive hacks.
- Push cadence (content script, which lives as long as its tab): immediately on change (play/pause/seek/track change), plus heartbeat every **500ms while playing, 1s while paused**, silent when the tab has no media. Command latency ≤ cadence — fine for remote control.
- The HTTP server runs **inside the extension handler process** (singleton in the principal class), not in the containing app. Syncs keep it warm while a YT tab is open; if the process is reaped, the next sync respawns it and the server restarts lazily. **This assumption is validated by a 3-line bind spike in Phase 1 before any HTTP code is written.** When Safari is closed or no YT tab exists, the server may be gone entirely: JellySleeve must treat **connection refused as "bridge idle"**, not as an error.
- The containing app is just the install vehicle + status window (extension enabled? server up?).
- Background script: manifest v3 with `"background": {"scripts": [...]}` (background **page**, not service worker — Safari supports it and service workers have known native-messaging quirks). The background is a stateless-ish event relay; it does not rely on staying loaded.

### Fallback (only if the Phase 1 bind spike fails)

Move the HTTP server into the containing app (menu bar, `LSUIElement`); share state via App Group `UserDefaults` + Darwin notifications. Do not build this preemptively.

### Future variant (optional, after the scrapers stabilize — do not build now)

Fold the extension into JellySleeve as its containing app and replace HTTP with App Group `UserDefaults` + Darwin notifications: removes the entire network attack surface (no listener, no drive-by, no local-process snooping). It is a transport-only migration (~1-2 days): manifest, content scripts, background relay and `StateStore` move unchanged; Safari will see a new extension (new bundle id, re-enable permissions manually). The `PlaybackSource` protocol in JellySleeve (Phase 4) is what keeps this swap cheap.

## Repo layout

Phase 0 (pure JS, before Xcode exists):

```
yt-safari-bridge/
├── PLAN.md                  ← this file
├── README.md
├── docs/api.md              ← contract for JellySleeve
└── extension/
    ├── manifest.json
    ├── background.js
    ├── common.js
    └── content/
        ├── youtube.js
        └── ytmusic.js
```

After Phase 1 the converter copies `extension/` into the Xcode project's extension target Resources. **From that commit on, the copy inside the Xcode project is the single source of truth and the top-level `extension/` folder is deleted** (same commit). Final layout:

```
yt-safari-bridge/
├── PLAN.md / README.md / docs/api.md
└── YTBridge/
    ├── YTBridge.xcodeproj
    ├── YTBridge/                      (app target)
    └── YTBridge Extension/
        ├── SafariWebExtensionHandler.swift
        ├── StateStore.swift
        ├── HTTPServer.swift
        └── Resources/                 ← canonical manifest.json + JS
```

## HTTP API contract (v1) — what JellySleeve codes against

Base: `http://127.0.0.1:8976`. The port is a **hardcoded constant** (one Swift `let` + README note). Changing it means rebuilding — the sandboxed extension process cannot read user env vars or arbitrary config files, so do not promise runtime configuration.

### Security model (implement exactly)

- Bind strictly to loopback (`127.0.0.1`). Never `0.0.0.0`.
- **No CORS headers, ever.** JellySleeve is a native process; it does not need CORS, and emitting `Access-Control-Allow-Origin` would let any webpage you visit read your listening state.
- **Reject with 403 any request whose `Host` header is not exactly `127.0.0.1:8976`** — defeats DNS rebinding (attacker page on `evil.com` resolving to 127.0.0.1 sends `Host: evil.com`).
- **Reject with 403 any request bearing an `Origin` header** — browsers always attach it to cross-origin requests; native clients don't send it. Together with the Host check this closes the drive-by browser vector.
- **Server limits:** max request size 8 KB (reject larger with 413), read timeout 5 s, max 8 concurrent connections, connection close after every response. Add `X-Content-Type-Options: nosniff` to all responses.
- **Every string field in responses is untrusted page content.** Video titles and channel names are attacker-controlled (anyone can upload a video named `<img onerror=...>`). Consumers MUST escape on render. The bridge's own duty: `artworkUrl` is allowlisted at the source (see Phase 0) because it is read from the page DOM.
- Accepted residual risks (documented, not forgotten): (a) cross-origin GETs via `<img>`/`<script>` carry no `Origin` and reach the server, but the response is unreadable to the attacker, so only port fingerprinting remains; (b) no auth token in v1, so any local native process can read listening state and send commands. Revisit with a bearer token (or the App Group variant below) if that ever matters.

### `GET /v1/now-playing`

```json
{
  "active": true,
  "source": "youtube_music",          // "youtube" | "youtube_music"
  "state": "playing",                  // "playing" | "paused"
  "title": "Song Title",
  "artist": "Artist Name",             // YouTube: channel name
  "album": "Album Name",               // YT Music only, else null
  "durationSec": 245.3,                // null = unknown/livestream
  "positionSec": 87.1,
  "videoId": "dQw4w9WgXcQ",
  "url": "https://music.youtube.com/watch?v=...",
  "artworkUrl": "https://...",
  "volume": 0.8,
  "liked": false,
  "tabId": 42,
  "updatedAtMs": 1765432100123
}
```

`{"active": false}` when nothing is playing/paused, **and also whenever the last sync from Safari is older than 3s** (staleness rule — covers crashed tabs, closed Safari, disabled extension). JellySleeve extrapolates position between polls using `updatedAtMs`, and treats connection refused the same as `active: false`. `artworkUrl` is `null` unless its host is allowlisted (`i.ytimg.com`, `lh3.googleusercontent.com`, `music.youtube.com`). All string fields are untrusted page content: escape on render.

### `POST /v1/command`

Body: `{"action": "play" | "pause" | "toggle" | "next" | "previous" | "seek" | "setVolume" | "like" | "unlike" | "toggleLike", "value": 120.5}`
`value` required for `seek` (seconds) and `setVolume` (0.0–1.0). `like`/`unlike` are idempotent, `toggleLike` flips. Returns `202 {"queued": true}`.
Errors: `400` unknown action / missing or non-numeric value; `503 {"error": "safari_disconnected"}` if last sync is older than 3s (don't queue into the void); `409 {"error": "no_active_player"}` surfaced via subsequent state. The queue is **bounded at 16 commands, dropping the oldest** on overflow.

### `GET /v1/health`

`{"ok": true, "safariLastPollMs": 312, "version": "0.1.0"}` — `safariLastPollMs` > ~3000 means the extension isn't syncing (Safari closed / extension disabled / no YT tab).

Write this contract into `docs/api.md` verbatim in Phase 0 so JellySleeve work can start in parallel.

## Phases

### Phase 0 — Scaffold + content scripts (pure JS, no Xcode)

1. Init repo, layout above, `docs/api.md`.
2. `manifest.json` (MV3): host permissions for `*://www.youtube.com/*` and `*://music.youtube.com/*`, `nativeMessaging` permission, background page (`"scripts"`), content scripts per host. **Do NOT add the `tabs` permission** (least privilege: it would expose URL/title of every open tab to a compromised extension). Nothing here needs it: `sender.tab.id` arrives with each message, and `tabs.onRemoved` / `tabs.sendMessage` to content-script tabs work without it.
3. `content/ytmusic.js` — extract state. Sources, in order of preference:
   - `document.querySelector('video')` → `paused`, `currentTime`, `duration`, `volume` (ground truth for playback).
   - DOM for metadata: `.title.ytmusic-player-bar` (title), `.byline.ytmusic-player-bar` (artist • album • year — parse on `•`), artwork from the **largest `srcset` entry** of the player-bar image (the bare `src` is a 60px thumb; prefer `#song-image img` when present), videoId from `location.search` `?v=`.
   - **Do not rely on `navigator.mediaSession`** — content scripts run in an isolated world in Safari; the page's metadata object is not visible there.
   - Selectors WILL drift with YT updates: centralize all selectors in one `SELECTORS` object at the top of each content script, and code defensively (null checks, fall back to `document.title`).
4. `content/youtube.js` — same shape: title from `ytd-watch-metadata h1` (fallback `document.title` minus " - YouTube"), artist = channel name (`#owner #channel-name a`), `album: null`, artwork `https://i.ytimg.com/vi/{videoId}/hqdefault.jpg`, ignore Shorts (`/shorts/`) for v1.
5. **Sanitation (do not skip):**
   - Numbers: livestreams report `video.duration === Infinity` and pre-metadata it is `NaN`. Non-finite values survive the native messaging bridge as `Double.infinity` and make `JSONSerialization` throw on the Swift side (500s on the API). Pass every numeric field through `const safe = n => Number.isFinite(n) ? n : null;` before sending.
   - Artwork: `artworkUrl` is read from the page DOM, so hostile page content could plant an arbitrary URL that the consumer would then fetch (tracking / local SSRF). Allowlist hosts (`i.ytimg.com`, `lh3.googleusercontent.com`, `music.youtube.com`) and send `null` otherwise.
6. Push loop in content script (owns all timing — the background must never need a timer):
   - Send `{type: "state", state}` via `browser.runtime.sendMessage` immediately on change (diff against last sent), plus heartbeat: 500ms interval while playing, 1s while paused, nothing when no `<video>`.
   - Re-read metadata on `yt-navigate-finish` (both sites fire it on SPA navigation) + the heartbeat as safety net.
7. Command execution in content script (receives `{action, value}` from background):
   - `play`/`pause`/`toggle`: call `video.play()` / `video.pause()` directly.
   - `seek`: `video.currentTime = value` (clamp to `[0, duration]`).
   - `setVolume`: `video.volume = value` clamped to `[0, 1]` (YT's volume slider UI may desync — acceptable).
   - `next`/`previous`: click DOM buttons — YT Music: `.next-button.ytmusic-player-bar` / `.previous-button.ytmusic-player-bar`; YouTube: `.ytp-next-button`; previous on YouTube = re-seek to 0 if no playlist button.
   - Guardrails: match `action` against a strict allowlist and ignore anything else (default-reject). Never use `eval`, `new Function`, or `innerHTML` anywhere in the extension; there is no legitimate need for them in this project.
8. `background.js` — event-driven relay, no state of its own beyond a `Map(tabId → state)`:
   ```js
   browser.runtime.onMessage.addListener(async (msg, sender) => {
     if (msg.type !== "state") return;
     tabStates.set(sender.tab.id, msg.state);
     const reply = await browser.runtime.sendNativeMessage("ignored",
       { type: "sync", state: activeState() });
     for (const cmd of (reply?.commands ?? [])) dispatchToActiveTab(cmd);
   });
   browser.tabs.onRemoved.addListener((tabId) => {
     tabStates.delete(tabId);
     browser.runtime.sendNativeMessage("ignored", { type: "sync", state: activeState() }); // final sync, may be {active:false}
   });
   ```
   Active tab = last one that reported `state === "playing"` (a paused tab stays active until another plays). Incoming messages wake the background page if Safari unloaded it; `onRemoved` also wakes it.
9. **Acceptance (no native side yet — the extension cannot be loaded into Safari until Phase 1):** validate the scrapers by pasting them into the Safari Web Inspector console on both sites. Verify: correct title/artist/album/position/artwork objects (and `null`, never `Infinity`/`NaN`, on a livestream) across song change, pause, seek, and SPA navigation without reload.

### Phase 1 — Xcode project via converter + bind spike

1. Run: `xcrun safari-web-extension-converter extension/ --project-location . --app-name YTBridge --bundle-identifier com.trypwood.ytbridge --macos-only --no-open`
2. **Source of truth migration:** delete the top-level `extension/` folder in the same commit; all JS edits now happen in `YTBridge Extension/Resources/`. Update README.
3. Verify the generated project builds: `xcodebuild -project YTBridge/YTBridge.xcodeproj -scheme YTBridge build` (sign with your personal Apple Development team for persistence, or use Safari's "Allow Unsigned Extensions" each session).
4. `SafariWebExtensionHandler.swift`: implement `beginRequest(with:)` to parse `{type: "sync", state}`, store into a thread-safe `StateStore` singleton (latest state + `lastSyncDate` + bounded FIFO command queue), respond `{commands: [...drained queue]}`. **Logging privacy:** never log metadata content; track titles in the unified log are a privacy leak readable by any same-user process. Log event types, payload sizes and timing only (or use os_log `%{private}` interpolation).
5. **Bind spike (before writing ANY HTTP code):** on first `beginRequest`, create an `NWListener` on `127.0.0.1:8976` with the `com.apple.security.network.server` entitlement added to the **extension** target, and `os_log` the listener state. This validates that the extension sandbox permits a listening socket. **If `.failed` → stop, switch to the documented fallback architecture before proceeding.**
6. **Acceptance:** with the extension enabled and a song playing: `log stream --predicate 'subsystem == "com.trypwood.ytbridge"'` shows syncs at ~500ms cadence and `listener ready`; `nc -z 127.0.0.1 8976` exits 0.

Manual steps (Claude Code must pause and ask): enable the extension in Safari Settings → Extensions; grant access to youtube.com and music.youtube.com ("Always Allow on Every Website" is fine for a personal tool); Develop menu → Allow Unsigned Extensions if running unsigned. Note: the extension does not run in Private Browsing unless explicitly allowed.

### Phase 2 — HTTP server in the handler process

1. Hand-rolled minimal HTTP/1.1 server on `Network.framework` (`NWListener` from the Phase 1 spike) — no SPM dependencies (avoids pbxproj surgery). Support: request-line + headers parse, `Content-Length` bodies, JSON responses, connection close per request. ~150 lines.
2. Start lazily on first `beginRequest` (singleton guard). Handle bind failure (port taken, e.g. Safari Technology Preview running the same extension) by logging and continuing without server.
3. Implement the **security model exactly as specified in the contract**: loopback bind, no CORS headers, 403 on bad `Host`, 403 on any `Origin` header, 413 over 8 KB, 5 s read timeout, max 8 concurrent connections, `nosniff` on every response.
4. Wire endpoints to `StateStore`: `/v1/now-playing` (with the 3s staleness rule), `/v1/health`, `/v1/command` (validate action, 503 when stale, bounded queue).
5. **Acceptance (curl, while a song plays in Safari):**
   - `curl -s 127.0.0.1:8976/v1/now-playing | jq` → correct metadata, position advances between calls.
   - Pause in Safari → `state` flips to `"paused"` within ~1s.
   - `curl -s 127.0.0.1:8976/v1/health | jq` → `safariLastPollMs < 1500`.
   - `curl -s -H "Host: evil.com:8976" 127.0.0.1:8976/v1/now-playing` → **403**.
   - `curl -s -H "Origin: https://evil.com" 127.0.0.1:8976/v1/now-playing` → **403**.
   - `lsof -nP -iTCP:8976 -sTCP:LISTEN` shows the bind as `127.0.0.1:8976`, NOT `*:8976`.
   - `head -c 20000 /dev/zero | curl -s --data-binary @- 127.0.0.1:8976/v1/command` → **413** (or closed connection).
   - Quit Safari → within 3s, `now-playing` returns `active: false` or the connection is refused (both are valid "idle" signals per contract).

### Phase 3 — Commands end-to-end

1. `POST /v1/command` → queue → next sync delivers → background routes to active tab → content script executes → state change pushes back immediately (instant confirmation in `now-playing`).
2. Edge cases: unknown action → 400; seek beyond duration → clamp; Safari closed → 503; queue overflow → oldest dropped.
3. **Acceptance (curl):** `toggle` pauses/resumes within ~1s (also from paused state, where cadence is 1s); `next` advances track on YT Music; `seek` moves the playhead; `setVolume 0.2` audibly lowers volume; same on a youtube.com tab; with Safari quit, `command` returns 503.

### Phase 4 — Hardening + handoff to JellySleeve

1. Multi-tab arbitration test: two tabs playing → most recent wins; close it → previous becomes active (verify the `onRemoved` final sync).
2. Tolerate selector failures without crashing the content script; verify artwork is the high-res variant on YT Music.
3. Status UI in the containing app window: extension syncing? server listening? last track seen. (Keep trivial — text labels, refresh button.)
4. README: build instructions, manual Safari steps, the hardcoded port (and that changing it = rebuild), troubleshooting via `health` + "connection refused means idle".
5. `docs/api.md` final pass — this is the integration contract; JellySleeve then adds a `YTBridgeSource` that polls `/v1/now-playing` every second and POSTs commands, **behind a `PlaybackSource` protocol** so a later transport swap (e.g. the App Group variant below) stays local to one type. The contract must state that consumers escape all string fields on render.

## Decisions already made (don't reopen)

- **Content-script-driven sync** over background timers or `connectNative` push: Safari unloads background pages and kills their timers (Apple-documented); incoming messages wake them. Content scripts live as long as their tab and own all cadence.
- Server in extension process over containing app + IPC: fewest moving parts; assumption validated by the Phase 1 bind spike; fallback documented above.
- **No CORS, strict `Host` allowlist, reject `Origin`:** the API is for native local clients only; browser-reachable localhost servers are a drive-by/DNS-rebinding target.
- Hardcoded port: the sandboxed extension process cannot read user env or config files; rebuild to change. Never bind `0.0.0.0`.
- DOM scraping over page-world script injection (`getVideoData()`): isolated-world DOM + `<video>` element covers everything v1 needs with less fragility.
- **No `tabs` permission:** least privilege; everything needed works without it.
- **Scraped strings are untrusted:** escaping is the consumer's job (stated in the contract); allowlisting `artworkUrl` is the bridge's job.
- Shorts, live streams, ads: out of scope v1. Livestreams must not break the API (`durationSec: null`); if an ad is playing, report whatever the player exposes (self-corrects when the ad ends).

## Risks

| Risk | Mitigation |
|---|---|
| Background page unloaded by Safari | By design: no background timers; content-script messages and `tabs.onRemoved` wake it |
| Extension handler process reaped | Next sync respawns it; server restarts lazily; state re-syncs ≤1s; JellySleeve treats refused connections as idle |
| `NWListener` blocked in extension sandbox | Phase 1 spike detects it before HTTP work; documented containing-app fallback |
| YT/YTM DOM selectors change | Centralized `SELECTORS`, defensive nulls, `document.title` fallback |
| Livestream `Infinity`/`NaN` crashes JSON serialization | Sanitized to `null` in content script (Phase 0 step 5) |
| MV3 service-worker quirks in Safari | Background **page** (`"scripts"`); MV2 fallback |
| Port 8976 occupied (e.g. STP) | Log + continue without server; health absent → JellySleeve shows "bridge offline"; port is a documented constant |
| Drive-by webpage hits the API | No CORS + `Host` validation + `Origin` rejection (403); residual subresource GETs are unreadable to the attacker |
| Malicious video title reaches consumer UIs | Contract marks all strings untrusted (escape on render); `artworkUrl` allowlisted at source |
| Local process reads listening state / sends commands | Accepted v1 (documented); bearer token or App Group variant later |
| Flood / slowloris exhausts handler process | 8 KB request cap, 5 s read timeout, max 8 connections, bounded queue |
| Track titles leak into unified log | Handler logs event types/sizes only, never metadata content |
| Unsigned extension disabled on Safari restart | Sign with personal Apple ID team in Xcode (free) |