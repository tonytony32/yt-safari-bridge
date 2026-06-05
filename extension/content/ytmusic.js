// content/ytmusic.js — YouTube Music adapter.
//
// All selectors live in SELECTORS so drift has one place to fix. Code defensively:
// any read may return null, and the engine falls back to document.title.
//
// navigator.mediaSession is NOT used: content scripts run in an isolated world in
// Safari and the page's mediaSession metadata object is not visible there. Ground
// truth is the <video> element plus the player-bar DOM.

(function () {
  "use strict";

  const SELECTORS = {
    title: ".title.ytmusic-player-bar",
    byline: ".byline.ytmusic-player-bar",
    // Prefer the dedicated song image; fall back to the player-bar thumbnail.
    image: "#song-image img, img.ytmusic-player-bar, .image.ytmusic-player-bar img",
    next: ".next-button.ytmusic-player-bar",
    prev: ".previous-button.ytmusic-player-bar",
  };

  const text = (sel) => {
    const el = document.querySelector(sel);
    const t = el && el.textContent ? el.textContent.trim() : "";
    return t || null;
  };

  function videoIdFromUrl() {
    try {
      return new URLSearchParams(location.search).get("v") || null;
    } catch {
      return null;
    }
  }

  // Byline is "Artist • Album • Year" for songs (or "Artist • Views • Year" for
  // uploaded videos — album may be approximate there; acceptable for v1).
  function parseByline() {
    const raw = text(SELECTORS.byline);
    if (!raw) return { artist: null, album: null };
    const parts = raw
      .split("•")
      .map((s) => s.trim())
      .filter(Boolean);
    return {
      artist: parts[0] || null,
      album: parts.length >= 3 ? parts[1] || null : null,
    };
  }

  const adapter = {
    source: "youtube_music",

    // The YT Music player bar persists across SPA navigation; treat any present
    // <video> with loaded media as active.
    isActive(video) {
      return !!video && (video.readyState >= 1 || !video.paused || video.currentTime > 0);
    },

    readMeta() {
      const { artist, album } = parseByline();
      const img = document.querySelector(SELECTORS.image);
      return {
        title: text(SELECTORS.title),
        artist,
        album,
        videoId: videoIdFromUrl(),
        artworkUrl: __ytBridge.largestSrcsetUrl(img),
      };
    },

    next() {
      const btn = document.querySelector(SELECTORS.next);
      if (btn) btn.click();
    },

    previous(video) {
      const btn = document.querySelector(SELECTORS.prev);
      if (btn) btn.click();
      else if (video) video.currentTime = 0;
    },
  };

  __ytBridge.run(adapter);
})();
