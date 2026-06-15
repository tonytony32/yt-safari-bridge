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
    "like",
    "unlike",
    "toggleLike",
  ]);

  // Heartbeat cadence. Position is re-sent at these intervals so the consumer can
  // extrapolate between polls; discrete events (play/pause/seek/track) also push
  // immediately.
  const PLAYING_MS = 500;
  const PAUSED_MS = 1000;
  const IDLE_POLL_MS = 1000; // silent poll: detects media appearing, sends nothing.

  const safe = (n) => (Number.isFinite(n) ? n : null);
  const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

  // Read the current "liked / me gusta" state via the adapter, coerced to a strict
  // tri-state: true (liked), false (not liked), or null (unknown — selector drift,
  // or a page with no like control). Any adapter throw degrades to null so a DOM
  // change never crashes the content script.
  function readLiked(adapter) {
    try {
      if (typeof adapter.readLiked !== "function") return null;
      const v = adapter.readLiked();
      return v === true || v === false ? v : null;
    } catch {
      return null;
    }
  }

  // Click the site's like control (the adapter owns the selector). The YouTube and
  // YT Music like buttons are both toggles, so one click flips the state; the
  // like/unlike/toggleLike command wrappers in executeCommand add idempotency.
  function clickLike(adapter) {
    try {
      if (typeof adapter.clickLike === "function") adapter.clickLike();
    } catch {}
  }

  // YouTube video thumbnails come in two aspect ratios. The 4:3 variants
  // (default/hqdefault/sddefault) letterbox the 16:9 frame with baked-in black
  // bars top and bottom — a square-cropped consumer overlay keeps the full height,
  // so those bars survive into the now-playing art. The 16:9 variants are clean:
  //   mqdefault   320×180  always present
  //   maxresdefault 1280×720  sharp, but only for HD uploads (404s otherwise)
  // We serve mqdefault immediately (never bars, never a broken cover) and probe
  // maxresdefault once per video; if it exists we upgrade and re-push the snapshot.
  const ytThumbVariant = new Map(); // videoId -> "maxresdefault" | "mqdefault"
  const ytThumbProbing = new Set(); // videoIds with an in-flight probe
  let onArtworkUpgraded = null; // set by run() to re-emit when a probe upgrades

  function probeMaxres(videoId) {
    if (ytThumbProbing.has(videoId)) return;
    ytThumbProbing.add(videoId);
    const img = new Image();
    img.onload = () => {
      ytThumbProbing.delete(videoId);
      // A present maxresdefault is 1280 wide; guard against any placeholder.
      if (img.naturalWidth >= 1000) {
        ytThumbVariant.set(videoId, "maxresdefault");
        if (onArtworkUpgraded) onArtworkUpgraded();
      } else {
        ytThumbVariant.set(videoId, "mqdefault");
      }
    };
    img.onerror = () => {
      ytThumbProbing.delete(videoId);
      ytThumbVariant.set(videoId, "mqdefault"); // no maxres: mqdefault stands.
    };
    img.src = "https://i.ytimg.com/vi/" + videoId + "/maxresdefault.jpg";
  }

  function ytThumbName(videoId) {
    if (!videoId) return "mqdefault";
    const known = ytThumbVariant.get(videoId);
    if (known) return known;
    probeMaxres(videoId);
    return "mqdefault"; // safe 16:9 default until the probe upgrades it
  }

  // Upgrade a thumbnail URL to a higher resolution where the host supports it,
  // so the consumer's overlay isn't fed a ~120px player-bar thumb. Applied after
  // the host allowlist (below), so it only ever rewrites trusted hosts.
  function hiResArtwork(u) {
    // Google image CDN (YT Music album art): the size lives in the URL as
    // =w60-h60-… or =s90. These serve any requested size, so bumping is safe.
    if (u.hostname.endsWith("googleusercontent.com")) {
      return u.href
        .replace(/=w\d+-h\d+/, "=w544-h544")
        .replace(/=s\d+/, "=s544");
    }
    // YouTube video thumbnails (i.ytimg.com/vi/<id>/<name>.jpg): pick a 16:9
    // variant (see probeMaxres) so no letterbox bars leak into the cover art.
    if (u.hostname === "i.ytimg.com") {
      const m = u.pathname.match(/\/vi\/([^/]+)\//);
      const variant = ytThumbName(m && m[1]);
      return u.href.replace(
        /\/(?:default|mqdefault|hqdefault|sddefault|maxresdefault)\.jpg/,
        "/" + variant + ".jpg"
      );
    }
    return u.href;
  }

  function allowlistArtwork(url) {
    if (typeof url !== "string" || url.length === 0) return null;
    try {
      const u = new URL(url, location.href);
      if (u.protocol !== "https:" && u.protocol !== "http:") return null;
      return artworkHostOk(u.hostname) ? hiResArtwork(u) : null;
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
      liked: readLiked(adapter),
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
      a.liked !== b.liked ||
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

    // A maxresdefault probe resolving mid-playback bumps the cover from mqdefault
    // to the sharp variant; re-emit so the consumer swaps in the upgraded art.
    onArtworkUpgraded = maybePushNow;

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
          if (typeof value === "number" && Number.isFinite(value)) {
            // Sources whose volume the page re-asserts (YT Music) provide an
            // adapter hook that drives the site's own control so the change
            // sticks; others just set <video>.volume directly.
            if (typeof adapter.setVolume === "function") {
              adapter.setVolume(clamp(value, 0, 1));
            } else if (video) {
              video.volume = clamp(value, 0, 1);
            }
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
        // Favorites map to YouTube's "like". The button is a toggle, so the
        // explicit like/unlike are made idempotent by reading current state first
        // (no-op when already in the target state); toggleLike always flips.
        case "like":
          if (readLiked(adapter) !== true) clickLike(adapter);
          break;
        case "unlike":
          if (readLiked(adapter) === true) clickLike(adapter);
          break;
        case "toggleLike":
          clickLike(adapter);
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

    // Page teardown (tab/window/Safari closing): tell the bridge we're gone now so
    // consumers go idle immediately instead of waiting out the 3s staleness window.
    // Skip bfcache freezes (persisted) — a restore re-reports real state next tick.
    window.addEventListener(
      "pagehide",
      (e) => {
        if (e && e.persisted) return;
        push({ active: false });
      },
      { capture: true }
    );

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
