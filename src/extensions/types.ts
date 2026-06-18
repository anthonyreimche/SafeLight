// Public extension API types. Everything a plugin can see lives here.
// Plugins are prebuilt ESM bundles whose default/named `activate(api)` export
// receives a SafelightAPI scoped to their extension id.

import type { ComponentType } from "react";

/** Stack a panel renders in by default ("none" = only via the View menu).
 *  Stacks are composite panels (e.g. "Edit") that host many small panels. */
export type PanelSlot = "develop-right" | "develop-left" | "none";

/** Default placement in a module's dock layout (used when the user has no
 *  saved layout for that module yet). */
export interface PanelDockDefault {
  module: "library" | "develop";
  direction: "left" | "right";
  /** Stacking order within the direction (lower = closer to main). */
  order?: number;
  width?: number;
  /** Initial group height when stacked below another panel in the column. */
  height?: number;
}

export interface PanelContribution {
  /** Globally unique, e.g. "core.histogram" or "my-ext.fancy-curves". */
  id: string;
  title: string;
  /** Rendered both in its stack slot and inside a dock panel. */
  component: ComponentType;
  slot?: PanelSlot;
  /** Sort position within the slot (lower = higher up). Default 100. */
  order?: number;
  defaultDock?: PanelDockDefault;
}

/** One dock column in a layout preset. Panels listed top→bottom. */
export interface LayoutRail {
  side: "left" | "right";
  width?: number;
  /** Panel ids, e.g. "core.histogram". Unknown ids render a placeholder. */
  panels: string[];
}

export interface ModuleLayoutDef {
  rails: LayoutRail[];
  /** Panels that start as floating windows. */
  floating?: Record<string, { x: number; y: number; width: number }>;
}

/** A named dock arrangement selectable from the Layout menu. Modules omitted
 *  from `modules` fall back to the registry's defaultDock placements, so a
 *  layout with no `modules` at all means "the built-in defaults". */
export interface LayoutContribution {
  id: string;
  name: string;
  /** Shown as a tooltip in the Layout menu. */
  description?: string;
  modules?: Partial<Record<"library" | "develop", ModuleLayoutDef>>;
}

export interface ThemeContribution {
  id: string;
  name: string;
  colorScheme?: "light" | "dark";
  /** CSS custom properties applied to :root, e.g. { "--color-surface-0": "#fff" }. */
  vars: Record<string, string>;
}

/** A render pipeline (scene-linear → display transform), selectable in the
 *  Pixel Peeper panel. The GLSL must define
 *    vec3 pipelineToDisplay(vec3 lin)
 *  mapping scene-linear RGB (sRGB primaries, HDR — values may exceed 1.0) to
 *  display-encoded output. Helpers available: luma(), srgbToLinear(),
 *  linearToSrgb(), linearToSrgbU(). */
export interface PipelineContribution {
  id: string;
  name: string;
  /** Shown under the picker when active. */
  description?: string;
  /** Body defining pipelineToDisplay; omit to reuse the built-in transform. */
  glsl?: string;
  /** Skip the default RAW base tone curve (set when the transform brings its
   *  own contrast curve, e.g. AgX / ACES). */
  skipBaseCurve?: boolean;
}

export interface SliderIconContribution {
  /** Referenced by Slider's `icon` prop, e.g. "core.exposure". */
  id: string;
  /** Inline SVG markup, rendered at 12×12 beside the slider label. */
  svg: string;
}

/** One field in an extension's settings dialog. */
export type SettingsField =
  | {
      key: string;
      label: string;
      hint?: string;
      type: "boolean";
      default: boolean;
    }
  | {
      key: string;
      label: string;
      hint?: string;
      type: "number";
      default: number;
      min?: number;
      max?: number;
      step?: number;
    }
  | {
      key: string;
      label: string;
      hint?: string;
      type: "string";
      default: string;
      placeholder?: string;
    }
  | {
      key: string;
      label: string;
      hint?: string;
      type: "select";
      default: string;
      options: { value: string; label: string }[];
    };

/** Declarative settings dialog, opened from the Extensions panel. Values are
 *  persisted per-extension and read back with api.settings.get(). */
export interface SettingsContribution {
  /** Dialog title; defaults to the extension's name. */
  title?: string;
  fields: SettingsField[];
}

/** A repo found by the official-extension search (GitHub topic). */
export interface ExtensionSearchResult {
  /** "owner/repo" — also the install spec. */
  fullName: string;
  description: string | null;
  stars: number;
  updatedAt: string;
}

/** safelight.json at the root of an extension repo. */
export interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  /** Entry ESM bundle, relative to the extension folder, e.g. "dist/index.js". */
  main: string;
}

/** One settings field used by an export processor's in-panel UI.
 *  Mirrors SettingsField but scoped to a single processor. */
