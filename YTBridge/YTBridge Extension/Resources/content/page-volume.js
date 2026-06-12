// content/page-volume.js — MAIN-WORLD helper (registered by background.js).
//
// The site adapter (ytmusic.js) runs in Safari's ISOLATED world, where the
// `#movie_player` player API is not reachable. This file is registered as a
// MAIN-world content script, so it runs in the page's own JS context and can
// drive the real player. It only ever reads our own data-attribute and sets
// volume — no other surface. (It is a MAIN-world content script rather than a
// <script src> injection because YouTube's CSP blocks injected extension scripts.)
//
// Protocol: ytmusic.js writes the target percent (0–100) to
// document.documentElement[data-ytbridge-volume] and fires the
// `ytbridge-setvolume` event on window. We read the attribute (CustomEvent
// detail does not survive the isolated→main world hop; a DOM attribute does).
(function () {
  "use strict";

  function applyVolume() {
    var raw = document.documentElement.getAttribute("data-ytbridge-volume");
    var pct = parseInt(raw, 10);
    if (!isFinite(pct)) return;
    pct = Math.min(100, Math.max(0, pct));

    // Drive the player API. This is the source of truth YT Music re-asserts onto
    // the <video> element, so setting it here is what makes the change *stick* (a
    // bare <video>.volume gets overwritten within ~10–20 s); confirmed in the page
    // world that setVolume() alone persists.
    try {
      var mp = document.getElementById("movie_player");
      if (mp && typeof mp.setVolume === "function") {
        if (typeof mp.unMute === "function") mp.unMute();
        mp.setVolume(pct);
      }
    } catch (e) {}

    // Best-effort: nudge the visible slider widget too, where the layout exposes
    // one, so the on-screen control tracks the change. Absent on some layouts —
    // harmless no-op then, since the player API above already did the real work.
    try {
      var sl = document.querySelector("#volume-slider");
      if (sl) {
        sl.value = pct;
        sl.dispatchEvent(new Event("change", { bubbles: true }));
      }
    } catch (e) {}
  }

  window.addEventListener("ytbridge-setvolume", applyVolume);
})();
