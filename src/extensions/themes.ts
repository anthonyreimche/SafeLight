// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Theme engine: themes are just sets of CSS custom properties layered onto
// :root, overriding the Tailwind v4 @theme defaults in index.css. The active
// choice is shared across windows via the storage event.

import { create } from "zustand";
import { privilegedWindow } from "@/native/privileged";
import { useRegistry, type RegisteredTheme } from "./registry";

/** Written only by applyTheme, i.e. by a person's choice. */
export const THEME_STORAGE_KEY = "sl_theme";
const THEME_KEY = THEME_STORAGE_KEY;
export const DEFAULT_THEME = "core.neutral";

export const useThemeStore = create<{ activeId: string }>(() => ({
  activeId: DEFAULT_THEME,
}));

let appliedKeys: string[] = [];

/** Sent to the window last, so an unchanged material isn't asked for twice. */
let sentMaterial: "acrylic" | "mica" | null | undefined;

/** The theme's variables on the root. A glass theme's surfaces are translucent
 *  for the window's material to show through; without the material
 *  (`sl-material` not set) a panel or menu would show whatever lies behind it,
 *  so its surfaces are written fully opaque. Other colours, and every theme
 *  without a material, keep their alpha: a scrim or tint is meant to show
 *  through. */
function writeThemeVars(theme: RegisteredTheme): void {
  const root = document.documentElement;
  const opaqueSurfaces = !!theme.window?.material && !root.classList.contains("sl-material");
  for (const [k, v] of Object.entries(theme.vars)) {
    root.style.setProperty(k, opaqueSurfaces && k.startsWith("--color-surface") ? `rgb(from ${v} r g b / 1)` : v);
  }
}

function setMaterialClass(on: boolean): void {
  const root = document.documentElement;
  if (root.classList.contains("sl-material") === on) return;
  root.classList.toggle("sl-material", on);
  const theme = useRegistry.getState().themes[useThemeStore.getState().activeId];
  if (theme) writeThemeVars(theme);
}

/** Ask the window for the active theme's material, or clear it: it is
 *  withheld while Reduce transparency is on. The root paints transparent
 *  (`sl-material`) only once the window confirms it draws the material;
 *  otherwise the opaque root rule in index.css stays. */
export function syncWindowMaterial(): void {
  const bridge = privilegedWindow();
  if (!bridge) return;
  const root = document.documentElement;
  const theme = useRegistry.getState().themes[useThemeStore.getState().activeId];
  const wanted = root.classList.contains("sl-opaque") ? null : (theme?.window?.material ?? null);
  if (wanted === sentMaterial) return;
  sentMaterial = wanted;
  if (wanted === null) setMaterialClass(false);
  void bridge.setMaterial(wanted).then(
    (applied) => {
      if (sentMaterial === wanted) setMaterialClass(applied && wanted !== null);
    },
    () => {
      if (sentMaterial === wanted) setMaterialClass(false);
    },
  );
}

export function applyTheme(id: string): void {
  const theme = useRegistry.getState().themes[id];
  if (!theme) return;
  const root = document.documentElement.style;
  for (const k of appliedKeys) root.removeProperty(k);
  appliedKeys = Object.keys(theme.vars);
  writeThemeVars(theme);
  useThemeStore.setState({ activeId: id });
  syncWindowMaterial();
  // The native window-controls overlay (Win/Linux) is recoloured per-surface by
  // useTitleBarOverlay (src/ui/window-chrome.ts), which re-runs on this id change.
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
