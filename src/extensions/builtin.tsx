// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Built-in contributions, modeled as pre-installed extensions: every stock
// panel is its own extension entry, so it shows in the Extensions panel and
// can be disabled (but never uninstalled). Registration still flows through
// the same scoped API external plugins use, so a disabled built-in panel can
// be replaced by a community version.

import type { ComponentType } from "react";
import type { PanelDockDefault, ProcessingStageContribution, SafelightAPI } from "./types";
import type { DevelopParams } from "@/catalog/types";
import { DENOISE_STAGE } from "@/rendering/webgl/builtin-denoise";
import { useDevelopStore } from "@/state/develop-store";
import { HistogramPanel } from "@/modules/develop/panels/HistogramPanel";
import { CropPanel } from "@/modules/develop/panels/CropPanel";
import { TransformPanel } from "@/modules/develop/panels/TransformPanel";
import { WhiteBalancePanel } from "@/modules/develop/panels/WhiteBalancePanel";
import { BasicPanel } from "@/modules/develop/panels/BasicPanel";
import { ToneCurvePanel } from "@/modules/develop/panels/ToneCurvePanel";
import { ColorGradingPanel } from "@/modules/develop/panels/ColorGradingPanel";
import { DetailPanel } from "@/modules/develop/panels/DetailPanel";
import { EffectsPanel } from "@/modules/develop/panels/EffectsPanel";
import { HSLPanel } from "@/modules/develop/panels/HSLPanel";
import { MasksPanel } from "@/modules/develop/panels/MasksPanel";
import { RetouchPanel } from "@/modules/develop/panels/RetouchPanel";
import { PresetsPanel } from "@/modules/develop/panels/PresetsPanel";
import { EditActionsPanel } from "@/modules/develop/DevelopSidebar";
import { FoldersPanel, LibraryFiltersPanel } from "@/modules/library/LibrarySidebar";
import { InfoPanel } from "@/modules/library/InfoPanel";
import { KeywordsPanel } from "@/modules/library/KeywordsPanel";
import { ExportPanel } from "@/modules/export/ExportPanel";
import { DevToolsPanel } from "./devtools/DevToolsPanel";
import { DevSettings } from "./devtools/DevSettings";
import { installLogCapture, uninstallLogCapture } from "./devtools/log-capture";
import {
  initDevtoolsDetachSync,
  teardownDevtoolsDetachSync,
} from "./devtools/detach";
import { initDevFolder, teardownDevFolder } from "./devtools/dev-folder";
import {
  activateAccessibility,
  deactivateAccessibility,
} from "@/state/accessibility";
import { AccessibilitySettings } from "./accessibility/AccessibilitySettings";

export interface BuiltinExtension {
  id: string;
  name: string;
  version: string;
  description?: string;
  /** Locked extensions can't be disabled (the Extensions manager itself). */
  locked?: boolean;
  /** Ships inactive — seeded into the disabled list on first launch. */
  disabledByDefault?: boolean;
  activate(api: SafelightAPI): void;
  /** Tear down side effects when disabled (built-ins can't be uninstalled, but
   *  may patch globals — e.g. Developer Tools patches console). */
  deactivate?(): void;
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
  onReset?: () => void,
): BuiltinExtension => ({
  id,
  name: title,
  version: V,
  description,
  activate: (api) =>
    api.registerPanel({
      id,
      title,
      component,
      defaultDock,
      onReset,
      // The per-panel preview-off eye is no longer built in — it ships as the
      // optional "panel-click-to-toggle" extension, which decorates every panel
      // header via registerPanelHeaderAccessory.
    }),
});

// Right-click "Reset to defaults" for a develop panel: reset just its own param
// keys (one undoable edit). Crop and Transform also clear their ephemeral UI
// state (aspect lock / guided-line editing) alongside the params.
const resetDevelop = (keys: (keyof DevelopParams)[], label: string) => () =>
  void useDevelopStore.getState().resetParams(keys, label);

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

