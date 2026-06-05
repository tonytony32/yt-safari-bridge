// console-test.js — paste into the Safari Web Inspector console on a youtube.com/watch
// or music.youtube.com tab to validate the Phase 0 scrapers WITHOUT loading the
// extension. Self-contained: mirrors the logic in extension/common.js + the adapters.
//
// Prints the state object once per second. Call __ytBridgeStop() to stop.

(function () {
  "use strict";

  const ARTWORK_HOSTS = new Set(["i.ytimg.com", "music.youtube.com"]);
  const safe = (n) => (Number.isFinite(n) ? n : null);
  const text = (sel) => {
    const el = document.querySelector(sel);
    const t = el && el.textContent ? el.textContent.trim() : "";
    return t || null;
  };
  const vid = () => {
    try {
      return new URLSearchParams(location.search).get("v") || null;
    } catch {
      return null;
    }
  };
  const artworkHostOk = (h) =>
    ARTWORK_HOSTS.has(h) ||
    h === "googleusercontent.com" ||
    h.endsWith(".googleusercontent.com");
  function allowlistArtwork(url) {
    if (typeof url !== "string" || !url) return null;
    try {
      const u = new URL(url, location.href);
      return artworkHostOk(u.hostname) ? u.href : null;
    } catch {
      return null;
    }
  }
  function largestSrcsetUrl(img) {
    if (!img) return null;
    const srcset = img.getAttribute("srcset");
    if (!srcset) return img.currentSrc || img.src || null;
    let best = null,
      bestW = -1;
    for (const part of srcset.split(",")) {
      const seg = part.trim().split(/\s+/);
      const u = seg[0];
      if (!u) continue;
      const w = (seg[1] || "").endsWith("w") ? parseInt(seg[1], 10) : 1;
      const width = Number.isFinite(w) ? w : 1;
      if (width > bestW) {
        bestW = width;
        best = u;
      }
    }
    return best || img.currentSrc || img.src || null;
  }

  const isMusic = location.hostname === "music.youtube.com";

  const VIEWS_WORD = /(views?|visualizaç|visualizaciones|reproducc|vues|aufrufe|просмотр|再生|회|观看|次)/i;
  const isViewCount = (s) => /\d/.test(s) && VIEWS_WORD.test(s);
  const isYearOnly = (s) => /^\d{4}$/.test(s);
  const MUSIC_IMG_SELS = [
    "ytmusic-player-bar #song-image img",
    "ytmusic-player-bar img.image",
    "ytmusic-player-bar img#img",
    "ytmusic-player-bar img",
    "#song-image img",
    "img.ytmusic-player-bar",
  ];

  const vidFromArtwork = (u) => {
    const m = typeof u === "string" && u.match(/\/vi\/([A-Za-z0-9_-]{6,})\//);
    return m ? m[1] : null;
  };
  const vidFromPlayerBar = () => {
    const a = document.querySelector('ytmusic-player-bar a[href*="watch?v="]');
    try {
      return a ? new URL(a.href, location.href).searchParams.get("v") : null;
    } catch {
      return null;
    }
  };

  function readMusic() {
    const raw = text(".byline.ytmusic-player-bar");
    const parts = raw ? raw.split("•").map((s) => s.trim()).filter(Boolean) : [];
    const mid = parts.length >= 3 ? parts[1] : null;
    const album = mid && !isViewCount(mid) && !isYearOnly(mid) ? mid : null;
    let artworkUrl = null;
    for (const sel of MUSIC_IMG_SELS) {
      const u = largestSrcsetUrl(document.querySelector(sel));
      if (u) {
        artworkUrl = u;
        break;
      }
    }
    const videoId = vid() || vidFromPlayerBar() || vidFromArtwork(artworkUrl);
    return {
      title: text(".title.ytmusic-player-bar"),
      artist: parts[0] || null,
      album,
      videoId,
      artworkUrl,
      url: videoId ? "https://music.youtube.com/watch?v=" + videoId : location.href,
    };
  }

  function readYouTube() {
    const id = vid();
    return {
      title:
        text("ytd-watch-metadata h1, h1.ytd-watch-metadata, #title h1") ||
        (document.title ? document.title.replace(/ - YouTube$/, "") : null),
      artist: text("#owner #channel-name a, ytd-channel-name a"),
      album: null,
      videoId: id,
      artworkUrl: id ? "https://i.ytimg.com/vi/" + id + "/hqdefault.jpg" : null,
    };
  }

  function build() {
    const video = document.querySelector("video");
    if (!video) return null;
    const meta = isMusic ? readMusic() : readYouTube();
    return {
      active: true,
      source: isMusic ? "youtube_music" : "youtube",
      state: video.paused ? "paused" : "playing",
      title: meta.title || document.title || null,
      artist: meta.artist || null,
      album: meta.album || null,
      durationSec: safe(video.duration),
      positionSec: safe(video.currentTime),
      videoId: meta.videoId || null,
      url: meta.url || location.href,
      artworkUrl: allowlistArtwork(meta.artworkUrl),
      volume: safe(video.volume),
    };
  }

  if (window.__ytBridgeTimer) clearInterval(window.__ytBridgeTimer);
  window.__ytBridgeStop = () => clearInterval(window.__ytBridgeTimer);
  window.__ytBridgeTimer = setInterval(() => console.log(build()), 1000);
  console.log("yt-bridge console test running. __ytBridgeStop() to stop.");
  console.log(build());
})();
