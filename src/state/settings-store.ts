// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Global application preferences. One persisted zustand store, shared across
// windows via the storage event (same pattern as themes/layouts). Non-React
// modules read it with getSettings(); React components subscribe with
// useSettings(). Theme and layout are NOT duplicated here — they already have
// their own persisted stores; the Preferences dialog drives them directly.

import { create } from "zustand";
import type { SortDirection, SortField } from "@/catalog/types";
import type { ColorSpaceId } from "@/rendering/color-space";
import type { UpdateChannel } from "@/update/update-checker";

export type ExportFormatPref = "image/jpeg" | "image/png" | "image/webp" | "image/tiff";

/** The surround shades, dark → light: pure black, darktable's own five-rung grey
 *  ladder centred on #777777 (the ~18% middle grey both darktable and Ansel use
 *  for the darkroom canvas, the standard for color-critical viewing), then pure
 *  white. Black and white bracket the ladder for a darkroom-black or lightbox-
 *  white surround; middle grey stays the default. */
export const CANVAS_SURROUND_SHADES: { value: string; label: string }[] = [
  { value: "#000000", label: "Black" },
  { value: "#3b3b3b", label: "Dark grey" },
  { value: "#525252", label: "Grey" },
  { value: "#686868", label: "Mid grey" },
  { value: "#777777", label: "Middle grey" },
  { value: "#8a8a8a", label: "Light grey" },
  { value: "#ffffff", label: "White" },
];

/** Factory-default surround: the ~18% middle grey used for color-critical
 *  viewing, and the rung the −/+ stepper falls back to when the stored shade
 *  isn't on the ladder. */
export const DEFAULT_CANVAS_SURROUND = "#777777";

/** Index of DEFAULT_CANVAS_SURROUND within CANVAS_SURROUND_SHADES. Derived so
 *  it stays correct as rungs are added at either end of the ladder. */
export const DEFAULT_CANVAS_SURROUND_INDEX = CANVAS_SURROUND_SHADES.findIndex(
  (s) => s.value === DEFAULT_CANVAS_SURROUND,
);

/** How grid previews are built for RAW files on import:
 *  - "auto": use the embedded camera JPEG when it's already at least the
 *    thumbnail resolution, otherwise render the sensor for a sharper preview.
 *  - "embedded": always use the embedded JPEG (fastest import, camera look).
 *  - "rendered": always decode the RAW sensor (slower, neutral/accurate). */
export type PreviewSource = "auto" | "embedded" | "rendered";

/** Per-theme custom UI colour overrides: theme id → (CSS custom property → hex).
 *  Layered over the active theme (and over high contrast) by the accessibility
 *  extension; absent keys fall back to the theme's own value. */
export type ColorOverrides = Record<string, Record<string, string>>;

/** Colour-vision simulation filter applied over the whole window so you can
 *  check how the UI and your photo read to colour-blind viewers. "none" = off. */
export type ColorVisionFilter =
  | "none"
  | "protanopia"
  | "deuteranopia"
  | "tritanopia";

export interface ExportPreset {
  name: string;
  format: ExportFormatPref;
  quality: number;
  longEdge: number | null;
  colorSpace: ColorSpaceId;
  sharpenAmount: number;
  sharpenRadius: number;
  /** Bits per sample for TIFF export (8 or 16); absent on older presets. */
  tiffBitDepth?: 8 | 16;
}

export interface AppSettings {
  // ── Interface ──────────────────────────────────────────────────────────
  /** Whole-UI zoom (0.8–2.0). Applied as CSS zoom on <body>. Doubles as the
   *  "scale beyond 100%" accessibility control — the px-based typography scales
   *  with it, so this is how text is enlarged. */
  uiScale: number;
  /** Reduce motion: disables spinners/animated affordances where practical. */
  reduceMotion: boolean;
  /** UI font: CSS font-family string. "" = the built-in mono stack. */
  uiFont: string;
  /** Use a fixed neutral-grey shade behind the image in Develop (see
   *  canvasSurround), independent of the theme. On by default — a middle-grey
   *  surround keeps brightness/contrast/saturation perception accurate while
   *  editing, like darktable/Ansel. Off = the surround follows the active
   *  theme's surface-0 instead. */
  canvasSurroundOverride: boolean;
  /** The fixed surround shade used when canvasSurroundOverride is on. One of
   *  CANVAS_SURROUND_SHADES (black, white, or a neutral grey hex). Defaults to
   *  middle grey. */
  canvasSurround: string;
  /** Width of the white color-assessment mat as a percentage of the smaller
   *  viewport dimension (resolution-independent). Tunable so the band reads
   *  right on any display size. */
  assessBorderPct: number;
  /** How much the app behind a window-style pop-up (Preferences, Extensions)
   *  is dimmed: the backdrop's black opacity, 0 (no dimming) – 0.8. Default
   *  0.6. Lower it to keep the photo visible while a window is open. */
  windowDim: number;
  /** Clicking a slider jumps its value to the cursor position, then continues
   *  as a drag from there. Off (the default) keeps the relative drag-to-adjust
   *  model: a click grabs the current value and only movement changes it. */
  sliderJumpToCursor: boolean;

