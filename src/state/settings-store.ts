// Global application preferences. One persisted zustand store, shared across
// windows via the storage event (same pattern as themes/layouts). Non-React
// modules read it with getSettings(); React components subscribe with
// useSettings(). Theme and layout are NOT duplicated here — they already have
// their own persisted stores; the Preferences dialog drives them directly.

import { create } from "zustand";
import type { SortDirection, SortField } from "@/catalog/types";
import type { ColorSpaceId } from "@/rendering/color-space";

export type ExportFormatPref = "image/jpeg" | "image/png" | "image/webp";

export interface AppSettings {
  // ── Interface ──────────────────────────────────────────────────────────
  /** Whole-UI zoom (0.8–1.3). Applied as CSS zoom on <body>. */
  uiScale: number;
  /** Reduce motion: disables spinners/animated affordances where practical. */
  reduceMotion: boolean;
  /** UI font: CSS font-family string. "" = the built-in mono stack. */
  uiFont: string;

  // ── Library ────────────────────────────────────────────────────────────
  defaultGridSize: number; // px, 120–360
  defaultSortField: SortField;
  defaultSortDirection: SortDirection;
  /** Long edge of rendered thumbnails (quality vs. memory/speed). */
  thumbMaxEdge: 320 | 640 | 960;

  // ── Develop / performance ──────────────────────────────────────────────
  /** Cache decoded RAW previews (IndexedDB or <project>/.safelight/raw). */
  rawCacheEnabled: boolean;
  /** Long-edge cap of cached previews (bigger = sharper re-opens, more disk). */
  rawCacheMaxEdge: 2048 | 3072 | 4096;

  // ── Render pipeline ────────────────────────────────────────────────────
  /** Resolution cap of the Develop render buffer (true 1:1 zoom vs. memory). */
  developMaxEdge: 4096 | 6144 | 8192;
  /** 16-bit GPU textures for cached previews when the GPU supports them. */
  highBitDepth: boolean;
  /** Recompute the histogram on every render (off = after edits settle). */
  liveHistogram: boolean;

  // ── Export defaults ────────────────────────────────────────────────────
  exportFormat: ExportFormatPref;
  exportQuality: number; // 1–100
  exportLongEdge: number | null; // null = original
  exportBundle: boolean; // zip when exporting multiple
  /** Output color space; converts pixels and embeds the matching ICC profile. */
  exportColorSpace: ColorSpaceId;

  // ── Shortcuts ──────────────────────────────────────────────────────────
  /** Single-letter shortcuts (G/D/F). Tab and Ctrl-combos always work. */
  singleKeyShortcuts: boolean;

  // ── Metadata ────────────────────────────────────────────────────────────
  /** Write XMP sidecar files alongside original images for interoperability
   *  with other photo tools (Lightroom, Darktable, etc.). */
  writeXmpSidecars: boolean;

  // ── Extensions ─────────────────────────────────────────────────────────
  /** GitHub topic that marks official extensions in the browser. */
  extensionTopic: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  uiScale: 1,
  reduceMotion: false,
  uiFont: "",
  defaultGridSize: 200,
  defaultSortField: "dateImported",
  defaultSortDirection: "desc",
  thumbMaxEdge: 640,
  rawCacheEnabled: true,
  rawCacheMaxEdge: 3072,
  developMaxEdge: 4096,
  highBitDepth: true,
  liveHistogram: true,
  exportFormat: "image/jpeg",
  exportQuality: 90,
  exportLongEdge: null,
  exportBundle: true,
  exportColorSpace: "srgb",
  singleKeyShortcuts: true,
  writeXmpSidecars: false,
  extensionTopic: "safelight-extension",
};

const KEY = "sl_settings_v1";

function load(): AppSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {}
  return { ...DEFAULT_SETTINGS };
}

export const useSettings = create<AppSettings>(() => load());

export const getSettings = (): AppSettings => useSettings.getState();

function applySideEffects(s: AppSettings): void {
  // CSS zoom scales the whole px-based UI cleanly in Chromium.
  (document.body.style as CSSStyleDeclaration & { zoom: string }).zoom =
    s.uiScale === 1 ? "" : String(s.uiScale);
  // index.css kills animations/transitions under this class.
  document.documentElement.classList.toggle("sl-reduce-motion", s.reduceMotion);
  // Body font-family reads var(--font-mono); an inline :root override wins.
  if (s.uiFont) {
    document.documentElement.style.setProperty("--font-mono", s.uiFont);
  } else {
    document.documentElement.style.removeProperty("--font-mono");
  }
}

export function updateSettings(patch: Partial<AppSettings>): void {
  useSettings.setState(patch);
  const s = useSettings.getState();
  applySideEffects(s);
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {}
}

export function resetSettings(): void {
  updateSettings({ ...DEFAULT_SETTINGS });
}

/** Call once at boot: apply side effects and follow changes in other windows. */
export function initSettings(): void {
  applySideEffects(useSettings.getState());
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY || !e.newValue) return;
    try {
      const s = { ...DEFAULT_SETTINGS, ...JSON.parse(e.newValue) };
      useSettings.setState(s);
      applySideEffects(s);
    } catch {}
  });
}
