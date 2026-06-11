// Built-in contributions, registered through the same API external plugins
// use. Every panel here — sidebars included — is a dockview panel: the
// defaultDock field places it in a module's default layout, and any panel can
// be opened, floated, or re-docked from the View menu.

import type { SafelightAPI } from "./types";
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

export function registerBuiltins(api: SafelightAPI): void {
  // ── Develop: every panel is its own dock panel ────────────────────────────
  // Lightroom-style rails, Photoshop-style docking: each panel stacks in the
  // left/right column by default and can be dragged, tabbed, minimized, or
  // floated individually. Heights are relative weights within the column.
  const developRight: [string, string, React.ComponentType, number][] = [
    ["core.histogram", "Histogram", HistogramPanel, 150],
    ["core.tuning", "Tuning", TuningPanel, 180],
    ["core.crop", "Crop", CropPanel, 150],
    ["core.transform", "Transform", TransformPanel, 180],
    ["core.white-balance", "White Balance", WhiteBalancePanel, 120],
    ["core.basic", "Basic", BasicPanel, 220],
    ["core.tone-curve", "Tone Curve", ToneCurvePanel, 220],
    ["core.color-grading", "Color Grading", ColorGradingPanel, 200],
    ["core.detail", "Detail", DetailPanel, 150],
    ["core.lens-correction", "Lens Correction", LensCorrectionPanel, 120],
    ["core.effects", "Effects", EffectsPanel, 150],
    ["core.hsl", "HSL", HSLPanel, 220],
  ];
  developRight.forEach(([id, title, component, height], i) =>
    api.registerPanel({
      id,
      title,
      component,
      defaultDock: {
        module: "develop",
        direction: "right",
        order: i + 1,
        width: 280,
        height,
      },
    }),
  );

  const developLeft: [string, string, React.ComponentType, number][] = [
    ["core.masks", "Masks", MasksPanel, 240],
    ["core.retouch", "Retouch", RetouchPanel, 160],
    ["core.presets", "Presets", PresetsPanel, 200],
  ];
  developLeft.forEach(([id, title, component, height], i) =>
    api.registerPanel({
      id,
      title,
      component,
      defaultDock: {
        module: "develop",
        direction: "left",
        order: i,
        width: 240,
        height,
      },
    }),
  );

  // Slim undo/redo/reset bar at the top of the right rail.
  api.registerPanel({
    id: "core.edit",
    title: "Edit",
    component: EditActionsPanel,
    defaultDock: {
      module: "develop",
      direction: "right",
      order: 0,
      width: 280,
      height: 76,
    },
  });

  // ── Library layout ─────────────────────────────────────────────────────────
  api.registerPanel({
    id: "core.folders",
    title: "Folders",
    component: FoldersPanel,
    defaultDock: { module: "library", direction: "left", order: 0, width: 240 },
  });
  api.registerPanel({
    id: "core.filters",
    title: "Filters",
    component: LibraryFiltersPanel,
    defaultDock: { module: "library", direction: "left", order: 1, width: 240 },
  });
  api.registerPanel({
    id: "core.info",
    title: "Info",
    component: InfoPanel,
    defaultDock: { module: "library", direction: "right", order: 0, width: 280 },
  });

  // ── View-menu-only panels ──────────────────────────────────────────────────
  api.registerPanel({
    id: "core.export",
    title: "Export",
    component: ExportPanel,
  });
  api.registerPanel({
    id: "core.extensions",
    title: "Extensions",
    component: ExtensionManagerPanel,
  });

  // ── Layouts ───────────────────────────────────────────────────────────────
  // "Classic" has no explicit module defs: it resolves to the registry's
  // defaultDock placements, so extension panels join it automatically.
  // Extensions can register alternative arrangements (tabbed tool columns,
  // single-rail minimal workspaces, …) through the same call; the Layout menu
  // also always offers "Custom" — the user's own saved arrangement.
  api.registerLayout({
    id: "core.classic",
    name: "Classic",
    description:
      "Stacked tool rails on the left and right of the main view — the traditional darkroom arrangement.",
  });

  // ── Themes ────────────────────────────────────────────────────────────────
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
}