// ---------------------------------------------------------------------------
// Processing stage contributions: GLSL extracted from the monolithic shader.
// Each stage is injected back into the shader by buildFragmentShader when the
// stage is registered; disabling the owning extension removes the GLSL.
// ---------------------------------------------------------------------------

const VIGNETTE_STAGE: ProcessingStageContribution = {
  id: "core.vignette",
  name: "Vignette",
  phase: "effects",
  priority: 50,
  glsl: `c = applyVignette(c, vUv);`,
  helpers: `vec3 applyVignette(vec3 c, vec2 uv) {
  if (abs(uVignetteAmount) < 0.001) return c;
  vec2 centered = uv - 0.5;
  float roundness = uVignetteRoundness / 100.0;
  float rx = abs(centered.x);
  float ry = abs(centered.y);
  float rect = max(rx, ry);
  float circ = length(centered);
  float r = mix(rect, circ, clamp(roundness + 0.5, 0.0, 1.0)) * 2.0;
  float midpoint = mix(0.5, 1.5, 1.0 - uVignetteMidpoint / 100.0);
  float feather = mix(0.05, 0.95, uVignetteFeather / 100.0);
  float lo = max(0.0, midpoint - feather * 0.5);
  float hi = midpoint + feather * 0.5;
  float edge = smoothstep(lo, hi, r);
  float vigAmt = uVignetteAmount / 100.0;
  float darkening = vigAmt < 0.0 ? -vigAmt * edge : 0.0;
  float lightening = vigAmt > 0.0 ?  vigAmt * edge : 0.0;
  float hlProtect = uVignetteHighlights > 0.001
    ? clamp(luma(c) * (uVignetteHighlights / 100.0) * 2.0, 0.0, 1.0)
    : 0.0;
  darkening *= (1.0 - hlProtect);
  c = c * (1.0 - darkening) + c * lightening;
  return clamp(c, 0.0, 1.0);
}`,
  uniforms: [
    { key: "uVignetteAmount",     glslType: "float", default: 0, range: { min: -100, max: 100 }, label: "Amount" },
    { key: "uVignetteMidpoint",   glslType: "float", default: 50, range: { min: 0, max: 100 }, label: "Midpoint" },
    { key: "uVignetteRoundness",  glslType: "float", default: 0, range: { min: -100, max: 100 }, label: "Roundness" },
    { key: "uVignetteFeather",    glslType: "float", default: 50, range: { min: 0, max: 100 }, label: "Feather" },
    { key: "uVignetteHighlights", glslType: "float", default: 0, range: { min: 0, max: 100 }, label: "Highlights" },
  ],
};

