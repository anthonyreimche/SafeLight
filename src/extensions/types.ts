// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

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
  /** Reset this panel's values to their defaults. When set, right-clicking the
   *  panel's dock header offers "Reset to defaults". Should be a single
   *  undoable action. */
  onReset?: () => void;
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

/** Declarative settings, shown as the extension's section in Preferences ▸
 *  Extensions. Values are persisted per-extension and read back with
 *  api.settings.get(). The declarative `fields` are auto-rendered by the host
 *  (themed, searchable); supply `component` only for genuinely custom UI. */
export interface SettingsContribution {
  /** Section title; defaults to the extension's name. */
  title?: string;
  fields: SettingsField[];
  /** Sort position within the Extensions group (lower = higher up). Default 100. */
  order?: number;
  /** Escape hatch: render this instead of the declarative `fields`. Receives no
   *  props — read/write values via api.settings inside the component. */
  component?: ComponentType;
}

/** A repo found by the official-extension search (GitHub topic). */
export interface ExtensionSearchResult {
  /** "owner/repo" — also the install spec. */
  fullName: string;
  description: string | null;
  stars: number;
  updatedAt: string;
  /** GitHub repo topics — drive the store's category chips. */
  topics?: string[];
}

/** Curation lists from the trust registry repo, fetched + normalised (lowercased)
 *  in the Electron main process. `verified` is the human-reviewed allowlist;
 *  `repos`/`owners` are the banned kill-switch; `reason` maps a banned
 *  "owner/repo" or "owner" to a short explanation shown to the user. */
export interface TrustList {
  verified: string[];
  repos: string[];
  owners: string[];
  reason: Record<string, string>;
}

/** Normalised GitHub repo metadata for the Extensions store detail view.
 *  A subset of the GitHub repos API, shaped in the Electron main process. */
export interface ExtensionRepoMeta {
  fullName: string;
  description: string | null;
  stars: number;
  openIssues: number;
  updatedAt: string;
  license: string | null;
  topics: string[];
  homepage: string | null;
  htmlUrl: string;
  /** Branch to fetch the README and resolve relative asset links against. */
  defaultBranch: string;
  ownerLogin: string;
  ownerAvatarUrl: string | null;
  hasIssues: boolean;
  hasDiscussions: boolean;
  /** GitHub's social-preview card — a usable thumbnail with no manifest icon. */
  ogImageUrl: string;
}

/** safelight.json at the root of an extension repo. All fields beyond the core
 *  five (id/name/version/main) are optional and additive — older manifests load
 *  unchanged; the store simply shows richer detail when they're present. */
export interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  /** Entry ESM bundle, relative to the extension folder, e.g. "dist/index.js". */
  main: string;
  /** Icon URL (absolute, or relative to the repo's default branch). */
  icon?: string;
  /** Store categories, e.g. ["Panels", "Color"]. Preferred over repo topics. */
  categories?: string[];
  /** Free-form search keywords. */
  keywords?: string[];
  /** Project homepage / docs URL. */
  homepage?: string;
  /** Source repo as "owner/repo" — lets a custom-imported extension self-declare
   *  its repo so the detail view can show its README without a remembered source. */
  repository?: string;
  /** Screenshot URLs (absolute, or relative to the repo's default branch). */
  screenshots?: string[];
  /** SPDX license id, e.g. "MIT". */
  license?: string;
  /** Minimum SafeLight version required, e.g. "1.2.0". Blocks install below it. */
  minAppVersion?: string;
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

/** Runtime pixel data for a processing stage's declared texture (e.g. a baked
 *  3D-LUT atlas), supplied via api.setStageTexture. The renderer uploads it once
 *  per version change and binds it to the stage's sampler each frame — so the
 *  data can be swapped (a different film stock) without recompiling the shader. */
export interface StageTextureData {
  /** Tightly-packed pixels, row-major. rgba8/r8 → Uint8Array (4 / 1 bytes per
   *  texel); rgba16f/r16f → Float32Array (4 / 1 floats per texel), uploaded to a
   *  half-float texture (linear-filterable in WebGL2) for interpolatable data
   *  like LUTs and spectral tables. */
  data: Uint8Array | Float32Array;
  width: number;
  height: number;
  format: "rgba8" | "r8" | "rgba16f" | "r16f";
  /** Bump when `data` changes under the same key to force a GPU re-upload. */
  version: number;
}

