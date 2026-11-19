// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Which extension window (api.registerWindow) is open in this app window, and
// which ones were maximized this session. One is open at a time: opening
// another replaces it. Kept apart from the registry so the registry can close
// a window its extension takes away without importing the host that draws it.

import { create } from "zustand";

interface OpenWindowState {
  /** The open window's id, or null. */
  open: string | null;
  /** Window ids the user maximized, kept across closes until restart. */
  maximized: Readonly<Record<string, boolean>>;
}

export const useOpenWindow = create<OpenWindowState>(() => ({ open: null, maximized: {} }));

export const showWindow = (id: string): void => useOpenWindow.setState({ open: id });

/** Close window `id` if it is the open one. */
export function hideWindow(id: string): void {
  if (useOpenWindow.getState().open === id) useOpenWindow.setState({ open: null });
}

export const isWindowOpen = (id: string): boolean => useOpenWindow.getState().open === id;

export const useWindowOpen = (id: string): boolean => useOpenWindow((s) => s.open === id);

export const toggleWindowMaximized = (id: string): void =>
  useOpenWindow.setState((s) => ({ maximized: { ...s.maximized, [id]: !s.maximized[id] } }));