const GRAIN_STAGE: ProcessingStageContribution = {
  id: "core.grain",
  name: "Grain",
  phase: "effects",
  priority: 60,
  glsl: `c = applyGrain(c, vUv);`,
  helpers: `float grainHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float gaussGrain(vec2 seed) {
  float u1 = max(grainHash(seed), 1e-6);
  float u2 = grainHash(seed + vec2(127.1, 311.7));
  return sqrt(-2.0 * log(u1)) * cos(6.28318530718 * u2);
}

float grainNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float g00 = gaussGrain(i);
  float g10 = gaussGrain(i + vec2(1.0, 0.0));
  float g01 = gaussGrain(i + vec2(0.0, 1.0));
  float g11 = gaussGrain(i + vec2(1.0, 1.0));
  return mix(mix(g00, g10, f.x), mix(g01, g11, f.x), f.y);
}

vec3 applyGrain(vec3 c, vec2 uv) {
  if (uGrainAmount < 0.001) return c;
  float amount = uGrainAmount / 100.0;
  float sizeT = (uGrainSize - 25.0) / 75.0;
  float rough = uGrainRoughness / 100.0;
  float chromaVar = uGrainColor / 100.0;
  float freq = mix(1400.0, 200.0, sizeT * sizeT);
  vec2 guv = vec2(uv.x * uImageAspect, uv.y) * freq;
  float L = luma(c);
  float density = mix(0.08, 1.0, sqrt(clamp(L, 0.0, 1.0)));
  float sigma = amount * density * 0.14;
  if (chromaVar < 0.01) {
    float n = grainNoise(guv);
    if (rough > 0.15) {
      float t = (rough - 0.15) / 0.85;
      n += grainNoise(guv * 2.17 + 17.3) * 0.5 * t;
    }
    c += vec3(n * sigma);
  } else {
    float rFreq = 1.0 + 0.25 * chromaVar;
    float bFreq = 1.0 - 0.15 * chromaVar;
    float nR = grainNoise(guv * rFreq);
    float nG = grainNoise(guv + vec2(43.7, 91.3));
    float nB = grainNoise(guv * bFreq + vec2(71.9, 37.1));
    if (rough > 0.15) {
      float t = (rough - 0.15) / 0.85;
      nR += grainNoise(guv * rFreq * 2.17 + 17.3) * 0.5 * t;
      nG += grainNoise((guv + vec2(43.7, 91.3)) * 2.17 + 17.3) * 0.5 * t;
      nB += grainNoise((guv * bFreq + vec2(71.9, 37.1)) * 2.17 + 17.3) * 0.5 * t;
    }
    c.r += nR * sigma;
    c.g += nG * sigma;
    c.b += nB * sigma;
  }
  return clamp(c, 0.0, 1.0);
}`,
  uniforms: [
    { key: "uGrainAmount",    glslType: "float", default: 0, range: { min: 0, max: 100 }, label: "Amount" },
    { key: "uGrainSize",      glslType: "float", default: 25, range: { min: 25, max: 100 }, label: "Size" },
    { key: "uGrainRoughness", glslType: "float", default: 50, range: { min: 0, max: 100 }, label: "Roughness" },
    { key: "uGrainColor",     glslType: "float", default: 0, range: { min: 0, max: 100 }, label: "Color" },
  ],
};

