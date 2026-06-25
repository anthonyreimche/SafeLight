// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Accessibility overlays. These sit *on top of* the active theme rather than
// being baked into it: the built-in themes ship as designed (Neutral in
// particular stays a colour-assessment mid-grey), and a user who needs more
// opts in here. Everything is driven by the persisted settings store and
// re-applied whenever settings OR the active theme change.
//
// Why a separate module (not settings-store's applySideEffects): the
// high-contrast overlay has to know the active theme's polarity and re-layer
// itself after every theme switch, so it subscribes to both stores. Keeping it
// out of settings-store also avoids a settings ⇄ themes import cycle.

import { create } from "zustand";
import { getSettings, useSettings } from "./settings-store";
import { useThemeStore } from "@/extensions/themes";
import { useRegistry } from "@/extensions/registry";

// The theme vars the high-contrast overlay replaces. On disable we restore each
// from the active theme's own value (NOT removeProperty — that would drop the
// theme's inline value and fall back to the neutral @theme default in index.css).
const HC_KEYS = [
  "--color-surface-0",
  "--color-surface-1",
  "--color-surface-2",
  "--color-surface-3",
  "--color-surface-4",
  "--color-border",
  "--color-border-subtle",
  "--color-text-primary",
  "--color-text-secondary",
  "--color-text-muted",
  "--color-accent",
  "--color-accent-hover",
  "--color-slider-fill",
] as const;

// Maximal-contrast palettes. The app's selected-state pattern is white text on
// --color-slider-fill, so slider-fill stays dark enough for white to clear AA
// in both palettes; --color-accent is only ever a tint / thin bar / text colour
// (never a solid fill under text), so it just needs to read against the
// surfaces. Text-on-surface clears AA trivially at these black/white extremes.
const HC_DARK: Record<string, string> = {
  "--color-surface-0": "#000000",
  "--color-surface-1": "#0e0e0e",
  "--color-surface-2": "#1c1c1c",
  "--color-surface-3": "#2e2e2e",
  "--color-surface-4": "#404040",
  "--color-border": "#808080",
  "--color-border-subtle": "#5a5a5a",
  "--color-text-primary": "#ffffff",
  "--color-text-secondary": "#ededed",
  "--color-text-muted": "#d0d0d0",
  "--color-accent": "#b0b0b0",
  "--color-accent-hover": "#cccccc",
  "--color-slider-fill": "#5a5a5a",
};

const HC_LIGHT: Record<string, string> = {
  "--color-surface-0": "#ffffff",
  "--color-surface-1": "#f4f4f4",
  "--color-surface-2": "#e8e8e8",
  "--color-surface-3": "#d8d8d8",
  "--color-surface-4": "#c6c6c6",
  "--color-border": "#4a4a4a",
  "--color-border-subtle": "#8a8a8a",
  "--color-text-primary": "#000000",
  "--color-text-secondary": "#161616",
  "--color-text-muted": "#343434",
  "--color-accent": "#4a4a4a",
  "--color-accent-hover": "#2e2e2e",
  "--color-slider-fill": "#5a5a5a",
};

/** The active theme's vars, or undefined if none is registered/applied yet. */
function activeThemeVars(): Record<string, string> | undefined {
  const id = useThemeStore.getState().activeId;
  return useRegistry.getState().themes[id]?.vars;
}

/** Light themes declare colorScheme: "light"; Dark declares "dark"; Neutral
 *  declares nothing. High contrast follows that polarity, and treats the
 *  polarity-less Neutral theme as dark (its text is light on mid-grey). */
function highContrastPalette(): Record<string, string> {
  const id = useThemeStore.getState().activeId;
  const theme = useRegistry.getState().themes[id];
  return theme?.colorScheme === "light" ? HC_LIGHT : HC_DARK;
}

// The overridable colour tokens are exactly HC_KEYS (surfaces, borders, text
// roles, accent, slider-fill) — the set the Custom-colours UI exposes too.
export const OVERRIDABLE_KEYS = HC_KEYS;

