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

browser.runtime.onInstalled.addListener(reregisterPageWorldScripts);
ensurePageWorldScripts();

// Persist volume by driving the page's real player API in the MAIN world. The
// ISOLATED-world content script can only set <video>.volume, which YT Music
// re-asserts its own level over within ~10–20 s; #movie_player.setVolume() is the
// source of truth it honors. executeScript({world:"MAIN"}) is the one MAIN-world
// path desktop Safari runs reliably, and setVolume is command-driven so injecting
// on demand is fine. Works on both youtube.com and music.youtube.com (both expose
// #movie_player). value is a 0.0–1.0 fraction.
function persistVolume(tabId, value) {
  if (tabId == null || typeof value !== "number" || !Number.isFinite(value)) return;
  try {
    const p = browser.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: (frac) => {
        const v = Math.min(1, Math.max(0, frac));
        try {
          const mp = document.getElementById("movie_player");
          if (mp && typeof mp.setVolume === "function") {
            if (typeof mp.unMute === "function") mp.unMute();
            mp.setVolume(Math.round(v * 100));
          }
        } catch (e) {}
        try {
          const el = document.querySelector("video");
          if (el) el.volume = v;
        } catch (e) {}
      },
      args: [value],
    });
    if (p && typeof p.catch === "function") p.catch(() => {});
  } catch (e) {}
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
  // The content-script message above sets <video>.volume for instant feedback, but
  // YT Music re-asserts over it; make the change stick by also driving the real
  // player API in the MAIN world (the content script can't reach it).
  if (cmd.action === "setVolume") persistVolume(activeTabId, cmd.value);
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
