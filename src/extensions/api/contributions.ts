// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Extension contribution shapes: what a plugin registers through the SafelightAPI.

import type { ComponentType } from "react";
import type { BrushDab, ModuleId } from "@/catalog/types";

export type { ModuleId };

/** Stack a panel renders in by default ("none" = only via the View menu).
 *  Stacks are composite panels (e.g. "Edit") that host many small panels. */
export type PanelSlot = "develop-right" | "develop-left" | "none";

/** Default placement in a module's dock layout (used when the user has no
 *  saved layout for that module yet, and where View-menu/shortcut toggles
 *  reopen the panel). */
export interface PanelDockDefault {
  module: ModuleId;
  /** "left"/"right" are vertical columns beside the main view (sized by
   *  `width`); "bottom" is a full-width horizontal strip under it (sized by
   *  `height`). */
  direction: "left" | "right" | "bottom";
  /** Stacking order within the direction (lower = closer to main). */
  order?: number;
  /** Side-rail column width. */
  width?: number;
  /** Bottom-rail strip height. */
  height?: number;
}

export interface PanelContribution {
  /** Globally unique, e.g. "core.histogram" or "my-ext.fancy-curves". */
  id: string;
  title: string;
  /** Rendered inside a dock panel. */
  component: ComponentType;
  /** @deprecated Ignored: panels live in the dock. Kept so older extensions still type-check. */
  slot?: PanelSlot;
  /** Sort position (lower = higher up). Default 100. */
  order?: number;
  defaultDock?: PanelDockDefault;
  /** Old panel ids this panel takes the place of in saved layouts, e.g. a panel
   *  that moved here from another extension. Wherever a layout names one of
   *  them, and no registered panel uses that id any more, the dock shows this
   *  panel in its spot. */
  replaces?: readonly string[];
  /** Stretch to the remaining rail height instead of rendering at natural
   *  height; the panel body must size to 100% and manage its own scrolling.
   *  One fill panel per side rail stretches (the rail stops scrolling while it
   *  is expanded); bottom-rail panels always fill. */
  fill?: boolean;
  /** Opt in to bottom rails — the full-width horizontal strip under the main
   *  view. Panels are vertical columns unless they say otherwise, so the dock
   *  offers a bottom drop target only for panels that lay out horizontally;
   *  everything else can only be docked left, right or floated. Implied by a
   *  `defaultDock.direction` of "bottom". */
  allowBottomDock?: boolean;
  /** Reset this panel's values to their defaults. When set, right-clicking the
   *  panel's dock header offers "Reset to defaults". Should be a single
   *  undoable action. */
  onReset?: () => void;
  /** The develop params this panel's effect is made of. While the panel's
   *  preview-off eye is held, Develop draws the photo with them at their
   *  defaults; the stored edit is untouched. List every key whose change the
   *  user would expect the eye to hide, including another tool's that is
   *  meaningless without yours (Transform lists the crop, which is authored in
   *  the transformed frame). The extension's stage params stay as they are;
   *  a panel without `owns` previews off by dropping them all. Keys that
   *  aren't develop params are dropped at registration, with a warning. Older
   *  builds ignore it. */
  owns?: readonly (keyof import("@/catalog/types").DevelopParams)[];
  /** A control rendered in the dock header to the left of the title (e.g. the
   *  per-panel bypass eye). Must handle its own clicks; the header swallows
   *  pointerdowns on buttons so it won't start a drag. */
  headerAccessory?: ComponentType;
  /** When present, this panel can be instantiated per mask: it appears in the
   *  Masking panel's "+ Adjust" menu and each mask that adds it renders its own
   *  instance of `mask.component`. */
  mask?: MaskPanelContribution;
}

/** Per-mask instance of a panel: a compact variant rendered inside the Masking
 *  panel's Adjust tab. The component reads and writes the mask it belongs to
 *  through the mask scope (useMaskScope in core panels, api.develop.useMaskScope
 *  or api.develop.useParamScope for extensions) — never the global develop
 *  params. Core adjustments (scope.adj / hsl / toneCurve) go to the GPU's
 *  local-adjustment path; extension params (scope.setParams) to the mask's bag,
 *  where each maskable stage they belong to runs once more inside the mask
 *  (ProcessingStageContribution.mask). A stage that isn't maskable keeps its
 *  values there unused. */
export interface MaskPanelContribution {
  component: ComponentType;
  /** Sort position among a mask's sub-panels (lower = higher up). Default 100. */
  order?: number;
  /** The mask values this sub-panel edits: MaskAdjustments keys ("exposure"),
   *  the structured blocks ("hsl", "toneCurve"), or qualified extension param
   *  keys ("my-ext.stage.amount"). Seeded with defaults when the sub-panel is
   *  added to a mask, cleared when it's removed, and restored to defaults by
   *  the mask's Reset action. List every key the component writes: a mask runs
   *  a stage's copy while its bag holds any of the stage's keys, so one left
   *  out would keep the copy running after the sub-panel is removed. */
  owns: readonly string[];
}

/** One dock rail in a layout preset. Panels listed top→bottom (side rails)
 *  or left→right (bottom rails). */
export interface LayoutRail {
  side: "left" | "right" | "bottom";
  /** Side rails: column width. */
  width?: number;
  /** Bottom rails: strip height. */
  height?: number;
  /** Panel ids, e.g. "core.histogram". Unknown ids render a placeholder. */
  panels: string[];
}

/** Where a dock panel is currently hosted (see dock.usePanelPlacement). */
export interface PanelPlacement {
  side: "left" | "right" | "bottom" | "float";
}

export interface ModuleLayoutDef {
  rails: LayoutRail[];
  /** Panels that start as floating windows. */
  floating?: Record<string, { x: number; y: number; width: number }>;
  /** Panels that start collapsed to their header. */
  collapsed?: string[];
}

/** A named dock arrangement selectable from the Layout menu. Modules omitted
 *  from `modules` fall back to their defaults: a registered module's
 *  `defaultLayout`, else the registry's defaultDock placements, so a layout
 *  with no `modules` at all means "the built-in defaults". */
