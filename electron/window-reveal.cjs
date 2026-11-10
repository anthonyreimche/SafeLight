// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Windows open hidden and show once the page has painted (ready-to-show), so
// the first frame isn't black. Chromium sends ready-to-show only after it
// paints the hidden window, and under software rendering or a Wayland session
// it may never do so: the window stayed hidden and Safelight seemed not to
// start. A loaded page, or failing that a window open for a while, is shown
// anyway; a black first frame is better than no window.

"use strict";

/** How long a loaded page may take to report ready-to-show. */
const LOAD_GRACE_MS = 1000;
/** How long a window may stay hidden when its page reports nothing at all. */
const OPEN_GRACE_MS = 5000;

/**
 * Calls `show` once: on ready-to-show, LOAD_GRACE_MS after the page loads, or
 * OPEN_GRACE_MS after this call, whichever comes first. Never for a window
 * closed before then.
 * @param {{ once: Function, isDestroyed: () => boolean, webContents: { once: Function } }} win
 * @param {() => void} show
 */
function revealWhenReady(win, show) {
  let done = false;
  let loadTimer = null;
  const reveal = (late) => {
    if (done) return;
    done = true;
    clearTimeout(openTimer);
    clearTimeout(loadTimer);
    if (win.isDestroyed()) return;
    if (late) console.warn("[safelight] the window never reported ready-to-show; showing it anyway");
    show();
  };
  const openTimer = setTimeout(() => reveal(true), OPEN_GRACE_MS);
  win.once("ready-to-show", () => reveal(false));
  win.webContents.once("did-finish-load", () => {
    if (!done) loadTimer = setTimeout(() => reveal(true), LOAD_GRACE_MS);
  });
  win.once("closed", () => {
    done = true;
    clearTimeout(openTimer);
    clearTimeout(loadTimer);
  });
}

module.exports = { LOAD_GRACE_MS, OPEN_GRACE_MS, revealWhenReady };