/** Fixed processing phases. Order is enforced by the shader compiler.
 *  "geometry" runs first and is special: its GLSL operates on the mutable
 *  source-UV `vec2 srcUv` (after crop/transform/lens, before the image is
 *  sampled), so a stage can warp/displace the coordinate and have the entire
 *  downstream pipeline — source sampling, white balance, exposure, NR, masks —
 *  follow. Every other phase operates on a color (`lin` or `c`). */
export type ProcessingPhase =
  | "geometry"
  | "decode"
  | "noise-reduction"
  | "scene-linear"
  | "tone-map"
  | "display-adjust"
  | "effects"
  | "output-encode";

/** Ordered phase list for the shader compiler's sort. */
export const PROCESSING_PHASE_ORDER: ProcessingPhase[] = [
  "geometry",
  "decode",
  "noise-reduction",
  "scene-linear",
  "tone-map",
  "display-adjust",
  "effects",
  "output-encode",
];

/** One full-screen GPU pass run BEFORE the main develop draw. Passes ping-pong
 *  through framebuffers in source-UV space at source resolution, so iterative
 *  and neighbourhood algorithms (à trous wavelets, non-local means, separable
 *  blurs) that a single inline fragment can't express become possible.
 *
 *  Contract: the body mutates `vec3 c`, initialised to `readPrev(vUv)` — linear
 *  scene RGB sampled from the previous pass (or the source image for the first
 *  pass). Sample neighbours with `readPrev(uv)`. The final pass's output is
 *  exposed to the owning stage's inline `glsl` as `vec3 stageResult` (sampled at
 *  the current pixel). Engine-provided uniforms/helpers in every pass:
 *    uniform vec2 uTexel;      // 1.0 / passResolution
 *    uniform int  uPassIndex;  // current iteration, 0 .. uPassCount-1
 *    uniform int  uPassCount;  // this pass's `iterations`
 *    vec3 readPrev(vec2 uv);   // linear RGB of the previous pass at uv
 *    float luma(vec3); vec3 srgbToLinear(vec3); vec3 linearToSrgb(vec3);
 *  Pass `uniforms` share the owning stage's qualified-key namespace, so the same
 *  param (e.g. "{id}.lumaAmount") can drive both the pass and the inline glsl. */
export interface StagePass {
  glsl: string;
  helpers?: string;
  /** Ping-pong iterations; uPassIndex runs 0..iterations-1. Default 1. */
  iterations?: number;
  uniforms?: UniformDeclaration[];
}

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

  /** Optional pre-passes (see StagePass). Their final result is bound for this
   *  stage's inline `glsl` as `vec3 stageResult`. */
  passes?: StagePass[];

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
// Catalog lifecycle hooks (orchestrator)
// ---------------------------------------------------------------------------

/** Subscribe to catalog lifecycle events. Lets an extension own a side concern
 *  (e.g. XMP sidecars) without core knowing about it. All handlers are async and
 *  awaited; a throwing handler is logged and skipped so one extension can't break
 *  a save or an import. */
export interface CatalogHooksContribution {
  /** Globally unique, e.g. "my-ext.xmp". */
  id: string;
  /** Called for each newly discovered photo during a project scan. Return a
   *  partial CatalogPhoto to merge onto the record (e.g. rating/label/keywords
   *  read from a sidecar). Later handlers' fields win, matching the old
   *  single-XMP precedence over the SafeLight sidecar. */
  onPhotoImport?(ctx: {
    photo: import("@/catalog/types").CatalogPhoto;
    dir: FileSystemDirectoryHandle;
    fileName: string;
  }): Promise<Partial<import("@/catalog/types").CatalogPhoto> | void>;
  /** Called after one or more photos' metadata (rating/label/flag/keywords)
   *  is committed. `getEditState` lazily fetches a photo's edit stack. */
  onMetadataChange?(ctx: {
    photos: import("@/catalog/types").CatalogPhoto[];
    getEditState(id: string): Promise<import("@/catalog/types").EditState | null>;
  }): Promise<void>;
  /** Called after a develop edit is committed to history. */
  onEditCommit?(ctx: {
    photo: import("@/catalog/types").CatalogPhoto;
    editState: import("@/catalog/types").EditState;
  }): Promise<void>;
  /** Called when a photo is removed from the catalog. */
  onPhotoRemove?(ctx: {
    photo: import("@/catalog/types").CatalogPhoto;
    dir: FileSystemDirectoryHandle;
    fileName: string;
  }): Promise<void>;
}

