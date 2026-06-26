// chrome-shim.js — the WebExtension namespace shim for Chrome.
//
// The shared code (background.js, common.js, the content scripts) is written against the
// standardized `browser.*` namespace, which Safari and Firefox define natively. Chrome only
// defines `chrome.*`, so without this every `browser.runtime.*` call would throw
// ReferenceError. Aliasing is enough — NOT the full webextension-polyfill — because every
// API this project awaits (runtime/tabs/windows.sendMessage·update, scripting.executeScript·
// register/unregister/getRegisteredContentScripts, alarms.create) returns a native Promise in
// modern Chrome, and no callback-only API is used. Events (onMessage/onAlarm/…) are identical
// under the alias.
//
// Loaded first in BOTH execution contexts: as the first importScripts() in the service-worker
// bootstrap, and as the first entry of every content_scripts `js` array (Chrome defines no
// `browser` in the content-script isolated world either). Keep it dependency-free and trivial
// so it can't fail.

"use strict";

globalThis.browser = globalThis.browser || chrome;