export interface LayoutContribution {
  id: string;
  name: string;
  /** Shown as a tooltip in the Layout menu. */
  description?: string;
  /** Keyed by module id ("library", "develop", or a registered module). */
  modules?: Partial<Record<string, ModuleLayoutDef>>;
}

/** A top-level module beside Library and Develop. Registering one adds its tab
 *  to the strip, lets it pop out into its own window, gives it its own dock
 *  layout, and makes its id valid for `navigation.goTo`. */
export interface ModuleContribution {
  /** The tab key, the `?detached=` key, the dock-layout key and the value
   *  `navigation.goTo` accepts, e.g. "map". Lower-case letters, digits, ".",
   *  "_" and "-", starting with a letter or digit; any other id is refused.
   *  "library" and "develop" are kept for the official Library and Develop
   *  extensions. */
  id: string;
  /** Tab label, e.g. "Map"; also names its pop-out window. */
  label: string;
  /** The main view. Core renders it inside the app shell (top bar, dock rails,
   *  optional status bar) in the main dock area; it must fill its container.
   *  Mounted only while the module is active in that window, so every tab
   *  switch unmounts it. A render error in it (or in `statusBar`) is shown in
   *  its place; the rest of the window keeps working. */
  component: ComponentType;
  /** Tab position after Library and Develop, which always lead (lower =
   *  further left). Default 100. */
  order?: number;
  /** Rails and floating panels to seed the first time the user opens the
   *  module, and what a layout preset without an entry for it resolves to. May
   *  name core panels ("core.folders", "core.filters", "core.info"); panels
   *  not registered at the time (a core panel the user disabled) are left
   *  out. Without it, panels whose `defaultDock.module` is this id are seeded,
   *  as for the built-ins. */
  defaultLayout?: ModuleLayoutDef;
  /** Content for the shell's footer status bar. */
  statusBar?: ComponentType;
}

export interface ThemeContribution {
  id: string;
  name: string;
  colorScheme?: "light" | "dark";
  /** CSS custom properties applied to :root, e.g. { "--color-surface-0": "#fff" }. */
  vars: Record<string, string>;
  /** Ask the window for a system-drawn backdrop (Windows 11 22H2+ and macOS;
   *  elsewhere, and in software rendering, the window stays opaque). The
   *  theme's surface colours should then be translucent (rgba) to show it.
   *  Ignored while Reduce transparency is on. The Develop canvas surround
   *  stays opaque either way. */
  window?: { material: "acrylic" | "mica" };
}

/** A render pipeline (scene-linear → display transform). Users pick one per
 *  photo from the display transform menu in Develop's bottom bar; Preferences
 *  ▸ Rendering sets the default for photos without a pick. The GLSL must define
 *    vec3 pipelineToDisplay(vec3 lin)
 *  mapping scene-linear RGB (sRGB primaries, HDR — values may exceed 1.0) to
 *  display-encoded output. A channel of `lin` can also be negative: colours
 *  outside the sRGB primaries reach it that way from RAW sources, and colour
 *  noise reduction can leave small excursions below zero on any source, so
 *  guard a channel before taking its log, pow or sqrt. Helpers available:
 *  luma(), srgbToLinear(), linearToSrgb(), linearToSrgbU(). linearToSrgb()
 *  clips to 0..1; linearToSrgbU() keeps values above 1.0 (clamps below 0);
 *  slEncodePerceptual() (v2 photos) also keeps negatives, by sign. */
export interface PipelineContribution {
  id: string;
  name: string;
  /** Shown under the picker when active. */
  description?: string;
  /** Body defining pipelineToDisplay; omit to reuse the built-in transform.
   *  Return the display-encoded (sRGB) value: downstream display-space edits
   *  operate on it, and the core converts it once at the end for the selected
   *  output space (Display-P3 / Adobe RGB / ProPhoto) — transforms must NOT
   *  bake in their own output-space handling. */
  glsl?: string;
  /** The transform brings its own look (AgX, ACES, …): Safelight drops its
   *  default baseline tone (the camera-style lift applied to RAW sources in
   *  linear light), so the transform is the profile. It drops the baseline
   *  only: the core filmic shoulder still runs unless `skipToneShoulder` is
   *  set. On process version 2 photos that includes the camera baseline after
   *  channel reconstruction (the refit and the camera maker's exposure offset). */
  skipBaseCurve?: boolean;
  /** The transform brings its own highlight roll-off: the core filmic
   *  shoulder (which compresses luminance above 0.85 at Highlights 0) is
   *  bypassed, so the transform receives exposure-scaled scene-linear values
   *  with their headroom. Highlights still works, globally and in masks: a
   *  negative value blends in the core recovery in proportion to the slider;
   *  a positive value lifts values up to white and leaves values above white
   *  untouched. Independent of `skipBaseCurve`; set both for true scene-linear
   *  input. Photos at process version 1 ignore it and keep the shoulder.
   *  Safelight builds from before this flag ignore it and keep the
   *  shoulder, so set the manifest's `minAppVersion` if the transform relies
   *  on it. */
  skipToneShoulder?: boolean;
  /** Per-photo settings, stored in the photo's paramBag as "{id}.{key}", so
   *  presets, Copy/Paste and undo carry them like stage params. Without
   *  `derive` each is also a GLSL uniform named `key` in `glsl` and `helpers`,
   *  bound from the bag every frame (its `default` while the bag holds no
   *  value of its type). With `derive` they are values only. float, int and
   *  bool only. The bag is shared with processing stages, so a transform's id
   *  must not also be a stage's id. Without `derive`, keys are rewritten
   *  wherever they appear as identifiers in `glsl` and `helpers`: don't reuse
   *  one as a local name. `params`, `helpers` and `derive` need Safelight
   *  3.1.0: older builds don't know them, so the transform fails to compile
   *  there and renders with the built-in. Set the manifest's `minAppVersion`
   *  to "3.1.0". */
  params?: UniformDeclaration[];
  /** GLSL functions `glsl` calls, namespaced like a stage's helpers. Needs
   *  Safelight 3.1.0, like `params`. */
  helpers?: string;
  /** Computes the GLSL uniforms `glsl` and `helpers` read from `params`, on
   *  the main thread, wherever a photo's bag is handed to a renderer. The
   *  results are never stored. With `derive` the rewritten identifiers are
   *  its uniforms' keys, and the params are values only. Needs Safelight
   *  3.1.0, like `params`. */
  derive?: TransformDerive;
}

