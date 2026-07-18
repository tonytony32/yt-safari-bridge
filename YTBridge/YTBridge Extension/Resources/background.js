// background.js — event-driven relay between content scripts and the native handler.
//
// Critical Safari constraint: this page is unloaded after idle and its setInterval
// callbacks are NOT invoked afterward. So it owns NO timers. Incoming runtime
// messages (and tabs.onRemoved) wake it; each wake carries one round trip — push
// state up via sendNativeMessage, dispatch any commands that come back down.

"use strict";

// Page-world helpers. Content scripts run in Safari's ISOLATED world, where the
// real player API (#movie_player) and navigator.mediaSession live in the page and
// are unreachable. Code that needs them must run in the page's MAIN world.
//
// Two ways to reach MAIN world; on desktop Safari they do NOT behave the same:
//   - scripting.executeScript({world:"MAIN"}) — works. Used for setVolume, which is
//     command-driven, so an on-demand inject per command fits (see persistVolume).
//   - scripting.registerContentScripts({world:"MAIN"}) — the registration succeeds
//     but desktop Safari does NOT actually inject/run it (confirmed empirically:
//     getRegisteredContentScripts lists it, yet the script never executes). So it
//     is unreliable for anything we depend on.
// Injecting via <script src="safari-web-extension://…"> is a third option but is
// blocked by YouTube's strict CSP (script-src), so it is out.
//
// page-mediasession.js is a teardown hook (pagehide/beforeunload) that has to be
// resident in the page, which executeScript can't do — so it stays a registered
// MAIN-world content script, accepting that it may be a no-op on desktop Safari
// until Apple fixes registered MAIN injection. (It only clears a lingering Now
// Playing card; degrading to "card lingers briefly" is acceptable.)
const PAGE_WORLD_SCRIPTS = [
  {
    id: "ytbridge-page-mediasession",
    matches: ["*://www.youtube.com/*", "*://music.youtube.com/*"],
    js: ["content/page-mediasession.js"],
    runAt: "document_idle",
    world: "MAIN",
    allFrames: false,
  },
];

// Ids registered by older builds that must be torn down (page-volume.js is gone;
// volume now goes through persistVolume()/executeScript instead).
const OBSOLETE_SCRIPT_IDS = ["ytbridge-page-volume"];

// On install/update: unregister current + obsolete ids, then register fresh, so a
// changed matches/world/id (or a removed script) in a new build fully replaces the
// stale registration.
async function reregisterPageWorldScripts() {
  const ids = PAGE_WORLD_SCRIPTS.map((s) => s.id).concat(OBSOLETE_SCRIPT_IDS);
  try {
    await browser.scripting.unregisterContentScripts({ ids });
  } catch (e) {
    // None registered yet (first install): nothing to remove.
  }
  try {
    await browser.scripting.registerContentScripts(PAGE_WORLD_SCRIPTS);
  } catch (e) {
    // registerContentScripts unavailable: only the Now Playing teardown helper is
    // affected; volume is unaffected (it goes through executeScript).
  }
}

// Self-heal on every event-page load: drop any obsolete registrations, then add
// whatever current script is missing. Registration persists across sessions, so
// after convergence this is a single cheap read per wake. Covers the case where
// onInstalled does not fire (e.g. a dev rebuild that keeps the same version).
async function ensurePageWorldScripts() {
  try {
    const have = await browser.scripting.getRegisteredContentScripts();
    const haveIds = new Set(have.map((s) => s.id));
    const obsolete = OBSOLETE_SCRIPT_IDS.filter((id) => haveIds.has(id));
    if (obsolete.length) {
      try {
        await browser.scripting.unregisterContentScripts({ ids: obsolete });
      } catch (e) {}
    }
    const missing = PAGE_WORLD_SCRIPTS.filter((s) => !haveIds.has(s.id));
    if (missing.length) await browser.scripting.registerContentScripts(missing);
  } catch (e) {
    // scripting API unavailable: nothing to do here (volume still works via
    // executeScript when a command arrives).
  }
}

browser.runtime.onInstalled.addListener(() => {
  reregisterPageWorldScripts();
  ensureKeepalive();
});
ensurePageWorldScripts();

