// content/page-volume.js — PAGE-WORLD helper (injected by ytmusic.js).
//
// The content script runs in Safari's isolated world, where YT Music's Polymer
// volume slider `.value` setter (and the `#movie_player` player API) are not
// reachable. This file runs in the *page* world, so it can drive both. It only
// ever reads our own data-attribute and sets volume — no other surface.
//
// Protocol: ytmusic.js writes the target percent (0–100) to
// document.documentElement[data-ytbridge-volume] and fires the
// `ytbridge-setvolume` event on window. We read the attribute (CustomEvent
// detail does not survive the isolated→page world hop; a DOM attribute does).
(function () {
  "use strict";

  function applyVolume() {
    var raw = document.documentElement.getAttribute("data-ytbridge-volume");
    var pct = parseInt(raw, 10);
    if (!isFinite(pct)) return;
    pct = Math.min(100, Math.max(0, pct));

    // Drive the actual player (immediate audio) …
    try {
      var mp = document.getElementById("movie_player");
      if (mp && typeof mp.setVolume === "function") {
        if (typeof mp.unMute === "function") mp.unMute();
        mp.setVolume(pct);
      }
    } catch (e) {}

    // … and the slider widget, so its Polymer value updates and stops
    // re-asserting the old level over the player a few seconds later.
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
