// popup.js — the user's on/off switch for the bridge.
//
// Single setting in storage.local: `bridgeEnabled` (default ON when unset). The background
// reads it and stops forwarding playback state to the container app when OFF, so JellyBeat
// goes idle. The socket stays bound (the headless agent owns it); "off" means "don't expose
// my playback", not "kill the bridge process" (do that from System Settings → Login Items).

"use strict";

const KEY = "bridgeEnabled";
const toggle = document.getElementById("toggle");
const hint = document.getElementById("hint");

function render(enabled) {
  toggle.checked = enabled;
  hint.textContent = enabled
    ? "JellyBeat puede ver tu reproducción de YouTube."
    : "En pausa — JellyBeat no ve tu reproducción.";
}

// Default ON when the key was never set.
browser.storage.local
  .get(KEY)
  .then((res) => render(res[KEY] !== false))
  .catch(() => render(true));

toggle.addEventListener("change", () => {
  browser.storage.local.set({ [KEY]: toggle.checked }).catch(() => {});
  render(toggle.checked);
});
