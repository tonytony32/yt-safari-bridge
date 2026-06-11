// background.js — event-driven relay between content scripts and the native handler.
//
// Critical Safari constraint: this page is unloaded after idle and its setInterval
// callbacks are NOT invoked afterward. So it owns NO timers. Incoming runtime
// messages (and tabs.onRemoved) wake it; each wake carries one round trip — push
// state up via sendNativeMessage, dispatch any commands that come back down.

"use strict";

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
  // Re-insert to move this tab to the end → Map order tracks update recency,
  // which pickFallbackActive() relies on when the active tab closes.
  tabStates.delete(tabId);
  tabStates.set(tabId, msg.state);
  if (msg.state && msg.state.state === "playing") activeTabId = tabId;
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