export type ExportProcessorField =
  | {
      key: string;
      label: string;
      hint?: string;
      type: "boolean";
      default: boolean;
    }
  | {
      key: string;
      label: string;
      hint?: string;
      type: "number";
      default: number;
      min?: number;
      max?: number;
      step?: number;
    }
  | {
      key: string;
      label: string;
      hint?: string;
      type: "string";
      default: string;
      placeholder?: string;
    }
  | {
      key: string;
      label: string;
      hint?: string;
      type: "select";
      default: string;
      options: { value: string; label: string }[];
    };

/** A post-processing step called for each image after the WebGL pipeline
 *  encodes it to a Blob. Processors run in registration order, each receiving
 *  the Blob returned by the previous step. */
export interface ExportProcessorContribution {
  /** Globally unique, e.g. "my-ext.watermark". */
  id: string;
  /** Shown as a collapsible section header in the Export panel. */
  label: string;
  /** Optional settings that appear in the Export panel UI. */
  settings?: ExportProcessorField[];
  /**
   * Called once per exported image.
   * @param blob    The encoded image Blob from the previous pipeline stage.
   * @param photo   The CatalogPhoto record (filename, exif, rating, …).
   * @param settings  Current values of the declared settings fields.
   * @returns       A new Blob, or the original if no modification was needed.
   */
  process(
    blob: Blob,
    photo: import("@/catalog/types").CatalogPhoto,
    settings: Record<string, unknown>,
  ): Promise<Blob>;
}

/** A filename template variable set contributed by an extension. Safelight
 *  resolves the built-in variables ({filename}, {ext}, {year}, {month},
 *  {day}, {rating}, {camera}, {lens}) from CatalogPhoto; extensions may
 *  register additional templates. */
export interface FilenameTemplateContribution {
  /** Globally unique, e.g. "my-ext.date-template". */
  id: string;
  /** Human-readable name shown in the filename template picker (future UI). */
  label: string;
  /**
   * Template string using {variable} placeholders. Built-in variables:
   * {filename} base name without extension, {ext} format extension,
   * {year} {month} {day} from EXIF date, {rating} star count (0-5),
   * {camera} camera model, {lens} lens name.
   */
  template: string;
}

// ---------------------------------------------------------------------------
// Processing stage contributions (orchestrator pipeline)
// ---------------------------------------------------------------------------

export type GlslType =
  | "float" | "int" | "bool"
  | "vec2" | "vec3" | "vec4"
  | "ivec2" | "ivec3" | "ivec4"
  | "mat3" | "mat4"
  | "sampler2D";

export interface UniformDeclaration {
  /** Parameter bag key, e.g. "exposure". Qualified at registration time as
   *  "{stageId}.{key}", e.g. "core.exposure.exposure". */
  key: string;
  glslType: GlslType;
  default: number | number[] | boolean;
  range?: { min: number; max: number; step?: number };
  label?: string;
}

export interface InterStageVariable {
  /** Shared variable name, e.g. "refT". Emitted as `isv_{name}` in the shader. */
  name: string;
  glslType: "float" | "vec2" | "vec3" | "vec4";
  /** GLSL initializer expression evaluated after this stage runs.
   *  Omit if this stage only consumes the variable. */
  producer?: string;
}

export interface TextureRequirement {
  /** Parameter bag key for the texture data. */
  key: string;
  kind: "lut" | "coverage" | "dynamic";
  width?: number;
  height?: number;
  format?: "rgba8" | "rgba16f" | "r8";
}

/** Fixed processing phases. Order is enforced by the shader compiler. */
export type ProcessingPhase =
  | "decode"
  | "noise-reduction"
  | "scene-linear"
  | "tone-map"
  | "display-adjust"
  | "effects"
  | "output-encode";

/** Ordered phase list for the shader compiler's sort. */
export const PROCESSING_PHASE_ORDER: ProcessingPhase[] = [
  "decode",
  "noise-reduction",
  "scene-linear",
  "tone-map",
  "display-adjust",
  "effects",
  "output-encode",
];

export interface ProcessingStageContribution {
  /** Globally unique, e.g. "core.exposure" or "film-sim.halation". */
  id: string;
  name: string;
  phase: ProcessingPhase;
  /** Order within the phase. Lower = runs first. Default 100. */
  priority?: number;

  /** GLSL code fragment operating on `vec3 color` (read/write). */
  glsl: string;
  /** Helper functions available to this stage's glsl (namespaced by compiler). */
  helpers?: string;

  uniforms: UniformDeclaration[];

  produces?: InterStageVariable[];
  /** Names of InterStageVariables this stage reads. */
  consumes?: string[];

  textures?: TextureRequirement[];

  /** Whether this stage participates in masked local adjustments. */
  mask?: { maskable: true; maskPhase: "linear" | "display" };