export interface TransformDerive {
  /** The uniforms `glsl` and `helpers` read: any GlslType but mat4 and
   *  sampler2D. Their keys, not the params', are rewritten wherever they
   *  appear as identifiers in `glsl` and `helpers`: don't reuse one as a
   *  local name. Never stored in the bag. */
  uniforms: UniformDeclaration[];
  /** Pure and synchronous. `values` holds every param by key: the bag's
   *  value when it fits the param's type, else its default. Returns a value
   *  for each declared uniform (matrices as 9 numbers, column-major); one
   *  that is missing or doesn't fit binds the uniform's default. A throw
   *  binds every default and logs one warning. */
  fn(values: Readonly<Record<string, UniformValue>>): Record<string, UniformValue>;
}

export interface SliderIconContribution {
  /** Referenced by Slider's `icon` prop, e.g. "core.exposure". */
  id: string;
  /** Inline SVG markup, rendered at 12×12 beside the slider label. */
  svg: string;
}

/** One field in an extension's settings dialogue. */
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
  /** Extra synonyms that match this section in the Preferences search (e.g. a
   *  custom-component section whose controls aren't declarative `fields`). */
  keywords?: string[];
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

/** What an export processor is told about the export it runs in. */
export interface ExportProcessorContext {
  /** The export's long-edge setting in pixels, `null` for original size. It
   *  caps the source before the crop, so a cropped photo is delivered smaller
   *  than this. A processor that renders the photo again through
   *  `api.export.renderPhotos` with the same `longEdge` gets the delivered
   *  file's pixel grid, to within a pixel when the second render is served
   *  from a different decode of the source (a cache entry written in
   *  between). */
  longEdge: number | null;
  /** The output this export asks for: format, quality, long edge, bit depth,
   *  colour space, output sharpening, metadata and location, as the export
   *  reads them. Delivery and the other processors' settings are not part of
   *  it. An optional field left out takes its default (sRGB, no sharpening,
   *  8-bit, no metadata). Frozen: changing it changes nothing. Needs Safelight
   *  3.2.0. */
  settings: Readonly<import("./export").ExportOutput>;
}

/** An export's pixels before encoding: RGBA, top-down, encoded for the
 *  export's colour space, 0..65535 (an 8-bit export's value is this divided by
 *  257). */
export interface ExportFrame {
  data: Uint16Array;
  width: number;
  height: number;
  colorSpace: import("@/rendering/color-space").ColorSpaceId;
  /** The ICC profile the file will embed, or null (sRGB). */
  icc: Uint8Array | null;
  /** What the frame will be quantized to. */
  bitDepth: 8 | 16;
}

/** A step called for each exported image: on its pixels before encoding
 *  (`processPixels`), on the encoded Blob (`process`), or both; a processor
 *  declares at least one. Processors run in registration order, every
 *  `processPixels` before any `process`, each receiving what the previous step
 *  returned. */
