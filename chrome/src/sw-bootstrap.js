// sw-bootstrap.js — Chrome MV3 background service-worker entry point.
//
// Chrome MV3 allows only a single `background.service_worker` file (no `background.scripts`
// array like Firefox/Safari event pages), so this bootstrap pulls in the shared relay the way
// the Firefox manifest's scripts array does — same order, same shared global:
//   1. chrome-shim.js   — define `browser` (= chrome) before anything uses it
//   2. chrome-config.js — set globalThis.__YTB_INGEST / __YTB_TOKEN (read by forwardSync)
//   3. background.js     — the shared relay; registers its runtime/tabs/alarms listeners
//
// MUST be a CLASSIC worker (no "type":"module" in the manifest): importScripts() exists only
// in classic workers, and the reuse contract depends on a single shared mutable globalThis so
// the config's globals reach background.js. importScripts is synchronous and in-order, run at
// top level so the listeners are registered during initial evaluation (required for MV3 SW
// event delivery after a cold wake).

"use strict";

importScripts("chrome-shim.js", "chrome-config.js", "background.js");
