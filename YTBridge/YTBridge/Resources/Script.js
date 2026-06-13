function show(enabled, useSettingsInsteadOfPreferences) {
    if (useSettingsInsteadOfPreferences) {
        document.getElementsByClassName('state-on')[0].innerText = "YTBridge’s extension is currently on. You can turn it off in the Extensions section of Safari Settings.";
        document.getElementsByClassName('state-off')[0].innerText = "YTBridge’s extension is currently off. You can turn it on in the Extensions section of Safari Settings.";
        document.getElementsByClassName('state-unknown')[0].innerText = "You can turn on YTBridge’s extension in the Extensions section of Safari Settings.";
        document.getElementsByClassName('open-preferences')[0].innerText = "Quit and Open Safari Settings…";
    }

    if (typeof enabled === "boolean") {
        document.body.classList.toggle(`state-on`, enabled);
        document.body.classList.toggle(`state-off`, !enabled);
    } else {
        document.body.classList.remove(`state-on`);
        document.body.classList.remove(`state-off`);
    }
}

function openPreferences() {
    webkit.messageHandlers.controller.postMessage("open-preferences");
}

document.querySelector("button.open-preferences").addEventListener("click", openPreferences);

// Called by the native side (ViewController) with the result of polling the local
// bridge API. `data` is {up:false} when the server is unreachable (bridge idle), or
// {up:true, state:<GET /v1/now-playing body>} when it answered.
function showBridge(data) {
    const serverLine = document.getElementById("server-line");
    const trackLine = document.getElementById("track-line");
    const artwork = document.getElementById("artwork");
    if (!serverLine || !trackLine) return;

    if (!data || !data.up) {
        serverLine.textContent = "Bridge: offline (idle) — connection refused. Safari closed or no YouTube tab open.";
        trackLine.textContent = "";
        setArtwork(artwork, null);
        return;
    }

    const s = data.state || {};
    if (s.active) {
        serverLine.textContent = "Bridge: ✅ listening on 127.0.0.1:8976 — Safari is syncing.";
        // textContent (never innerHTML): title/artist are untrusted page content.
        const where = s.source === "youtube_music" ? "YT Music" : "YouTube";
        trackLine.textContent =
            `${s.state === "playing" ? "▶︎" : "❚❚"} ${s.title || "(unknown)"} — ${s.artist || ""}  ·  ${where}`;
        // artworkUrl is host-allowlisted at the bridge (i.ytimg.com / music.youtube.com
        // / *.googleusercontent.com) and the CSP only permits those hosts, so a hostile
        // value can't make the webview fetch an arbitrary URL.
        setArtwork(artwork, s.artworkUrl);
    } else {
        serverLine.textContent = "Bridge: ✅ listening on 127.0.0.1:8976 — no active player (nothing playing).";
        trackLine.textContent = "";
        setArtwork(artwork, null);
    }
}

// Show the cover art when we have a URL, hide it otherwise (avoids a broken-image
// box). Only assigns src on change so we don't refetch every 2s poll.
function setArtwork(img, url) {
    if (!img) return;
    if (typeof url === "string" && url.length > 0) {
        if (img.src !== url) img.src = url;
        img.hidden = false;
    } else {
        img.removeAttribute("src");
        img.hidden = true;
    }
}

// Double-click the cover art → ask the bridge to raise the playing YouTube tab.
const artworkEl = document.getElementById("artwork");
if (artworkEl) {
    artworkEl.addEventListener("dblclick", () => {
        webkit.messageHandlers.controller.postMessage("focus-tab");
    });
}

function refreshBridge() {
    webkit.messageHandlers.controller.postMessage("refresh");
}

document.querySelector("button.refresh").addEventListener("click", refreshBridge);