// Compose the colour layers onto :root, last-wins: theme vars → high-contrast
// palette (when on) → the user's per-theme custom overrides. Every overridable
// key is recomputed and set on each call, so removing an override or switching
// theme can't leave a stale inline value behind (removeProperty would fall back
// to the index.css @theme neutral default, hence we re-set from theme/HC).
function applyColorLayers(
  hcOn: boolean,
  overrides: Record<string, string>,
): void {
  const root = document.documentElement.style;
  const themeVars = activeThemeVars();
  const hc = hcOn ? highContrastPalette() : null;
  for (const k of OVERRIDABLE_KEYS) {
    const base = hc ? hc[k] : themeVars?.[k];
    const val = overrides[k] ?? base;
    if (val != null) root.setProperty(k, val);
    else root.removeProperty(k);
  }
}

// ── Colour-vision simulation ────────────────────────────────────────────────
// Standard single-matrix simulations (the widely-used Brettel/Viénot values).
// Injected once as a hidden <svg> in <body>; index.css references them by id on
// #root via the data-sl-cvd attribute so the defs themselves aren't filtered.
const CVD_FILTERS_ID = "sl-cvd-defs";
const CVD_MATRICES: Record<string, string> = {
  protanopia:
    "0.567 0.433 0     0 0  0.558 0.442 0     0 0  0     0.242 0.758 0 0  0 0 0 1 0",
  deuteranopia:
    "0.625 0.375 0     0 0  0.7   0.3   0     0 0  0     0.3   0.7   0 0  0 0 0 1 0",
  tritanopia:
    "0.95  0.05  0     0 0  0     0.433 0.567 0 0  0     0.475 0.525 0 0  0 0 0 1 0",
};

function ensureCvdFilters(): void {
  if (document.getElementById(CVD_FILTERS_ID)) return;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("id", CVD_FILTERS_ID);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute(
    "style",
    "position:absolute;width:0;height:0;overflow:hidden;pointer-events:none",
  );
  for (const [name, matrix] of Object.entries(CVD_MATRICES)) {
    const filter = document.createElementNS(ns, "filter");
    filter.setAttribute("id", `sl-cvd-${name}`);
    filter.setAttribute("color-interpolation-filters", "linearRGB");
    const fe = document.createElementNS(ns, "feColorMatrix");
    fe.setAttribute("type", "matrix");
    fe.setAttribute("values", matrix);
    filter.appendChild(fe);
    svg.appendChild(filter);
  }
  document.body.appendChild(svg);
}

// ── OS accessibility preferences ────────────────────────────────────────────
// When the user keeps "Match system accessibility settings" on, these OS-level
// media queries are OR-ed into the manual toggles, so e.g. turning on
// prefers-reduced-motion in Windows/macOS settings calms the app without the
// user touching anything. (Windows High Contrast / forced-colors is handled in
// CSS via @media (forced-colors: active), not here.)
type OSMatchers = {
  reduceMotion: MediaQueryList;
  moreContrast: MediaQueryList;
  reduceTransparency: MediaQueryList;
};
let osMatchers: OSMatchers | null = null;

function osWants(kind: keyof OSMatchers): boolean {
  if (!osMatchers || !getSettings().syncOSAccessibility) return false;
  return osMatchers[kind].matches;
}

/** Read the current settings (+ OS prefs) and apply every accessibility overlay
 *  to the DOM. Idempotent and side-effect-only (never calls setState), so it's
 *  safe to run from store subscriptions and media-query change events. */
export function applyAccessibility(): void {
  const s = getSettings();
  const root = document.documentElement;
  const activeId = useThemeStore.getState().activeId;
  applyColorLayers(
    s.highContrast || osWants("moreContrast"),
    s.colorOverrides?.[activeId] ?? {},
  );
  root.classList.toggle("sl-reduce-motion", s.reduceMotion || osWants("reduceMotion"));
  root.classList.toggle(
    "sl-opaque",
    s.reduceTransparency || osWants("reduceTransparency"),
  );
  root.classList.toggle("sl-focus-ring", s.strongFocus);
  root.classList.toggle("sl-larger-text", s.largerText);
  root.classList.toggle("sl-large-targets", s.largerControls);
  root.classList.toggle("sl-title-headings", s.lowercaseHeadings);
  if (s.colorVisionFilter === "none") {
    root.removeAttribute("data-sl-cvd");
  } else {
    root.setAttribute("data-sl-cvd", s.colorVisionFilter);
  }
}