// Persist volume by driving the page's real player API in the MAIN world. The
// ISOLATED-world content script can only set <video>.volume, which YT Music
// re-asserts its own level over within ~10–20 s; #movie_player.setVolume() is the
// source of truth it honors. executeScript({world:"MAIN"}) is the one MAIN-world
// path desktop Safari runs reliably, and setVolume is command-driven so injecting
// on demand is fine. Works on both youtube.com and music.youtube.com (both expose
// #movie_player). value is a 0.0–1.0 fraction. Returns the executeScript promise so
// the caller can AWAIT it — the background is a non-persistent event page, and a
// fire-and-forget inject gets killed when the page suspends right after the sync
// round trip, so the volume change never lands. The caller keeps the page alive by
// awaiting this inside the same chain that already awaits the native round trip.
function persistVolume(tabId, value) {
  if (tabId == null || typeof value !== "number" || !Number.isFinite(value)) {
    return Promise.resolve();
  }
  return browser.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: (frac) => {
      const v = Math.min(1, Math.max(0, frac));
      const pct = Math.round(v * 100);
      // The player API: the source of truth for audio that YT Music honors and
      // doesn't re-assert over.
      try {
        const mp = document.getElementById("movie_player");
        if (mp && typeof mp.setVolume === "function") {
          if (typeof mp.unMute === "function") mp.unMute();
          mp.setVolume(pct);
        }
      } catch (e) {}
      // YT Music's on-screen volume sliders don't track the player API on their
      // own, so the visible control would sit at the old position. Set the Polymer
      // .value (reachable here in the MAIN world) so the UI reflects the change.
      try {
        ["volume-slider", "expand-volume-slider"].forEach((id) => {
          const sl = document.getElementById(id);
          if (sl) {
            sl.value = pct;
            sl.dispatchEvent(new Event("change", { bubbles: true }));
          }
        });
      } catch (e) {}
      try {
        const el = document.querySelector("video");
        if (el) el.volume = v;
      } catch (e) {}
    },
    args: [value],
  });
}

// tabId -> latest state object reported by that tab's content script.
const tabStates = new Map();

// The active tab is the last one that reported state === "playing". A paused tab
// stays active until another tab starts playing.
let activeTabId = null;

function pickFallbackActive() {
  // On active-tab removal, prefer the most-recently-updated tab that is still
  // playing; otherwise fall back to the most-recently-updated tab of any state.
  // The Map is kept in update-recency order (see onMessage: delete+set), so the
  // last matching key is the most recent.
  let playing = null;
  let last = null;
  for (const [id, st] of tabStates) {
    last = id;
    if (st && st.state === "playing") playing = id;
  }
  return playing ?? last;
}

// The state JellyBeat should see, with tabId attached. {active:false} when idle.
function activeState() {
  if (activeTabId != null && tabStates.has(activeTabId)) {
    return Object.assign({}, tabStates.get(activeTabId), { tabId: activeTabId });
  }
  return { active: false };
}

