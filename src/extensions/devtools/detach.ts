// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Pops the Developer Tools panel out into its own OS window (e.g. on a second
// monitor), mirroring the module-detach pattern in src/state/detach.ts: the main
// process opens the app's index with `?devtools=1` as a window that shares the
// origin, preload and COOP/COEP (electron/app-windows.cjs).
//
// The detached window renders only the panel (see App.tsx). Re-docking, and the
// log the window shows, are Developer Tools' own: it listens on its control
// channel in the main window and opens the panel again.

import { toggleDockPanel, useDockStore } from "@/extensions/dock";
import { privilegedWindow } from "@/native/privileged";

const DEVTOOLS_PARAM = "devtools";
/** The panel id Developer Tools registers, which the popped-out window shows. */
export const DEVTOOLS_PANEL_ID = "core.devtools";

/** True when the current window is the detached Developer Tools window. */
export function isDevtoolsWindow(): boolean {
  return new URLSearchParams(window.location.search).get(DEVTOOLS_PARAM) === "1";
}

function ensurePanelClosed(): void {
  if (useDockStore.getState().open.includes(DEVTOOLS_PANEL_ID)) toggleDockPanel(DEVTOOLS_PANEL_ID);
}

/** Open (or focus) the Developer Tools window and remove the in-dock panel. */
export function detachDevtools(): void {
  const bridge = privilegedWindow();
  if (!bridge) return;
  bridge
    .openApp("devtools")
    .catch((err: unknown) => console.warn("[safelight] Developer Tools window:", err));
  ensurePanelClosed(); // it now lives in its own window
}
