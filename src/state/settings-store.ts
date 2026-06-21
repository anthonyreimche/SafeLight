// Global application preferences. One persisted zustand store, shared across
// windows via the storage event (same pattern as themes/layouts). Non-React
// modules read it with getSettings(); React components subscribe with
// useSettings(). Theme and layout are NOT duplicated here — they already have
// their own persisted stores; the Preferences dialog drives them directly.

import { create } from "zustand";
import type { SortDirection, SortField } from "@/catalog/types";
import type { ColorSpaceId } from "@/rendering/color-space";
import type { UpdateChannel } from "@/update/update-checker";

export type ExportFormatPref = "image/jpeg" | "image/png" | "image/webp";

/** How grid previews are built for RAW files on import:
 *  - "auto": use the embedded camera JPEG when it's already at least the
 *    thumbnail resolution, otherwise render the sensor for a sharper preview.
 *  - "embedded": always use the embedded JPEG (fastest import, camera look).
 *  - "rendered": always decode the RAW sensor (slower, neutral/accurate). */
export type PreviewSource = "auto" | "embedded" | "rendered";

export interface ExportPreset {
  name: string;
  format: ExportFormatPref;
  quality: number;
  longEdge: number | null;
  colorSpace: ColorSpaceId;
  sharpenAmount: number;
  sharpenRadius: number;
}

export interface AppSettings {
  // ── Interface ──────────────────────────────────────────────────────────
  /** Whole-UI zoom (0.8–1.3). Applied as CSS zoom on <body>. */
  uiScale: number;
  /** Reduce motion: disables spinners/animated affordances where practical. */
  reduceMotion: boolean;
  /** UI font: CSS font-family string. "" = the built-in mono stack. */
  uiFont: string;

  // ── Startup ────────────────────────────────────────────────────────────
  /** Reopen the most-recently-used project on launch instead of the welcome
   *  grid. Falls back to the grid if the folder can't be reopened. */
  restoreLastProject: boolean;

  // ── Library ────────────────────────────────────────────────────────────
  defaultGridSize: number; // px, 120–360
  defaultSortField: SortField;
  defaultSortDirection: SortDirection;
  /** Prompt for confirmation before removing photos from the catalog. */
  confirmRemovePhotos: boolean;
  /** When a folder is selected, also show photos in its subfolders. Off =
   *  only photos directly inside the selected folder. */
  showSubfolderPhotos: boolean;

  // ── Previews / thumbnails ──────────────────────────────────────────────
  /** How RAW grid previews are built on import (see PreviewSource). */
  previewSource: PreviewSource;
  /** Long edge of rendered thumbnails (quality vs. memory/speed). */
  thumbMaxEdge: 320 | 640 | 960;
  /** Persist grid previews to <project>/.safelight/previews. Off = memory-only,
   *  rebuilt on demand each open (keeps the project folder small). */
  persistPreviews: boolean;

  // ── Develop cache ──────────────────────────────────────────────────────
  /** Cache decoded RAW develop previews (IndexedDB or <project>/.safelight/raw).
   *  Master switch: off = never read or write the develop cache. */
  rawCacheEnabled: boolean;
  /** When caching is on, pre-decode the whole catalog on open ("Cache all").
   *  Off = "As needed": only cache photos as they're opened in Develop. */
  rawCachePrefetch: boolean;
  /** Long-edge cap of cached previews (bigger = sharper re-opens, more disk). */
  rawCacheMaxEdge: 2048 | 3072 | 4096;

  // ── Render pipeline ────────────────────────────────────────────────────
  /** Resolution cap of the Develop render buffer (true 1:1 zoom vs. memory). */
  developMaxEdge: 4096 | 6144 | 8192;
  /** GPU memory budget (bytes) for resident decoded RAW sources. Larger keeps
   *  more photos ready for instant re-open and crisp zoom, at the cost of VRAM. */
  gpuSourceCacheBytes: number;
  /** Background-decode the previous/next photo while editing so navigating to it
   *  is instant. Off saves CPU/VRAM at the cost of a decode on each step. */
  developPrefetchNeighbors: boolean;
  /** 16-bit GPU textures for cached previews when the GPU supports them. */
  highBitDepth: boolean;
  /** Recompute the histogram on every render (off = after edits settle). */
  liveHistogram: boolean;
  /** Zoom a photo opens at in Develop: fit-to-window or 100% (1:1). */
  developOpenZoom: "fit" | "100";

  // ── Export defaults ────────────────────────────────────────────────────
  exportFormat: ExportFormatPref;
  exportQuality: number; // 1–100
  exportLongEdge: number | null; // null = original
  exportBundle: boolean; // zip when exporting multiple
  /** Output color space; converts pixels and embeds the matching ICC profile. */
  exportColorSpace: ColorSpaceId;
  /** Saved export presets (format + quality + resolution + sharpening). */
  exportPresets: ExportPreset[];

  // ── Shortcuts ──────────────────────────────────────────────────────────
  /** Single-letter shortcuts (G/D/F). Tab and Ctrl-combos always work. */
  singleKeyShortcuts: boolean;

  // ── Extensions ─────────────────────────────────────────────────────────
  /** GitHub topic that marks official extensions in the browser. */
  extensionTopic: string;
  /** Check installed extensions for newer releases on launch (shows a badge). */
  checkExtensionUpdates: boolean;
  /** Silently install extension updates in the background when found. */
  autoUpdateExtensions: boolean;

  // ── Updates ────────────────────────────────────────────────────────────
  /** Check GitHub for a newer release on startup and show a banner. */
  checkForUpdates: boolean;
  /** Which releases trigger a notification: "patch" = all, "minor" = stable only. */
  updateChannel: UpdateChannel;
}

export const DEFAULT_SETTINGS: AppSettings = {
  uiScale: 1,
  reduceMotion: false,
  uiFont: "",
  restoreLastProject: false,
  defaultGridSize: 200,
  defaultSortField: "dateImported",
  defaultSortDirection: "desc",
  confirmRemovePhotos: true,
  showSubfolderPhotos: false,
  previewSource: "auto",
  thumbMaxEdge: 640,
  persistPreviews: true,
  rawCacheEnabled: true,
  rawCachePrefetch: true,
  rawCacheMaxEdge: 3072,
  developMaxEdge: 4096,
  gpuSourceCacheBytes: 512 * 1024 * 1024,
  developPrefetchNeighbors: true,
  highBitDepth: true,
  liveHistogram: true,
  developOpenZoom: "fit",
  exportFormat: "image/jpeg",
  exportQuality: 90,
  exportLongEdge: null,
  exportBundle: true,
  exportColorSpace: "srgb",
  exportPresets: [],
  singleKeyShortcuts: true,
  extensionTopic: "safelight-extension",
  checkExtensionUpdates: true,
  autoUpdateExtensions: false,
  checkForUpdates: true,
  updateChannel: "patch",
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