  // ── Accessibility ──────────────────────────────────────────────────────
  // All off/neutral by default: the themes ship as designed, and a user who
  // needs more enables these opt-in overrides. Applied in accessibility.ts.
  /** Override the active theme's text/surface/accent vars with a maximal-
   *  contrast palette (dark polarity for the Dark and Neutral themes, light for
   *  the Light theme). Lets users who can't read the as-designed mid-grey chrome
   *  force WCAG-AA contrast without changing the default look for everyone. */
  highContrast: boolean;
  /** Always-visible keyboard focus ring (a thick outline on :focus-visible),
   *  for users who navigate by keyboard or need a stronger focus cue. */
  strongFocus: boolean;
  /** Colour-vision simulation applied to the whole window (see ColorVisionFilter).
   *  A proofing/empathy aid — it filters the photo too, so turn it off for
   *  colour-critical editing. */
  colorVisionFilter: ColorVisionFilter;
  /** Enlarge the smallest UI labels and drop their all-caps + wide-tracking
   *  styling, which is hardest to read at size — the labels are otherwise 9–11px
   *  and some are uppercase. */
  largerText: boolean;
  /** Grow interactive controls to a comfortable minimum hit target (WCAG 2.2
   *  SC 2.5.8, ≥24px) for pointer/motor accessibility. */
  largerControls: boolean;
  /** Render the all-caps section headings in Title Case (capitalise the first
   *  letter of each word) instead of UPPERCASE — easier to read for some users,
   *  since all-caps slows word recognition. */
  lowercaseHeadings: boolean;
  /** Make the decorative translucent backgrounds opaque so edges and content
   *  read clearly. */
  reduceTransparency: boolean;
  /** Also follow the OS's own accessibility preferences — reduced motion,
   *  increased contrast, reduced transparency — on top of the toggles above. On
   *  by default; the explicit toggles can only ADD to what the OS asks for (they
   *  never switch an OS preference back off). Applied in accessibility.ts. */
  syncOSAccessibility: boolean;
  /** Opt-in on-canvas keyboard editing for direct-manipulation tools (tone-curve
   *  points, mask handles, viewport pan/zoom). Off by default; the numeric
   *  fallbacks (curve In/Out, mask geometry) are always available. Gated through
   *  the accessibility extension — see useKeyboardCanvasEditing. */
  keyboardCanvasEditing: boolean;
  /** Per-theme custom colour overrides (see ColorOverrides). Edited in
   *  Preferences ▸ Accessibility ▸ Custom colours; applied in accessibility.ts. */
  colorOverrides: ColorOverrides;
  /** Draw the selection/focus highlight rings in the canvas editors (e.g. the
   *  ring on the selected tone-curve point). On by default; turn off to hide
   *  those visible editing highlights. */
  editingHighlights: boolean;

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
  /** Base directory for the catalog/previews/cache of read-only source folders
   *  (e.g. a memory card), which can't host their own .safelight. "" = the app's
   *  own data directory. An absolute path overrides it (e.g. a fast scratch SSD).
   *  Each source folder gets its own subdirectory under this base. Native only. */
  externalCatalogDir: string;

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
  /** Default bits per sample for TIFF export (8 or 16). */
  exportTiffBitDepth: 8 | 16;
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
  /** Only allow installing extensions on the verified allowlist. Off by default;
   *  a strict gate for cautious users / managed deployments. */
  onlyVerifiedExtensions: boolean;

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
  canvasSurroundOverride: true,
  canvasSurround: DEFAULT_CANVAS_SURROUND,
  assessBorderPct: 4.5,
  windowDim: 0.6,
  sliderJumpToCursor: false,
  highContrast: false,
  strongFocus: false,
  colorVisionFilter: "none",
  largerText: false,
  largerControls: false,
  lowercaseHeadings: false,
  reduceTransparency: false,
  syncOSAccessibility: true,
  keyboardCanvasEditing: false,
  colorOverrides: {},
  editingHighlights: true,
  restoreLastProject: false,
  defaultGridSize: 200,
  defaultSortField: "dateImported",
  defaultSortDirection: "desc",
  confirmRemovePhotos: true,
  showSubfolderPhotos: false,
  previewSource: "auto",
  thumbMaxEdge: 640,
  persistPreviews: true,
  externalCatalogDir: "",
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
  exportTiffBitDepth: 16,
  exportPresets: [],
  singleKeyShortcuts: true,
  extensionTopic: "safelight-extension",
  checkExtensionUpdates: true,
  autoUpdateExtensions: false,
  onlyVerifiedExtensions: false,
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
  // Reduce-motion lives in accessibility.ts now (it's OR-ed with the OS's
  // prefers-reduced-motion), so it isn't applied here.
  // Body font-family reads var(--font-mono); an inline :root override wins.
  if (s.uiFont) {
    document.documentElement.style.setProperty("--font-mono", s.uiFont);
  } else {
    document.documentElement.style.removeProperty("--font-mono");
  }
  // Canvas surround override: set a fixed shade on :root, or remove it so the
  // surround falls back to the theme's --color-surface-0 (see ViewportImage).
  if (s.canvasSurroundOverride) {
    document.documentElement.style.setProperty(
      "--color-canvas-surround",
      s.canvasSurround,
    );
  } else {
    document.documentElement.style.removeProperty("--color-canvas-surround");
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

/** Step the Develop surround one rung darker (-1) or lighter (+1) through
 *  CANVAS_SURROUND_SHADES, pinning a fixed shade (so it works even when the
 *  surround was following the theme). Shared by the toolbar widget and the
 *  keybindings. Clamps at the ends of the ladder. */
export function stepCanvasSurround(dir: -1 | 1): void {
  const found = CANVAS_SURROUND_SHADES.findIndex(
    (s) => s.value === getSettings().canvasSurround,
  );
  // -1 (no stored shade) falls back to the middle-grey rung.
  const idx = found === -1 ? DEFAULT_CANVAS_SURROUND_INDEX : found;
  const next = Math.min(
    CANVAS_SURROUND_SHADES.length - 1,
    Math.max(0, idx + dir),
  );
  updateSettings({
    canvasSurroundOverride: true,
    canvasSurround: CANVAS_SURROUND_SHADES[next].value,
  });
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