// ---------------------------------------------------------------------------
// Preset importers
// ---------------------------------------------------------------------------

/** Teach the Presets panel to import preset files from other apps. The panel's
 *  Import picker offers each registered importer's file extensions; a matching
 *  file is routed to `parse`. */
export interface PresetImporterContribution {
  /** Globally unique, e.g. "my-ext.lightroom". */
  id: string;
  /** Shown in the import picker, e.g. "Lightroom preset (.xmp)". */
  label: string;
  /** File extensions handled, lowercase with leading dot, e.g. [".xmp"]. */
  extensions: string[];
  /** Parse a chosen file into a named set of develop params, or null if the
   *  file isn't a recognizable preset of this kind. */
  parse(file: File): Promise<{
    name: string;
    params: Partial<import("@/catalog/types").DevelopParams>;
  } | null>;
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

// ---------------------------------------------------------------------------
// Library grid filter predicates (generic — lets an extension narrow the grid
// beyond the built-in rating/flag/label filter, e.g. text / EXIF search)
// ---------------------------------------------------------------------------

/** A predicate applied as an extra AND step in the Library grid's
 *  visible-photos derivation. Core stays blind to *why* a photo is hidden — the
 *  extension owns the matching logic and re-registers (same id, fresh `test`)
 *  whenever its query changes. */
export interface GridFilterContribution {
  /** Globally unique, e.g. "my-ext.search". */
  id: string;
  /** Return false to hide the photo from the grid (and from culling nav). */
  test(photo: import("@/catalog/types").CatalogPhoto): boolean;
  /** Invoked by the Library "Clear filters" action so search clears too. */
  onClear?(): void;
}

// ---------------------------------------------------------------------------
// Library sort orders (generic — lets an extension add sort options to the
// Library toolbar's sort dropdown, e.g. by camera / lens)
// ---------------------------------------------------------------------------

/** An extra sort order offered in the Library sort dropdown. The comparator is
 *  ascending; the toolbar's direction toggle flips it. */
export interface LibrarySortContribution {
  /** Globally unique, also the persisted sort id, e.g. "my-ext.camera". */
  id: string;
  /** Shown in the sort dropdown. */
  label: string;
  /** Ascending comparator over two photos (return <0, 0, >0). */
  compare(
    a: import("@/catalog/types").CatalogPhoto,
    b: import("@/catalog/types").CatalogPhoto,
  ): number;
}

// ---------------------------------------------------------------------------
// UI slots (generic named mount points in core chrome)
// ---------------------------------------------------------------------------

/** Named regions of core UI an extension may render into. "library-subbar" is a
 *  full-width bar directly below the Library toolbar (only rendered when an
 *  extension contributes to it). "develop-toolbar" sits in the Develop status
 *  bar (left of the zoom controls); "develop-canvas-overlay" is a click-through
 *  layer covering the Develop canvas, aligned via `api.develop`. */
export type SlotName =
  | "library-toolbar"
  | "library-subbar"
  | "develop-toolbar"
  | "develop-canvas-overlay"
  // Inside the Detail panel's Noise Reduction area. When an extension contributes
  // here (e.g. an alternative denoise method), the panel renders the slot in place
  // of the built-in NR sliders.
  | "develop-detail";

export interface SlotContribution {
  /** Globally unique, e.g. "my-ext.search-bar". */
  id: string;
  slot: SlotName;
  component: ComponentType;
  /** Sort position within the slot (lower = earlier). Default 100. */
  order?: number;
}

// ---------------------------------------------------------------------------
// Cursors (generic — a shared cursor vocabulary + custom cursor images)
// ---------------------------------------------------------------------------

/** A named cursor an extension contributes. Supply either `css` (a native CSS
 *  cursor value, e.g. "crosshair") OR `image` (inline `<svg…>` markup or an
 *  image/data URL) with an optional hotspot. Reference it by `id` from
 *  `api.develop.setCanvasCursor`. Note: image cursors cap at ~128×128 px and an
 *  image URL is subject to the app CSP (inline SVG is encoded to a data URL and
 *  always allowed). The `fallback` keyword is shown if the image can't load. */
export interface CursorContribution {
  /** Globally unique, e.g. "my-ext.measure". */
  id: string;
  css?: string;
  image?: string;
  hotspotX?: number;
  hotspotY?: number;
  fallback?: string;
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
   *  into the single-pass develop shader at registration time. Re-registering
   *  the same id replaces it (and its params); disabling the extension removes
   *  it. The shader recompiles on any such change. */
  registerProcessingStage(c: ProcessingStageContribution): void;
  /** Remove a single processing stage this extension registered (by id), e.g.
   *  to turn a feature off without disabling the whole extension. */
  unregisterProcessingStage(id: string): void;
  /** Supply (or clear, with null) the pixel data for a processing stage's
   *  declared texture — e.g. a baked LUT atlas. Bound to the stage's sampler
   *  (named by the texture's `key`) on every frame; re-call with a bumped
   *  `version` to swap the data without recompiling the shader. */
  setStageTexture(
    stageId: string,
    key: string,
    tex: StageTextureData | null,
  ): void;
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
  /** Register a lens profile that overrides or supplements the built-in Lensfun
   *  database. Extensions with priority > 0 are checked before Lensfun. */
  registerLensProfile(c: import("@/lens-profiles/types").LensProfileContribution): void;
  /** Subscribe to catalog lifecycle events (photo import / metadata change /
   *  edit commit / photo remove). Lets an extension own a side concern such as
   *  XMP sidecars without core depending on it. */
  registerCatalogHooks(c: CatalogHooksContribution): void;
  /** Teach the Presets panel to import preset files from other applications. */
  registerPresetImporter(c: PresetImporterContribution): void;
  /** Contribute a predicate that further narrows the Library grid (e.g. text or
   *  EXIF search). Re-register with the same id to update the predicate; the
   *  grid and culling navigation re-derive against it. */
  registerGridFilter(c: GridFilterContribution): void;
  /** Render a component into a named core UI slot (e.g. the Library toolbar). */
  registerSlot(c: SlotContribution): void;
  /** Register a named cursor (a shared semantic token or a custom image) usable
   *  via api.develop.setCanvasCursor. Re-registering the same id replaces it. */
  registerCursor(c: CursorContribution): void;
  /** Add a sort order to the Library toolbar's sort dropdown. */
  registerLibrarySort(c: LibrarySortContribution): void;
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
  /** Open / close the Preferences dialog. `open` may take a section id (a core
   *  section's id or an extension id) to deep-link straight to that section. */
  preferences: { open(sectionId?: string): void; close(): void; toggle(): void };
  /** Navigate between app modules. */
  navigation: { goTo(module: "library" | "develop"): void };
  /** Read the current binding for any action id (built-in or extension). */
  keybindings: { getBinding(actionId: string): string };
  /** Develop-canvas integration for overlays (e.g. before/after comparison).
   *  `useDevelopOverlay` returns the displayed image rect + a change nonce
   *  (call from a "develop-canvas-overlay" component); `captureFrame` renders an
   *  off-screen frame with arbitrary params, aligned to the live view. */
  develop: {
    useDevelopOverlay(): {
      rect: { x: number; y: number; w: number; h: number } | null;
      nonce: number;
    };
    captureFrame(
      params: import("@/catalog/types").DevelopParams,
    ): Promise<ImageBitmap>;
    /** Drive the Develop-canvas cursor while a tool is active. Pass a registered
     *  cursor id (built-in token or one from registerCursor), an inline spec, or
     *  a raw CSS value; pass null to clear. Higher `priority` wins when several
     *  tools request at once (default 10). Returns a release fn — call it (or
     *  pass null) on tool deactivate; the request is also swept if the extension
     *  unloads. The built-in zoom/pan/pick cursors take over during an active
     *  drag or pick, so a passive tool cursor never fights a live gesture. */
    setCanvasCursor(
      cursor: string | CursorContribution | null,
      opts?: { priority?: number },
    ): () => void;
    /** Persist (or, with null, delete) an opaque binary blob for the currently
     *  loaded Develop photo. The key is namespaced per extension. Stored as a
     *  sidecar outside catalog.json so large payloads (e.g. a warp displacement
     *  field) don't bloat the whole-file JSON rewrite. Core treats the bytes as
     *  opaque — the extension owns the format and load/save timing. */
    putPhotoData(key: string, data: Uint8Array | null): void;
    /** Read the opaque blob previously stored for the current Develop photo
     *  under `key`, or null if none exists (or no photo/project is open). */
    getPhotoData(key: string): Promise<Uint8Array | null>;
  };
}

export interface ExtensionModule {
  activate(api: SafelightAPI): void;
  deactivate?(): void;
}

/** Raw filesystem access by absolute path. Privileged: handed to core exactly
 *  once at boot via claimPrivileged() and never left on the page global, because
 *  extension code shares the renderer realm and could otherwise read/write/delete
 *  any file. Backs the path-based handle adapters (src/project/native-fs.ts). */
export interface NativeFsBridge {
  read(path: string): Promise<{ data: Uint8Array; mtimeMs: number; size: number }>;
  write(path: string, data: Uint8Array): Promise<void>;
  list(path: string): Promise<{ name: string; kind: "file" | "directory" }[]>;
  mkdir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  move(src: string, dest: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  pickDirectory(): Promise<string | null>;
}

/** In-app updater. Privileged: install() fetches and runs a release installer
 *  (arbitrary code execution), so it's claimed at boot rather than exposed. */
export interface NativeUpdatesBridge {
  /** Download and install the asset for `tag` from `repo`, then quit/relaunch. */
  install(repo: string, tag: string): Promise<void>;
}

/** The one-shot privileged bundle returned by claimPrivileged(). */
export interface PrivilegedBridge {
  fs: NativeFsBridge;
  updates: NativeUpdatesBridge;
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
      /** GitHub Releases API proxy — runs in the main process to bypass the renderer CSP. */
      releases: {
        /** Fetch releases for `owner/repo`. Returns the raw GitHub API array. */
        fetch(repo: string): Promise<{ tag_name: string; html_url: string; body: string | null; draft: boolean }[]>;
      };
      /** GitHub repo metadata + README proxy for the Extensions store detail view.
       *  Optional: absent in the plain-browser build and older Electron builds. */
      github?: {
        /** Normalised repo metadata for "owner/repo". */
        repoMeta(repo: string): Promise<ExtensionRepoMeta>;
        /** Raw README text for "owner/repo" at `ref`, or null if none exists. */
        readme(repo: string, ref?: string): Promise<string | null>;
        /** The repo's real og:image URL — a custom social preview when the owner
         *  uploaded one, else GitHub's auto-generated card. Never rejects. */
        ogImage(repo: string): Promise<string>;
      };
      plugins: {
        list(): Promise<ExtensionManifest[]>;
        /** Accepts "owner/repo", "owner/repo#ref", or a github.com URL. */
        install(spec: string): Promise<ExtensionManifest>;
        uninstall(id: string): Promise<void>;
        /** Search GitHub for official extensions (repos with `topic`). Results
         *  are cached per (topic, query); pass `force` to bypass the cache. */
        search(
          query: string,
          topic: string,
          force?: boolean,
        ): Promise<ExtensionSearchResult[]>;
        /** The `version` from the repo's root safelight.json on its default
         *  branch, or null. Lets the updater detect a pushed version bump
         *  without a GitHub Release. Optional: absent in older Electron builds. */
        latestVersion?(repo: string): Promise<string | null>;
        /** Verified-allowlist + banned-kill-switch lists from the trust
         *  registry, cached in the main process. Optional: absent in older
         *  Electron builds (callers then treat everything as unverified). */
        trustList?(force?: boolean): Promise<TrustList>;
      };
      /** Renderer-side control of the window's Chrome DevTools. Backs the
       *  Developer Tools extension's Native tab. */
      devtools?: {
        open(mode?: "right" | "bottom" | "undocked" | "detach"): Promise<void>;
        close(): Promise<void>;
        toggle(): Promise<void>;
        isOpen(): Promise<boolean>;
        /** Reload the renderer. `hard` ignores the HTTP cache. */
        reload(hard?: boolean): Promise<void>;
      };
      /** Main-process diagnostics for the Developer Tools System / Native tabs. */
      diagnostics?: {
        /** chromium GPU feature status (app.getGPUFeatureStatus()). */
        gpuInfo(): Promise<Record<string, string>>;
        /** Per-process CPU / memory metrics (app.getAppMetrics()). */
        metrics(): Promise<
          {
            type: string;
            pid: number;
            cpuPercent: number;
            memoryMB: number;
          }[]
        >;
      };
      /** Recolor the native window-controls overlay (Windows/Linux) to follow
       *  the active theme; no-op on macOS. */
      titlebar?: {
        setOverlay(color: string, symbolColor: string): Promise<void>;
      };
      /** One-shot handover of the privileged fs + update-installer surface.
       *  Returns the bundle on the first call (core, at boot) and null after, so
       *  extension code — which shares the renderer realm — can never acquire it.
       *  Optional: absent in the plain-browser build and older Electron builds. */
      claimPrivileged?(): PrivilegedBridge | null;
    };
  }
}
