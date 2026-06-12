// background.js — event-driven relay between content scripts and the native handler.
//
// Critical Safari constraint: this page is unloaded after idle and its setInterval
// callbacks are NOT invoked afterward. So it owns NO timers. Incoming runtime
// messages (and tabs.onRemoved) wake it; each wake carries one round trip — push
// state up via sendNativeMessage, dispatch any commands that come back down.

"use strict";

// Page-world helpers. The content scripts above run in Safari's ISOLATED world,
// where the real player API (#movie_player.setVolume) and navigator.mediaSession
// live in the page and are unreachable. These must run in the page's own JS
// context. Injecting them with <script src="safari-web-extension://…"> is blocked
// by YouTube's strict CSP (script-src), so we register them as MAIN-world content
// scripts instead (scripting.registerContentScripts, Safari 16.4+) — those are
// injected by the engine and are NOT subject to the page CSP.
const PAGE_WORLD_SCRIPTS = [
  {
    id: "ytbridge-page-volume",
    matches: ["*://music.youtube.com/*"],
    js: ["content/page-volume.js"],
    runAt: "document_idle",
    world: "MAIN",
    allFrames: false,
  },
  {
    id: "ytbridge-page-mediasession",
    matches: ["*://www.youtube.com/*", "*://music.youtube.com/*"],
    js: ["content/page-mediasession.js"],
    runAt: "document_idle",
    world: "MAIN",
    allFrames: false,
  },
];

// On install/update: unregister first so a changed matches/world/id in a new build
// replaces the stale registration, then register fresh.
async function reregisterPageWorldScripts() {
  const ids = PAGE_WORLD_SCRIPTS.map((s) => s.id);
  try {
    await browser.scripting.unregisterContentScripts({ ids });
  } catch (e) {
    // None registered yet (first install): nothing to remove.
  }
  try {
    await browser.scripting.registerContentScripts(PAGE_WORLD_SCRIPTS);
  } catch (e) {
    // If MAIN-world registration is unavailable, volume still changes audio via
    // the <video>.volume fallback in the content script (it just won't persist).
  }
}

// Self-heal on every event-page load: register only what is missing. Registration
// persists across sessions, so after the first time this is a single cheap read.
// This covers the case where onInstalled does not fire (e.g. a dev rebuild that
// keeps the same version) — without it the helpers would never get registered.
async function ensurePageWorldScripts() {
  try {
    const have = await browser.scripting.getRegisteredContentScripts({
      ids: PAGE_WORLD_SCRIPTS.map((s) => s.id),
    });
    const haveIds = new Set(have.map((s) => s.id));
    const missing = PAGE_WORLD_SCRIPTS.filter((s) => !haveIds.has(s.id));
    if (missing.length) await browser.scripting.registerContentScripts(missing);
  } catch (e) {
    // scripting API unavailable: fall back to <video>.volume (see above).
  }
}

browser.runtime.onInstalled.addListener(reregisterPageWorldScripts);
ensurePageWorldScripts();

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

// The state JellySleeve should see, with tabId attached. {active:false} when idle.
function activeState() {
  if (activeTabId != null && tabStates.has(activeTabId)) {
    return Object.assign({}, tabStates.get(activeTabId), { tabId: activeTabId });
  }
  return { active: false };
}

async function syncNative() {
  try {
    const reply = await browser.runtime.sendNativeMessage("application.id", {
      type: "sync",
      state: activeState(),
    });
    const commands = (reply && reply.commands) || [];
    for (const cmd of commands) dispatchToActiveTab(cmd);
  } catch (e) {
    // No native host yet (Phase 0) or handler momentarily down: ignore. The next
    // content-script push will retry the round trip.
  }
}

function dispatchToActiveTab(cmd) {
  if (activeTabId == null || !cmd || typeof cmd.action !== "string") return;
  try {
    const p = browser.tabs.sendMessage(activeTabId, {
      type: "command",
      action: cmd.action,
      value: cmd.value,
    });
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch {}
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
