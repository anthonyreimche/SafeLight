// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Theme engine: themes are just sets of CSS custom properties layered onto
// :root, overriding the Tailwind v4 @theme defaults in index.css. The active
// choice is shared across windows via the storage event.

import { create } from "zustand";
import { useRegistry } from "./registry";

const THEME_KEY = "sl_theme";
export const DEFAULT_THEME = "core.neutral";

export const useThemeStore = create<{ activeId: string }>(() => ({
  activeId: DEFAULT_THEME,
}));

let appliedKeys: string[] = [];

export function applyTheme(id: string): void {
  const theme = useRegistry.getState().themes[id];
  if (!theme) return;
  const root = document.documentElement.style;
  for (const k of appliedKeys) root.removeProperty(k);
  appliedKeys = Object.keys(theme.vars);
  for (const [k, v] of Object.entries(theme.vars)) root.setProperty(k, v);
  useThemeStore.setState({ activeId: id });
  try {
    localStorage.setItem(THEME_KEY, id);
  } catch {}
}

/** Apply the saved theme if its contribution is registered (call again after
 *  plugins finish loading, in case the saved theme comes from a plugin). */
export function applySavedTheme(): void {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved && saved !== useThemeStore.getState().activeId) applyTheme(saved);
  } catch {}
}

export function initThemes(): void {
  applySavedTheme();
  window.addEventListener("storage", (e) => {
    if (e.key === THEME_KEY && e.newValue) applyTheme(e.newValue);
  });
}
