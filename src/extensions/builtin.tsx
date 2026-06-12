// Built-in contributions, modeled as pre-installed extensions: every stock
// panel is its own extension entry, so it shows in the Extensions panel and
// can be disabled (but never uninstalled). Registration still flows through
// the same scoped API external plugins use, so a disabled built-in panel can
// be replaced by a community version.

import type { ComponentType } from "react";
import type { PanelDockDefault, SafelightAPI } from "./types";
import { HistogramPanel } from "@/modules/develop/panels/HistogramPanel";
import { TuningPanel } from "@/modules/develop/panels/TuningPanel";
import { CropPanel } from "@/modules/develop/panels/CropPanel";
import { TransformPanel } from "@/modules/develop/panels/TransformPanel";
import { WhiteBalancePanel } from "@/modules/develop/panels/WhiteBalancePanel";
import { BasicPanel } from "@/modules/develop/panels/BasicPanel";
import { ToneCurvePanel } from "@/modules/develop/panels/ToneCurvePanel";
import { ColorGradingPanel } from "@/modules/develop/panels/ColorGradingPanel";
import { DetailPanel } from "@/modules/develop/panels/DetailPanel";
import { LensCorrectionPanel } from "@/modules/develop/panels/LensCorrectionPanel";
import { EffectsPanel } from "@/modules/develop/panels/EffectsPanel";
import { HSLPanel } from "@/modules/develop/panels/HSLPanel";
import { MasksPanel } from "@/modules/develop/panels/MasksPanel";
import { RetouchPanel } from "@/modules/develop/panels/RetouchPanel";
import { PresetsPanel } from "@/modules/develop/panels/PresetsPanel";
import { EditActionsPanel } from "@/modules/develop/DevelopSidebar";
import { FoldersPanel, LibraryFiltersPanel } from "@/modules/library/LibrarySidebar";
import { InfoPanel } from "@/modules/library/InfoPanel";
import { ExportPanel } from "@/modules/export/ExportPanel";
import { ExtensionManagerPanel } from "./ExtensionManagerPanel";

export interface BuiltinExtension {
  id: string;
  name: string;
  version: string;
  description?: string;
  /** Locked extensions can't be disabled (the Extensions manager itself). */
  locked?: boolean;
  activate(api: SafelightAPI): void;
}

const V = "1.0.0";

/** One pre-installed extension that contributes a single panel. The extension
 *  id doubles as the panel id, so existing layouts keep working. */
const panelExt = (
  id: string,
  title: string,
  component: ComponentType,
  description: string,
  defaultDock?: PanelDockDefault,
): BuiltinExtension => ({
  id,
  name: title,
  version: V,
  description,
  activate: (api) => api.registerPanel({ id, title, component, defaultDock }),
});

// Lightroom-style rails, Photoshop-style docking: each panel stacks in the
// left/right column by default and can be dragged, tabbed, minimized, or
// floated individually. Heights are relative weights within the column.
const right = (order: number, height: number): PanelDockDefault => ({
  module: "develop",
  direction: "right",
  order,
  width: 280,
  height,
});
const left = (order: number, height: number): PanelDockDefault => ({
  module: "develop",
  direction: "left",
  order,
  width: 240,
  height,
});