// One sync round trip to the bridge host: push state up, get queued commands back. The
// transport differs per browser, and is the ONLY browser-specific line in this file:
//   - Safari has a native containing app, so it relays through it (sendNativeMessage →
//     SafariWebExtensionHandler → loopback POST to the host). URLSession sends no Origin.
//   - Chrome/Firefox have no containing app, so they POST the host's loopback ingest
//     directly. Their build defines globalThis.__YTB_INGEST (+ __YTB_TOKEN) via a config
//     shim loaded before this file (see manifest background.scripts order); Safari leaves
//     them undefined and falls through to native messaging — identical behavior to before.
// Either path resolves to { commands: [...] } (or {} on failure); callers read .commands.
async function forwardSync(payload) {
  const ingest = globalThis.__YTB_INGEST;
  if (ingest) {
    const res = await fetch(ingest, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-YTBridge-Token": globalThis.__YTB_TOKEN || "",
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return {};
    return await res.json();
  }
  return browser.runtime.sendNativeMessage("application.id", payload);
}

async function syncNative() {
  try {
    const reply = await forwardSync({ type: "sync", state: activeState() });
    const commands = (reply && reply.commands) || [];
    // Await each dispatch so the event page stays alive until the MAIN-world volume
    // inject (executeScript) actually completes — see persistVolume.
    for (const cmd of commands) {
      // focusTab is a tab/window action (raise the playing tab), not a playback
      // command — handle it here instead of forwarding to the content script,
      // which default-rejects anything outside its playback allowlist.
      if (cmd && cmd.action === "focusTab") await focusActiveTab();
      else await dispatchToActiveTab(cmd);
    }
  } catch (e) {
    // No native host yet (Phase 0) or handler momentarily down: ignore. The next
    // content-script push will retry the round trip.
  }
}

// Bring the active (playing) tab — and its window — to the foreground. Triggered
// by a focusTab command (the container app's "double-click the cover art"). Uses
// tabs.update / windows.update, which work with our host permissions alone (the
// `tabs` permission only gates reading url/title, which we never need).
async function focusActiveTab() {
  if (activeTabId == null) return;
  try {
    const tab = await browser.tabs.update(activeTabId, { active: true });
    if (tab && tab.windowId != null) {
      await browser.windows.update(tab.windowId, { focused: true });
    }
  } catch {}
}

async function dispatchToActiveTab(cmd) {
  if (activeTabId == null || !cmd || typeof cmd.action !== "string") return;
  try {
    await browser.tabs.sendMessage(activeTabId, {
      type: "command",
      action: cmd.action,
      value: cmd.value,
    });
  } catch {}
  // The content-script message above sets <video>.volume for instant feedback, but
  // YT Music re-asserts over it; make the change stick by also driving the real
  // player API in the MAIN world (the content script can't reach it). Awaited so the
  // event page doesn't suspend mid-inject.
  if (cmd.action === "setVolume") {
    try {
      await persistVolume(activeTabId, cmd.value);
    } catch (e) {}
  }
}

browser.runtime.onMessage.addListener((msg, sender) => {
  if (!msg || msg.type !== "state" || !sender || !sender.tab) return;
  const tabId = sender.tab.id;
  const wasPlaying =
    tabStates.has(tabId) && tabStates.get(tabId)?.state === "playing";
  const nowPlaying = !!(msg.state && msg.state.state === "playing");
  // Re-insert to move this tab to the end → Map order tracks update recency,
  // which pickFallbackActive() relies on when the active tab closes.
  tabStates.delete(tabId);
  tabStates.set(tabId, msg.state);
  // Hand off the active slot only on the rising edge (a tab transitioning *into*
  // playing). Doing it on every "playing" heartbeat made two tabs playing at once
  // flip activeTabId back and forth every ~500ms, so now-playing oscillated between
  // their two tracks. A steady-state heartbeat from the already-active tab keeps it.
  if (nowPlaying && !wasPlaying) activeTabId = tabId;
  else if (activeTabId == null) activeTabId = tabId;
  // Relay this push (and pull back any queued commands) in one round trip.
  syncNative();
});

browser.tabs.onRemoved.addListener((tabId) => {
  tabStates.delete(tabId);
  if (activeTabId === tabId) activeTabId = pickFallbackActive();
  // Final sync so the consumer sees the player go away (may be {active:false}).
  syncNative();
});

// Bind the bridge proactively at browser launch. The native HTTP server lives in
// the extension process and only binds as a side effect of a sync (the handler's
// beginRequest -> HTTPServer.ensureRunning()). Nothing drove a sync at startup, so
// after every Safari launch the socket stayed down — JellyBeat saw connection
// refused ("idle") — until a YouTube tab happened to push state, or the user
// toggled the extension off/on to force a content-script re-inject. onStartup wakes
// this non-persistent event page once per browser session (the Apple/MDN-supported
// hook for exactly this), so we sync straight away: the round trip reports
// {active:false} (no tab yet) and binds the listener, letting JellyBeat connect
// immediately even before any YouTube tab is open.
browser.runtime.onStartup.addListener(() => {
  ensureKeepalive();
  syncNative();
});

// Keep the bridge socket warm independent of playback. The native HTTP server lives
// in the extension's handler process, which macOS reaps when idle; only a native
// sync revives it (beginRequest -> HTTPServer.ensureRunning). Content-script
// heartbeats drive syncs ONLY while a YouTube tab is actively pushing state — so
// with Safari open but nothing playing, the YT tab paused/idle (the silent `else`
// branch in common.js's tick() never pushes), or the tab throttled in the
// background, no sync happens: the handler process is reaped, the socket dies, and
// JellyBeat sees "connection refused" even though a YouTube tab is right there.
//
// A periodic alarm wakes this non-persistent event page on a cadence that does NOT
// depend on any tab or on playback; each wake does a sync that re-binds the listener
// via ensureRunning(). alarms is the one timer Safari honors for a suspended event
// page (setInterval/setTimeout are not — that's why the background owns no timers
// elsewhere). Any gap between ticks degrades only to the documented "connection
// refused == idle" contract (docs/api.md), never to stale state, because the
// StateStore staleness rule already reports {active:false} after 3 s. Safari clamps
// periodInMinutes to a floor (~0.5–1 min), so this is cheap.
const KEEPALIVE_ALARM = "ytbridge-keepalive";

function ensureKeepalive() {
  try {
    // Idempotent: creating an alarm with an existing name replaces it. Alarms
    // persist across event-page unloads, so re-creating on each load is harmless.
    browser.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
  } catch (e) {
    // alarms API unavailable: fall back to playback-driven syncs only (old behavior).
  }
}

if (browser.alarms && browser.alarms.onAlarm) {
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm && alarm.name === KEEPALIVE_ALARM) syncNative();
  });
}

// Arm on first load of the event page (covers enable/reload, where onStartup and
// onInstalled may not both fire).
ensureKeepalive();
