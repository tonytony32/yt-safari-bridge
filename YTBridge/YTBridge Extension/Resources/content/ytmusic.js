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
    // Player-bar thumbnail. Tried in order; the first <img> with a YT thumbnail
    // src wins. `ytmusic-player-bar img` catches it regardless of class drift.
    image: [
      "ytmusic-player-bar #song-image img",
      "ytmusic-player-bar img.image",
      "ytmusic-player-bar img#img",
      "ytmusic-player-bar img",
      "#song-image img",
      "img.ytmusic-player-bar",
    ],
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

  function videoIdFromArtwork(url) {
    if (typeof url !== "string") return null;
    const m = url.match(/\/vi\/([A-Za-z0-9_-]{6,})\//);
    return m ? m[1] : null;
  }

  // The player-bar title is usually a link to watch?v=<id>; recover the id there
  // when the page URL is a playlist/library view and the art is album art.
  function videoIdFromPlayerBar() {
    const a = document.querySelector('ytmusic-player-bar a[href*="watch?v="]');
    if (!a) return null;
    try {
      return new URL(a.href, location.href).searchParams.get("v") || null;
    } catch {
      return null;
    }
  }

  // A view-count segment ("141 K visualizaciones", "1.2M views", "3,4 Mio. Aufrufe"…)
  // — language-agnostic-ish: it carries a digit AND a "views" word. Used to tell a
  // real song byline ("Artist • Album • Year") from a video byline
  // ("Artist • Views • Year"), where there is no album.
  const VIEWS_WORD = /(views?|visualizaç|visualizaciones|reproducc|vues|aufrufe|просмотр|再生|회|观看|次)/i;
  const isViewCount = (s) => /\d/.test(s) && VIEWS_WORD.test(s);
  const isYearOnly = (s) => /^\d{4}$/.test(s);

  // Byline is "Artist • Album • Year" for songs, or "Artist • Views • Year" for
  // uploaded videos (no album). Take parts[1] as album only when it looks like a
  // real album name — not a view count and not a bare year.
  function parseByline() {
    const raw = text(SELECTORS.byline);
    if (!raw) return { artist: null, album: null };
    const parts = raw
      .split("•")
      .map((s) => s.trim())
      .filter(Boolean);
    const mid = parts.length >= 3 ? parts[1] : null;
    const album = mid && !isViewCount(mid) && !isYearOnly(mid) ? mid : null;
    return { artist: parts[0] || null, album };
  }

  // Walk the candidate selectors; return the largest srcset URL from the first
  // <img> that actually has a usable source. common.js then host-allowlists it.
  function pickArtwork() {
    for (const sel of SELECTORS.image) {
      const img = document.querySelector(sel);
      if (!img) continue;
      const url = __ytBridge.largestSrcsetUrl(img);
      if (url) return url;
    }
    return null;
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
      const artworkUrl = pickArtwork();
      // On playlist/library pages the URL has no ?v=; recover the id from the
      // player-bar thumbnail (i.ytimg.com/vi/<id>/...).
      const videoId =
        videoIdFromUrl() ||
        videoIdFromPlayerBar() ||
        videoIdFromArtwork(artworkUrl);
      return {
        title: text(SELECTORS.title),
        artist,
        album,
        videoId,
        artworkUrl,
        url: videoId
          ? "https://music.youtube.com/watch?v=" + videoId
          : location.href,
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

    // YT Music owns volume through its Polymer slider and re-asserts it onto the
    // <video> a few seconds after we set it — so setting <video>.volume alone is
    // transient. Drive the real slider instead, via the page-world helper (its
    // `.value` setter is unreachable from the content script's isolated world).
    // We also set <video>.volume here for immediate audio feedback even if the
    // helper is unavailable (e.g. blocked before it loads).
    setVolume(frac) {
      const v = Math.min(1, Math.max(0, frac));
      const video = document.querySelector("video");
      if (video) video.volume = v;
      try {
        document.documentElement.setAttribute(
          "data-ytbridge-volume",
          String(Math.round(v * 100))
        );
        window.dispatchEvent(new Event("ytbridge-setvolume"));
      } catch {}
    },
  };

  // Inject the page-world volume helper once. `<script src=…>` (not innerHTML /
  // eval) keeps the no-dynamic-code rule; it runs in the page world so it can
  // reach `#movie_player` / the slider's Polymer setter.
  function injectPageVolumeHelper() {
    try {
      const s = document.createElement("script");
      s.src = browser.runtime.getURL("content/page-volume.js");
      s.addEventListener("load", () => s.remove());
      (document.head || document.documentElement).appendChild(s);
    } catch {}
  }
  injectPageVolumeHelper();

  __ytBridge.run(adapter);
})();
