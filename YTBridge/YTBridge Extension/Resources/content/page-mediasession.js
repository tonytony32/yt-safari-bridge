// content/page-mediasession.js — PAGE-WORLD teardown helper (injected by the
// youtube.js / ytmusic.js content scripts).
//
// Why this exists: YouTube and YT Music set navigator.mediaSession in the *page*
// world, and that object is what Safari registers with macOS as the system
// "Now Playing" card (Control Center / media keys / menu bar). The content script
// runs in the isolated world and cannot see it (see ytmusic.js header). When Safari
// tears the page down — closing the tab/window or quitting the app — the site does
// not reliably clear its mediaSession, so the card lingers with the last title +
// artwork even though nothing is playing and Safari is gone.
//
// Running in the page world, this helper clears the real mediaSession and stops the
// player on teardown, nudging Safari to deregister the card before the page (and the
// app) die. It only ever acts on genuine teardown — never during normal playback —
// so it does not fight the site's own Now Playing handling.
//
// No eval / innerHTML; it only reads/writes navigator.mediaSession and calls the
// player's documented pause API.
(function () {
  "use strict";

  function clearNowPlaying() {
    try {
      var ms = navigator.mediaSession;
      if (ms) {
        try { ms.playbackState = "none"; } catch (e) {}
        try { ms.metadata = null; } catch (e) {}
      }
    } catch (e) {}
    // Pausing the real player makes Safari push a "stopped" to the system Now
    // Playing center, which together with the null metadata removes the card.
    try {
      var mp = document.getElementById("movie_player");
      if (mp && typeof mp.pauseVideo === "function") mp.pauseVideo();
    } catch (e) {}
    try {
      var v = document.querySelector("video");
      if (v && !v.paused) v.pause();
    } catch (e) {}
  }

  // pagehide(persisted=true) is a bfcache freeze the page can be restored from —
  // leave its media intact. Everything else (close, quit, real navigation) is a
  // teardown where we want the card gone.
  window.addEventListener("pagehide", function (e) {
    if (e && e.persisted) return;
    clearNowPlaying();
  });
  // Plain listener (never sets returnValue), so it does not raise a "leave site?"
  // prompt; it just gives us one more reliable teardown hook than pagehide alone.
  window.addEventListener("beforeunload", clearNowPlaying);
})();
