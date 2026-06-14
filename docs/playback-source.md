# The `PlaybackSource` contract (vendor-neutral)

This document defines a small, **vendor-neutral playback-source contract**: a normalized
"now playing + remote control" interface that a consumer (e.g. JellySleeve) can arbitrate over
**without knowing which backend it is talking to**.

`yt-safari-bridge` is **one implementation** of this contract, served over HTTP at
`http://127.0.0.1:8976` (see [`api.md`](api.md) for the wire details). Jellyfin — or any other
backend — is just another implementation that maps onto the same normalized model. The point of
this file is to let JellySleeve code its source-arbitration logic against **this contract**,
not against the YouTube bridge or Jellyfin specifically.

The model is deliberately aligned with **MPRIS** (the de-facto cross-player standard; see the
mapping table at the end), so the shape is familiar and portable.

## 1. Normalized now-playing model

A source reports, at any moment, either *idle* or an *active* snapshot:

| Field | Type | Meaning | Idle |
|---|---|---|---|
| `active` | bool | Is anything playing/paused right now? | `false` |
| `source` | string | Backend/source identifier (`"youtube"`, `"youtube_music"`, `"jellyfin"`, …) | — |
| `state` | `"playing"` \| `"paused"` | Transport state | — |
| `title` | string (untrusted) | Track / video title | — |
| `artist` | string (untrusted) | Artist; on YouTube = channel | — |
| `album` | string \| null (untrusted) | Album, when known | — |
| `durationSec` | number \| null | Total length; `null` = unknown/livestream | — |
| `positionSec` | number | Current position | — |
| `artworkUrl` | string \| null | Cover art **as a direct URL** (host-allowlisted at the source) | — |
| `volume` | number 0.0–1.0 | Output volume | — |
| `trackId` | string \| null | Stable id for the current item (bridge: `videoId`) | — |
| `liked` | bool \| null | Favorite/like state of the current item; `null` = unknown | — |
| `updatedAtMs` | number | Epoch ms of the last update (for position extrapolation + staleness) | — |

**All string fields are untrusted content** (a video can be titled `<img onerror=…>`). Consumers
MUST escape on render. Artwork is a **direct URL** here, not a fetch-by-id handle — a consumer
whose other sources use id-based artwork (e.g. Jellyfin) needs a URL path too (see §6).

> The YouTube bridge's `GET /v1/now-playing` returns exactly these fields (it names the id
> `videoId` rather than `trackId`, and adds `url`/`tabId` extras). A normalized adapter on the
> consumer side maps them to the table above.

## 2. Commands

A source accepts these transport commands (the bridge takes them as
`POST /v1/command {"action", "value"}`):

| Command | Param | MPRIS analogue |
|---|---|---|
| `play` / `pause` / `toggle` | — | Play / Pause / PlayPause |
| `next` / `previous` | — | Next / Previous |
| `seek` | `value`: seconds (absolute) | SetPosition |
| `setVolume` | `value`: 0.0–1.0 | Volume (set) |
| `like` / `unlike` / `toggleLike` | — | (no MPRIS analogue — favorites extension) |

`like` / `unlike` are idempotent (a no-op when already in the target state); `toggleLike`
flips. The resulting `liked` shows up in a subsequent now-playing read.

Commands are **best-effort and asynchronous**: they are accepted (`202`) and applied on the next
sync; the resulting state shows up in a subsequent now-playing read. A consumer should treat the
now-playing feed as the source of truth, not the command's return.

## 3. Capabilities (self-describing)

So a generic arbiter doesn't hard-code per-backend quirks, a source advertises what it supports.
The bridge reports this under `capabilities` in `GET /v1/health`:

```json
{
  "canPlayPause": true,
  "canNext": true,
  "canPrevious": true,
  "canSeek": true,
  "canSetVolume": true,
  "hasFavorites": true,
  "hasQueue": false
}
```

For the YouTube bridge these are **constant** (the same for `youtube` and `youtube_music`):
full transport control and favorites (YouTube's "like"), but **no queue**. A consumer hides
the heart/queue UI when `hasFavorites`/`hasQueue` are false; here it shows the favorite
affordance and wires it to `like`/`unlike`/`toggleLike` + the `liked` field. (Jellyfin
reports both `hasFavorites: true` and `hasQueue: true`.)

## 4. Activeness & staleness (how a consumer knows a source is "live")

- **Active** = the source reports `active: true` **and** its last update is fresh
  (`now − updatedAtMs ≤ 3000 ms`). The bridge already enforces this 3 s staleness rule
  server-side: a stale source returns `{"active": false}`.
- **Idle** = `active: false`, **or the source is unreachable** (for the bridge: connection
  refused — Safari closed / no YouTube tab / handler reaped). A consumer MUST treat a refused
  connection as "idle", never as an error.
- `GET /v1/health`'s `safariLastPollMs` (ms since the last Safari sync) tells a consumer whether
  the source is syncing at all, independent of whether something is playing.

## 5. Arbitration guidance (for a multi-source consumer)

A consumer with several sources (JellySleeve = Jellyfin + this bridge) decides which one drives
the UI:

- **Automatic**: pick the source that is currently *active* (per §4). If more than one is active,
  prefer the **most-recently-changed** (`updatedAtMs`). If none is active, fall back to a
  default/last source.
- **Manual override**: let the user pin a specific source.
- When a source becomes the active one, **route commands to it** and **let only it write the
  shared now-playing state** — pause/ignore the other sources' feeds so they don't clobber it.

The arbiter is the consumer's responsibility. This source stays "dumb": it only reports its own
state and executes its own commands. It never needs to know other sources exist.

## 6. Implementing another source against this contract

To add a backend (e.g. Jellyfin) as a `PlaybackSource`, map its native model onto §1/§2:

- Produce the normalized snapshot (title/artist/album/position/duration/volume/state/active).
- Provide the transport commands (converting units — e.g. Jellyfin position ticks ↔ seconds,
  volume 0–100 ↔ 0.0–1.0).
- Report capabilities (Jellyfin: favorites + queue = true).
- **Artwork**: this bridge gives a direct `artworkUrl`. An id-based backend (Jellyfin fetches by
  item id + tag) needs the consumer's artwork layer to accept **both** "direct URL" and
  "fetch-by-id" — so the normalized snapshot should carry an optional `artworkUrl` that, when
  present, short-circuits id-based fetching.

## 7. MPRIS alignment

| MPRIS (`org.mpris.MediaPlayer2.Player`) | This contract |
|---|---|
| `PlaybackStatus` (Playing/Paused/Stopped) | `state` + `active` |
| `Metadata` → `xesam:title` | `title` |
| `Metadata` → `xesam:artist` | `artist` |
| `Metadata` → `xesam:album` | `album` |
| `Metadata` → `mpris:length` | `durationSec` (µs → s) |
| `Metadata` → `mpris:artUrl` | `artworkUrl` |
| `Metadata` → `mpris:trackid` | `trackId` |
| `Position` | `positionSec` (µs → s) |
| `Volume` (0.0–1.0) | `volume` |
| `PlayPause` / `Next` / `Previous` | `toggle` / `next` / `previous` |
| `SetPosition` | `seek` |
| `CanSeek` / `CanControl` / `CanGoNext` … | `capabilities.*` |

The semantics are 1:1; only the transport differs (MPRIS is D-Bus, this is loopback HTTP/JSON).
A future migration to App Group `UserDefaults` + Darwin notifications (see PLAN.md) would keep
this same normalized model — only the transport changes, which is the whole point of pinning the
contract here.
