// content/youtube.js — youtube.com adapter.
//
// Active only on /watch pages. Shorts (/shorts/) are out of scope for v1 and report
// inactive. Selectors are centralized; document.title is the fallback for the title.

(function () {
  "use strict";

  const SELECTORS = {
    title: "ytd-watch-metadata h1, h1.ytd-watch-metadata, #title h1",
    channel: "ytd-watch-metadata #owner #channel-name a, #owner #channel-name a, ytd-channel-name a",
    next: ".ytp-next-button",
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

  const adapter = {
    source: "youtube",

    isActive() {
      if (location.pathname.startsWith("/shorts/")) return false; // out of scope v1
      return location.pathname === "/watch" && !!videoIdFromUrl();
    },

    readMeta() {
      const videoId = videoIdFromUrl();
      const title =
        text(SELECTORS.title) ||
        (document.title ? document.title.replace(/ - YouTube$/, "") : null);
      return {
        title,
        artist: text(SELECTORS.channel), // channel name stands in for "artist"
        album: null,
        videoId,
        artworkUrl: videoId
          ? "https://i.ytimg.com/vi/" + videoId + "/hqdefault.jpg"
          : null,
      };
    },

    next() {
      const btn = document.querySelector(SELECTORS.next);
      if (btn) btn.click();
    },

    // No reliable "previous track" on a single video page: restart it.
    previous(video) {
      if (video) video.currentTime = 0;
    },
  };

  // The page-world teardown helper (page-mediasession.js) clears the macOS Now
  // Playing card on teardown; it runs in the MAIN world, registered by background.js
  // as a MAIN-world content script (injecting it here with <script src> is blocked
  // by YouTube's CSP).
  __ytBridge.run(adapter);
})();
