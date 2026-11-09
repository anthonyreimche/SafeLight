// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Built-in contributions, modelled as a pre-installed extension: the core
// extension (the Extensions manager, the stock themes, the Classic layout and
// the built-in denoiser). Every panel and module is an extension of its own
// (the Essentials). Registration still flows through the same scoped API
// external plugins use.

import type { SafelightAPI } from "./types";
import { DENOISE_STAGE } from "@/rendering/webgl/builtin-denoise";
import { CORE_EXTENSION_ID, noteBuiltinExtensions } from "./core-extension";

export interface BuiltinExtension {
  id: string;
  name: string;
  version: string;
  description?: string;
  /** Locked extensions can't be disabled (the Extensions manager itself). */
  locked?: boolean;
  /** Ships inactive — seeded into the disabled list on first launch. */
  disabledByDefault?: boolean;
  /** Saved layouts never switch it on or off: whatever the user chose for it
   *  stands, whichever layout is picked. */
  keepAcrossLayouts?: boolean;
  activate(api: SafelightAPI): void;
  /** Tear down side effects when disabled (built-ins can't be uninstalled, but
   *  may patch globals). */
  deactivate?(): void;
}

const V = "1.0.0";

export const BUILTIN_EXTENSIONS: BuiltinExtension[] = [
  // ── Core (locked): the Extensions manager, stock themes, Classic layout ──
  {
    id: CORE_EXTENSION_ID,
    name: "Safelight Core",
    version: V,
    description: "Extension manager, the stock themes and the Classic layout.",
    locked: true,
    activate(api) {
      // Extensions are managed in a pop-up (the puzzle button in the top bar),
      // not a dockable panel — see ExtensionsDialog.
      // "Classic" has no explicit module defs: it resolves to the registry's
      // defaultDock placements, so extension panels join it automatically.
      api.registerLayout({
        id: "core.classic",
        name: "Classic",
        description:
          "Stacked tool rails on the left and right of the main view — the traditional darkroom arrangement.",
      });
      // "Safelight Neutral" (the default) mirrors the index.css defaults so
      // switching back is a clean reset; vars listed here are the full themable
      // surface. It follows darktable's rule of an achromatic, mid-grey UI — no
      // pure black/white and no colour cast — so the chrome and the image
      // surround don't perceptually skew the brightness/contrast/saturation of
      // the photo being edited.
      // Built-in display transform: always present so Preferences ▸ Rendering
      // has at least one option even when no extension is installed.
      api.registerPipeline({
        id: "core.pipeline",
        name: "Built-in",
        description:
          "Safelight's stock pipeline: unclamped sRGB encode with HDR highlight handling and the default RAW base curve.",
      });
      api.registerTheme({
        id: "core.neutral",
        name: "Safelight Neutral",
        colorScheme: "dark",
        vars: {
          // Achromatic (R=G=B) throughout — no colour cast. A bright mid-grey
          // chrome modelled on darktable/Ansel: the whole field of view sits
          // near middle grey so it doesn't perceptually skew the image's
          // brightness/contrast/saturation while editing. Surfaces ascend from
          // the recessed base; text is near-white and borders are dark for
          // Ansel-like contrast. The Develop image surround is a separate true
          // middle grey (#777) set via the canvas-surround setting, not a
          // surface here.
          "--color-surface-0": "#525252",
          "--color-surface-1": "#5e5e5e",
          "--color-surface-2": "#686868",
          "--color-surface-3": "#747474",
          "--color-surface-4": "#828282",
          "--color-border": "#3b3b3b",
          "--color-border-subtle": "#4a4a4a",
          "--color-text-primary": "#f4f4f4",
          // Neutral keeps its as-designed mid-grey text: pushing text to AA on
          // this middle-grey field means pushing it toward white, which fights
          // the theme's purpose (an eye adapted to mid-grey for colour
          // assessment). Users who need more contrast here enable the opt-in
          // High-contrast override in Preferences → Accessibility.
          "--color-text-secondary": "#d0d0d0",
          "--color-text-muted": "#9c9c9c",
          // Dark achromatic accent so active controls/selection (white text on
          // accent) stay legible against the light chrome.
          "--color-accent": "#2e2e2e",
          "--color-accent-hover": "#3c3c3c",
          "--color-slider-fill": "#2e2e2e",
        },
      });
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
          // Raised for WCAG AA: #555555 muted was 2.3–2.7:1 on the dark
          // surfaces; #848484 clears 4.5:1 on all three. Secondary nudged up so
          // it stays clearly brighter than the new muted.
          "--color-text-secondary": "#999999",
          "--color-text-muted": "#848484",
          "--color-accent": "#6e6e6e",
          "--color-accent-hover": "#828282",
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
          // Darkened for WCAG AA: #979797 muted was 2.2–2.7:1 on the light
          // surfaces; #636363 clears 4.5:1 on all three (still lighter than the
          // #5a5a5a secondary, preserving the hierarchy).
          "--color-text-muted": "#636363",
          "--color-accent": "#636363",
          "--color-accent-hover": "#525252",
          "--color-slider-fill": "#8a8a8a",
          // The curve editor and histogram draw dark on the light surface; the
          // clip readouts are darker than the defaults to read as small text.
          "--curve-rgb": "#2e2e2e",
          "--curve-grid": "#d6d6d6",
          "--curve-identity": "#c4c4c4",
          "--curve-ring": "#5a5a5a",
          "--curve-ring-focused": "#000000",
          "--curve-point": "#1c1c1c",
          "--histogram-curve": "rgba(46,46,46,0.85)",
          "--histogram-grid": "rgba(0,0,0,0.08)",
          "--histogram-zone": "rgba(0,0,0,0.06)",
          "--histogram-label": "rgba(28,28,28,0.85)",
          "--histogram-clip-shadow": "rgba(30,50,200,0.95)",
          "--histogram-clip-highlight": "rgba(190,20,20,0.95)",
          "--histogram-clip-shadow-active": "rgb(20,40,170)",
          "--histogram-clip-highlight-active": "rgb(160,10,10)",
          "--histogram-clip-shadow-bg": "rgba(50,77,255,0.18)",
          "--histogram-clip-highlight-bg": "rgba(255,50,50,0.18)",
        },
      });
      // Built-in multi-pass wavelet denoiser (noise-reduction phase). A community
      // denoise extension that registers its own noise-reduction stage replaces
      // this one — buildStageInjection drops builtin.denoise when another exists.
      api.registerProcessingStage(DENOISE_STAGE);
      // Clipping / colour-assessment / surround shortcuts are core actions, so
      // they live in the central KEY_ACTIONS registry (conflict-checked,
      // Develop-scoped) rather than the extension-action path — see
      // keybindings-store.ts and use-keyboard-shortcuts.ts.
    },
  },
];

noteBuiltinExtensions(BUILTIN_EXTENSIONS.map((b) => b.id));
