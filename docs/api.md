# YT Bridge HTTP API contract (v1)

This is the integration contract for JellySleeve. Base URL:

```
http://127.0.0.1:8976
```

The port is a **hardcoded constant** (one Swift `let` + this note). Changing it means
rebuilding the extension — the sandboxed extension process cannot read user env vars or
arbitrary config files, so runtime configuration is not promised.

## Security model (implemented exactly)

- Binds strictly to loopback (`127.0.0.1`). Never `0.0.0.0`.
- **No CORS headers, ever.** JellySleeve is a native process; it does not need CORS, and
  emitting `Access-Control-Allow-Origin` would let any webpage you visit read your
  listening state.
- **Rejects with `403` any request whose `Host` header is not exactly `127.0.0.1:8976`** —
  defeats DNS rebinding (an attacker page on `evil.com` resolving to 127.0.0.1 sends
  `Host: evil.com`).
- **Rejects with `403` any request bearing an `Origin` header** — browsers always attach it
  to cross-origin requests; native clients don't send it. Together with the Host check this
  closes the drive-by browser vector.
- **Server limits:** max request size 8 KB (reject larger with `413`), read timeout 5 s,
  max 8 concurrent connections, connection close after every response. `X-Content-Type-Options:
  nosniff` on all responses.
- **Every string field in responses is untrusted page content.** Video titles and channel
  names are attacker-controlled (anyone can upload a video named `<img onerror=...>`).
  **Consumers MUST escape on render.** The bridge's own duty: `artworkUrl` is allowlisted at
  the source because it is read from the page DOM.
- Accepted residual risks (documented, not forgotten): (a) cross-origin GETs via
  `<img>`/`<script>` carry no `Origin` and reach the server, but the response is unreadable to
  the attacker, so only port fingerprinting remains; (b) no auth token in v1, so any local
  native process can read listening state and send commands. Revisit with a bearer token if
  that ever matters.

## `GET /v1/now-playing`

```json
{
  "active": true,
  "source": "youtube_music",
  "state": "playing",
  "title": "Song Title",
  "artist": "Artist Name",
  "album": "Album Name",
  "durationSec": 245.3,
  "positionSec": 87.1,
  "videoId": "dQw4w9WgXcQ",
  "url": "https://music.youtube.com/watch?v=...",
  "artworkUrl": "https://...",
  "volume": 0.8,
  "tabId": 42,
  "updatedAtMs": 1765432100123
}
```

Field notes:

- `source`: `"youtube"` | `"youtube_music"`.
- `state`: `"playing"` | `"paused"`.
- `artist`: YouTube → channel name.
- `album`: YT Music only, else `null`.
- `durationSec`: `null` = unknown/livestream.
- `artworkUrl`: `null` unless its host is allowlisted (`i.ytimg.com`,
  `lh3.googleusercontent.com`, `music.youtube.com`).

`{"active": false}` is returned when nothing is playing/paused, **and also whenever the last
sync from Safari is older than 3 s** (staleness rule — covers crashed tabs, closed Safari,
disabled extension). JellySleeve extrapolates position between polls using `updatedAtMs`, and
treats **connection refused the same as `active: false`**. All string fields are untrusted
page content: escape on render.

## `POST /v1/command`

Body:

```json
{ "action": "play | pause | toggle | next | previous | seek | setVolume", "value": 120.5 }
```

`value` required for `seek` (seconds) and `setVolume` (0.0–1.0). Returns `202 {"queued": true}`.

Errors:

- `400` — unknown action / missing or non-numeric value.
- `503 {"error": "safari_disconnected"}` — last sync older than 3 s (don't queue into the void).
- `409 {"error": "no_active_player"}` — surfaced via subsequent state.

The queue is **bounded at 16 commands, dropping the oldest** on overflow.

## `GET /v1/health`

```json
{
  "ok": true,
  "safariLastPollMs": 312,
  "version": "0.1.0",
  "capabilities": {
    "canPlayPause": true,
    "canNext": true,
    "canPrevious": true,
    "canSeek": true,
    "canSetVolume": true,
    "hasFavorites": false,
    "hasQueue": false
  }
}
```

`safariLastPollMs` > ~3000 means the extension isn't syncing (Safari closed / extension
disabled / no YT tab). `capabilities` is self-describing so a generic consumer doesn't hard-code
per-backend quirks (this source has no favorites and no queue).

## Generic source contract

This API is one implementation of a **vendor-neutral `PlaybackSource` contract** — see
[`playback-source.md`](playback-source.md). Code consumers (e.g. JellySleeve's source arbiter)
against that normalized model + MPRIS mapping, not against YouTube-specific shapes.

## Consumer guidance

- Treat **connection refused as "bridge idle"**, not an error.
- Escape all string fields on render.
- Put a `YTBridgeSource` behind a `PlaybackSource` protocol so a later transport swap (e.g. the
  App Group variant) stays local to one type.
