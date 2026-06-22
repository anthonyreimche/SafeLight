// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Pops the Developer Tools panel out into its own OS window (e.g. on a second
// monitor), mirroring the module-detach pattern in src/state/detach.ts: open an
// app:// URL with a query flag; Electron's did-create-window handler turns it
// into a native child window that shares the origin, preload and COOP/COEP.
//
// The detached window renders only the panel (see App.tsx). Its log buffer is
// filled from the main window over the log BroadcastChannel (log-capture.ts);
// this module adds a small control channel for re-docking.

import { toggleDockPanel, useDockStore } from "@/extensions/dock";

const DEVTOOLS_PARAM = "devtools";
const WINDOW_NAME = "safelight-devtools";
const CTL_CHANNEL = "safelight-devtools-ctl";
const PANEL_ID = "core.devtools";

/** True when the current window is the detached Developer Tools window. */
export function isDevtoolsWindow(): boolean {
  return new URLSearchParams(window.location.search).get(DEVTOOLS_PARAM) === "1";
}

// Reference to the popped window so a second detach focuses it instead of
// opening a duplicate. The window `name` also enforces single-instance at the
// browser level.
let popped: Window | null = null;
let ctlChannel: BroadcastChannel | null = null;

function ensurePanelOpen(): void {
  if (!useDockStore.getState().open.includes(PANEL_ID)) toggleDockPanel(PANEL_ID);
}
function ensurePanelClosed(): void {
  if (useDockStore.getState().open.includes(PANEL_ID)) toggleDockPanel(PANEL_ID);
}

/** Open (or focus) the Developer Tools window and remove the in-dock panel. */
export function detachDevtools(): void {
  if (popped && !popped.closed) {
    popped.focus();
    return;
  }
  const url = `${window.location.origin}${window.location.pathname}?${DEVTOOLS_PARAM}=1`;
  const win = window.open(url, WINDOW_NAME, "width=760,height=600");
  if (!win) return;
  popped = win;
  ensurePanelClosed(); // it now lives in its own window
  win.focus();
}

/** Called from the detached window: re-dock in the main window, then close. */
export function reattachDevtools(): void {
  const ch = ctlChannel ?? new BroadcastChannel(CTL_CHANNEL);
  ch.postMessage({ type: "reattach" });
  window.close();
}

/** Wire up the control channel (set up on extension activate). */
export function initDevtoolsDetachSync(): void {
  if (ctlChannel) return;
  ctlChannel = new BroadcastChannel(CTL_CHANNEL);
  ctlChannel.onmessage = (e: MessageEvent<{ type: string }>) => {
    // Only the main window re-docks; the detached window is the one closing.
    if (e.data?.type === "reattach" && !isDevtoolsWindow()) {
      popped = null;
      ensurePanelOpen();
    }
  };
}

export function teardownDevtoolsDetachSync(): void {
  ctlChannel?.close();
  ctlChannel = null;
}
