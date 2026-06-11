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
    if (!serverLine || !trackLine) return;

    if (!data || !data.up) {
        serverLine.textContent = "Bridge: offline (idle) — connection refused. Safari closed or no YouTube tab open.";
        trackLine.textContent = "";
        return;
    }

    const s = data.state || {};
    if (s.active) {
        serverLine.textContent = "Bridge: ✅ listening on 127.0.0.1:8976 — Safari is syncing.";
        // textContent (never innerHTML): title/artist are untrusted page content.
        const where = s.source === "youtube_music" ? "YT Music" : "YouTube";
        trackLine.textContent =
            `${s.state === "playing" ? "▶︎" : "❚❚"} ${s.title || "(unknown)"} — ${s.artist || ""}  ·  ${where}`;
    } else {
        serverLine.textContent = "Bridge: ✅ listening on 127.0.0.1:8976 — no active player (nothing playing).";
        trackLine.textContent = "";
    }
}

function refreshBridge() {
    webkit.messageHandlers.controller.postMessage("refresh");
}

document.querySelector("button.refresh").addEventListener("click", refreshBridge);