export const BUILTIN_EXTENSIONS: BuiltinExtension[] = [
  // ── Core (locked): the Extensions manager, stock themes, Classic layout ──
  {
    id: "core",
    name: "Safelight Core",
    version: V,
    description: "Extension manager, the stock themes and the Classic layout.",
    locked: true,
    activate(api) {
      api.registerPanel({
        id: "core.extensions",
        title: "Extensions",
        component: ExtensionManagerPanel,
      });
      // "Classic" has no explicit module defs: it resolves to the registry's
      // defaultDock placements, so extension panels join it automatically.
      api.registerLayout({
        id: "core.classic",
        name: "Classic",
        description:
          "Stacked tool rails on the left and right of the main view — the traditional darkroom arrangement.",
      });
      // "Safelight Dark" mirrors the index.css defaults so switching back is a
      // clean reset; vars listed here are the full themable surface.
      api.registerTheme({
        id: "core.dark",
        name: "Safelight Dark",
        colorScheme: "dark",
        vars: {
          "--color-surface-0": "#0a0a0a",
          "--color-surface-1": "#111111",
          "--color-surface-2": "#1a1a1a",
          "--color-surface-3": "#242424",
          "--color-surface-4": "#2e2e2e",
          "--color-border": "#333333",
          "--color-border-subtle": "#222222",
          "--color-text-primary": "#e0e0e0",
          "--color-text-secondary": "#888888",
          "--color-text-muted": "#555555",
          "--color-accent": "#4a9eff",
          "--color-accent-hover": "#6ab4ff",
          "--color-slider-fill": "#5a5a5a",
        },
      });
      api.registerTheme({
        id: "core.light",
        name: "Safelight Light",
        colorScheme: "light",
        vars: {
          "--color-surface-0": "#f4f4f4",
          "--color-surface-1": "#ebebeb",
          "--color-surface-2": "#e0e0e0",
          "--color-surface-3": "#d2d2d2",
          "--color-surface-4": "#c4c4c4",
          "--color-border": "#b5b5b5",
          "--color-border-subtle": "#d8d8d8",
          "--color-text-primary": "#1c1c1c",
          "--color-text-secondary": "#5a5a5a",
          "--color-text-muted": "#979797",
          "--color-accent": "#2f7fe0",
          "--color-accent-hover": "#1f6fd0",
          "--color-slider-fill": "#8a8a8a",
        },
      });
    },
  },

  // ── Develop: right rail ──
  panelExt("core.edit", "Edit", EditActionsPanel, "Undo, redo and reset actions for the current edit.", right(0, 76)),
  panelExt("core.histogram", "Histogram", HistogramPanel, "Live RGB histogram of the rendered image.", right(1, 150)),
  panelExt("core.tuning", "Tuning", TuningPanel, "Camera profile and base tuning controls.", right(2, 180)),
  panelExt("core.crop", "Crop & Straighten", CropPanel, "Crop, straighten and aspect-ratio tools.", right(3, 150)),
  panelExt("core.transform", "Transform", TransformPanel, "Perspective and geometry corrections.", right(4, 180)),
  panelExt("core.white-balance", "White Balance", WhiteBalancePanel, "Temperature and tint.", right(5, 120)),
  panelExt("core.basic", "Basic", BasicPanel, "Exposure, contrast, highlights, shadows, presence.", right(6, 220)),
  panelExt("core.tone-curve", "Tone Curve", ToneCurvePanel, "Parametric and point tone curves per channel.", right(7, 220)),
  panelExt("core.color-grading", "Color Grading", ColorGradingPanel, "Shadow / midtone / highlight color wheels.", right(8, 200)),
  panelExt("core.detail", "Detail", DetailPanel, "Sharpening and noise reduction.", right(9, 150)),
  panelExt("core.lens-correction", "Lens Correction", LensCorrectionPanel, "Distortion and vignette correction.", right(10, 120)),
  panelExt("core.effects", "Effects", EffectsPanel, "Vignette, grain and dehaze.", right(11, 150)),
  panelExt("core.hsl", "HSL", HSLPanel, "Per-color hue, saturation and luminance mixer.", right(12, 220)),

  // ── Develop: left rail ──
  panelExt("core.masks", "Masking", MasksPanel, "Local adjustments with brush, linear and radial masks.", left(0, 240)),
  panelExt("core.retouch", "Heal / Clone", RetouchPanel, "Heal and clone spot removal.", left(1, 160)),
  panelExt("core.presets", "Presets", PresetsPanel, "Save and apply develop presets.", left(2, 200)),

  // ── Library ──
  panelExt("core.folders", "Folders", FoldersPanel, "Project folder tree.", {
    module: "library", direction: "left", order: 0, width: 240,
  }),
  panelExt("core.filters", "Filters", LibraryFiltersPanel, "Filter the grid by rating, flag and label.", {
    module: "library", direction: "left", order: 1, width: 240,
  }),
  panelExt("core.info", "Info", InfoPanel, "Metadata and EXIF for the selected photo.", {
    module: "library", direction: "right", order: 0, width: 280,
  }),

  panelExt("core.export", "Export", ExportPanel, "Export photos with format, size and quality options.", {
    module: "library", direction: "right", order: 1, width: 280,
  }),
];
