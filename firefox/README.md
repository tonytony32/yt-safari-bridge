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
origins (`moz-extension://…`); the public `/v1/*` API still rejects any `Origin`.

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

Experimental. The Firefox-specific behaviors below were verified from Mozilla docs but
should be smoke-tested on a live Firefox 128+ build:

- the exact `Origin` string Firefox attaches to the loopback POST (expected
  `moz-extension://<uuid>`; the host prefix-matches the scheme);
- `registerContentScripts({ world: "MAIN" })` actually injecting the teardown helper;
- the `alarms` keepalive firing near its 30 s period without an excessive event-page reload
  cost.
