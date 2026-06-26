# YT Bridge — Chrome build

A Chrome port of the extension. It feeds the **same bridge host** Safari and Firefox do — the
headless **YTBridge** macOS app that owns the loopback HTTP server on `127.0.0.1:8976` — so
JellyBeat consumes it through the unchanged [`docs/api.md`](../docs/api.md) contract, whichever
browser is playing.

## How it differs from Safari / Firefox

The content scripts and the background relay are **shared, byte-for-byte** (they live in
`YTBridge Extension/Resources/` and are the single source of truth). Chrome needs three small
adapters on top, because it diverges from Safari/Firefox MV3 in two ways:

- **No `browser` namespace.** Chrome only defines `chrome.*`. [`src/chrome-shim.js`](src/chrome-shim.js)
  aliases `globalThis.browser = chrome` — enough, not the full `webextension-polyfill`, because
  every API the shared code awaits returns a native Promise in modern Chrome. The shim is loaded
  first in the service worker *and* first in every `content_scripts` array.
- **Service worker, not an event page.** Chrome MV3 allows only `background.service_worker`
  (one file). [`src/sw-bootstrap.js`](src/sw-bootstrap.js) is a classic worker that
  `importScripts("chrome-shim.js", "chrome-config.js", "background.js")` — the same load order
  as Firefox's `background.scripts` array, in one shared global.
- **Transport.** Like Firefox, [`src/chrome-config.js`](src/chrome-config.js) sets
  `globalThis.__YTB_INGEST` / `__YTB_TOKEN`, so `background.js`'s `forwardSync()` POSTs the
  host's `/_internal/sync` ingest directly instead of relaying through a Safari containing app.

The host accepts the Chrome feeder because its internal ingest admits extension-scheme origins
(`chrome-extension://…`) **and answers the CORS preflight** the browser sends before the POST
(reflecting that exact origin, plus `Access-Control-Allow-Private-Network` for Chrome's PNA);
the public `/v1/*` API still emits no CORS header and rejects any `Origin`. No manifest `key`
or hard-coded extension id is needed — the host prefix-matches the scheme, so any install id
works.

## Build & load

```sh
scripts/build-chrome.sh
```

That assembles `chrome/dist/` (shared sources copied from the Safari Resources + the four
Chrome files). Then in Chrome:

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top-right).
3. **Load unpacked** → pick the `chrome/dist/` folder.

No signing is required for development. The **YTBridge host must be running** (JellyBeat
launches it) for the bridge to answer; connection-refused just means the host is down, same as
for Safari/Firefox.

## Requirements

- Chrome **111+** (`registerContentScripts({ world: "MAIN" })` is 102+, but 111 is the floor we
  set for promise-API parity; the volume control and the Now-Playing teardown helper rely on
  MAIN-world injection, which — unlike desktop Safari — actually runs on Chrome).
- The YTBridge host installed and running.

## Status

Experimental — **not yet smoke-tested on a live Chrome build** (the sibling Firefox build is
confirmed working on Zen). Heads-up from that Firefox testing: a browser-extension background
`fetch()` to the loopback ingest **does** send a CORS preflight (`OPTIONS`) — the
"`host_permissions` bypasses CORS" assumption was false. The host now answers that preflight
(reflecting the `chrome-extension://` origin + `Access-Control-Allow-Private-Network: true`), so
Chrome should work the same way. If it silently fails, check the service-worker console for
`CORS`/`OPTIONS`/`Private Network Access` errors against `/_internal/sync` first.

Worth confirming on a live Chrome build:

- the service-worker `importScripts` bootstrap loading shim → config → `background.js` in one
  shared global, and the SW staying alive across the sub-second loopback fetch;
- `registerContentScripts({ world: "MAIN" })` injecting the teardown helper;
- **Private/Local Network Access** on **Chrome 142+** (the LNA prompt ships there); the host
  already sends `Access-Control-Allow-Private-Network: true` on the ingest.
