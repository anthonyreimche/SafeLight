// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Which documents may exist in a Safelight window, and which may use the
// privileged fs and update bridge. The preload hands that bridge out once per
// document, to the first caller, which is core at boot. Any other app:// file
// (an extension's own page under /__plugins__/) loaded as a top-level document
// would get a fresh preload and could claim it, so only the app's index may be
// navigated to or opened, and only its top frame may call the privileged
// channels. main.cjs wires these in; they are pure so the unit suite pins them.

"use strict";

/** The app's own index: the main window, `?detached=` pop-outs and the
 *  `?devtools=1` window. Any query or hash; nothing else on app://. */
function isAppIndexUrl(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return false;
  }
  return (
    u.protocol === "app:" &&
    u.host === "bundle" &&
    (u.pathname === "/" || u.pathname === "/index.html")
  );
}

function navigationAllowed(url) {
  return isAppIndexUrl(url);
}

/** "allow-app" opens a native child window, "external" hands the URL to the
 *  system browser, "deny" drops it. */
function windowOpenAction(url) {
  if (isAppIndexUrl(url)) return "allow-app";
  let protocol;
  try {
    protocol = new URL(String(url)).protocol;
  } catch {
    return "deny";
  }
  return protocol === "http:" || protocol === "https:" ? "external" : "deny";
}

function privilegedSenderAllowed({ url, isTopFrame }) {
  return isTopFrame === true && isAppIndexUrl(url);
}

/** Where to send a window whose committed document is an app:// page other
 *  than the index: the index with the same query, so a pop-out stays the same
 *  pop-out. A programmatic reload re-requests whatever path history.pushState
 *  left and never passes will-navigate, so this is what keeps an extension's
 *  own page from living on as a top-level document. null for the index itself
 *  and for anything off app://. */
function indexRedirectFor(url) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return null;
  }
  if (u.protocol !== "app:" || isAppIndexUrl(url)) return null;
  return `app://bundle/index.html${u.search}`;
}

/** Wraps an ipcMain.handle handler for a privileged channel. It judges the
 *  document the sender's webContents last committed (`committedUrls`, filled
 *  on did-navigate), because frame.url and getURL() follow history.pushState.
 *  Until a commit is recorded it judges the frame's url, or the page's once
 *  the frame is gone. The sender is read before anything awaits: senderFrame
 *  turns null once the frame navigates, so it is never compared with the
 *  page's mainFrame (a reload's last catalog flush arrives from such a frame
 *  and must still land). */
function guardPrivileged(
  channel,
  handler,
  { committedUrls = new WeakMap(), warn = console.warn } = {},
) {
  return async (e, ...args) => {
    const frame = e.senderFrame;
    const url =
      committedUrls.get(e.sender) ?? (frame ? frame.url : e.sender.getURL());
    const isTopFrame = frame ? frame.parent === null : true;
    if (!privilegedSenderAllowed({ url, isTopFrame })) {
      warn(`[safelight] ${channel} refused for ${url}`);
      throw new Error("Not allowed");
    }
    return handler(e, ...args);
  };
}

const DOT_SEGMENTS = new Set([".", ".."]);

/** An "owner/repo" string safe to interpolate into a GitHub URL. A "." or ".."
 *  segment would be resolved away and point the request at another path. */
function validRepo(repo) {
  const m = /^([\w.-]+)\/([\w.-]+)$/.exec(String(repo));
  return m !== null && !DOT_SEGMENTS.has(m[1]) && !DOT_SEGMENTS.has(m[2]);
}

module.exports = {
  isAppIndexUrl,
  navigationAllowed,
  windowOpenAction,
  privilegedSenderAllowed,
  indexRedirectFor,
  guardPrivileged,
  validRepo,
};