export const BUILTIN_EXTENSIONS: BuiltinExtension[] = [
  // ── Core (locked): the Extensions manager, stock themes, Classic layout ──
  {
    id: "core",
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
      // pure black/white and no color cast — so the chrome and the image
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
          // Achromatic (R=G=B) throughout — no color cast. A bright mid-grey
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
        },
      });
      api.registerProcessingStage(VIGNETTE_STAGE);
      api.registerProcessingStage(GRAIN_STAGE);
      // Built-in multi-pass wavelet denoiser (noise-reduction phase). A community
      // denoise extension that registers its own noise-reduction stage replaces
      // this one — buildStageInjection drops builtin.denoise when another exists.
      api.registerProcessingStage(DENOISE_STAGE);
      // Clipping / color-assessment / surround shortcuts are core actions, so
      // they live in the central KEY_ACTIONS registry (conflict-checked,
      // Develop-scoped) rather than the extension-action path — see
      // keybindings-store.ts and use-keyboard-shortcuts.ts.
    },
  },

  // ── Accessibility (enabled by default) ──
  // Owns the whole opt-in accessibility stack so it can be turned off as one
  // unit. The baseline semantic correctness (aria names/roles, dialog focus
  // trap, landmarks, the always-on :focus-visible ring) stays in the core
  // components/CSS and is unaffected by disabling this. activate/deactivate live
  // in state/accessibility.ts; deactivate removes every DOM side-effect.
  {
    id: "core.accessibility",
    name: "Accessibility",
    version: V,
    description:
      "High-contrast and colour-vision overlays, larger text and controls, reduced motion and transparency, OS-preference sync, and opt-in keyboard editing for the canvas tools. Disable to remove all of these — the app stays screen-reader navigable either way.",
    activate(api) {
      activateAccessibility();
      // Registered (not a core section) so it lives under Preferences ▸
      // Extensions and vanishes when this extension is disabled. Custom
      // component (reads/writes the core settings store); keywords keep it
      // findable in the settings search.
      api.registerSettings({
        title: "Accessibility",
        order: 0,
        fields: [],
        component: AccessibilitySettings,
        keywords: [
          "a11y", "wcag", "contrast", "vision", "colour blind", "color blind",
          "colorblind", "protanopia", "deuteranopia", "tritanopia", "focus",
          "zoom", "magnify", "scale", "legible", "readable", "text size",
          "font size", "uppercase", "caps", "hit target", "transparency",
          "opacity", "motion", "system", "os", "prefers", "forced colors",
          "high contrast mode", "keyboard",
        ],
      });
    },
    deactivate() {
      deactivateAccessibility();
    },
  },

  // ── Develop: right rail ──
  panelExt("core.edit", "Edit", EditActionsPanel, "Undo, redo and reset actions for the current edit.", right(0, 76), () => void useDevelopStore.getState().reset()),
  panelExt("core.histogram", "Histogram", HistogramPanel, "Live RGB histogram of the rendered image.", right(1, 150)),
  panelExt("core.transform", "Transform", TransformPanel, "Perspective, upright and geometry corrections.", right(2, 320), () => {
    const st = useDevelopStore.getState();
    st.setGuidedEditing(false);
    void st.resetParams(["transform", "straighten", "uprightMode", "guidedLines"], "Reset Transform");
  }),
  panelExt("core.crop", "Crop & Straighten", CropPanel, "Crop, straighten and aspect-ratio tools.", right(3, 150), () => {
    const st = useDevelopStore.getState();
    st.setCropAspect(0);
    void st.resetParams(["crop", "straighten"], "Reset Crop & Straighten");
  }),
  panelExt("core.white-balance", "White Balance", WhiteBalancePanel, "Temperature and tint.", right(4, 120), resetDevelop(["temperature", "tint"], "Reset White Balance")),
  panelExt("core.basic", "Basic", BasicPanel, "Exposure, contrast, highlights, shadows, presence.", right(5, 220), resetDevelop(["exposure", "contrast", "highlights", "highlightDetail", "shadows", "shadowDetail", "whites", "blacks", "texture", "clarity", "dehaze", "vibrance", "saturation"], "Reset Basic")),
  panelExt("core.tone-curve", "Tone Curve", ToneCurvePanel, "Parametric and point tone curves per channel.", right(6, 220), resetDevelop(["toneCurve"], "Reset Tone Curve")),
  panelExt("core.color-grading", "Color Grading", ColorGradingPanel, "Shadow / midtone / highlight color wheels.", right(7, 200), resetDevelop(["colorGrading"], "Reset Color Grading")),
  panelExt("core.detail", "Detail", DetailPanel, "Sharpening and noise reduction.", right(8, 150), resetDevelop(["sharpening", "sharpenRadius", "sharpenDetail", "sharpenMasking", "luminanceNR", "luminanceNRDetail", "luminanceNRContrast", "luminanceNRShadows", "luminanceNRHighlights", "colorNR", "colorNRDetail", "colorNRSmoothness"], "Reset Detail")),
  panelExt("core.effects", "Effects", EffectsPanel, "Vignette, grain and dehaze.", right(10, 150), resetDevelop(["vignette", "grain"], "Reset Effects")),
  // HSL is a full extension (not a bare panelExt) so it can contribute its own
  // Preferences ▸ HSL section: layout default, coloured tracks, and the on-image
  // target-tool sensitivity (read by the picker in DevelopCanvas).
  {
    id: "core.hsl",
    name: "HSL",
    version: V,
    description: "Per-color hue, saturation and luminance mixer.",
    activate(api) {
      api.registerPanel({
        id: "core.hsl",
        title: "HSL",
        component: HSLPanel,
        defaultDock: right(11, 220),
        onReset: resetDevelop(["hsl"], "Reset HSL"),
      });
      api.registerSettings({
        title: "HSL",
        order: 60,
        keywords: ["hue", "saturation", "luminance", "color mixer", "target", "tat"],
        fields: [
          {
            key: "defaultView",
            label: "Default layout",
            hint: "Tabs shows one band at a time; All stacks Hue, Saturation and Luminance.",
            type: "select",
            default: "tabs",
            options: [
              { value: "tabs", label: "Tabs (one band)" },
              { value: "all", label: "All bands" },
            ],
          },
          {
            key: "hueRange",
            label: "Colour range",
            hint: "How wide each colour's selection reaches. Lower is more surgical (tighter bands); higher blends neighbouring colours. 100 is the default seamless tiling.",
            type: "number",
            default: 100,
            min: 50,
            max: 150,
            step: 5,
          },
          {
            key: "smoothness",
            label: "Smoothness",
            hint: "How soft the transition between colours is. Lower gives more defined band edges; higher feathers them. 100 matches the default.",
            type: "number",
            default: 100,
            min: 0,
            max: 100,
            step: 5,
          },
          {
            key: "pickerSensitivity",
            label: "Target tool sensitivity",
            hint: "How far an on-image drag moves the sliders (units per pixel).",
            type: "number",
            default: 0.5,
            min: 0.1,
            max: 1.5,
            step: 0.05,
          },
        ],
      });
    },
  },

  // ── Develop: left rail ──
  panelExt("core.masks", "Masking", MasksPanel, "Local adjustments with brush, linear and radial masks.", left(0, 240), () => {
    const st = useDevelopStore.getState();
    st.selectMask(null);
    st.selectComponent(null);
    void st.resetParams(["masks"], "Reset Masking");
  }),
  panelExt("core.retouch", "Heal", RetouchPanel, "Heal spot removal.", left(1, 160), () => {
    const st = useDevelopStore.getState();
    st.selectSpot(null);
    void st.resetParams(["retouch"], "Reset Heal");
  }),
  panelExt("core.presets", "Presets", PresetsPanel, "Save and apply develop presets.", left(2, 200)),

  // ── Library ──
  panelExt("core.folders", "Folders", FoldersPanel, "Project folder tree.", {
    module: "library", direction: "left", order: 0, width: 240,
  }),
  panelExt("core.filters", "Filters", LibraryFiltersPanel, "Filter the grid by rating, flag and label.", {
    module: "library", direction: "left", order: 1, width: 240,
  }),
  panelExt("core.keywords", "Keywords", KeywordsPanel, "All keywords in the project with photo counts. Click to filter.", {
    module: "library", direction: "left", order: 2, width: 240,
  }),
  panelExt("core.info", "Info", InfoPanel, "Metadata and EXIF for the selected photo.", {
    module: "library", direction: "right", order: 0, width: 280,
  }),

  panelExt("core.export", "Export", ExportPanel, "Export photos with format, size and quality options.", {
    module: "library", direction: "right", order: 1, width: 280,
  }),

  // ── Developer Tools (disabled by default) ──
  // Enable from Extensions ▸ Installed, then open via View ▸ Developer Tools.
  // Activation installs the console/error capture; disabling removes it so a
  // disabled extension leaves the console untouched.
  {
    id: "core.devtools",
    name: "Developer Tools",
    version: V,
    description:
      "In-app inspector: console, errors/warnings, system & WebGL info, localStorage editor and Electron DevTools controls. Disabled by default.",
    disabledByDefault: true,
    activate(api) {
      installLogCapture();
      initDevtoolsDetachSync(); // cross-window re-dock control
      initDevFolder(); // scan the configured dev folder, if any
      api.registerPanel({
        id: "core.devtools",
        title: "Developer Tools",
        component: DevToolsPanel,
      });
      // Dev-folder configuration lives in this extension's own settings section
      // (Preferences ▸ Developer Tools), so it disappears when the extension is
      // disabled. No declarative fields — a custom component drives it all.
      api.registerSettings({
        title: "Developer Tools",
        fields: [],
        component: DevSettings,
      });
      api.registerKeybinding({
        id: "core.devtools.toggle",
        label: "Toggle Developer Tools Panel",
        category: "General",
        defaultCombo: "Ctrl+Alt+I",
        handler: () => api.dock.togglePanel("core.devtools"),
      });
    },
    deactivate() {
      uninstallLogCapture();
      teardownDevtoolsDetachSync();
      teardownDevFolder(); // unload every dev-folder extension
    },
  },
];
