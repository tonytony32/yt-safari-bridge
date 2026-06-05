// common.js — shared helpers + the content-script bridge engine.
//
// Loaded BEFORE the site-specific content script (see manifest content_scripts.js
// order). All content scripts for a frame share one isolated-world global, so this
// file exposes `window.__ytBridge`, which youtube.js / ytmusic.js consume via
// `__ytBridge.run(adapter)`.
//
// Hard rules (see PLAN.md):
//   - No eval / new Function / innerHTML anywhere.
//   - All timing lives here (the background page must never need a timer).
//   - Every numeric field is sanitized to null if non-finite (livestream Infinity /
//     pre-metadata NaN would otherwise crash JSONSerialization on the Swift side).
//   - artworkUrl is host-allowlisted; anything else becomes null.

(function () {
  "use strict";

  // Hosts we trust to serve artwork. A hostile page could plant an arbitrary URL in
  // the DOM that the consumer would then fetch (tracking / local SSRF), so anything
  // off this list is dropped to null. Exact hosts plus any *.googleusercontent.com
  // subdomain (yt3/yt4/lh3… all Google-owned image CDNs; YT Music album art comes
  // from yt3.googleusercontent.com, video thumbs from i.ytimg.com).
  const ARTWORK_HOSTS = new Set(["i.ytimg.com", "music.youtube.com"]);
  const artworkHostOk = (h) =>
    ARTWORK_HOSTS.has(h) ||
    h === "googleusercontent.com" ||
    h.endsWith(".googleusercontent.com");

  // Commands we will execute. Default-reject everything else.
  const COMMAND_ACTIONS = new Set([
    "play",
    "pause",
    "toggle",
    "next",
    "previous",
    "seek",
    "setVolume",
  ]);

  // Heartbeat cadence. Position is re-sent at these intervals so the consumer can
  // extrapolate between polls; discrete events (play/pause/seek/track) also push
  // immediately.
  const PLAYING_MS = 500;
  const PAUSED_MS = 1000;
  const IDLE_POLL_MS = 1000; // silent poll: detects media appearing, sends nothing.

  const safe = (n) => (Number.isFinite(n) ? n : null);
  const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

  function allowlistArtwork(url) {
    if (typeof url !== "string" || url.length === 0) return null;
    try {
      const u = new URL(url, location.href);
      if (u.protocol !== "https:" && u.protocol !== "http:") return null;
      return artworkHostOk(u.hostname) ? u.href : null;
    } catch {
      return null;
    }
  }

  // Pick the highest-resolution candidate from an <img> srcset (the bare src on the
  // YT Music player bar is a ~60px thumb). Returns the raw URL string or null.
  function largestSrcsetUrl(img) {
    if (!img) return null;
    const srcset = img.getAttribute("srcset");
    if (!srcset) return img.currentSrc || img.src || null;
    let best = null;
    let bestW = -1;
    for (const part of srcset.split(",")) {
      const seg = part.trim().split(/\s+/);
      const u = seg[0];
      if (!u) continue;
      const desc = seg[1] || "";
      const w = desc.endsWith("w") ? parseInt(desc, 10) : 1;
      const width = Number.isFinite(w) ? w : 1;
      if (width > bestW) {
        bestW = width;
        best = u;
      }
    }
    return best || img.currentSrc || img.src || null;
  }

  // Build the now-playing state object from the <video> element + adapter metadata.
  // Returns null when the tab has no active media (caller stays silent).
  function buildState(adapter) {
    const video = document.querySelector("video");
    if (!video) return null;
    if (!adapter.isActive(video)) return null;

    let meta;
    try {
      meta = adapter.readMeta(video) || {};
    } catch {
      meta = {}; // selector drift must never crash the content script.
    }

    return {
      active: true,
      source: adapter.source,
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

  function statesDiffer(a, b) {
    if (!a || !b) return a !== b;
    return (
      a.state !== b.state ||
      a.videoId !== b.videoId ||
      a.title !== b.title ||
      a.artist !== b.artist ||
      a.album !== b.album ||
      a.artworkUrl !== b.artworkUrl ||
      a.volume !== b.volume ||
      // a position jump (seek) of more than one heartbeat is a discrete event
      Math.abs((a.positionSec ?? 0) - (b.positionSec ?? 0)) > 1.5
    );
  }

  function run(adapter) {
    let timer = null;
    let lastSent = null;
    let boundVideo = null;

    function push(state) {
      try {
        const p = browser.runtime.sendMessage({ type: "state", state });
        if (p && typeof p.catch === "function") p.catch(() => {});
      } catch {
        // background may be momentarily unloaded; the next heartbeat retries.
      }
    }

    // Emit immediately when discrete fields change; the heartbeat handles position.
    function maybePushNow() {
      const s = buildState(adapter);
      if (s && statesDiffer(s, lastSent)) {
        lastSent = s;
        push(s);
      }
    }

    function bindVideo() {
      const video = document.querySelector("video");
      if (video === boundVideo) return;
      boundVideo = video;
      if (!video) return;
      const events = [
        "play",
        "pause",
        "seeked",
        "ratechange",
        "volumechange",
        "loadedmetadata",
        "emptied",
      ];
      for (const ev of events) {
        video.addEventListener(ev, maybePushNow, { passive: true });
      }
    }

    function tick() {
      bindVideo();
      const s = buildState(adapter);
      if (s) {
        lastSent = s;
        push(s);
        timer = setTimeout(tick, s.state === "playing" ? PLAYING_MS : PAUSED_MS);
      } else {
        // No active media: stay silent (send nothing) but keep polling so we notice
        // when playback starts.
        timer = setTimeout(tick, IDLE_POLL_MS);
      }
    }

    function executeCommand(action, value) {
      if (!COMMAND_ACTIONS.has(action)) return; // default-reject
      const video = document.querySelector("video");
      switch (action) {
        case "play":
          video && video.play().catch(() => {});
          break;
        case "pause":
          video && video.pause();
          break;
        case "toggle":
          if (video) {
            if (video.paused) video.play().catch(() => {});
            else video.pause();
          }
          break;
        case "seek":
          if (video && typeof value === "number" && Number.isFinite(value)) {
            const hi = Number.isFinite(video.duration) ? video.duration : value;
            video.currentTime = clamp(value, 0, hi);
          }
          break;
        case "setVolume":
          if (video && typeof value === "number" && Number.isFinite(value)) {
            video.volume = clamp(value, 0, 1);
          }
          break;
        case "next":
          try {
            adapter.next(video);
          } catch {}
          break;
        case "previous":
          try {
            adapter.previous(video);
          } catch {}
          break;
      }
      // Confirm the resulting state quickly (instant feedback in now-playing).
      setTimeout(maybePushNow, 80);
    }

    browser.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === "command") {
        executeCommand(msg.action, msg.value);
      }
    });

    // SPA navigation: both sites fire yt-navigate-finish. Re-read after it settles.
    document.addEventListener("yt-navigate-finish", () => {
      boundVideo = null; // force re-bind to the (possibly new) <video>
      setTimeout(maybePushNow, 50);
    });

    tick();
  }

  window.__ytBridge = {
    safe,
    clamp,
    allowlistArtwork,
    largestSrcsetUrl,
    run,
  };
})();
