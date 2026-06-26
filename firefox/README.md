# YT Bridge — Firefox build

A Firefox port of the extension. It feeds the **same bridge host** the Safari extension
does — the headless **YTBridge** macOS app that owns the loopback HTTP server on
`127.0.0.1:8976` — so JellyBeat consumes it through the unchanged
[`docs/api.md`](../docs/api.md) contract, regardless of which browser is playing.

## How it differs from Safari

The content scripts and the background relay are **shared, byte-for-byte**, with the Safari
extension (they live in `YTBridge Extension/Resources/` and are the single source of truth).
Only two things are Firefox-specific:

- **Transport.** Safari relays each sync through its native containing app
  (`sendNativeMessage` → `SafariWebExtensionHandler` → loopback POST). Firefox has no
  containing app, so its background `fetch()`es the host's `/_internal/sync` ingest
  directly. That one branch lives in `background.js`'s `forwardSync()`, switched on the
  `globalThis.__YTB_INGEST` global that [`src/firefox-config.js`](src/firefox-config.js)
  defines (and Safari leaves undefined).
- **Manifest.** [`src/manifest.json`](src/manifest.json) drops `nativeMessaging`, adds the
  `http://127.0.0.1:8976/*` host permission, sets `browser_specific_settings.gecko`
  (`id` + `strict_min_version: "128.0"`), and loads `firefox-config.js` before
  `background.js`.

The host accepts the Firefox feeder because its internal ingest admits extension-scheme
origins (`moz-extension://…`) **and answers the CORS preflight** Firefox sends before the POST
(reflecting that exact origin); the public `/v1/*` API still emits no CORS header and rejects
any `Origin`.

## Build & load

```sh
scripts/build-firefox.sh
```

That assembles `firefox/dist/` (shared sources copied from the Safari Resources + the two
Firefox files). Then in Firefox:

1. Open `about:debugging#/runtime/this-firefox`.
2. **Load Temporary Add-on…** → pick `firefox/dist/manifest.json`.
3. If playback control needs it, grant the extension access to YouTube via its toolbar menu.

No signing is required and it works on the Release channel, but a temporary add-on is
dropped when Firefox restarts — re-load it each session. The **YTBridge host must be
running** (JellyBeat launches it) for the bridge to answer; connection-refused just means
the host is down, same as for Safari.

## Requirements

- Firefox **128+** (`scripting.executeScript`/`registerContentScripts` with `world: "MAIN"`
  landed in 128; the volume control and the Now-Playing teardown helper rely on it).
- The YTBridge host installed and running.

## Status

**Confirmed working** end-to-end on **Zen Browser** (a Firefox/Gecko fork): the extension feeds
the host and `GET /v1/now-playing` returns live state.

One thing the offline research got wrong and only live testing caught: a Firefox extension's
background `fetch()` to the loopback ingest **does** send a CORS preflight (`OPTIONS`) — the
"`host_permissions` bypasses CORS" assumption did not hold. The host now answers that preflight
for extension-scheme/`null` origins (reflecting the exact origin, never `*`, never on `/v1/*`),
which is what made it work. If you port to another Gecko browser and it silently fails, check
the browser console for `CORS`/`OPTIONS` errors against `/_internal/sync` first.

Still nice to confirm on your build (not blockers — they degrade gracefully):

- `registerContentScripts({ world: "MAIN" })` injecting the Now-Playing teardown helper;
- the `alarms` keepalive cadence near 30 s.