export interface ExportProcessorContribution {
  /** Globally unique, e.g. "my-ext.watermark". */
  id: string;
  /** Shown as a collapsible section header in the Export panel. */
  label: string;
  /** Optional settings that appear in the Export panel UI. */
  settings?: ExportProcessorField[];
  /**
   * Called once per exported image, after it is encoded.
   * @param blob    The encoded image Blob from the previous pipeline stage.
   * @param photo   The CatalogPhoto record (filename, exif, rating, …).
   * @param settings  Current values of the declared settings fields.
   * @param context   The export's own settings that a processor may need.
   * @returns       A new Blob, or the original if no modification was needed.
   */
  process?(
    blob: Blob,
    photo: import("@/catalog/types").CatalogPhoto,
    settings: Record<string, unknown>,
    context: ExportProcessorContext,
  ): Promise<Blob>;
  /**
   * Called once per exported image with its pixels, after mapping and
   * sharpening, before quantization and encode. Change `frame.data` in place
   * and return nothing, or return a frame, which may change size (a mat). Only
   * the returned `data`, `width` and `height` are read. Needs Safelight 3.1.0:
   * older builds ignore it and require `process`.
   */
  processPixels?(
    frame: ExportFrame,
    photo: import("@/catalog/types").CatalogPhoto,
    settings: Record<string, unknown>,
    context: ExportProcessorContext,
  ): Promise<ExportFrame | void>;
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
   * {filename} base name without extension, {ext} the delivered file's
   * extension (a processor's output type when it changed it),
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
  /** Makes the uniform an array of this many (1 to 64) scalars or vectors,
   *  e.g. `float uBandGain[8]`; its value and default are all their numbers,
   *  flattened. Not for matrices or samplers. */
  length?: number;
  default: number | number[] | boolean;
  range?: { min: number; max: number; step?: number };
  label?: string;
  /** For Safelight's own stages: the name of the constant (ProcessingStageContribution
   *  `defines`) the array is declared with, e.g. `uSpotA[MAX_SPOTS]`. `length`
   *  is still its size. */
  size?: string;
  /** For a `mat3` of Safelight's own stages: the value `derive` returns is an
   *  ImageSpaceMatrix, which core finishes for the image's aspect wherever the
   *  image is drawn. */
  space?: "image";
}

/** A matrix a geometry stage derives, row-major: `normalized` acts on image
 *  coordinates (0 to 1), then `square` in the image's square space (centred,
 *  x scaled by the aspect), where a rotation keeps its proportions. Core binds
 *  Ainv · square · A · normalized, A being the square basis. */
export interface ImageSpaceMatrix {
  square: number[];
  normalized: number[];
}

/** A value a uniform binds: a number for float and int, a boolean for bool,
 *  and an array for the vector and matrix types (matrices column-major). */
export type UniformValue = number | number[] | boolean;

/** A per-pixel value one stage hands to stages after it in the same draw (see
 *  ProcessingStageContribution.produces / `consumes`). */
export interface InterStageVariable {
  /** Emitted as the global `isv_{name}` in every program whose stage set holds
   *  its producer. Letters, digits and underscores, starting with a letter,
   *  and no `__` (GLSL reserves it). Names are global across extensions:
   *  prefix them with your own. */
  name: string;
  glslType: "float" | "vec2" | "vec3" | "vec4";
  /** GLSL expression assigned to `isv_{name}` right after the producing
   *  stage's glsl, inside its block, so it may name the stage's locals,
   *  uniforms, helpers and stageResult. Omit to assign `isv_{name}` in the
   *  glsl itself; an empty or blank string is refused. */
  producer?: string;
}

/** A pass draw count read from the param bag each frame (StagePass.iterations). */
export interface PassDrawCount {
  /** An int or float uniform the stage declares, inline or in this pass. Its
   *  bag value `{stageId}.{key}`, or its default while the bag holds no finite
   *  number, is rounded and clamped to [0, max]. */
  key: string;
  /** The most draws a frame may take: an integer from 1 to 1024. */
  max: number;
}

export interface TextureRequirement {
  /** Parameter bag key for the texture data. */
  key: string;
  /** "lut" / "dynamic": pixel data supplied through api.setStageTexture (one
   *  global bag, not per photo). "coverage": the photo's paramBag value at
   *  "{stageId}.{key}" is a BrushDab[] (the shape core masks use, source-UV,
   *  radius in image-height units); the renderer bakes it into brush coverage
   *  per render, so it persists, undoes and exports like any edit, and the
   *  stage's inline glsl / helpers read it as `float key(vec2 uv)` (0..1 at
   *  source-UV; not available inside passes). Coverage shares the brush
   *  atlas's four channels with the photo's own brush masks. "photo": filled
   *  per frame by the stage's `derive`, which returns its StageTextureData
   *  under the texture's key (a curve's lookup table); for Safelight's own
   *  stages only. "atlas": brush coverage of the stage's own, for Safelight's
   *  own stages: `derive` returns up to four `{ id, dabs }` items (BrushDab[],
   *  as a coverage texture's) under the texture's key, and the renderer bakes
   *  them into the four channels of this texture, in order, so the first item
   *  is channel 0. Needs Safelight 3.2.0. "paint": coloured brush strokes on
   *  up to MAX_PAINT_LAYERS layers. The photo's paramBag value at
   *  "{stageId}.{key}" is a PaintLayer[]; the renderer bakes each layer into a
   *  tile of one texture per render, and the stage's inline glsl / helpers read
   *  it as `vec4 key(int layer, vec2 uv)`: the layer's straight colour (rgb,
   *  display-encoded) and coverage (a) at source-UV, vec4(0) for a layer that
   *  isn't painted. Not available inside passes. One per stage; it takes a
   *  stage texture unit, as "lut" and "dynamic" do. */
  kind: "lut" | "coverage" | "dynamic" | "photo" | "atlas" | "paint";
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

/** Fixed processing phases. The order is set in stage-order.ts, and
 *  stage-injection.ts decides where each phase's GLSL goes.
 *  "geometry" runs first and is special: its GLSL operates on the mutable
 *  source-UV `vec2 srcUv` (after crop/transform/lens, before the image is
 *  sampled), so a stage can warp/displace the coordinate and have the entire
 *  downstream pipeline — source sampling, white balance, exposure, NR, masks —
 *  follow. Every other phase operates on a colour (`lin` or `c`).
 *
 *  "decode" runs on the linear colour after the baseline tone (applied to RAW
 *  sources unless the display transform skips it), at the same injection
 *  point as "noise-reduction": before core NR. Stage prepasses read the source
 *  through the same linearization and baseline (`toLin`), so no extension hook
 *  sees the decode before the baseline.
 *
 *  "scene-linear" and "tone-map" run on `lin` after the core linear edits.
 *  Under a display transform that sets `skipToneShoulder` they also receive
 *  the headroom above 1.0 that the core shoulder otherwise compresses.
 *
 *  "display-adjust", "effects" and "output-encode" run on the display-encoded
 *  `c`, in that order: after Sharpening and the masks' display adjustments,
 *  before the core's own output encoding and its final clip to [0, 1].
 *
 *  Scene-linear `lin` can hold negative components: colours outside the sRGB
 *  primaries arrive that way from RAW sources, and colour noise reduction can
 *  leave small excursions below zero on any source. A stage that takes the
 *  log, pow or sqrt of a channel must guard it. */
export type ProcessingPhase =
  | "geometry"
  | "decode"
  | "noise-reduction"
  | "scene-linear"
  | "tone-map"
  | "display-adjust"
  | "effects"
  | "output-encode";

/** Ordered phase list: the order stage-order.ts sorts stages by. */
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

/** The phases a stage can be masked in (ProcessingStageContribution.mask):
 *  those that run after mask coverage is known. Geometry, decode and noise
 *  reduction run before it. */
export const MASKABLE_PHASES: readonly ProcessingPhase[] = [
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
 *  Contract: the body mutates `vec3 c`, initialized to the pixel's own texel —
 *  fetched exactly from the previous draw's output, or on the first draw
 *  `readPrev(vUv)` of the stage's input: the decoded
 *  source linearized for `reads: "source"`, the image as edited up to the stage
 *  for `reads: "current"`, in the stage's declared `space` either way. With no
 *  `space`, the source reads as linear Rec.709 and the current image as the
 *  values the stage's inline `glsl` receives. Sample neighbours with
 *  `readPrev(uv)`. The final pass's output is exposed to the owning stage's
 *  inline `glsl` as `vec3 stageResult` (sampled at the current pixel).
 *  Engine-provided uniforms/helpers in every pass:
 *    uniform vec2 uTexel;      // 1.0 / passResolution
 *    uniform int  uPassIndex;  // current iteration, 0 .. uPassCount-1
 *    uniform int  uPassCount;  // this pass's resolved draw count (see `iterations`)
 *    uniform vec2 uSourceSize; // the decoded source's size in pixels before Safelight
 *                              // capped it to the Develop render resolution: a RAW's
 *                              // frame as decoded, a bitmap's own size; for a cached
 *                              // preview standing in for the photo, the preview's size.
 *                              // A radius in source pixels scales to pass texels by
 *                              // max(1.0 / uTexel.x, 1.0 / uTexel.y) / max(uSourceSize.x, uSourceSize.y).
 *    uniform bool uSrcLinear;  // true while the source is a scene-linear float decode
 *                              // (a RAW); false for camera-rendered bitmaps, photos read
 *                              // through an input profile (registerInputProfiles) and
 *                              // the camera preview shown before the RAW decodes
 *    vec3 readPrev(vec2 uv);   // previous pass at uv; first pass: the stage's input
 *    vec3 readSource(vec2 uv); // the decoded source at uv, as a `reads: "source"` stage's
 *                              // first read gets it, on any draw and whatever the stage
 *                              // reads (since 3.2.0)
 *    vec3 fetchInput(ivec2 texel); // the stage's input texel, linearized and in the stage's
 *                              // space, on any draw; texels outside the frame clamp to its
 *                              // edge. A source at another size than the passes is resampled
 *                              // once and stored at the pass format (since 3.2.3)
 *    float luma(vec3); vec3 srgbToLinear(vec3);
 *    vec3 linearToSrgb(vec3);  // display encode: clips to 0..1
 *    vec3 linearToSrgbU(vec3); // same curve, clamps below 0 only; keeps values above 1.0
 *    #define SL_PROCESS_VERSION // the photo's process version (see ProcessingStageContribution.glsl)
 *  Pass `uniforms` share the owning stage's qualified-key namespace, so the same
 *  param (e.g. "{id}.lumaAmount") can drive both the pass and the inline glsl.
 *  A pass that fails to compile takes its stage out of the frame, inline glsl
 *  included, and is reported as the stage's failure. */
export interface StagePass {
  glsl: string;
  helpers?: string;
  /** Ping-pong iterations; uPassIndex runs 0..count-1 and uPassCount is the
   *  count. A number is a fixed count (default 1), taken as a whole number from
   *  1 to 1024; anything else is clamped, with a registration warning.
   *  `{ key, max }` reads it from the bag each frame; 0 skips the pass, and a
   *  stage whose passes all draw 0 times runs nothing that frame (no split
   *  either) and reads as idle. A stage runs its passes when the bag holds a
   *  non-zero value under its id, or when a `{ key, max }` pass resolves above
   *  0 from the bag or the uniform's default: a non-zero default draw count
   *  makes the stage run on every photo until a bag value turns it off (since
   *  3.1.0; earlier builds only used the bag test). */
  iterations?: number | PassDrawCount;
  uniforms?: UniformDeclaration[];
  /** 3 (default): `glsl` mutates `vec3 c` and the draw stores alpha 1. 4: it
   *  mutates `vec4 c`, which starts as the previous draw's texel fetched
   *  exactly and is stored whole, so alpha carries a fourth value to the next
   *  draw (1 on the stage's input). `vec4 fetchPrev4(ivec2 texel)` fetches any
   *  texel of the previous draw exactly, `vec4 readPrev4(vec2 uv)` samples it
   *  filtered. Without float render targets alpha is clipped to [0, 1] at 8
   *  bits, like the rgb. The inline's `stageResult` is the last draw's rgb
   *  either way. */
  channels?: 3 | 4;
  /** GLSL body of `ivec4 passRegion()`, run before each draw: it returns
   *  `ivec4(x0, y0, x1, y1)`, and the draw writes only the texels with
   *  x0 <= x < x1 and y0 <= y < y1 (`ivec2(gl_FragCoord.xy)`), clipped to
   *  the frame; an empty one writes none. It may read the pass's uniforms,
   *  helpers and the core's (uPassIndex, uPassCount, uTexel …), but it runs in
   *  a vertex program, so its helpers can't name gl_FragCoord or discard.
   *  Each texel outside keeps what that ping-pong target held two draws back,
   *  so a region must hold every texel this draw or the one before it changes;
   *  the one before may be the previous pass's. The stage's first two draws
   *  and its last are drawn whole whatever it returns. For a pass whose draws
   *  each change a small part of the frame, this saves reading the rest
   *  (since 3.2.2). */
  region?: string;
  /** Keeps the state after this pass, so a later frame of the live view can
   *  start from it. The stage resumes from the last kept pass whose inputs are
   *  unchanged: the source, the size, the process version, the image upstream
   *  for `reads: "current"`, the programs, uniform values and draw counts of
   *  that pass and every pass before it, and whether any later pass draws. As
   *  long as each pass's region follows its rule, a resumed frame gives
   *  exactly the result a full run gives. Each kept pass, in each mask copy,
   *  holds a full-size target while the photo is open; a pass that nothing
   *  draws after keeps nothing. Exports and thumbnails keep none (since 3.2.3). */
  keep?: boolean;
}

/** The values a processing stage receives and hands back (see
 *  ProcessingStageContribution.space). */
export interface StageSpace {
  /** "linear": proportional to light. "perceptual": the same values through
   *  the sRGB curve extended both ways — sign kept, no ceiling — so math
   *  written for display-encoded [0, 1] behaves the same there and still sees
   *  what lies beyond it. The core converts in before the stage and back out
   *  after it. */
  encoding: "linear" | "perceptual";
  /** Primaries of the values handed to the stage. Default "rec709", the core's
   *  working primaries; "rec2020" is a lossless matrix view of the same data. */
  primaries?: "rec709" | "rec2020";
}

/** A point in the develop program's main() where one of the Essentials'
 *  processing tools runs, in program order: the geometry (Crop & Straighten,
 *  declarations only), White Balance, Exposure/Highlights/Shadows,
 *  Whites/Blacks/Contrast, Tone Curve, HSL, Dehaze/Clarity/Texture, Highlight
 *  and Shadow Detail, Vibrance/Saturation, Colour Grading, Sharpening. */
export type StageAnchor =
  | "geometry"
  | "retouch"
  | "white-balance"
  | "tone"
  | "masks"
  | "display-basic"
  | "tone-curve"
  | "hsl"
  | "presence"
  | "band-detail"
  | "vibrance"
  | "color-grading"
  | "sharpen";

/** What a stage's `derive` reads besides the photo's params. The view's own
 *  state (the as-shot temperature, the sharpening preview, clipping) stays in
 *  the develop program's uniforms (uAsShotTemperature, uSharpenViz …), which a
 *  block may read by name. */
export interface StageDeriveContext {
  /** The owning extension's stored settings, as `api.settings.get` reads them. */
  settings<T>(key: string, fallback: T): T;
}

/** A uniform's value: a number or boolean, the numbers of a vector, matrix
 *  (column-major) or array uniform, or an image-space matrix (UniformDeclaration
 *  `space`). */
export type StageValue = number | boolean | number[] | ImageSpaceMatrix;

/** The longest edge, in pixels, of a brush tip's alpha image. */
export const MAX_BRUSH_TIP_EDGE = 128;

/** A brush tip (api.develop.registerBrushTip): the shape a brush stamps in
 *  place of its round, feathered disc. A dab names one with `tip` on the dab
 *  that starts its stroke, and the stroke keeps it. `alpha` is the shape's
 *  coverage, 0 to 255, row by row from the top, `width * height` bytes with
 *  no edge over MAX_BRUSH_TIP_EDGE. The longest edge is stamped across the
 *  dab's diameter, turned by the dab's `angle`. */
export interface BrushTipContribution {
  /** Unique across extensions; a dab stores it, so keep it stable. */
  id: string;
  label: string;
  alpha: { width: number; height: number; data: Uint8Array };
  /** Heading a picker files the tip under ("Clouds", an imported pack's name). */
  group?: string;
  /** The brush settings the tip was made for, which a painter loads when the
   *  tip is picked. Core keeps them, clamped into range, and stamps nothing by
   *  them: the painter lays the dabs. Needs Safelight 3.2.5. */
  brush?: BrushTipSettings;
}

/** A tip's own brush settings, as a raster editor's brush preset holds them.
 *  Each is optional; a painter uses its own default for one left out. */
export interface BrushTipSettings {
  /** Distance between dabs, as a fraction of the diameter: 0.01 to 10. */
  spacing?: number;
  /** How far a dab may land off the stroke, across it, as a fraction of the
   *  diameter: 0 to 10. */
  scatter?: number;
  /** Dabs laid at each spacing step: a whole number from 1 to 16. */
  count?: number;
  /** How much smaller a dab may come out, at random: 0 (never) to 1 (down to nothing). */
  sizeJitter?: number;
  /** How far a dab may turn at random: 0 (never) to 1 (a full turn either way). */
  angleJitter?: number;
  /** How much less a dab may deposit, at random: 0 to 1. */
  flowJitter?: number;
  /** The tip's turn, in radians. */
  angle?: number;
  /** Turn each dab along the stroke's direction, on top of `angle`. */
  followStroke?: boolean;
}

/** The most layers a paint texture (TextureRequirement "paint") bakes. */
export const MAX_PAINT_LAYERS = 4;

/** A brush dab that lays colour: `color` is display-encoded sRGB, 0 to 1. A
 *  change of colour starts a new stroke, as `strokeStart` does. */
export interface PaintDab extends BrushDab {
  color: [number, number, number];
}

/** One layer of a paint texture, in the order the layers bake: the first is
 *  layer 0. Other fields an extension keeps on it (a name) are left alone. */
export interface PaintLayer {
  id: string;
  dabs: PaintDab[];
}

/** One brush stroke an atlas texture (TextureRequirement "atlas") bakes into
 *  a channel of its own. */
export interface StageAtlasItem {
  id: string;
  dabs: import("@/catalog/types").BrushDab[];
}

export interface ProcessingStageContribution {
  /** Globally unique, e.g. "film-sim.halation". Ids under "core." and
   *  "builtin.denoise" are Safelight's own: registering one from an extension is
   *  refused. */
  id: string;
  name: string;
  phase: ProcessingPhase;
  /** Order within the phase. Lower = runs first. Default 100. */
  priority?: number;
  /** For Safelight's own stages: run at this point among the processing
   *  tools, ahead of the core block it is named for, instead of in the phase's
   *  group. The block is written as it reads (no braces, no space conversion)
   *  and sees the core's working values: `lin` at the two scene anchors, `c`
   *  at the display ones. Ignored, with a warning, on any other extension's
   *  stage, bar `"tone"`: any extension's scene-linear stage may run there,
   *  on `lin` (linear Rec.709) after White Balance and ahead of the tone block
   *  (Basic's exposure, curves and the default shoulder), so an exposure tool
   *  works before the tone mapping. Such a stage is written as its own
   *  namespaced block, runs with Safelight's stages at the anchor by
   *  priority, and can't declare passes, a space, a mask, reads or produces
   *  (registration refuses it). Needs Safelight 3.2.5; older builds ignore
   *  the anchor and run the stage in its phase. */
  anchor?: StageAnchor;

  /** For Safelight's own stages: this stage patches the source before the
   *  frame develops (Heal's): while any of the `active` uniforms' derived
   *  values is above zero, the renderer first draws the program's patch pass
   *  into a copy of the source and develops from that copy, so every tap of the
   *  frame reads the patched pixels. Needs Safelight 3.2.0. */
  patch?: { active: readonly string[] };

  /** For Safelight's own stages: constants defined ahead of the stage's
   *  uniforms, `#define NAME value`, which its uniforms may be sized by. */
  defines?: Record<string, number>;

  /** For Safelight's own stages: this stage is the photo's geometry. `region`
   *  names a `vec4` uniform whose derived value is the part of the transformed
   *  image a frame shows (x, y, width, height, 0 to 1), and `inverse` a `mat3`
   *  with `space: "image"` taking the transformed image to the source. Core
   *  sizes frames from the region and maps canvas points through both. One
   *  geometry stage at a time: the first registered. */
  geometry?: { region: string; inverse: string };

  /** GLSL code fragment operating, by phase, on `vec2 srcUv`, `vec3 lin` or
   *  `vec3 c` (read/write; see ProcessingPhase). Here, in `helpers` and in the
   *  passes, `SL_PROCESS_VERSION` is defined as the photo's process version (1,
   *  2 or 3), so `#if SL_PROCESS_VERSION >= 2` keeps a change off older photos.
   *  Needs Safelight 3.2.0; earlier builds don't define it. */
  glsl: string;
  /** Helper functions available to this stage's glsl (namespaced by compiler). */
  helpers?: string;

  uniforms: UniformDeclaration[];

  /** Optional pre-passes (see StagePass). Their final result is bound for this
   *  stage's inline `glsl` as `vec3 stageResult`. */
  passes?: StagePass[];

  /** Values this stage hands to the stages after it in the same draw. The core
   *  declares each as `isv_{name}`, and the registry refuses a name another
   *  registered stage already produces. Inline code only: passes can't see
   *  them, and a pass that mentions one is refused. */
  produces?: InterStageVariable[];
  /** Names of the InterStageVariables this stage reads as `isv_{name}`. Every
   *  `isv_` name the stage's glsl, helpers or producers read must be listed
   *  here or in `produces`, or the stage is refused. A consumer ordered ahead
   *  of the producer reads zero (with a warning); one whose variable no stage
   *  in the set produces is left out of the program (with a warning) rather
   *  than failing to compile. */
  consumes?: string[];

  textures?: TextureRequirement[];

  /** Lets the stage run again inside local adjustment masks. A mask whose
   *  `bag` holds one of the stage's keys (written by a panel's
   *  `PanelContribution.mask` component) gets its own copy of the stage, right
   *  after it in the pipeline: same glsl and passes, the mask's values, blended
   *  in by the mask's coverage. Copies chain in mask order, each reading the
   *  image as the one before left it, and a copy's passes run on their own.
   *  Only stages in MASKABLE_PHASES can be masked (registration warns for the
   *  others), and only on photos at process version 2 or later. A copy hands
   *  on none of the stage's `produces`. */
  mask?: { maskable: true };

  /** When the stage changes nothing: uniform key → value. While every listed
   *  uniform's value, as the uniform binds it (the bag's under "{id}.{key}",
   *  or the default where the bag has none), equals the one given, vectors
   *  element by element, the stage is dormant. The live Develop view leaves
   *  it out of a process version 2 or later photo's program, and its passes
   *  don't run in any view. The first photo that needs it brings it in, and it stays in
   *  until Safelight restarts, so a slider moved back to its rest value
   *  compiles nothing. A mask copy is judged by the mask's values. Each key
   *  must name a uniform the stage or one of its passes declares, not an array
   *  uniform, and each value must fit its type, or the stage is refused.
   *
   *  The stage must render exactly as without it while dormant. The rule is
   *  ignored, with a warning, where leaving the stage out changes the frame
   *  anyway: geometry stages, noise-reduction stages (one keeps the built-in
   *  denoiser out), display stages without `space` (version 2 clips their
   *  input), stages that `produce` values others consume, and stages that
   *  `patch` the source. Basic's tone block (the default shoulder and the
   *  camera-match lift) must never declare it either. Needs Safelight 3.2.1;
   *  older builds ignore it. */
  dormantWhen?: Readonly<Record<string, UniformValue>>;

  /** A view aid, such as a focus or exposure overlay: the stage runs only in
   *  the frames the live Develop view shows. Exports, thumbnails, headless
   *  renders, captures (unless `asShown`), probes and the histogram draw the
   *  photo without it, whatever the bag holds. Drive it with
   *  `api.develop.setViewValues`, so nothing of it reaches the edit. Refused
   *  on geometry stages, on stages that `produce` values and with `mask`.
   *  Needs Safelight 3.2.4; older builds draw the stage everywhere. */
  viewOnly?: boolean;

  /** For a stage in the decode or noise-reduction phase: its result keeps the
   *  photo's own fine detail in place, as a chromatic-aberration or flat-field
   *  correction does. With Dynamic render resolution, Develop then goes on
   *  adding the full-size photo's detail to the zoomed-in view while the stage
   *  is at work. Without it the detail is left off for that photo, because it
   *  would put back what a denoiser or a moiré filter removed. Leave it out
   *  for any stage that smooths or removes detail. Needs Safelight 3.2.4;
   *  older builds ignore it. */
  keepsDetail?: boolean;

  /** How this stage's params behave in presets. "global" (the default) is a
   *  look that applies to any photo — e.g. a film sim or a curve — so it is
   *  offered when saving a preset and pre-selected when changed. "per-image" is
   *  tied to one photo's content — spatial tools like warp, heal or red-eye —
   *  so it is excluded from presets by default and only surfaced under the Save
   *  dialogue's "Show all". Omit for ordinary global adjustments. */
  presetScope?: "global" | "per-image";

  /** Opt into full-information values. Omitted, a stage before the display
   *  transform gets `lin` as linear Rec.709 (signed, unclamped; from the
   *  scene-linear phase on, the core shoulder has compressed its highlights
   *  wherever that runs, see `skipToneShoulder`) and one after
   *  it gets `c` display-encoded and clamped to [0, 1], bar the offset
   *  Sharpening adds after a version 1 photo's last clamp (a mask covering a
   *  pixel in part mixes it through). Set, the stage gets its variable in this
   *  encoding and these primaries. After the display transform that is `c` as
   *  the core's display tools leave it: on a version 2 photo unclamped until a
   *  tool in use that needs [0, 1] or an earlier stage without `space` clips it
   *  (Effects' Vignette and Grain don't clip from line 2); on a version 1 photo with the
   *  old core's clamps. Ignored on geometry stages, which run before the image
   *  is sampled (registration warns). Details in docs/dev/api/contributions.md:
   *  "Values a stage sees: space" and "Process versions". */
  space?: StageSpace;

  /** What the stage's passes read first. "source" (the default) is the decoded
   *  image. "current" is the image as edited up to this stage, drawn into a
   *  float texture before the passes run; effects and output-encode stages
   *  read it as of the end of display-adjust. Ignored without `passes` and on
   *  geometry stages. */
  reads?: "source" | "current";

  /** With `reads: "current"`, the first process version whose photos this
   *  stage reads the current image on: a whole number, 1 (every version) by
   *  default. On older versions it reads the source, as a "source" reader
   *  does, with no extra draw, and its passes don't rerun for upstream edits.
   *  For a stage that changed what it reads and keeps older photos' look.
   *  Since 3.2.0. */
  readsCurrentFrom?: number;

  /** Ids of the stages this one runs after, even against priority: a soft
   *  dependency inside the phase. An id that isn't registered, or sits in another
   *  phase (a phase boundary always wins), is ignored. Stages that name each other
   *  in a cycle lose the entries between them and nothing else, with a warning.
   *  A value that isn't a list of ids is ignored, with a warning at registration.
   *  Older builds ignore it. */
  after?: string[];

  /** For Safelight's own stages: the stage's uniform values (and photo
   *  textures) for a set of params, keyed by uniform or texture `key`. Runs in
   *  the window whenever the params or the extension's settings change; the
   *  values travel with the params to whichever renderer draws them, the live
   *  view's, a probe's, a thumbnail's or an export's, so each draws its own
   *  params' values. Keys that aren't the stage's are dropped. Never sent to the
   *  render worker. Ignored, with a warning, on any other extension's stage. */
  derive?(
    params: import("@/catalog/types").DevelopParams,
    ctx: StageDeriveContext,
  ): Record<string, StageValue | StageTextureData | StageAtlasItem[]>;
}

// ---------------------------------------------------------------------------
// Catalogue lifecycle hooks (orchestrator)
// ---------------------------------------------------------------------------

/** Subscribe to catalogue lifecycle events. Lets an extension own a side concern
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
  /** Called when a photo is removed from the catalogue. When several photos are
   *  removed at once, up to eight may be handled concurrently. */
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
   *  file isn't a recognizable preset of this kind. Null or empty params make
   *  the panel report that no develop settings were found; a throw, or not
   *  finishing within 15 seconds, reports a failed import with the reason. */
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
  /** The photo fields `test` reads, by their top-level name ("keywords",
   *  "exif"). Declared, the grid is filtered and sorted again only when one of
   *  them changes on some photo, or the filter is registered again; `[]` for a
   *  test that reads none, such as one that passes every photo while its filter
   *  is off. Left out, every change to any photo runs the filter again. */
  reads?: readonly (keyof import("@/catalog/types").CatalogPhoto)[];
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
  /** The photo fields `compare` reads, by their top-level name ("exif",
   *  "rating"). Declared, the grid is sorted again only when one of them changes
   *  on some photo; left out, every change to any photo sorts it again. */
  reads?: readonly (keyof import("@/catalog/types").CatalogPhoto)[];
}

// ---------------------------------------------------------------------------
// Library grid context-menu items (generic — lets an extension add an action to
// the right-click menu on a photo / multi-selection, e.g. "Create virtual copy")
// ---------------------------------------------------------------------------

/** An item appended to the Library grid's right-click context menu. Core groups
 *  extension items below its built-in actions (Open, Rename, …) behind a
 *  separator. `ids` are the targeted photos: the right-clicked photo, or the
 *  whole current selection when the right-clicked photo is part of it (the same
 *  targeting the built-in items use). */
export interface GridMenuItemContribution {
  /** Globally unique, e.g. "my-ext.virtual-copy". */
  id: string;
  /** Menu label. A function receives the targeted ids so the label can vary
   *  (e.g. add a "(3)" count for a multi-selection). */
  label: string | ((ids: string[]) => string);
  /** Sort position among extension items (lower = earlier). Default 100. */
  order?: number;
  /** Render in the red "danger" colour (e.g. a destructive action). */
  danger?: boolean;
  /** Return false to show the item greyed-out for the current target. */
  enabled?: (ids: string[]) => boolean;
  /** Invoked with the targeted photo ids when the item is chosen. */
  onClick: (ids: string[]) => void;
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
// Panel header accessories (a control on EVERY panel's dock header)
// ---------------------------------------------------------------------------

/** Identity of the panel a global header accessory is decorating. */
export interface PanelHeaderContext {
  panelId: string;
  title: string;
  /** Dock module the panel defaults into, if known. */
  module?: ModuleId;
  /** The extension that registered the panel ("host"/"core.*" for built-ins). */
  extensionId: string;
  /** True when the develop renderer can preview this panel's effect off — i.e.
   *  it governs core adjustments or its extension owns a GPU stage. False for
   *  panels with no image effect (Histogram, Edit, Presets), so a preview eye can
   *  hide itself there. */
  previewable: boolean;
}

/** A control rendered in EVERY panel's dock header (to the left of the title),
 *  in addition to that panel's own headerAccessory. One component decorates all
 *  panels — it receives each panel's identity via props and returns null to
 *  render nothing for a given panel. Lets an extension add a uniform per-panel
 *  affordance (e.g. a preview-off eye) without core knowing about it. Must
 *  handle its own pointer events; the header ignores pointerdowns on buttons so
 *  it won't start a panel drag. */
export interface PanelHeaderAccessoryContribution {
  /** Globally unique, e.g. "my-ext.eye". */
  id: string;
  component: ComponentType<PanelHeaderContext>;
  /** Sort position among header accessories (lower = earlier). Default 100. */
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

/** A stylesheet applied to every app window after the core styles, e.g. to
 *  restyle the input controls through the documented `sl-*` styling hooks.
 *  Extension rules are unlayered, so they win over Tailwind utility classes at
 *  equal or lower specificity without `!important`; inline styles still win.
 *  `@import` is refused (the sheet is left empty). Re-registering the same id
 *  replaces the CSS; disabling the extension removes the sheet. */
export interface StylesheetContribution {
  /** Globally unique, e.g. "my-ext.controls". */
  id: string;
  /** Plain CSS. */
  css: string;
}