  /** Stage IDs this one should run after (soft dependency — skipped if absent). */
  after?: string[];
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------

/** A keyboard shortcut contributed by an extension. The action appears in
 *  Preferences ▸ Shortcuts and can be rebound by the user like any built-in. */
export interface KeyActionContribution {
  /** Unique action id, e.g. "my-ext.invert-colors". */
  id: string;
  label: string;
  category?: "General" | "Develop" | "Library";
  /** Default key combo in SafeLight combo format, e.g. "Ctrl+Shift+I". */
  defaultCombo: string;
  /** Called when the combo fires (or the user's rebind of it fires). */
  handler(): void;
}

export interface SafelightAPI {
  version: 1;
  extensionId: string;
  /** The app's React instance — plugins must use this, not their own copy. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  react: any;
  registerPanel(c: PanelContribution): void;
  registerTheme(c: ThemeContribution): void;
  registerLayout(c: LayoutContribution): void;
  registerSliderIcon(c: SliderIconContribution): void;
  /** Register a render pipeline (display transform / tone mapper). */
  registerPipeline(c: PipelineContribution): void;
  /** Register a GPU processing stage. The stage's GLSL fragment is compiled
   *  into the single-pass develop shader at registration time. Unregistering
   *  (or disabling the extension) removes the GLSL and recompiles. */
  registerProcessingStage(c: ProcessingStageContribution): void;
  /** Register a keyboard shortcut; appears in Preferences ▸ Shortcuts. */
  registerKeybinding(c: KeyActionContribution): void;
  /** Declare a settings dialog (⚙ in the Extensions panel). */
  registerSettings(c: SettingsContribution): void;
  /** Register a post-export image processor. Processors run in registration
   *  order, each receiving the Blob from the previous step. Settings declared
   *  in `c.settings` appear as a collapsible section in the Export panel. */
  registerExportProcessor(c: ExportProcessorContribution): void;
  /** Contribute a filename template. Built-in variables are resolved by core;
   *  the template appears in the Export panel's filename template picker. */
  registerFilenameTemplate(c: FilenameTemplateContribution): void;
  /** Persisted per-extension key/value settings. */
  settings: {
    get<T>(key: string, fallback: T): T;
    set(key: string, value: unknown): void;
    /** Fires when any of this extension's settings change (any window). */
    onChange(cb: (key: string, value: unknown) => void): () => void;
  };
  /** Reusable UI building blocks (Panel, Slider, Histogram, CurveEditor, Rating, Thumbnail). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  components: Record<string, ComponentType<any>>;
  /** Zustand hooks and the zustand `create` factory.
   *  useDevelopStore, useCatalogStore, useUIStore, useSettings,
   *  usePresetsStore, useKeybindings, useThemeStore, useLayoutStore,
   *  usePipelineStore, create. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stores: Record<string, any>;
  dock: { togglePanel(id: string): void };
  themes: { apply(id: string): void };
  layouts: { apply(id: string): void };
  pipelines: { apply(id: string): void };
  /** Open / close the Preferences dialog. */
  preferences: { open(): void; close(): void; toggle(): void };
  /** Navigate between app modules. */
  navigation: { goTo(module: "library" | "develop"): void };
  /** Read the current binding for any action id (built-in or extension). */
  keybindings: { getBinding(actionId: string): string };
}

export interface ExtensionModule {
  activate(api: SafelightAPI): void;
  deactivate?(): void;
}

declare global {
  interface Window {
    /** Extension API (also handy in the devtools console). */
    safelight?: SafelightAPI;
    /** Electron bridge; absent in the plain-browser dev build. */
    safelightNative?: {
      platform: string;
      versions: { electron: string; chrome: string };
      /** Returns the live version string from package.json (bypasses the Vite build-time constant). */
      appVersion(): Promise<string>;
      /** In-app updater — downloads and runs the platform asset, then quits. */
      updates: {
        /** Download and install the asset for `tag` from `repo`, then quit/relaunch. */
        install(repo: string, tag: string): Promise<void>;
      };
      /** GitHub Releases API proxy — runs in the main process to bypass the renderer CSP. */
      releases: {
        /** Fetch releases for `owner/repo`. Returns the raw GitHub API array. */
        fetch(repo: string): Promise<{ tag_name: string; html_url: string; body: string | null; draft: boolean }[]>;
      };
      plugins: {
        list(): Promise<ExtensionManifest[]>;
        /** Accepts "owner/repo", "owner/repo#ref", or a github.com URL. */
        install(spec: string): Promise<ExtensionManifest>;
        uninstall(id: string): Promise<void>;
        /** Search GitHub for official extensions (repos with `topic`). */
        search(query: string, topic: string): Promise<ExtensionSearchResult[]>;
      };
      /** Native file access by absolute path (path-based handle adapters). */
      fs?: {
        read(path: string): Promise<{ data: Uint8Array; mtimeMs: number; size: number }>;
        write(path: string, data: Uint8Array): Promise<void>;
        list(path: string): Promise<{ name: string; kind: "file" | "directory" }[]>;
        mkdir(path: string): Promise<void>;
        remove(path: string): Promise<void>;
        move(src: string, dest: string): Promise<void>;
        exists(path: string): Promise<boolean>;
        pickDirectory(): Promise<string | null>;
      };
    };
  }
}
