// chrome-config.js — transport config for the Chrome build.
//
// importScripts()-ed by sw-bootstrap.js AFTER chrome-shim.js and BEFORE background.js, so it
// runs in the one service-worker global and the globals it sets are visible to background.js's
// forwardSync(). Chrome has no Safari-style containing app to relay through, so background.js
// POSTs the bridge host's loopback ingest directly when these are set; Safari leaves them
// undefined and uses native messaging instead. (Mirror of firefox/src/firefox-config.js.)
//
// The host (the YTBridge macOS app) owns the socket on 127.0.0.1:8976 for the whole time
// JellyBeat runs — this extension is just one feeder of state into it. The token must match
// HTTPServer.internalToken in the app target. It is NOT a real secret (it ships in plain text
// inside the extension); it only bars a random local process, the same loopback threat model
// as docs/api.md. The host additionally requires the request's Origin to be an extension-scheme
// origin (chrome-extension://…), which a web page cannot forge.

"use strict";

globalThis.__YTB_INGEST = "http://127.0.0.1:8976/_internal/sync";
globalThis.__YTB_TOKEN = "ytb-internal-7f3a9c2e1b8d4056-v1";