// ── Extension lifecycle ─────────────────────────────────────────────────────
// This module is the runtime of the `core.accessibility` built-in extension.
// activate/deactivate are driven by its entry in builtin.tsx; disabling the
// extension must remove every DOM side-effect (classes, vars, the CVD <svg>,
// listeners) so the app returns to its as-designed, overlay-free state. The
// baseline semantic correctness (aria, focus-trap, landmarks, the always-on
// :focus-visible ring) lives in the core components/CSS and is unaffected.

/** Reactive "is the accessibility extension active" flag, so components that gate
 *  on keyboard-canvas editing re-render when the extension is enabled/disabled. */
const useA11yActive = create<{ active: boolean }>(() => ({ active: false }));

let onOSChange: (() => void) | null = null;
let unsubSettings: (() => void) | null = null;
let unsubTheme: (() => void) | null = null;

/** Activate the overlays: inject the CVD filters, watch settings / theme / OS
 *  preferences, and apply the current state. Idempotent. Safe to call before
 *  initThemes/initSettings — the settings store is loaded at import, and the
 *  theme subscription re-layers high-contrast once the saved theme is applied. */
export function activateAccessibility(): void {
  if (useA11yActive.getState().active) return;
  ensureCvdFilters();
  if (typeof window !== "undefined" && window.matchMedia) {
    osMatchers = {
      reduceMotion: window.matchMedia("(prefers-reduced-motion: reduce)"),
      moreContrast: window.matchMedia("(prefers-contrast: more)"),
      reduceTransparency: window.matchMedia("(prefers-reduced-transparency: reduce)"),
    };
    onOSChange = () => applyAccessibility();
    for (const mq of Object.values(osMatchers)) {
      mq.addEventListener("change", onOSChange);
    }
  }
  unsubSettings = useSettings.subscribe(() => applyAccessibility());
  unsubTheme = useThemeStore.subscribe(() => applyAccessibility());
  useA11yActive.setState({ active: true });
  applyAccessibility();
}

/** Tear everything down when the extension is disabled: stop watching, remove
 *  every applied class/attribute, restore the theme's own colour vars, and
 *  remove the injected CVD filter <svg>. */
export function deactivateAccessibility(): void {
  if (!useA11yActive.getState().active) return;
  if (osMatchers && onOSChange) {
    for (const mq of Object.values(osMatchers)) {
      mq.removeEventListener("change", onOSChange);
    }
  }
  osMatchers = null;
  onOSChange = null;
  unsubSettings?.();
  unsubTheme?.();
  unsubSettings = null;
  unsubTheme = null;
  const root = document.documentElement;
  applyColorLayers(false, {}); // restore theme vars (drops HC + custom overrides)
  root.classList.remove(
    "sl-reduce-motion",
    "sl-opaque",
    "sl-focus-ring",
    "sl-larger-text",
    "sl-large-targets",
    "sl-title-headings",
  );
  root.removeAttribute("data-sl-cvd");
  document.getElementById(CVD_FILTERS_ID)?.remove();
  useA11yActive.setState({ active: false });
}

// ── Keyboard canvas editing gate ────────────────────────────────────────────
// The on-canvas arrow-key manipulation layer (tone-curve points, mask handles,
// viewport pan/zoom) is opt-in: it runs only when the accessibility extension is
// active AND the user enabled "Keyboard canvas editing". The always-on numeric
// fields (curve In/Out, mask geometry) are NOT gated — they're the conformance
// baseline. Components use the hook so they re-render on either change.

/** Hook: true when on-canvas keyboard editing should be live. */
export function useKeyboardCanvasEditing(): boolean {
  const active = useA11yActive((s) => s.active);
  const on = useSettings((s) => s.keyboardCanvasEditing);
  return active && on;
}

/** Imperative read of the same gate, for non-React code. */
export function isKeyboardCanvasEditingActive(): boolean {
  return useA11yActive.getState().active && getSettings().keyboardCanvasEditing;
}
