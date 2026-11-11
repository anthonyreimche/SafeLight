// Safelight extension API types, generated from Safelight's
// src/extensions/api/*.ts by scripts/build-extension-types.mjs. Don't edit
// this file: regenerate it, or copy a newer one.
//
// Import its types with `import type`. It declares a few of the host's
// functions for their types only; reach those through `api`.
// Safelight 3.2.3. GPL-3.0-only.

import type { ButtonHTMLAttributes, CSSProperties, ComponentType, DragEvent, InputHTMLAttributes, JSX, MemoExoticComponent, MouseEvent, ReactNode, TextareaHTMLAttributes } from "react";
import type { StoreApi, UseBoundStore } from "zustand";

// src/catalog/photo.ts

export interface CatalogPhoto {
    id: string;
    filename: string;
    /** Path relative to the project root, e.g. "2024/trip/IMG_001.NEF". */
    relPath: string;
    /** Containing folder: dirname of relPath ("" = project root). */
    folder: string;
    directoryHandle: FileSystemDirectoryHandle | null;
    fileHandle: FileSystemFileHandle | null;
    thumbnailBlob: Blob | null;
    thumbnailUrl: string | null;
    width: number;
    height: number;
    fileSize: number;
    mimeType: string;
    rating: number;
    colorLabel: ColorLabel;
    flag: FlagStatus;
    rotation: number;
    keywords: string[];
    dateCreated: number;
    dateImported: number;
    exif: ExifData;
    /** Set when the last decode attempt failed (no thumbnail). Human-readable
     *  reason for the grid's warning tooltip; cleared once a preview is built. */
    decodeError?: string;
    /** Set on a RAW imported from its camera preview alone: libraw has yet to read
     *  its frame size, as-shot white balance and exposure bias from the whole file
     *  (readPendingMetadata, in the background once the import is done). Until
     *  then width/height are the preview's. */
    metadataPending?: true;
    /** The editFingerprint of the edit the stored preview was rendered with.
     *  Undefined when the preview was built from the file, without any edit. The
     *  edit can change without a new preview (Paste Settings, Update processing,
     *  an extension), so Develop draws the preview first only while this matches
     *  the edit it opens with. */
    previewEdit?: string;
    /** The rotation the stored preview was made at; undefined means `rotation`. They
     *  can differ: a turn is stored before its preview, whose write can fail or be cut
     *  short by a quit. A preview made at another rotation is never shown: one is
     *  built from the file instead. */
    previewRotation?: number;
    /** Set on a *virtual copy* — a second catalogue record that shares another
     *  photo's source file but keeps its own id, edits and metadata. Holds the id
     *  of the master record (the one that owns the file on disk). A virtual copy
     *  has no disk file of its own, so the project scan re-attaches the master's
     *  live handles to it on open instead of dropping it (see project-storage).
     *  Copies of copies still point at the root master. Undefined on a master. */
    copyOf?: string;
    /** A virtual copy's user-facing distinguisher (e.g. "copy", "copy 2", or a
     *  name the user typed). `filename` still mirrors the master's real file; the
     *  displayed/exported name folds them together as `base_<copyName>.ext` (see
     *  catalog/copy-name.ts). Undefined on a master. */
    copyName?: string;
    /** The stack this photo belongs to: photos sharing a stackId are one stack (a
     *  burst, a bracket), shown as the cover alone until it is expanded. A stack
     *  with fewer than two members shown is no stack (see catalog/stacks). */
    stackId?: string;
    /** Marks this photo as its stack's cover. Two windows can mark different
     *  members, so the cover is resolved, not read: the lowest id of the marked
     *  members, else the first member in order (stackCoverId). */
    stackCover?: true;
    /** The input profile extension's token for how this non-RAW photo is read
     *  (api.catalog.setInputProfile). Opaque to core, which only keys the
     *  photo's converted source by it. */
    inputProfile?: string;
}

/** A photo record as catalog.json stores it. The live file handles, the preview
 *  blob and its object URL belong to the window holding the record. */
export type StoredPhoto = Omit<CatalogPhoto, "directoryHandle" | "fileHandle" | "thumbnailBlob" | "thumbnailUrl">;

export type ColorLabel = "none" | "red" | "yellow" | "green" | "blue" | "purple";

export type FlagStatus = "none" | "pick" | "reject";

export interface ExifData {
    cameraMake?: string;
    cameraModel?: string;
    bodySerial?: string;
    lens?: string;
    lensMake?: string;
    lensSerial?: string;
    focalLength?: number;
    focalLength35mm?: number;
    aperture?: number;
    maxAperture?: number;
    shutterSpeed?: string;
    iso?: number;
    exposureCompensation?: number;
    exposureProgram?: string;
    exposureMode?: string;
    meteringMode?: string;
    whiteBalance?: string;
    flash?: string;
    subjectDistance?: number;
    sceneCaptureType?: string;
    colorSpace?: string;
    artist?: string;
    copyright?: string;
    software?: string;
    imageDescription?: string;
    dateTimeOriginal?: string;
    subSecTimeOriginal?: string;
    orientation?: number;
    colorTemperature?: number;
    rawExposureBias?: number;
    baselineExposure?: number | null;
    baselineShadows?: number | null;
    cameraMatchVersion?: number;
    gpsLatitude?: number;
    gpsLongitude?: number;
    gpsAltitude?: number;
}

export interface EditState {
    photoId: string;
    stack: EditSnapshot[];
    currentIndex: number;
}

export interface EditSnapshot {
    timestamp: number;
    label: string;
    params: DevelopParams;
    /** Generic extension-contributed processing-stage params (e.g. denoise),
     *  keyed by qualified key "{stageId}.{key}". Optional so pre-existing stacks
     *  load unchanged; validated on load via normalizeParamBag. */
    paramBag?: Record<string, unknown>;
}

export type SortField = 'dateImported' | 'dateCreated' | 'filename' | 'rating';

export type SortDirection = 'asc' | 'desc';

export type ViewMode = 'grid' | 'list';

/** A top-level module id: "library", "develop", or one an extension registered
 *  through api.registerModule. */
export type ModuleId = 'library' | 'develop' | (string & {});

export type AppModule = ModuleId;

// src/extensions/api/contributions.ts

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
    owns?: readonly (keyof DevelopParams)[];
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
    floating?: Record<string, {
        x: number;
        y: number;
        width: number;
    }>;
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
    window?: {
        material: "acrylic" | "mica";
    };
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
export type SettingsField = {
    key: string;
    label: string;
    hint?: string;
    type: "boolean";
    default: boolean;
} | {
    key: string;
    label: string;
    hint?: string;
    type: "number";
    default: number;
    min?: number;
    max?: number;
    step?: number;
} | {
    key: string;
    label: string;
    hint?: string;
    type: "string";
    default: string;
    placeholder?: string;
} | {
    key: string;
    label: string;
    hint?: string;
    type: "select";
    default: string;
    options: {
        value: string;
        label: string;
    }[];
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
export type ExportProcessorField = {
    key: string;
    label: string;
    hint?: string;
    type: "boolean";
    default: boolean;
} | {
    key: string;
    label: string;
    hint?: string;
    type: "number";
    default: number;
    min?: number;
    max?: number;
    step?: number;
} | {
    key: string;
    label: string;
    hint?: string;
    type: "string";
    default: string;
    placeholder?: string;
} | {
    key: string;
    label: string;
    hint?: string;
    type: "select";
    default: string;
    options: {
        value: string;
        label: string;
    }[];
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
    settings: Readonly<ExportOutput>;
}

/** An export's pixels before encoding: RGBA, top-down, encoded for the
 *  export's colour space, 0..65535 (an 8-bit export's value is this divided by
 *  257). */
export interface ExportFrame {
    data: Uint16Array;
    width: number;
    height: number;
    colorSpace: ColorSpaceId;
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
    process?(blob: Blob, photo: CatalogPhoto, settings: Record<string, unknown>, context: ExportProcessorContext): Promise<Blob>;
    /**
     * Called once per exported image with its pixels, after mapping and
     * sharpening, before quantization and encode. Change `frame.data` in place
     * and return nothing, or return a frame, which may change size (a mat). Only
     * the returned `data`, `width` and `height` are read. Needs Safelight 3.1.0:
     * older builds ignore it and require `process`.
     */
    processPixels?(frame: ExportFrame, photo: CatalogPhoto, settings: Record<string, unknown>, context: ExportProcessorContext): Promise<ExportFrame | void>;
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

export type GlslType = "float" | "int" | "bool" | "vec2" | "vec3" | "vec4" | "ivec2" | "ivec3" | "ivec4" | "mat3" | "mat4" | "sampler2D";

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
    range?: {
        min: number;
        max: number;
        step?: number;
    };
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
export type ProcessingPhase = "geometry" | "decode" | "noise-reduction" | "scene-linear" | "tone-map" | "display-adjust" | "effects" | "output-encode";

/** Ordered phase list: the order stage-order.ts sorts stages by. */
declare const PROCESSING_PHASE_ORDER: ProcessingPhase[];

/** The phases a stage can be masked in (ProcessingStageContribution.mask):
 *  those that run after mask coverage is known. Geometry, decode and noise
 *  reduction run before it. */
declare const MASKABLE_PHASES: readonly ProcessingPhase[];

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
export type StageAnchor = "geometry" | "retouch" | "white-balance" | "tone" | "masks" | "display-basic" | "tone-curve" | "hsl" | "presence" | "band-detail" | "vibrance" | "color-grading" | "sharpen";

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
declare const MAX_BRUSH_TIP_EDGE = 128;

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
    alpha: {
        width: number;
        height: number;
        data: Uint8Array;
    };
}

/** The most layers a paint texture (TextureRequirement "paint") bakes. */
declare const MAX_PAINT_LAYERS = 4;

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
    dabs: BrushDab[];
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
     *  at the display ones. Ignored, with a warning, on any other extension's stage. */
    anchor?: StageAnchor;
    /** For Safelight's own stages: this stage patches the source before the
     *  frame develops (Heal's): while any of the `active` uniforms' derived
     *  values is above zero, the renderer first draws the program's patch pass
     *  into a copy of the source and develops from that copy, so every tap of the
     *  frame reads the patched pixels. Needs Safelight 3.2.0. */
    patch?: {
        active: readonly string[];
    };
    /** For Safelight's own stages: constants defined ahead of the stage's
     *  uniforms, `#define NAME value`, which its uniforms may be sized by. */
    defines?: Record<string, number>;
    /** For Safelight's own stages: this stage is the photo's geometry. `region`
     *  names a `vec4` uniform whose derived value is the part of the transformed
     *  image a frame shows (x, y, width, height, 0 to 1), and `inverse` a `mat3`
     *  with `space: "image"` taking the transformed image to the source. Core
     *  sizes frames from the region and maps canvas points through both. One
     *  geometry stage at a time: the first registered. */
    geometry?: {
        region: string;
        inverse: string;
    };
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
    mask?: {
        maskable: true;
    };
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
    derive?(params: DevelopParams, ctx: StageDeriveContext): Record<string, StageValue | StageTextureData | StageAtlasItem[]>;
}

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
        photo: CatalogPhoto;
        dir: FileSystemDirectoryHandle;
        fileName: string;
    }): Promise<Partial<CatalogPhoto> | void>;
    /** Called after one or more photos' metadata (rating/label/flag/keywords)
     *  is committed. `getEditState` lazily fetches a photo's edit stack. */
    onMetadataChange?(ctx: {
        photos: CatalogPhoto[];
        getEditState(id: string): Promise<EditState | null>;
    }): Promise<void>;
    /** Called after a develop edit is committed to history. */
    onEditCommit?(ctx: {
        photo: CatalogPhoto;
        editState: EditState;
    }): Promise<void>;
    /** Called when a photo is removed from the catalogue. */
    onPhotoRemove?(ctx: {
        photo: CatalogPhoto;
        dir: FileSystemDirectoryHandle;
        fileName: string;
    }): Promise<void>;
}

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
        params: Partial<DevelopParams>;
    } | null>;
}

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

/** A predicate applied as an extra AND step in the Library grid's
 *  visible-photos derivation. Core stays blind to *why* a photo is hidden — the
 *  extension owns the matching logic and re-registers (same id, fresh `test`)
 *  whenever its query changes. */
export interface GridFilterContribution {
    /** Globally unique, e.g. "my-ext.search". */
    id: string;
    /** Return false to hide the photo from the grid (and from culling nav). */
    test(photo: CatalogPhoto): boolean;
    /** Invoked by the Library "Clear filters" action so search clears too. */
    onClear?(): void;
}

/** An extra sort order offered in the Library sort dropdown. The comparator is
 *  ascending; the toolbar's direction toggle flips it. */
export interface LibrarySortContribution {
    /** Globally unique, also the persisted sort id, e.g. "my-ext.camera". */
    id: string;
    /** Shown in the sort dropdown. */
    label: string;
    /** Ascending comparator over two photos (return <0, 0, >0). */
    compare(a: CatalogPhoto, b: CatalogPhoto): number;
}

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

/** Named regions of core UI an extension may render into. "library-subbar" is a
 *  full-width bar directly below the Library toolbar (only rendered when an
 *  extension contributes to it). "develop-toolbar" sits in the Develop status
 *  bar (left of the zoom controls); "develop-canvas-overlay" is a click-through
 *  layer covering the Develop canvas, aligned via `api.develop`. */
export type SlotName = "library-toolbar" | "library-subbar" | "develop-toolbar" | "develop-canvas-overlay" | "develop-detail";

export interface SlotContribution {
    /** Globally unique, e.g. "my-ext.search-bar". */
    id: string;
    slot: SlotName;
    component: ComponentType;
    /** Sort position within the slot (lower = earlier). Default 100. */
    order?: number;
}

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

// src/extensions/api/scoped-api.ts

export interface SafelightAPI {
    version: 1;
    extensionId: string;
    /** The app's React instance — plugins must use this, not their own copy. */
    react: typeof import("react");
    registerPanel(c: PanelContribution): void;
    registerTheme(c: ThemeContribution): void;
    registerLayout(c: LayoutContribution): void;
    /** Register a top-level module (a tab beside Library and Develop). */
    registerModule(c: ModuleContribution): void;
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
     *  `version` to swap the data without recompiling the shader. Disabling,
     *  updating or reloading the extension drops its stages' textures and frees
     *  their GPU copies, so supply them from `activate`, not only from module
     *  top-level code (a re-enabled extension's module is not re-run). */
    setStageTexture(stageId: string, key: string, tex: StageTextureData | null): void;
    /** Register a keyboard shortcut; appears in Preferences ▸ Shortcuts. */
    registerKeybinding(c: KeyActionContribution): void;
    /** Declare a settings dialogue (⚙ in the Extensions panel). */
    registerSettings(c: SettingsContribution): void;
    /** Register a post-export image processor. Processors run in registration
     *  order, each receiving the Blob from the previous step. Settings declared
     *  in `c.settings` appear as a collapsible section in the Export panel. */
    registerExportProcessor(c: ExportProcessorContribution): void;
    /** Contribute a filename template. Built-in variables are resolved by core;
     *  the template appears in the Export panel's filename template picker. */
    registerFilenameTemplate(c: FilenameTemplateContribution): void;
    /** Subscribe to catalogue lifecycle events (photo import / metadata change /
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
    /** Remove a slot contribution this extension registered (by id). Lets a slot
     *  come and go with feature state — e.g. dropping develop-detail controls when
     *  a denoise method is "off" so the panel falls back to its built-in sliders. */
    unregisterSlot(id: string): void;
    /** Render a control in EVERY panel's dock header (e.g. a per-panel toggle).
     *  The component receives each panel's identity; return null to skip a panel. */
    registerPanelHeaderAccessory(c: PanelHeaderAccessoryContribution): void;
    /** Register a named cursor (a shared semantic token or a custom image) usable
     *  via api.develop.setCanvasCursor. Re-registering the same id replaces it. */
    registerCursor(c: CursorContribution): void;
    /** Add a sort order to the Library toolbar's sort dropdown. */
    registerLibrarySort(c: LibrarySortContribution): void;
    /** Append an action to the Library grid's right-click context menu. Core
     *  passes the targeted photo ids (the right-clicked photo, or the whole
     *  selection if it's part of one). Re-registering the same id replaces it. */
    registerGridMenuItem(c: GridMenuItemContribution): void;
    /** Apply a stylesheet in every app window, after the core styles — the way
     *  to restyle core controls (see the styling hooks in docs/dev/api/components.md).
     *  Re-registering the same id replaces its CSS. */
    registerStylesheet(c: StylesheetContribution): void;
    /** Remove a stylesheet this extension registered (by id). */
    unregisterStylesheet(id: string): void;
    /** Persisted per-extension key/value settings. */
    settings: {
        get<T>(key: string, fallback: T): T;
        set(key: string, value: unknown): void;
        /** Fires when any of this extension's settings change (any window). */
        onChange(cb: (key: string, value: unknown) => void): () => void;
    };
    /** Reusable UI building blocks, typed with each core component's actual
     *  props, not as an opaque component bag. */
    components: {
        Panel: (props: PanelProps) => JSX.Element;
        Slider: (props: SliderProps) => JSX.Element;
        Histogram: (props: HistogramProps) => JSX.Element;
        CurveEditor: (props: CurveEditorProps) => JSX.Element;
        Rating: typeof Rating;
        Thumbnail: MemoExoticComponent<(props: ThumbnailProps) => JSX.Element>;
        /** The Library's list-view row (thumbnail, name, flags, rating, dimensions,
         *  camera). Pass `compact` in a narrow container to drop the last two. */
        PhotoListRow: MemoExoticComponent<(props: PhotoListRowProps) => JSX.Element>;
        /** The right-click menu core surfaces use, placed at client `x`/`y` and
         *  kept in the viewport. Closes on an outside click, Escape, scroll, or
         *  choosing an item. */
        ContextMenu: (props: ContextMenuProps) => JSX.Element;
        /** The interface-scale control: − and + around the value, in 10% steps
         *  between 80% and 200%. */
        ScaleStepper: (props: ScaleStepperProps) => JSX.Element;
        /** The long-edge picker of the Export panel and Preferences ▸ Export:
         *  presets plus a custom pixel size, `null` for the original size. */
        ResolutionControl: typeof ResolutionControl;
        /** Mounts every component registered into a named core slot
         *  (registerSlot), in registration order; nothing when there are none. */
        Slot: MemoExoticComponent<(props: SlotProps) => JSX.Element>;
        /** Binds its children to mask `maskId`: a mask sub-panel's component
         *  (PanelContribution.mask) drawn inside reads and writes that mask through
         *  useMaskScope / useParamScope. Needs Safelight 3.2.0. */
        MaskScope: (props: MaskScopeProps) => JSX.Element | null;
        /** The virtualized grid the Library draws its cells with: fixed-size
         *  cells, only the visible rows mounted, `scrollToIndex` kept in view. */
        VirtualGrid: typeof VirtualGrid;
        /** Develop's canvas area: the surround (theme shade, or the ISO grey under
         *  colour assessment), the active photo's canvas with every core overlay
         *  (the held canvas tool, extension overlays) and the photo's
         *  edit loaded as it opens. `empty` shows while no photo is open. Fills
         *  its container. */
        DevelopCanvas: (props: DevelopCanvasProps) => JSX.Element;
        /** The zoom readout and fit / 100% / step buttons for a DevelopCanvas
         *  sharing the same `zoom`. */
        ZoomControls: typeof ZoomControls;
        /** The canvas-surround shade picker. */
        SurroundControl: () => JSX.Element | null;
        /** The per-photo display transform (tone mapper) picker. */
        DisplayTransformControl: () => JSX.Element | null;
        /** "Update processing" for a photo stored with an older process version;
         *  nothing otherwise. */
        ProcessingUpdateControl: () => JSX.Element | null;
        /** The soft-proof toggle; nothing on a photo without the version 3 output. */
        ProofToggle: () => JSX.Element | null;
        /** The ISO 12646 colour-assessment toggle. */
        AssessmentToggle: () => JSX.Element;
        /** The eyedropper icon core's pickers show. */
        PickerIcon: typeof PickerIcon;
        /** The small "Auto" button of the develop panels (Auto Tone, Auto White
         *  Balance). */
        AutoButton: typeof AutoButton;
    };
    /** Shared, theme-styled UI primitives handed to extensions — Button, Select,
     *  NumberInput, TextInput, TextArea, Toggle, SegmentedControl, Field, Section,
     *  Card, Badge, ProgressBar, Row, Stack — plus `tokens` (canonical CSS-var
     *  strings). Authored in core (where Tailwind is scanned) and rendered inside
     *  the extension's own subtree, so they match the app. Prefer these over
     *  hand-rolled inline-styled controls. `confirmDialog` asks in the app's own
     *  dialogue card and resolves true on confirm; use it instead of
     *  `window.confirm`, which freezes the window's key handling in Electron. */
    ui: UIKit & {
        confirmDialog: typeof confirmDialog;
        /** Tell the person something in the app's dialogue card; resolves when they
         *  close it. Use it instead of `window.alert`. */
        alertDialog: typeof alertDialog;
    };
    /** React DOM's `createPortal`, from the app's copy, for a tooltip or popover
     *  that must escape its panel's clipping. Extension bundles can't import
     *  react-dom themselves. */
    reactDom: {
        createPortal: typeof import("react-dom").createPortal;
    };
    /** The app's Zustand store hooks and the zustand `create` factory, shared so
     *  plugins read/write the app's stores rather than their own copies. Typed
     *  with each store's actual state shape. */
    stores: {
        useDevelopStore: AppStore<DevelopState>;
        useCatalogStore: AppStore<CatalogState>;
        useUIStore: AppStore<UIState>;
        useSettings: AppStore<AppSettings>;
        usePresetsStore: typeof usePresetsStore;
        useKeybindings: typeof useKeybindings;
        useThemeStore: AppStore<ActiveIdState>;
        useLayoutStore: AppStore<ActiveIdState>;
        usePipelineStore: AppStore<ActiveIdState>;
        /** The open project: its name, folder tree and the project picker. */
        useProjectStore: AppStore<ProjectState>;
        create: typeof import("zustand").create;
    };
    /** The contribution registry (panels, themes, export processors, filename
     *  templates, stages, transforms …), read-only. React hook: select one slice
     *  (a record such as `s.exportProcessors`) and derive arrays from it with
     *  useMemo, since a selector that builds a new array each call re-renders
     *  forever. */
    registry: {
        use<T>(selector: (s: RegistryState) => T): T;
    };
    /** Write the app's Preferences (`useSettings` reads them). The change is
     *  saved and its side effects run (UI scale, reduced motion …), which a raw
     *  `useSettings.setState` does not do. The update settings
     *  (`checkExtensionUpdates`, `autoUpdateExtensions`, `checkForUpdates`,
     *  `updateChannel`) only change in Preferences: they are ignored here. */
    appSettings: {
        update(patch: Partial<AppSettings>): void;
    };
    /** Read-only metadata for the stage uniforms other installed extensions
     *  contribute — qualified key ("<stageId>.<uniform>"), label, value range and
     *  GLSL type. For tools that drive or inspect ANOTHER extension's sliders; the
     *  values themselves live in the develop store's paramBag (read
     *  `paramBag[qualifiedKey] ?? default`, write via `setDynParam`). Non-reactive:
     *  the list only changes as extensions load/unload — read it when you need it. */
    params: {
        list(): ParamDescriptor[];
        get(qualifiedKey: string): ParamDescriptor | undefined;
    };
    dock: {
        togglePanel(id: string): void;
        /** Where the calling panel component is docked right now ("float" when
         *  floating or rendered outside the dock). React hook — call it from the
         *  panel's component to adapt its layout to its rail. */
        usePanelPlacement(): PanelPlacement;
        /** Whether a panel is open in the current dock layout, on a rail or
         *  floating, as the View menu checks it. Non-reactive. */
        isPanelOpen(id: string): boolean;
    };
    themes: {
        apply(id: string): void;
    };
    layouts: {
        apply(id: string): void;
    };
    /** Display transforms. `apply` sets the Preferences default, which photos
     *  without their own pick follow; `effectiveId` is the transform a photo's
     *  `displayTransform` renders with (its pick while installed, else the
     *  default, else the built-in). */
    pipelines: {
        apply(id: string): void;
        effectiveId(displayTransform: string | null): string;
        /** The bag keys of a registered transform's params, "{id}.{key}": empty
         *  for a transform without params or an id that isn't registered. */
        paramKeys(id: string): string[];
    };
    /** Open / close the Preferences dialogue. `open` may take a section id (a core
     *  section's id or an extension id) to deep-link straight to that section. */
    preferences: {
        open(sectionId?: string): void;
        close(): void;
        toggle(): void;
        /** The field primitives core sections are built from, for a settings
         *  `component`: each hides itself while the Preferences search doesn't
         *  match its label or hint (`useFieldVisible` gives that answer for a
         *  control of your own). */
        fields: {
            Field: typeof Field;
            ToggleField: typeof ToggleField;
            OptionRow: typeof OptionRow;
            useFieldVisible: typeof useFieldVisible;
        };
    };
    /** Navigate between app modules: a built-in or a registered module id. The
     *  main window switches to it, or focuses its window if it is popped out,
     *  and ignores an unknown id. A popped-out window leaves its own module
     *  where it is and has the main window go to any other. */
    navigation: {
        goTo(module: ModuleId): void;
    };
    /** Read the current binding for any action id (built-in or extension), or
     *  `list()` every built-in key action with its current combo (override
     *  applied) + label + category — so a tool can check a remap against the LIVE
     *  shortcuts instead of a hard-coded list. `combo` is "" when unbound. */
    keybindings: {
        getBinding(actionId: string): string;
        list(): {
            id: string;
            label: string;
            category: string;
            combo: string;
        }[];
    };
    /** Cursor vocabulary. `labels`: canonical human-facing names for the built-in
     *  cursor tokens, keyed by token id (e.g. "pick", "zoom-in", "crop-move") — the
     *  single source of truth for this wording, so a cursor-restyling extension
     *  labels its controls to match the app. `resolve`: turn a token id (built-in or
     *  one a cursor theme has overridden) into a concrete CSS `cursor` value — use it
     *  to give an interactive overlay the SAME cursor the app uses (e.g.
     *  `resolve("pick")` for an on-image colour picker) instead of hardcoding
     *  "crosshair". An unknown token is returned as-is, so a raw CSS value passes
     *  through. Non-reactive: read it at render. */
    cursors: {
        labels: Readonly<Record<string, string>>;
        resolve(token: string): string;
    };
    /** Develop-canvas integration for overlays (e.g. before/after comparison).
     *  `useDevelopOverlay` returns the displayed image rect + a change nonce
     *  (call from a "develop-canvas-overlay" component); `captureFrame` renders an
     *  off-screen frame with arbitrary params, aligned to the live view. */
    develop: {
        useDevelopOverlay(): {
            rect: {
                x: number;
                y: number;
                w: number;
                h: number;
            } | null;
            nonce: number;
        };
        /** The mask a sub-panel instance belongs to (valid only inside a
         *  PanelContribution.mask component). Core local adjustments go through
         *  adj/setAdj; extension params through getParam/setParam/setParams, kept in
         *  the mask's bag, where they run a copy of each maskable stage they belong
         *  to inside the mask (ProcessingStageContribution.mask). `commit` ends a
         *  gesture as one undo step. */
        useMaskScope(): MaskParamScope;
        /** The params a panel component edits: the mask's inside a
         *  PanelContribution.mask component, the photo's paramBag anywhere else, with
         *  `maskId` null. Lets one component serve as both a panel's `component` and
         *  its `mask.component`. */
        useParamScope(): ParamScope;
        /** The frame covers the region the view shows, whatever crop `params`
         *  carry: in crop mode the whole photo and its margin, as the canvas shows
         *  it. The frame is for measuring: sRGB, and without the clipping warning, the
         *  mask overlay and the sharpening preview the view may be showing. Pass
         *  `{ asShown: true }` for a frame drawn over the canvas: it keeps those
         *  overlays, and on Linux with a display profile set it is converted to
         *  the monitor like the canvas is (elsewhere the two match). `paramBag` is
         *  merged over the photo's extension-stage params for this capture only,
         *  e.g. a stage's switch to render an auxiliary image (a gain map, a mask)
         *  aligned to the live view. Neither the params nor the bag reach the live
         *  view or the core's measurements of it (the histogram, Auto Tone, Auto
         *  WB, Upright). */
        captureFrame(params: DevelopParams, options?: {
            asShown?: boolean;
            paramBag?: Record<string, unknown>;
        }): Promise<ImageBitmap>;
        /** captureFrame's frame as floats, for values an 8-bit sRGB bitmap can't
         *  hold: RGBA, top-down, alpha 1. `point` "pre-output" (the
         *  default) is the signed colour every stage has finished with, as the
         *  output stage receives it: above 1 and below 0 where the photo goes
         *  there (version 1 photos clamp it to [0, 1] after the display
         *  transform, and hand over that). "output" is what the output stage
         *  makes of it in sRGB, in [0, 1]. "scene" is the scene-linear colour the
         *  display transform receives: after the core's linear edits, the masks
         *  and every scene-linear and tone-map stage, signed, before any display
         *  tool, for measuring a scene's range (a tone mapper's auto levels). The
         *  core shoulder has already compressed its highlights wherever it runs:
         *  always on version 1, and on version 2 and later unless the photo's
         *  display transform sets `skipToneShoulder`; elsewhere it is unclamped.
         *  Needs a Safelight build with the scene point; older builds don't know
         *  it. The frame is converted into `space`, default `{ encoding:
         *  "linear", primaries: "rec709" }`, on the GPU, pixel by pixel before
         *  any averaging. It is always a measurement: sRGB, unproofed, without
         *  the view's overlays. As with captureFrame, neither the params nor
         *  `paramBag` reach the live view or the core's measurements of it. The
         *  floats are read straight from the render target, never through an
         *  image encoder, so this supersedes renderPhotoFrame's `lossless` for
         *  frames that carry data. Null without float render targets, with no
         *  photo open, or when the GPU can't hold the frame, so feature-detect
         *  with it. `maxEdge` is the frame's long edge in pixels: 1280 by default
         *  (about 17 MB of floats for a 3:2 frame), never upscaled. A smaller
         *  frame is the full view's frame averaged down, each pixel the mean, in
         *  `space`, of the area it covers: tone, colour and detail (sharpening,
         *  noise reduction, texture) as the view shows them, at the smaller size.
         *  In a linear `space` that is the mean of linear values, where a smaller
         *  view averages encoded ones.
         *  `Infinity` asks for the full view, 16 bytes a pixel: at fit at most the
         *  Develop render resolution in Preferences (4096 px on the long edge by
         *  default, about 180 MB, up to 8192 px), zoomed in the visible window at
         *  the screen's device pixels. Its cost is reading that back, and in any
         *  `space` but perceptual Rec.709 the GPU holds a second frame of that
         *  size during the capture (about 360 MB together at 4096 px, 1.4 GB at
         *  8192 px), so ask for it only when you need detail finer than a smaller
         *  frame holds.
         *  While Develop still shows the camera preview, before the RAW decodes,
         *  the frame is drawn from that preview, as captureFrame's is. Needs
         *  Safelight 3.1.0; on older builds it is undefined. */
        captureFloatFrame(params: DevelopParams, options?: LiveFloatCaptureOptions): Promise<FloatFrame | null>;
        /** Render an arbitrary catalogue photo by id through the full develop pipeline
         *  with `params` (and optionally that photo's extension-stage `paramBag`) to
         *  an off-screen ImageBitmap, or null if it can't render. Unlike captureFrame
         *  this is NOT tied to the live Develop source, so it measures the requested
         *  photo even when another (or none) is open — e.g. batch Auto Tone / Auto WB
         *  across a Library selection. Rendered small (for histogram measurement).
         *  A `paramBag` is drawn as the live view draws one: under the entries the
         *  built-in stages take from `params`, such as the Detail panel's noise
         *  reduction. The frame is a JPEG at quality 0.9, which suits a picture. `lossless: true`
         *  returns it from a PNG instead, so every 8-bit channel value the pipeline
         *  wrote reaches the bitmap exactly: use it for a frame that carries data,
         *  such as a stage's measurement encoding, which a JPEG would smear across
         *  neighbouring values. A PNG costs more to encode than a JPEG, so leave it
         *  off for a frame you only look at. Needs Safelight 3.0.1; earlier builds
         *  ignore the option and return the JPEG. A lossless frame is null where only
         *  the grid's camera preview could stand in for the photo: that is another
         *  source, so no frame is better than a wrong one. */
        renderPhotoFrame(photoId: string, params: DevelopParams, paramBag?: Record<string, unknown>, options?: {
            lossless?: boolean;
        }): Promise<ImageBitmap | null>;
        /** renderPhotoFrame's frame as floats: captureFloatFrame's FloatFrame, with
         *  the same `point` and `space`, converted on the GPU as captureFloatFrame's
         *  is, for any catalogue photo. Rendered small, at
         *  most 640 px on the long edge (about 4 MB of floats, where a default
         *  captureFloatFrame frame is about 17 MB), so it suits measuring a
         *  selection. `options.paramBag` is drawn as renderPhotoFrame draws its
         *  `paramBag`. When Safelight can't decode the original (an unsupported
         *  RAW, or an offline original) the frame is drawn from the photo's stored
         *  or embedded preview, as renderPhotoFrame's lossless frame is, so its
         *  values stay within [0, 1]. Null if the photo can't render from a source
         *  of its own: the grid's camera preview never stands in, as for a lossless
         *  frame, since that is another source. Null without float render targets
         *  too. Needs Safelight 3.1.0; on older builds it is undefined. */
        renderPhotoFloatFrame(photoId: string, params: DevelopParams, options?: FloatCaptureOptions): Promise<FloatFrame | null>;
        /** The centre of the open photo's decoded source at native resolution.
         *  Safelight keeps it from the live RAW decode before capping the GPU
         *  texture to the Develop render resolution, and in the RAW cache beside
         *  each preview written from 3.1.0 on, so a photo opened from the cache has
         *  it too: up to 1024 px on each side, taken from the centre (a side
         *  shorter than that is kept whole), as RGBA floats, rows top-down, linear
         *  Rec.709 with white balance applied and before the baseline tone and
         *  every edit; `x` and `y` place it in the decoded frame of `sourceWidth`
         *  × `sourceHeight`. Null while no photo is open, between photos, for a
         *  bitmap (JPEG, TIFF, HEIF) and for one read through its input profile
         *  (registerInputProfiles), for the camera preview shown before the RAW
         *  decodes, for a stored preview standing in for the photo, and for a cache
         *  entry written before 3.1.0 until its rewrite lands, a few seconds after
         *  the open: wait for `useDevelopStore().sourceSize.native` before asking.
         *  Each call hands over a fresh copy, about 16 MB. Needs Safelight 3.1.0;
         *  on older builds it is undefined. */
        readSourceSample(): Promise<SourceSample | null>;
        /** Drive the Develop-canvas cursor while a tool is active. Pass a registered
         *  cursor id (built-in token or one from registerCursor), an inline spec, or
         *  a raw CSS value; pass null to clear. Higher `priority` wins when several
         *  tools request at once (default 10). Returns a release fn — call it (or
         *  pass null) on tool deactivate; the request is also swept if the extension
         *  unloads. The built-in zoom/pan/pick cursors take over during an active
         *  drag or pick, so a passive tool cursor never fights a live gesture. */
        setCanvasCursor(cursor: string | CursorContribution | null, opts?: {
            priority?: number;
        }): () => void;
        /** Persist (or, with null, delete) an opaque binary blob for the currently
         *  loaded Develop photo. The key is namespaced per extension. Stored as a
         *  sidecar outside catalog.json so large payloads (e.g. a warp displacement
         *  field) don't bloat the whole-file JSON rewrite. Core treats the bytes as
         *  opaque — the extension owns the format and load/save timing. */
        putPhotoData(key: string, data: Uint8Array | null): void;
        /** Hold the canvas's pick-drag tool (an eyedropper or on-image target
         *  tool), or with null let go of it. While it's held, a press on the image
         *  calls `tool.onPress` with the point in the canvas's pixels at once;
         *  with `onDown`, it is also handed the colour the view shows there (sRGB,
         *  0-1) once the probe answers, then the drag to `onMove` and its end to
         *  `onUp`. A held Ctrl, Cmd or Space pans instead, and Escape lets go.
         *  One extension holds it at a time: the last to set it. It is let go when
         *  the extension stops. */
        setPickDrag(tool: PickDragTool | null): void;
        /** React hook: whether this extension holds the pick-drag tool. */
        usePickDragHeld(): boolean;
        /** Hold the develop canvas with an on-image tool (canvas-tool.ts), or with
         *  null let go of it. While it's held, its `overlay` is drawn over the
         *  image inside the view, core's own canvas gestures stand aside (zoom
         *  too, unless `zoomable`), and the live view draws `viewParams` of the
         *  edit if given. Escape calls `onEscape` and lets it go. One extension
         *  holds it at a time: the last to set it. It is let go when the
         *  extension stops. Needs Safelight 3.2.0. */
        setCanvasTool(tool: CanvasTool | null): void;
        /** React hook: whether this extension holds the canvas tool. */
        useCanvasToolHeld(): boolean;
        /** The open photo's developed frame of the whole image, untransformed and
         *  uncropped, as RGBA8 rows from the top with its long edge at `edge` px:
         *  what Upright detects lines in. Null without a frame. Needs Safelight
         *  3.2.0. */
        readDevelopedPixels(edge: number): Promise<DevelopedPixels | null>;
        /** A small 8-bit sRGB copy of the open photo's source (RGBA8 rows from the
         *  top, about 1024 px on its long edge), for searches of the image itself:
         *  what Heal picks a source from. Null before the photo's first frame.
         *  Needs Safelight 3.2.0. */
        sourcePixels(): SourcePixels | null;
        /** Calls `listener` with each new sourcePixels image (another photo, a
         *  new decode); returns the unsubscribe. Needs Safelight 3.2.0. */
        onSourcePixels(listener: (pixels: SourcePixels) => void): () => void;
        /** The colour the develop canvas shows at `point` (in its pixels, as the
         *  pick-drag tool gives them), sRGB 0-1, read from the live frame; null
         *  with no canvas or no frame yet. */
        probe(point: CanvasPoint): Promise<readonly [number, number, number] | null>;
        /** The colour a mask's colour range compares at (u, v), 0 to 1 across the
         *  live frame buffer (useDevelopOverlay `rect`): scene-linear, before the
         *  display transform. Null with no frame. Needs Safelight 3.2.0. */
        probeMaskColour(u: number, v: number): Promise<readonly [number, number, number] | null>;
        /** Tint mask `maskId`'s coverage over the image (fading in and out), or with
         *  null none: the mask a mask panel is pointing at. Needs Safelight 3.2.0. */
        showMaskCoverage(maskId: string | null): void;
        /** Values the live view draws over the photo's own for this extension's
         *  stages, by qualified key ("{stageId}.{key}"), replacing the last set;
         *  null clears them. View-only feedback such as a hovered layer's
         *  highlight: never saved, undone or exported, and not in thumbnails.
         *  Keys of other extensions' stages are ignored, and holding the panel's
         *  preview off drops them with its stages' values. Cleared when the
         *  extension stops. Needs Safelight 3.2.1. */
        setViewValues(values: Record<string, unknown> | null): void;
        /** Offer a brush tip: a shape (an alpha image, at most 128 px an edge) a
         *  brush can stamp in place of its round disc. Name it by `id` in the `tip`
         *  of the dab that starts a stroke, with an optional `angle`; an id nothing
         *  holds bakes as the disc, so strokes saved with a tip keep drawing when
         *  its extension is off. Feather doesn't apply to a tip. Registering an id
         *  you hold replaces it; another extension's id is refused. Dropped when
         *  the extension stops. Needs Safelight 3.2.1. */
        registerBrushTip(tip: BrushTipContribution): void;
        /** Turn non-RAW photos (JPEG, PNG, WebP, AVIF, TIFF, NetPBM) into linear
         *  Rec.709 yourself. Each load of such a photo asks `resolver` for a
         *  transform and hands it the original's bytes; core reads the file's
         *  8-bit codes without colour management and applies the transform with
         *  nothing clipped, so colour outside sRGB arrives as negative channels.
         *  A null answer, a throw, an answer later than 3 s or an invalid
         *  transform leaves the photo to the browser's decode (sRGB). Develop,
         *  exports, headless renders and edited thumbnails use it; the Library's
         *  plain previews don't. One extension holds it: another's is refused
         *  with a warning, and registering again replaces your own. Dropped when
         *  the extension stops. Needs Safelight 3.2.3. */
        registerInputProfiles(resolver: InputProfileResolver): void;
        /** Your resolver's answers changed with no photo's token changing (a
         *  setting, a profile added or removed): photos converted before load
         *  again. Only the resolver's owner may call it. Needs Safelight 3.2.3. */
        invalidateInputProfiles(): void;
        /** React hook: the panels that can be added to a mask, in their order.
         *  Needs Safelight 3.2.0. */
        useMaskPanels(): MaskPanelEntry[];
        /** React hook: whether the open photo is stored with an older process
         *  version than the current one ("Update processing" applies), where an
         *  extension's values in a mask don't run. Needs Safelight 3.2.0. */
        useOlderProcessing(): boolean;
        /** Core's auto adjustments, each run to convergence and committed as one
         *  undo step: `whiteBalance` (grey-world, "Auto White Balance"),
         *  `whiteBalanceAt(point)` (the eyedropper: makes the canvas point neutral,
         *  probing it again after each step; "White Balance") and `tone` ("Auto
         *  Tone"). Each needs a rendered frame's histogram and does nothing
         *  without one; one runs at a time, and a second call while one runs does
         *  nothing. */
        autoAdjust: AutoAdjust;
        /** Read the opaque blob previously stored for the current Develop photo
         *  under `key`, or null if none exists (or no photo/project is open). */
        getPhotoData(key: string): Promise<Uint8Array | null>;
        /** Core develop scalars that live INSIDE a structured param object (e.g.
         *  "vignette.amount", "grain.size") — the ones a top-level setParam can't
         *  reach without merging the owning object. `list()` gives each one's range
         *  + current default + section `group`; `get`/`set` route to the right
         *  setParam path so a tool can drive them generically (e.g. key+wheel
         *  scrubbing). `set` is live (no history entry) — batch your own commitEdit. */
        adjustments: {
            list(): {
                key: string;
                label: string;
                group: string;
                min: number;
                max: number;
                step: number;
                default: number;
            }[];
            get(key: string): number;
            set(key: string, value: number): void;
        };
        /** Complete partial develop params with the defaults and clamp each value
         *  into its range, as Develop does with a loaded edit or an applied
         *  preset. */
        normalizeParams: typeof normalizeParams;
    };
    /** Headless export: render catalogue photos through the full develop pipeline to
     *  in-memory blobs, honouring the user's export settings. Unlike
     *  develop.captureFrame (current photo, view-sized), this renders ANY photos at
     *  export resolution — so an extension (e.g. a web-gallery publisher) can ship
     *  full-resolution images instead of the low-res catalogue preview. */
    export: {
        /** The persisted default export settings (Preferences ▸ Export): format,
         *  quality (0..1), longEdge (null = original), colorSpace, tiffBitDepth, pngBitDepth. */
        getDefaultSettings(): ExportSettings;
        /** Render each photo to a Blob, reusing one WebGL context for the batch.
         *  `settings` is merged OVER the defaults, so pass only what you want to
         *  override (e.g. { format: "image/jpeg", longEdge: 2048, quality: 0.85 }).
         *  One exception: a PNG renders at 8 bits whatever the user's PNG bit-depth
         *  Preference says, unless you pass `pngBitDepth: 16`, since a frame an
         *  extension renders for its own processing never asked for the slow,
         *  twice-as-large 16-bit path.
         *  `options.paramBag` is merged over each photo's own extension-stage
         *  params for this render only. The render runs the registered export
         *  processors unless `options.processors` is false; a render of the same
         *  photo started from inside its export processors runs none either way.
         *  Returns one entry per input, in
         *  order; `blob` is null for a photo that couldn't be decoded. */
        renderPhotos(photos: CatalogPhoto[], settings?: Partial<ExportSettings>, onProgress?: (p: ExportProgress) => void, options?: RenderPhotosOptions): Promise<RenderedPhoto[]>;
        /** The Export panel's run: render, run the export processors, name and
         *  deliver the files (downloads, a ZIP, or into `destDir`, a folder from
         *  `api.project.pickDirectory`). `settings` is the whole of them, not
         *  merged over the defaults. A `signal` in `options` stops the batch before
         *  its next photo; a failure every later write would meet (a full disk) stops
         *  it too, with `stopped` set on the result. */
        exportPhotos(photos: CatalogPhoto[], settings: ExportSettings, onProgress?: (p: ExportProgress) => void, destDir?: FileSystemDirectoryHandle, options?: ExportPhotosOptions): Promise<ExportResult>;
        /** True when these settings write ProPhoto RGB at 8 bits a channel, where
         *  smooth gradients band: the export asks for 16 bits only for a TIFF or
         *  PNG set to 16. */
        proPhotoAt8Bit(settings: BitDepthSettings): boolean;
    };
    /** Lower-level catalogue persistence, for extensions that add records the core
     *  scan didn't produce (e.g. virtual copies). `addPhotos` durably writes new
     *  records and inserts them into the live grid (optionally right after a given
     *  photo). `getEditState` / `putEditState` read and write a photo's saved
     *  develop recipe (the undo stack) by id — so an extension can, for instance,
     *  clone one photo's edits onto another. Writing the photo open in Develop
     *  reloads it there from the catalogue, which also clears the active tool and the
     *  mask and spot selection. */
    catalog: {
        addPhotos(photos: CatalogPhoto[], opts?: {
            afterId?: string;
        }): Promise<void>;
        getEditState(photoId: string): Promise<EditState | null>;
        putEditState(editState: EditState): Promise<void>;
        /** Rename one photo's file on disk, in place (same folder), preserving its
         *  extension. This is core's own rename path: an atomic native rename (no
         *  full-file copy), carrying the `<file>.safelight.json` sidecar and any
         *  virtual copies along, then updating and persisting the catalogue record —
         *  so ratings, edits and cached previews (keyed by photo id) survive. Pass
         *  the new name WITHOUT extension (core cleans it and re-appends the
         *  original). Returns `{ ok: true, filename }` or `{ ok: false, reason }`;
         *  it never throws for the ordinary failures (collision, missing photo,
         *  virtual copy, disk error). Batch renames that shuffle a numbering range
         *  should rename via a temporary pass first to dodge the collision guard. */
        renamePhoto(photoId: string, newBaseName: string): Promise<RenamePhotoResult>;
        /** The photos the Library grid is currently showing, in display order —
         *  active folder, filters, sort direction, extension grid filters and
         *  extension sorts all applied. React hook; the same list core's ←/→
         *  photo navigation walks, so a strip built on it always agrees with the
         *  grid. `without` names grid-filter contribution ids to leave out, for a
         *  surface that registers a filter and must not narrow itself by it. */
        useVisiblePhotos(options?: {
            without?: readonly string[];
        }): CatalogPhoto[];
        /** Queue a photo's grid preview through core's on-demand loader — the
         *  call a grid cell makes as it scrolls into view. The blob lands on the
         *  record's `thumbnailUrl`. For surfaces that draw thumbnails themselves
         *  (a canvas, a map pin) and so have no <Thumbnail> cell to trigger it. */
        requestThumbnail(photoId: string): void;
        /** Read a photo's grid preview (a JPEG of about 768 px) straight from the
         *  project, for a scan that walks the whole catalogue. It is not made resident:
         *  the photo's `thumbnailBlob` and `thumbnailUrl` are untouched and nothing is
         *  cached, so the caller owns the blob and a scan of a large project does not
         *  fill memory. Resolves to null when the photo has none. Core releases the
         *  `thumbnailBlob` / `thumbnailUrl` of photos far from view once many previews
         *  are loaded, so read them with this rather than from the record. */
        readPreview(photoId: string): Promise<Blob | null>;
        /** The Library's photo right-click menu, for a surface that lists photos.
         *  Wire `onContextMenu` to each cell and render `overlays` inside the
         *  surface; the menu carries the built-in actions (open, rename, copy/paste
         *  settings, rotate, re-import, export data, remove, delete from disk) and
         *  every registerGridMenuItem contribution, with the grid's dialogues. React
         *  hook. */
        usePhotoActions(): PhotoActions;
        /** Mount the Library's culling shortcuts (ratings, flags, colour labels,
         *  rotate, remove/delete, rename, reveal, select-all, prev/next) for as
         *  long as the calling component is mounted — so a photo surface docked in
         *  Develop culls exactly like the grid. Combos stay rebindable in
         *  Preferences ▸ Shortcuts, and Develop's own bindings keep priority where
         *  they overlap (Delete belongs to a selected mask component). React hook. */
        useCullingShortcuts(options?: CullingShortcutOptions): void;
        /** Read the full metadata of the photo the person is looking at when
         *  import left it pending (`metadataPending`); null stops. Reads queue, and
         *  only the last photo asked for is read, so arrowing through the grid reads
         *  the photo it stops on. */
        settleSelectedPhoto(id: string | null): Promise<void>;
        /** The histogram of a photo's saved edit (fresh defaults when it has none),
         *  rendered from its grid thumbnail, so it is quick to recompute on every
         *  selection. Null without WebGL or when the photo can't be read. */
        renderHistogram(photo: CatalogPhoto): Promise<HistogramData | null>;
        /** The photo open in Develop (the active photo), or undefined. React hook;
         *  a write to any other photo leaves it alone. */
        useActivePhoto(): CatalogPhoto | undefined;
        /** Put the photos in one new stack (a burst, a bracket), `opts.cover` (one
         *  of them) as its cover; a photo in another stack leaves it. The grid shows
         *  a collapsed stack as its cover alone, and ←/→ culling, select all and
         *  `useVisiblePhotos` follow what is shown. Written like a rating: no undo
         *  entry. Does nothing for fewer than two photos in the catalogue. */
        setStack(ids: string[], opts?: {
            cover?: string;
        }): Promise<void>;
        /** Take the photos out of their stacks. A stack left with one photo is no
         *  stack. */
        clearStack(ids: string[]): Promise<void>;
        /** Store `token` as the photos' `inputProfile`, or with null clear it:
         *  what your InputProfileResolver is handed for them. Opaque to core;
         *  synced between windows and written like a rating (no undo entry). The
         *  photos load again in Develop, and edited thumbnails are drawn again.
         *  Only the extension holding the input profile resolver may call it;
         *  any other call is rejected. Needs Safelight 3.2.3. */
        setInputProfile(ids: string[], token: string | null): Promise<void>;
        /** The stack photo `id` belongs to among all the catalogue's photos: its
         *  id, its members in catalogue order and its cover (the marked member with
         *  the lowest id, else the first member). Null for a photo in no stack. */
        stackOf(id: string): {
            stackId: string;
            ids: string[];
            cover: string;
        } | null;
        /** The name a photo is shown by: its filename, with a virtual copy's
         *  name added ("IMG_0001_copy.NEF"). */
        photoDisplayName: typeof photoDisplayName;
        /** Write `.safelight.json` sidecars (ratings, labels, edits) next to the
         *  photos' files; resolves with how many were written. */
        exportPhotoData(ids: string[]): Promise<number>;
        /** The Library's thumbnail sizes in pixels: what `useUIStore`'s
         *  `setGridSize` accepts, in the steps its zoom shortcuts take. */
        gridSize: {
            readonly min: number;
            readonly max: number;
            readonly step: number;
        };
    };
    /** Messages between the app's windows: catalogue changes, edit updates and
     *  the like, from other windows and this one. Returns an unsubscribe fn. */
    events: {
        onBroadcast: typeof onBroadcast;
        /** The window event the Focus keyword input shortcut (K by default)
         *  dispatches in Library. The panel holding the keyword field listens for
         *  it with `window.addEventListener` and focuses the field. */
        FOCUS_KEYWORD_INPUT: "sl-focus-keyword-input";
    };
    /** The project folder's tree, as the Folders panel edits it. Paths are
     *  relative to the project root ("" is the root). Each operation moves the
     *  files on disk and updates the catalogue and the tree. */
    project: {
        createFolder(parentRel: string, name: string): Promise<string | null>;
        renameFolder(rel: string, newName: string): Promise<void>;
        moveFolder(srcRel: string, destParentRel: string): Promise<void>;
        movePhotos(ids: string[], destRel: string): Promise<void>;
        deleteFolder(rel: string): Promise<void>;
        /** Ask the person for a folder to write into; null when they cancel. On
         *  the desktop the handle carries its absolute path (`pathOf`). */
        pickDirectory(id: string): Promise<FileSystemDirectoryHandle | null>;
        /** The absolute path behind a desktop folder handle, else null. */
        pathOf(handle: unknown): string | null;
        /** Show a path in the OS file manager; false outside the desktop app. */
        reveal(path: string): Promise<boolean>;
    };
    /** Bring files into the open project from outside it (a tether, a watch
     *  folder, a download). */
    library: {
        /** Write each file into `folder` of the open project (relative to its root,
         *  "/" between names; created if missing; the root when omitted) and import
         *  it as a photo, as the project scan imports a new file: previews, EXIF,
         *  then the grid and the Folders panel. `keywords` are added to the ones the
         *  file carries. One result per file, in order: `{ name, id }`, or
         *  `{ name, error }` when it was not taken. A name that is not one plain
         *  entry name (separators, `..`, a drive letter), a folder that leaves the
         *  project, a name already in use, an unsupported type, a file over 512 MiB
         *  and a read-only folder are all refused with a message; nothing is
         *  overwritten. Calls run one at a time. */
        importFiles: typeof importFiles;
    };
    /** Presets: the file formats and the descriptions the Presets panel and
     *  Copy Settings share. */
    presets: {
        /** The registered preset importers. React hook. */
        useImporters(): RegisteredPresetImporter[];
        /** The labels of the extension stages a preset's paramBag carries. */
        describeBag(bag: Record<string, unknown> | undefined): string[];
        /** What a preset changes, for its tooltip. */
        summarize(params: Partial<DevelopParams>): PresetDiff[];
        /** The adjustments a preset can be saved with from these params and bag:
         *  core fields, the display transform's params, then every extension
         *  stage's, as the save dialogue lists them. */
        fields(params: DevelopParams, paramBag: Record<string, unknown>): PresetField[];
        /** Download a preset as a Safelight JSON preset file. */
        exportFile(name: string, params: Partial<DevelopParams>, group?: string, paramBag?: Record<string, unknown>): void;
        /** Read a Safelight JSON preset, or another app's through the importers. */
        importFile(file: File, importers: readonly PresetImporterContribution[]): Promise<PresetImportOutcome>;
        /** Open the file picker for one file; null when cancelled. */
        pickFile(accept: string): Promise<File | null>;
        /** The picker's `accept` string for these importers. */
        pickerAccept(importers: readonly PresetImporterContribution[]): string;
    };
    /** The Extensions window. `openStore` opens it, on a store category's list
     *  when given one (a category key such as "preset"). */
    extensions: {
        openStore(category?: string): void;
    };
    /** Accessibility overlays (high contrast, colour-vision filters, larger text
     *  and controls, reduced motion and transparency, OS sync, keyboard canvas
     *  editing), read from the app settings. `activate` applies them and follows
     *  the settings, theme and OS; `deactivate` removes every trace. Both are
     *  idempotent. Which one ran last is kept for the next launch: overlays that
     *  were on come back before the theme is shown, and go once the installed
     *  extensions have loaded unless an extension called `activate`. */
    accessibility: {
        activate(): void;
        deactivate(): void;
        /** React hook: whether keyboard canvas editing is on (the overlays active
         *  and the setting on): an on-image tool then shows number fields for what
         *  it otherwise drags. Needs Safelight 3.2.0. */
        useKeyboardCanvasEditing(): boolean;
    };
    /** The native window controls drawn over the title bar (Windows, Linux). */
    titleBar: {
        /** Recolour them to the CSS colour variable behind the calling bar while
         *  it is mounted, following theme changes. React hook. */
        useOverlay(bgVar: string): void;
    };
    /** Developer Tools' reach into core: the dev-folder loader (which holds the
     *  privileged filesystem), the reads behind its Pipeline and Variables tabs,
     *  and the window's Chrome DevTools. Only the Developer Tools extension
     *  (`safelight.devtools`) gets it; for every other extension, and for
     *  `window.safelight`, it is undefined. */
    devtools?: {
        devFolder: {
            /** Load the extensions in the configured dev folder and follow changes
             *  to it. Idempotent. */
            init(): void;
            /** Unload them and stop following. */
            teardown(): void;
            /** Pick, rescan or clear the folder, with each extension's status. */
            Controls: (props: DevFolderControlsProps) => JSX.Element;
        };
        pipeline: {
            /** The process versions the program can be shown for. */
            versions: readonly ProcessVersion[];
            useOpenVersion(): {
                photoId: string | null;
                version: ProcessVersion;
            };
            useRows(version: ProcessVersion): PipelineRow[];
            useScreen(): ScreenTarget;
        };
        /** Every shared variable in this window, with its history and
         *  subscribers. Write through your own `api.variables`. */
        variables: VariablesInspector;
        /** The GPU's vendor, renderer, GLSL version and texture limit, probed once. */
        webglInfo(): WebGLInfo | null;
        /** The running app's version. */
        appVersion(): Promise<string>;
        /** Open, close and reload this window's Chrome DevTools; undefined
         *  outside the desktop app. */
        electron: NonNullable<Window["safelightNative"]>["devtools"];
        /** The desktop app's platform and Electron / Chromium versions, Chromium's
         *  GPU feature status and per-process CPU and memory; undefined outside the
         *  desktop app. `gpuInfo` and `metrics` are undefined in older desktop
         *  builds. */
        native?: {
            platform: NonNullable<Window["safelightNative"]>["platform"];
            versions: NonNullable<Window["safelightNative"]>["versions"];
            gpuInfo?: NonNullable<NonNullable<Window["safelightNative"]>["diagnostics"]>["gpuInfo"];
            metrics?: NonNullable<NonNullable<Window["safelightNative"]>["diagnostics"]>["metrics"];
        };
    };
    /** Shared variables: named JSON values any extension can register, read,
     *  subscribe to and write, synced across windows. A set() from an extension
     *  that hasn't seen the current value is refused and reported; use update()
     *  for read-modify-write. See docs/dev/api/stores.md. */
    variables: SharedVariablesAPI;
}

export interface ExtensionModule {
    activate(api: SafelightAPI): void;
    deactivate?(): void;
}

// src/extensions/api/store-types.ts

/** A repo found by the official-extension search (GitHub topic). */
export interface ExtensionSearchResult {
    /** "owner/repo" — also the install spec. */
    fullName: string;
    /** The extension's manifest name, from the registry index. Absent on live
     *  search results, where the store shows the repo name instead. */
    name?: string;
    description: string | null;
    stars: number;
    /** Repo creation time (ISO). Drives the store's "New" shelf. Present from the
     *  prebuilt registry index; null on the live-search fallback for repos GitHub's
     *  search payload didn't carry it for. */
    createdAt?: string | null;
    updatedAt: string;
    /** Where this result came from: the prebuilt registry index ("registry") or a
     *  live GitHub search ("live"). The browse grid skips per-card thumbnail
     *  re-resolution for "registry" results — their thumbnail is already baked by
     *  the index build, so a runtime icon/og round-trip would add nothing. */
    source?: "registry" | "live";
    /** GitHub repo topics — the store's category source when `categories` is absent. */
    topics?: string[];
    /** Store category slugs the registry build resolved. Absent on live-search
     *  results and older indexes, where the store reads the topics instead;
     *  [] means the registry found none (shown under Other). */
    categories?: string[];
    /** Type badge slug from the registry build (module, pipeline, panel), or
     *  null when it found none. */
    type?: string | null;
    /** Search keywords from the extension's manifest. */
    keywords?: string[];
    /** Screenshot URLs (https) from the extension's manifest. */
    screenshots?: string[];
    /** "owner/repo" extensions it pairs well with, linked both ways by the
     *  registry build. */
    worksWith?: string[];
    /** Owner avatar on the direct avatars CDN — the instant fallback thumbnail and
     *  the card's first paint (no github.com/owner.png redirect). */
    avatarUrl?: string | null;
    /** Best store thumbnail resolved in the main process (manifest icon → custom
     *  social preview → avatar). `custom` is false only for the avatar fallback, so
     *  the card can letterbox it instead of filling the frame. Present when served
     *  from a warm cache; the grid refreshes it via github.thumbnails on open. */
    thumbnail?: ExtensionThumbnail | null;
}

/** A resolved browse-card thumbnail. `custom` distinguishes a purpose-made
 *  icon/social-preview (fills the card) from the avatar fallback (letterboxed). */
export interface ExtensionThumbnail {
    url: string;
    custom: boolean;
}

/** One Extensions-store category, as registry.json publishes it. */
export interface StoreCategory {
    slug: string;
    label: string;
    description: string;
}

/** A type badge: what an extension adds (Module, Processing, Panel). */
export interface StoreType {
    slug: string;
    label: string;
}

/** The store's categories in display order and type badges in precedence order. */
export interface StoreVocabulary {
    categories: StoreCategory[];
    types: StoreType[];
}

/** Curation lists from the trust registry repo, fetched + normalized (lowercased)
 *  in the Electron main process. `verified` is the human-reviewed allowlist;
 *  `repos`/`owners` are the banned kill-switch; `reason` maps a banned
 *  "owner/repo" or "owner" to a short explanation shown to the user. */
export interface TrustList {
    verified: string[];
    /** For pinned verified entries, the reviewed point per "owner/repo": the
     *  version (and/or commit) a maintainer actually reviewed. Absent for legacy
     *  bare-string entries (verification not pinned to a version). A repo whose
     *  current version is newer than the reviewed version is "stale-verified" — the
     *  code in play is past the review, so the badge/install treat it as unreviewed. */
    reviewed: Record<string, {
        version?: string;
        commit?: string;
    }>;
    repos: string[];
    owners: string[];
    reason: Record<string, string>;
}

/** Normalized GitHub repo metadata for the Extensions store detail view.
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
    /** A letter or digit, then letters, digits, `.`, `_` and `-`. `core` and anything
     *  under `core.`, in any case, belong to Safelight's built-ins and are refused. */
    id: string;
    name: string;
    version: string;
    description?: string;
    author?: string;
    /** Entry ESM bundle, relative to the extension folder, e.g. "dist/index.js". */
    main: string;
    /** Icon URL (absolute, or relative to the repo's default branch). */
    icon?: string;
    /** Store categories, e.g. ["Panels", "Colour"]. Preferred over repo topics. */
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
    /** "owner/repo" extensions this one pairs well with. The store lists them on
     *  this extension's page, and this one on theirs when it is verified. */
    worksWith?: string[];
    /** SPDX license id, e.g. "MIT". */
    license?: string;
    /** Minimum SafeLight version required, e.g. "1.2.0". Blocks install below it. */
    minAppVersion?: string;
    /** Capabilities the extension requests (shown to the user in the store). Only
     *  `network` is *enforced* — declared HTTPS origins are added to the app's
     *  content-security policy, and anything not declared by an installed or
     *  dev-folder extension is blocked. Extensions otherwise run in-app with
     *  ambient access (your catalogue, files); that is NOT confined by this field,
     *  so install only extensions you trust. See EXTENSIONS.md. */
    permissions?: ExtensionPermissions;
}

/** The update-relevant fields of the safelight.json a repo currently publishes. */
export interface RemoteManifest {
    version: string;
    minAppVersion?: string;
}

/** One GitHub release of an extension. Lists are newest version first. */
export interface ExtensionRelease {
    version: string;
    tag: string;
    prerelease: boolean;
    /** ISO date, or "" when GitHub gave none. */
    publishedAt: string;
    /** Release notes as Markdown, capped at 20 KB. */
    notes: string;
    htmlUrl: string;
}

/** Declared extension capabilities. See ExtensionManifest.permissions. */
export interface ExtensionPermissions {
    /** HTTPS origins the extension needs to reach, e.g. ["https://api.example.com"]
     *  (a single leading-label wildcard like "https://*.example.com" is allowed).
     *  Only declared origins pass the content-security policy; undeclared hosts are
     *  blocked. A new declaration takes effect after the next app launch. */
    network?: string[];
    /** Optional human-readable rationale shown to the user beside the request. */
    reason?: string;
}

// src/extensions/api/stores.ts

/** A store hook: call it with a selector in a component, or use its
 *  getState / setState / subscribe anywhere. */
export type AppStore<T> = UseBoundStore<StoreApi<T>>;

/** Clipping overlay bits: 1 shadows, 2 highlights, 4 the gamut warning, which
 *  only version 3 photos show. */
export type ClippingMask = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface DevelopState {
    photoId: string | null;
    params: DevelopParams;
    /** Transient render-only override: when set, the renderer draws these params
     *  instead of `params` without touching history (used for preset hover
     *  preview). Cleared on mouse-out, on apply, and when switching photos. */
    previewParams: DevelopParams | null;
    /** Render-only override for the extension param bag, paired with
     *  `previewParams` for the preset hover preview: the preset's contributed
     *  params merged over the live bag. Null when no preview is active. */
    previewParamBag: Record<string, unknown> | null;
    /** Extension params keyed by qualified names ("{stageId}.{key}"). */
    paramBag: Record<string, unknown>;
    history: EditSnapshot[];
    historyIndex: number;
    histogram: HistogramData | null;
    asShotTemperature: number;
    /** Size of the source the last frame was drawn from, as the renderer holds it
     *  (already upright, after the upload cap). Derive an image aspect from this,
     *  not photo.width/height. `fullWidth`/`fullHeight` are the decoded frame's
     *  size before the cap, and `native` is true while a native-resolution sample
     *  is held for the source (the one api.develop.readSourceSample answers).
     *  {0,0} and false until a frame of the photo is drawn. */
    sourceSize: {
        width: number;
        height: number;
        fullWidth: number;
        fullHeight: number;
        native: boolean;
    };
    /** Why the open photo's stored edit couldn't be read, or null. While set, the
     *  photo is open with no history, and its changes, undo and redo are not saved.
     *  Cleared by opening the photo again, or another one, successfully. */
    editError: string | null;
    setHistogram: (histogram: HistogramData | null) => void;
    setSourceSize: (width: number, height: number, full?: {
        width: number;
        height: number;
        native: boolean;
    }) => void;
    /** Open a photo's stored edit. A change still uncommitted on the photo being
     *  left is committed to that photo first. */
    loadEdit: (photoId: string, asShotTemperature?: number) => Promise<void>;
    /** Take on the open photo's edit as the catalogue now holds it, after another
     *  window changed it. */
    reloadEdit: () => Promise<void>;
    setParam: <K extends keyof DevelopParams>(key: K, value: DevelopParams[K]) => void;
    /** Set a dynamic parameter by qualified key (e.g. "core.exposure.exposure"). */
    setDynParam: (key: string, value: unknown) => void;
    /** Set multiple dynamic parameters at once. */
    setDynParams: (patch: Record<string, unknown>) => void;
    setToneCurve: (channel: ToneCurveChannel, points: CurvePoint[]) => void;
    /** Replace the live params wholesale (merge a partial preset over the current
     *  params first) and merge the preset's bag over the live one, committed as
     *  one undoable edit. The photo keeps its own process version. */
    applyPreset: (params: DevelopParams, paramBag?: Record<string, unknown>) => Promise<void>;
    /** Set (or clear with null) the render-only preview params, optionally with a
     *  preset's bag. No history write, no broadcast. */
    setPreviewParams: (params: Partial<DevelopParams> | null, paramBag?: Record<string, unknown> | null) => void;
    commitEdit: (label: string) => Promise<void>;
    /** Reset just the given top-level param keys to their defaults (temperature
     *  falls back to the photo's as-shot WB), as one undoable edit. */
    resetParams: (keys: (keyof DevelopParams)[], label: string) => Promise<void>;
    undo: () => void;
    redo: () => void;
    reset: () => Promise<void>;
    /** Move the open photo from the older processing to the current one, as one
     *  undoable step that keeps every other setting. */
    updateProcessing: () => Promise<void>;
    canUndo: () => boolean;
    canRedo: () => boolean;
    /** Per-panel preview-off, keyed by panel id: the renderer leaves a bypassed
     *  panel's contribution out without touching the edit. Never persisted. */
    bypassedPanels: Record<string, boolean>;
    setPanelBypass: (panelId: string, on: boolean) => void;
    togglePanelBypass: (panelId: string) => void;
    showClipping: ClippingMask;
    setShowClipping: (mode: ClippingMask) => void;
    toggleClipping: () => void;
    /** Soft proof of the export colour space, on photos that have one (version 3). */
    proof: boolean;
    toggleProof: () => void;
    /** ISO 12646 colour assessment: the image framed in white on a middle-grey
     *  surround. */
    colorAssessment: boolean;
    toggleColorAssessment: () => void;
    /** Sharpening preview while Alt/Ctrl-dragging a sharpening slider: 0 off,
     *  1 masking, 2 detail, 3 luminance. */
    sharpenViz: number;
    setSharpenViz: (mode: number) => void;
    /** Mask value edits. They write params but don't commit: commitEdit ends a
     *  gesture for undo. */
    updateMask: (id: string, patch: Partial<Mask>) => void;
    updateMaskAdj: (id: string, patch: Partial<MaskAdjustments>) => void;
    /** Merge into the mask's extension-param bag; undefined values delete keys. */
    updateMaskBag: (id: string, patch: Record<string, unknown>) => void;
    /** Apply a mask sub-panel's `owns` list: seed writes each owned value's
     *  default, clear zeroes the adjustments and strips blocks and bag keys. */
    seedMaskPanelValues: (maskId: string, owns: readonly string[]) => void;
    clearMaskPanelValues: (maskId: string, owns: readonly string[]) => void;
}

/** A grid preview as a loader returns it, with the edit it shows. */
export type LoadedPreview = Blob & {
    readonly previewEdit?: string;
};

/** What a background rebuild of a photo changed (see mergeRebuiltPhoto). */
export type RebuiltChange = Partial<Pick<CatalogPhoto, "thumbnailBlob" | "thumbnailUrl" | "previewEdit" | "width" | "height" | "rotation" | "exif" | "decodeError" | "fileSize" | "mimeType" | "dateCreated" | "metadataPending">>;

export interface CatalogState {
    photos: CatalogPhoto[];
    selectedIds: Set<string>;
    activePhotoId: string | null;
    loading: boolean;
    /** Bumped after re-granting file permission, to reload bitmaps. */
    fileAccessNonce: number;
    /** The last project needs a permission re-grant. */
    needsReconnect: boolean;
    /** A permission re-grant is in progress. */
    reconnecting: boolean;
    loadCatalog: () => Promise<void>;
    reconnectFiles: () => Promise<void>;
    /** Swap in a freshly opened project's photos. */
    replaceCatalog: (photos: CatalogPhoto[]) => void;
    /** Append photos during a progressive open. */
    appendPhotos: (photos: CatalogPhoto[]) => void;
    /** Add new photo records and durably persist them, optionally each right
     *  after a given photo (api.catalog.addPhotos). */
    addPhotos: (photos: CatalogPhoto[], opts?: {
        afterId?: string;
    }) => Promise<void>;
    /** Finalize a progressive open with the authoritative list. */
    finalizeCatalog: (photos: CatalogPhoto[]) => void;
    /** Attach freshly read grid previews; returns the ids that took one. */
    mergeThumbnails: (updates: {
        id: string;
        blob: LoadedPreview;
    }[]) => string[];
    /** Replace one photo record in place (same id). Persistence is the caller's job. */
    updatePhoto: (photo: CatalogPhoto) => void;
    /** Take only the fields in `change` onto the photo as the store holds it now. */
    mergeRebuiltPhoto: (id: string, change: RebuiltChange) => void;
    /** Replace one photo's preview blob in place. */
    replaceThumbnail: (id: string, blob: LoadedPreview) => void;
    /** Let go of previews the loader read; returns the ids let go. */
    dropThumbnails: (entries: {
        id: string;
        blob: LoadedPreview;
    }[]) => string[];
    /** Take on what another window wrote to the catalogue. */
    mergeRemoteRecords: (photos: StoredPhoto[], deletedIds: string[]) => void;
    /** Replace the skeleton catalogue with the post-scan list. */
    reconcileCatalog: (photos: CatalogPhoto[]) => void;
    removePhoto: (id: string) => Promise<void>;
    removePhotos: (ids: string[]) => Promise<void>;
    /** Persist already-built photo records and show them (photos moved or
     *  renamed on disk, or metadata an extension changed). Build each from the
     *  photo as the store holds it right before the call. */
    relocatePhotos: (updated: CatalogPhoto[]) => Promise<void>;
    /** Set a virtual copy's display name. Display-only. */
    setCopyName: (id: string, copyName: string) => Promise<void>;
    /** Put the photos in one new stack, `opts.cover` as its cover. */
    setStack: (ids: string[], opts?: {
        cover?: string;
    }) => Promise<void>;
    /** Take the photos out of their stacks. */
    clearStack: (ids: string[]) => Promise<void>;
    /** Store an input profile token on the photos, or with null clear it. Call
     *  api.catalog.setInputProfile instead: it checks that you hold the
     *  resolver, and draws edited thumbnails again. Needs Safelight 3.2.3. */
    setInputProfile: (ids: string[], token: string | null) => Promise<void>;
    setRating: (id: string, rating: number) => Promise<void>;
    setColorLabel: (id: string, label: ColorLabel) => Promise<void>;
    setFlag: (id: string, flag: FlagStatus) => Promise<void>;
    applyRating: (ids: string[], rating: number) => Promise<void>;
    applyColorLabel: (ids: string[], label: ColorLabel) => Promise<void>;
    applyFlag: (ids: string[], flag: FlagStatus) => Promise<void>;
    rotatePhotos: (ids: string[], deg: number) => Promise<void>;
    addKeyword: (id: string, keyword: string) => Promise<void>;
    removeKeyword: (id: string, keyword: string) => Promise<void>;
    addKeywords: (ids: string[], keywords: string[]) => Promise<void>;
    removeKeywords: (ids: string[], keywords: string[]) => Promise<void>;
    select: (id: string) => void;
    selectRange: (id: string, orderedIds?: string[]) => void;
    toggleSelect: (id: string) => void;
    /** Select the given ids, or every photo in the catalogue when none are given. */
    selectAll: (ids?: string[]) => void;
    deselectAll: () => void;
    setActivePhoto: (id: string | null, options?: {
        broadcast?: boolean;
    }) => void;
}

export type FlagFilter = "any" | "pick" | "reject";

export type LabelFilter = "any" | ColorLabel;

export type RatingOp = "lt" | "lte" | "gt" | "gte" | "eq" | "neq";

export interface LibraryFilter {
    /** Stars threshold, compared via ratingOp. */
    rating: number;
    ratingOp: RatingOp;
    flag: FlagFilter;
    label: LabelFilter;
    /** A photo must carry all of these. */
    keywords: string[];
}

export interface UIState {
    activeModule: AppModule;
    setActiveModule: (module: AppModule) => void;
    viewMode: ViewMode;
    setViewMode: (mode: ViewMode) => void;
    /** A built-in SortField or an extension-contributed sort id. */
    sortField: string;
    sortDirection: SortDirection;
    setSort: (field: string, direction: SortDirection) => void;
    filter: LibraryFilter;
    setFilter: (patch: Partial<LibraryFilter>) => void;
    clearFilters: () => void;
    /** Project folder filter: relative path ("" = whole project), null = all. */
    activeFolder: string | null;
    setActiveFolder: (path: string | null) => void;
    /** The stacks shown expanded, by stackId; per session, a stack opens collapsed. */
    expandedStacks: ReadonlySet<string>;
    toggleStack: (stackId: string) => void;
    gridSize: number;
    setGridSize: (size: number) => void;
    stepGridSize: (direction: 1 | -1) => void;
    /** Live column count of the Library grid; 1 in list view. */
    gridColumns: number;
    setGridColumns: (n: number) => void;
    /** Modules popped out into their own windows (main-window view). */
    detached: Set<AppModule>;
    markDetached: (module: AppModule) => void;
    markAttached: (module: AppModule) => void;
}

export type ExportFormatPref = "image/jpeg" | "image/png" | "image/webp" | "image/tiff";

/** How grid previews are built for RAW files on import: the embedded camera
 *  JPEG when it is big enough ("auto"), always the embedded JPEG, or always a
 *  render of the sensor. */
export type PreviewSource = "auto" | "embedded" | "rendered";

/** Per-theme custom UI colour overrides: theme id → (CSS custom property → hex). */
export type ColorOverrides = Record<string, Record<string, string>>;

/** Colour-vision simulation over the whole window. "none" = off. */
export type ColorVisionFilter = "none" | "protanopia" | "deuteranopia" | "tritanopia";

/** Which releases the update check notifies of: full releases only, or
 *  pre-releases too. */
export type UpdateChannel = "stable" | "all";

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
    /** Bits per sample for PNG export (8 or 16); absent on older presets. */
    pngBitDepth?: 8 | 16;
}

/** The app's Preferences. Read them with useSettings, write them with
 *  api.appSettings.update. */
export interface AppSettings {
    /** Whole-UI zoom (0.8–2.0). */
    uiScale: number;
    reduceMotion: boolean;
    /** UI font as a CSS font-family; "" = the built-in stack. */
    uiFont: string;
    /** Use the fixed `canvasSurround` shade behind the image in Develop, not the
     *  theme's surface. */
    canvasSurroundOverride: boolean;
    canvasSurround: string;
    /** Width of the colour-assessment mat, as a percentage of the smaller
     *  viewport dimension. */
    assessBorderPct: number;
    /** How much the app behind a window-style pop-up is dimmed, 0–0.8. */
    windowDim: number;
    /** Clicking a slider jumps its value to the cursor. */
    sliderJumpToCursor: boolean;
    /** The plain wheel over a closed dropdown picks the previous or next option;
     *  off, only Shift+wheel does. */
    dropdownWheelSelect: boolean;
    /** Collapsing a dock panel writes into the picked saved layout. */
    autoSaveCollapsedPanels: boolean;
    highContrast: boolean;
    strongFocus: boolean;
    colorVisionFilter: ColorVisionFilter;
    largerText: boolean;
    largerControls: boolean;
    lowercaseHeadings: boolean;
    reduceTransparency: boolean;
    /** Also follow the OS's own accessibility preferences. */
    syncOSAccessibility: boolean;
    /** On-canvas keyboard editing for direct-manipulation tools. */
    keyboardCanvasEditing: boolean;
    colorOverrides: ColorOverrides;
    /** Draw the selection and focus rings in the canvas editors. */
    editingHighlights: boolean;
    restoreLastProject: boolean;
    /** Pixels, 120–360. */
    defaultGridSize: number;
    defaultSortField: SortField;
    defaultSortDirection: SortDirection;
    confirmRemovePhotos: boolean;
    showSubfolderPhotos: boolean;
    previewSource: PreviewSource;
    thumbMaxEdge: 320 | 640 | 960;
    persistPreviews: boolean;
    /** Where a project's .safelight working folder lives: beside the photos, or
     *  under externalCatalogDir. */
    catalogLocation: "in-folder" | "external";
    /** "" = the app's own data directory. */
    externalCatalogDir: string;
    rawCacheEnabled: boolean;
    rawCachePrefetch: boolean;
    rawCacheMaxEdge: 2048 | 3072 | 4096;
    developMaxEdge: 2560 | 3072 | 4096 | 6144 | 8192;
    /** GPU memory budget (bytes) for resident decoded RAW sources. */
    gpuSourceCacheBytes: number;
    developPrefetchNeighbors: boolean;
    highBitDepth: boolean;
    liveHistogram: boolean;
    developOpenZoom: "fit" | "100";
    /** The monitor's ICC profile the Develop view converts to (Linux); "" = none. */
    displayProfilePath: string;
    exportFormat: ExportFormatPref;
    /** 1–100. */
    exportQuality: number;
    /** null = original size. */
    exportLongEdge: number | null;
    exportBundle: boolean;
    exportColorSpace: ColorSpaceId;
    exportTiffBitDepth: 8 | 16;
    exportPngBitDepth: 8 | 16;
    exportIncludeMetadata: boolean;
    exportIncludeLocation: boolean;
    exportIfExists: "number" | "replace";
    exportPresets: ExportPreset[];
    singleKeyShortcuts: boolean;
    extensionTopic: string;
    checkExtensionUpdates: boolean;
    autoUpdateExtensions: boolean;
    onlyVerifiedExtensions: boolean;
    extensionsMaximized: boolean;
    checkForUpdates: boolean;
    updateChannel: UpdateChannel;
}

/** A folder the OS asked Safelight to open (a file manager's "Open with", a
 *  folder dropped on the app), and the photo in it to select. */
export interface NativeOpenTarget {
    /** Absolute path of the folder to open as the project. */
    folder: string;
    /** File name of the photo to select in it; null when a folder was given. */
    file: string | null;
}

export interface RecentProject {
    /** Stable key: absolute path (desktop) or folder name (browser). */
    id: string;
    name: string;
    /** Absolute path on the desktop, null in the browser. */
    path: string | null;
    /** Directory handle in the browser, null on the desktop. */
    handle: FileSystemDirectoryHandle | null;
    openedAt: number;
    /** The welcome card's cover. */
    cover: Blob | null;
}

export interface ProjectState {
    root: FileSystemDirectoryHandle | null;
    name: string;
    tree: FolderNode | null;
    opening: boolean;
    /** New-file import progress; importTotal is 0 when not importing. */
    importDone: number;
    importTotal: number;
    /** Blocking message shown when opening a folder failed; null = no error. */
    openError: string | null;
    /** Whether openError is about a folder Safelight can't write to. */
    openErrorReadOnly: boolean;
    /** The recent project whose folder openError says is unavailable; null otherwise. */
    openErrorRecentId: string | null;
    /** Bumped when the recent projects list changes, so a view can re-read it. */
    recentsRevision: number;
    /** Removes openErrorRecentId from the recent projects and dismisses openError. */
    removeFailedRecent: () => Promise<void>;
    /** Notice that a read-only folder's catalogue was redirected elsewhere. */
    storageNotice: string | null;
    /** Why the last catalogue save failed, while saves keep failing; null = saved. */
    saveError: string | null;
    dismissOpenError: () => void;
    dismissStorageNotice: () => void;
    /** Folder picker → open as project. Must run within a user gesture. */
    openProjectPicker: () => Promise<void>;
    openProject: (handle: FileSystemDirectoryHandle) => Promise<void>;
    openRecent: (entry: RecentProject) => Promise<void>;
    openLast: () => Promise<void>;
    openFromOs: (target: NativeOpenTarget) => Promise<void>;
    reconnectLast: () => Promise<boolean>;
    /** Cancel an in-progress import; imported photos are kept. */
    stopImport: () => void;
    /** Close the project and return to the welcome screen. */
    closeProject: () => void;
    /** Re-walk the open folder's directories and refresh the tree. */
    refreshTree: () => Promise<void>;
}

/** The id of the active theme, layout or display transform. */
export interface ActiveIdState {
    activeId: string;
}

// src/extensions/api/native-bridge.ts

/** One "separate" catalogue folder, as listed by the Preferences manager. */
export interface ExternalCatalogEntry {
    /** The per-source folder on disk — the reveal / delete target. */
    path: string;
    /** Folder leaf, e.g. "DCIM-1a2b3c4d" (source-name slug + path hash). */
    name: string;
    /** The source folder this catalogue was created for, or null if unrecorded
     *  (catalogues created before source.json was written). */
    sourcePath: string | null;
    /** Creation time (ms since epoch), or null if unrecorded. */
    createdAt: number | null;
    /** Total size on disk in bytes (catalogue + previews + RAW cache). */
    bytes: number;
    /** Last-modified time of the folder (ms since epoch), 0 if unknown. */
    mtimeMs: number;
    /** What the source held when the catalogue was last opened, to tell apart the
     *  catalogues of cards mounted at one path: how many photos, when, and the
     *  names of a few. Null / empty when unrecorded. */
    photoCount?: number | null;
    lastOpenedAt?: number | null;
    sampleNames?: string[];
}

/** Raw filesystem access by absolute path. Privileged: handed to core exactly
 *  once at boot via claimPrivileged() and never left on the page global, because
 *  extension code shares the renderer realm and could otherwise read/write/delete
 *  any file. Backs the path-based handle adapters (src/project/native-fs.ts). */
export interface NativeFsBridge {
    /** Read a file. With `range`, only bytes [start, end) are read, clipped to the
     *  file's end; `size` is always the whole file's. */
    read(path: string, range?: {
        start: number;
        end: number;
    }): Promise<{
        data: Uint8Array;
        mtimeMs: number;
        size: number;
    }>;
    write(path: string, data: Uint8Array): Promise<void>;
    /** A folder's entries. A link is listed as what it points to, and a broken one
     *  as a folder whose own listing fails; a folder link back above `path`, or into
     *  the project folder `root` when given, is left out. With `withSizes`, `size` is
     *  a file's size in bytes, when it could be read; without it the files aren't
     *  stat'ed, which saves a round trip each on a network share. */
    list(path: string, root?: string, withSizes?: boolean): Promise<{
        name: string;
        kind: "file" | "directory";
        size?: number;
    }[]>;
    mkdir(path: string): Promise<void>;
    /** Resolve a separate .safelight working directory for a project folder, under
     *  `baseOverride` or the app's data dir, keyed by the source path so each folder
     *  keeps its own catalogue. With `create` (default true) the directory is created
     *  and its path returned; with `create === false` it's an existence probe that
     *  returns the path only if a catalogue already lives there, else null. `variant`
     *  (default 1) picks the source's further catalogues, for another card mounted at
     *  the same path. Absent on older Electron builds — callers must feature-detect. */
    externalCatalogDir?(rootPath: string, baseOverride?: string | null, create?: boolean, variant?: number): Promise<string | null>;
    /** The `variant`s of a project folder's separate catalogues under `baseOverride`
     *  (or the app data dir) that hold a catalogue, ascending. Absent on older
     *  Electron builds — feature-detect. */
    externalCatalogVariants?(rootPath: string, baseOverride?: string | null): Promise<number[]>;
    /** List the "separate" catalogues stored under `baseOverride` (or the app data
     *  dir) for the Preferences manager. Each entry's `path` is the per-source
     *  folder to reveal or delete. Absent on older Electron builds — feature-detect. */
    listExternalCatalogs?(baseOverride?: string | null): Promise<ExternalCatalogEntry[]>;
    /** Spillover pointer: record / look up / clear which separate catalogue a
     *  read-only source spilled into. Stored under the app-data default (not the
     *  configured base), so a later writeable open can fold the spillover back no
     *  matter which "Separate catalogue location" is set then. Absent on older
     *  Electron builds — feature-detect. */
    setSpilloverPointer?(rootPath: string, spilloverDir: string): Promise<void>;
    getSpilloverPointer?(rootPath: string): Promise<string | null>;
    clearSpilloverPointer?(rootPath: string): Promise<void>;
    remove(path: string): Promise<void>;
    /** Move a path to the OS trash (Recycle Bin) instead of deleting it outright.
     *  Absent on older Electron builds — callers must feature-detect. */
    trash?(path: string): Promise<void>;
    move(src: string, dest: string): Promise<void>;
    exists(path: string): Promise<boolean>;
    pickDirectory(): Promise<string | null>;
    /** Pick one file with the OS dialogue; null when cancelled. Absent on older
     *  Electron builds — feature-detect. */
    pickFile?(filters?: {
        name: string;
        extensions: string[];
    }[]): Promise<string | null>;
    /** Reveal a path in the OS file manager — open a directory, or select a file
     *  inside its parent folder. Resolves true on success. */
    reveal(path: string): Promise<boolean>;
}

/** In-app updater. Privileged: install() fetches and runs a release installer
 *  (arbitrary code execution), so it's claimed at boot rather than exposed. */
export interface NativeUpdatesBridge {
    /** Download and install the asset for `tag` from Safelight's own repo (any
     *  other `repo` is refused), quitting once an installer has started. */
    install(repo: string, tag: string): Promise<void>;
    /** What this copy can offer for a release with these asset names: install
     *  it, or its release page (no asset for this platform, or a copy that
     *  can't install itself: macOS, AppImage, Flatpak, Nix, Arch, a non-package
     *  Linux install). Optional: absent in older Electron builds. */
    support?(assetNames: string[]): Promise<UpdateSupport>;
}

export type UpdateSupport = "install" | "release-page";

/** Window capture for the Report an issue dialogue. Privileged so extensions
 *  can't take silent captures of the whole window. */
export interface NativeCaptureBridge {
    /** The sender window as PNG bytes, long edge at most 1920 px; null when the
     *  window can't be captured (minimized, some Wayland setups). */
    page(): Promise<Uint8Array<ArrayBuffer> | null>;
}

/** A child or renderer process the main process saw die this launch. */
export interface NativeCrashRecord {
    time: number;
    /** Electron's process type ("GPU", "Utility", …) or "renderer". */
    process: string;
    reason: string;
    exitCode: number;
    /** Utility process service name, when Electron gives one. */
    name?: string;
}

/** How Safelight draws. The graphics backend is picked before the window
 *  exists, so a change applies at the next start. */
export interface NativeGpuBackendState {
    /** This launch draws in software (SwiftShader) instead of on the graphics card. */
    software: boolean;
    /** The next launch will draw in software. */
    nextSoftware: boolean;
    /** Why the next launch draws in software: the user picked it ("chosen"),
     *  or the graphics card failed. Null when it uses the graphics card. */
    reason: "chosen" | "webgl2-unavailable" | "gpu-crashes" | "renderer-failed" | null;
    /** The ANGLE backend this launch draws with ("gl", "d3d11", "swiftshader", …). */
    backend: string;
    /** The backend the next launch starts on. */
    next: string;
    /** The backend the user picked, or null for Automatic. */
    choice: string | null;
    /** This platform's backends, in the order Automatic tries them. */
    backends: string[];
}

/** Preferences ▸ Rendering ▸ Graphics backend. Privileged so extensions
 *  can't change how every later launch draws. */
export interface NativeGpuBridge {
    /** Null when the main process reports no backend (a build without the GPU ladder). */
    backend(): Promise<NativeGpuBackendState | null>;
    setSoftware(on: boolean): Promise<NativeGpuBackendState | null>;
    /** Pins one of `backends` for later launches; null goes back to Automatic. */
    setBackend(choice: string | null): Promise<NativeGpuBackendState | null>;
    /** The develop renderer couldn't start on this launch's graphics backend
     *  however often it tried: the next launch draws in software. */
    rendererFailed(detail: string): Promise<NativeGpuBackendState | null>;
}

/** The window's system-drawn backdrop. Privileged so extensions can't change
 *  how the window paints; a theme asks for it through the core. */
export interface NativeWindowBridge {
    /** Resolves true when the window now draws the material; null clears it.
     *  False on a system or backend that can't draw it. */
    setMaterial(material: "acrylic" | "mica" | null): Promise<boolean>;
}

/** The Developer Tools dev folder. Privileged because the folder's manifests
 *  widen the next launch's network policy. */
export interface NativeDevtoolsBridge {
    /** Record the folder (an absolute path, or null for none) with the main
     *  process, which reads its manifests' `permissions.network` at the next
     *  launch the way it reads installed extensions'. Resolves with the declared
     *  origins the current launch's policy does not allow yet. */
    syncDevFolder(folder: string | null): Promise<{
        pending: string[];
    }>;
}

/** Opening what the OS hands the app. Privileged so extensions can't point the
 *  project at a folder of their choosing. */
export interface NativeOsOpenBridge {
    /** The target waiting to be opened, which it then no longer is; null when none. */
    take(): Promise<NativeOpenTarget | null>;
    /** Called when the OS asks for a target while the app runs; `take()` fetches
     *  it. Returns the unsubscribe. */
    onRequest(listener: () => void): () => void;
}

/** Putting extension code on disk and taking it off again. Privileged so one
 *  extension can't install, replace or remove another. */
export interface NativePluginsBridge {
    /** Accepts "owner/repo", "owner/repo#ref", or a github.com URL. With a
     *  `version`, installs that GitHub release instead of the latest. */
    install(spec: string, version?: string): Promise<ExtensionManifest>;
    uninstall(id: string): Promise<void>;
    /** Finish an install/update: "keep" drops the previous version that
     *  install() kept aside; "rollback" puts it back and returns its manifest
     *  (null when there was none — the install is then removed). */
    settleUpdate(id: string, outcome: "keep" | "rollback"): Promise<ExtensionManifest | null>;
}

/** The one-shot privileged bundle returned by claimPrivileged(). */
export interface PrivilegedBridge {
    fs: NativeFsBridge;
    updates: NativeUpdatesBridge;
    /** Optional: absent in older Electron builds. */
    plugins?: NativePluginsBridge;
    /** Optional: absent in older Electron builds. */
    capture?: NativeCaptureBridge;
    /** Optional: absent in older Electron builds. */
    gpu?: NativeGpuBridge;
    /** Optional: absent in older Electron builds. */
    osOpen?: NativeOsOpenBridge;
    /** Optional: absent in older Electron builds. */
    window?: NativeWindowBridge;
    /** Optional: absent in older Electron builds. */
    devtools?: NativeDevtoolsBridge;
}

declare global {
    interface Window {
        /** Extension API (also handy in the devtools console). */
        safelight?: SafelightAPI;
        /** Electron bridge; absent in the plain-browser dev build. */
        safelightNative?: {
            platform: string;
            versions: {
                electron: string;
                chrome: string;
            };
            /** CPU architecture and OS version (`process.getSystemVersion()`).
             *  Optional: absent in older Electron builds. */
            system?: {
                arch: string;
                osVersion: string;
            };
            /** Returns the live version string from package.json (bypasses the Vite build-time constant). */
            appVersion(): Promise<string>;
            /** GitHub Releases API proxy — runs in the main process to bypass the renderer CSP. */
            releases: {
                /** Fetch releases for `owner/repo`. Returns the raw GitHub API array. */
                fetch(repo: string): Promise<{
                    tag_name: string;
                    html_url: string;
                    body: string | null;
                    draft: boolean;
                }[]>;
            };
            /** GitHub repo metadata + README proxy for the Extensions store detail view.
             *  Optional: absent in the plain-browser build and older Electron builds. */
            github?: {
                /** Normalized repo metadata for "owner/repo". */
                repoMeta(repo: string): Promise<ExtensionRepoMeta>;
                /** Raw README text for "owner/repo" at `ref`, or null if none exists. */
                readme(repo: string, ref?: string): Promise<string | null>;
                /** Batch-resolve the best thumbnail for each browse card (manifest icon →
                 *  custom social preview → avatar), in parallel in the main process.
                 *  Returns a { "owner/repo": { url, custom } } map; never rejects. */
                thumbnails(items: {
                    repo: string;
                    avatar: string | null;
                }[], 
                /** Bypass the icon/og caches (the store's ↻) so a just-changed icon or
                 *  social preview is re-resolved instead of served stale. */
                force?: boolean): Promise<Record<string, ExtensionThumbnail>>;
                /** Subscribe to per-repo thumbnails pushed as each resolves (so the grid
                 *  upgrades cards progressively rather than all at once). Returns an
                 *  unsubscribe fn. */
                onThumbnail(cb: (payload: {
                    repo: string;
                    thumb: ExtensionThumbnail;
                }) => void): () => void;
            };
            plugins: {
                list(): Promise<ExtensionManifest[]>;
                /** Browse official extensions. For the default topic this serves the
                 *  prebuilt registry index (one CDN fetch, whole catalogue, baked
                 *  thumbnails); a custom topic — or an unreachable index — falls back to a
                 *  live GitHub Search. Cached; pass `force` to bypass the cache. */
                search(query: string, topic: string, force?: boolean): Promise<ExtensionSearchResult[]>;
                /** The newest version a repo publishes, with its minAppVersion, or
                 *  null: its newest GitHub release (a newer pre-release with
                 *  `prerelease`), or its default branch's safelight.json when it has no
                 *  releases. Read from the registry index when that lists the repo.
                 *  Optional: absent in older Electron builds. */
                remoteManifest?(repo: string, opts?: {
                    prerelease?: boolean;
                }): Promise<RemoteManifest | null>;
                /** The repo's releases, newest first; [] for a repo that publishes from
                 *  its branch. Rejects when GitHub can't be read. Optional: absent in
                 *  older Electron builds. */
                releases?(repo: string, force?: boolean): Promise<ExtensionRelease[]>;
                /** safelight.json at one release's tag, or null. Optional: absent in
                 *  older Electron builds. */
                manifestAt?(repo: string, version: string): Promise<RemoteManifest | null>;
                /** Verified-allowlist + banned-kill-switch lists from the trust
                 *  registry, cached in the main process. Optional: absent in older
                 *  Electron builds (callers then treat everything as unverified). */
                trustList?(force?: boolean): Promise<TrustList>;
                /** The welcome setup's starter kits (kits.json in the trust registry),
                 *  cached in the main process; null when it was never fetched. Typed
                 *  unknown because it is remote data: parseKits validates it before
                 *  anything reads it. Optional: absent in older Electron builds. */
                kits?(force?: boolean): Promise<unknown>;
                /** The store's category vocabulary from the registry index, or null
                 *  when the index or its vocabulary is unavailable. Optional: absent in
                 *  older Electron builds. */
                vocabulary?(): Promise<StoreVocabulary | null>;
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
                metrics(): Promise<{
                    type: string;
                    pid: number;
                    cpuPercent: number;
                    memoryMB: number;
                }[]>;
                /** Processes that died this launch, oldest first. Optional: absent
                 *  in older Electron builds. */
                crashes?(): Promise<NativeCrashRecord[]>;
            };
            /** Opens a prefilled Safelight new-issue page in the system browser.
             *  Links too long for the OS hand-off travel through a one-shot local
             *  redirect. Rejects for any other URL. Optional: absent in older
             *  Electron builds. */
            report?: {
                openIssue(url: string): Promise<void>;
            };
            /** Recolor the native window-controls overlay (Windows/Linux) to follow
             *  the active theme and size to the Interface scale; on macOS it only
             *  re-centres the traffic lights. */
            titlebar?: {
                setOverlay(color: string, symbolColor: string, uiScale?: number): Promise<void>;
            };
            /** One-shot handover of the privileged fs + update-installer surface.
             *  Returns the bundle on the first call (core, at boot) and null after, so
             *  extension code — which shares the renderer realm — can never acquire it.
             *  Optional: absent in the plain-browser build and older Electron builds. */
            claimPrivileged?(): PrivilegedBridge | null;
        };
    }
}

// src/extensions/api/variables.ts

/** Who made a write or a registration. */
export interface VariableWriter {
    /** Extension id; Developer Tools' Edit value writes as its own. */
    extension: string;
    /** The window it happened in. */
    window: string;
}

/** Orders writes across windows: the higher `n` wins, and an equal `n` is
 *  broken by window id, so every window picks the same winner. */
export interface VariableRevision {
    n: number;
    window: string;
}

export interface VariableSnapshot<T> {
    name: string;
    /** Deep-frozen: change it with set() or update(), never in place. */
    value: T;
    revision: VariableRevision;
    writer: VariableWriter;
    registeredBy: VariableWriter;
    description?: string;
}

export type VariableWriteResult<T> = {
    ok: true;
    revision: VariableRevision;
} | {
    ok: false;
    reason: "stale";
    current: VariableSnapshot<T>;
} | {
    ok: false;
    reason: "unregistered";
} | {
    ok: false;
    reason: "invalid";
    message: string;
};

/** Named JSON values every extension can share, in every window. Values are
 *  plain JSON data (objects, arrays, strings, finite numbers, booleans, null)
 *  and last for the session. Writes use optimistic locking: an extension's
 *  set() is refused when another writer changed the variable after the latest
 *  revision this extension saw (through register, get, a subscriber delivery,
 *  or its own write). Refusals and lost cross-window races are logged as
 *  `[variables]` warnings, which Developer Tools' Issues tab shows. */
export interface SharedVariablesAPI {
    /** Make `name` exist. Idempotent: the first registration's `initial` and
     *  `description` win; a later call (any extension, any window) joins and
     *  gets the current snapshot. Throws on an invalid or reserved name, or an
     *  `initial` that isn't JSON data, or a `description` that isn't a string. */
    register<T>(name: string, init: {
        initial: T;
        description?: string;
    }): VariableSnapshot<T>;
    /** The current snapshot, or undefined when nobody has registered `name`. */
    get<T>(name: string): VariableSnapshot<T> | undefined;
    /** Called with the current snapshot if `name` exists (right away, or right
     *  after a delivery in progress), else on registration; then on every
     *  accepted write, local or from another window, in revision order. Returns
     *  the unsubscribe function. A listener that throws is logged; the others
     *  still run. */
    subscribe<T>(name: string, listener: (snapshot: VariableSnapshot<T>) => void): () => void;
    /** Write `value`. Refused as "stale" when another writer changed the
     *  variable after the latest revision this extension saw in this window. */
    set<T>(name: string, value: T): VariableWriteResult<T>;
    /** Read-modify-write: `fn` runs synchronously on the latest value and its
     *  result is written, so it is never "stale" within a window. A throwing
     *  `fn`, or one that returns a Promise, writes nothing ("invalid"). */
    update<T>(name: string, fn: (current: T) => T): VariableWriteResult<T>;
}

// src/catalog/develop-params.ts

export interface CurvePoint {
    x: number;
    y: number;
}

declare const TONE_CURVE_CHANNELS: readonly ["rgb", "red", "green", "blue"];

export type ToneCurveChannel = (typeof TONE_CURVE_CHANNELS)[number];

export interface ToneCurves {
    rgb: CurvePoint[];
    red: CurvePoint[];
    green: CurvePoint[];
    blue: CurvePoint[];
}

export interface CropRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

declare const HSL_CHANNELS: readonly ["red", "orange", "yellow", "green", "aqua", "blue", "purple", "magenta"];

export type HSLChannel = (typeof HSL_CHANNELS)[number];

export type HSLValues = Record<HSLChannel, number>;

export interface HSLAdjustments {
    hue: HSLValues;
    saturation: HSLValues;
    luminance: HSLValues;
}

export interface TransformParams {
    perspectiveV: number;
    perspectiveH: number;
    aspect: number;
    scale: number;
    offsetX: number;
    offsetY: number;
    flipH: boolean;
    flipV: boolean;
}

export type UprightMode = "off" | "auto" | "level" | "vertical" | "full" | "guided";

export interface GuidedLine {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
}

export interface ColorGradingRange {
    hue: number;
    sat: number;
    luma: number;
}

export interface ColorGradingParams {
    shadows: ColorGradingRange;
    midtones: ColorGradingRange;
    highlights: ColorGradingRange;
    global: ColorGradingRange;
    shadowRange: number;
    highlightRange: number;
}

export interface VignetteParams {
    amount: number;
    midpoint: number;
    roundness: number;
    feather: number;
    highlights: number;
}

export interface GrainParams {
    amount: number;
    size: number;
    roughness: number;
    color: number;
}

export interface MaskAdjustments {
    exposure: number;
    contrast: number;
    highlights: number;
    shadows: number;
    whites: number;
    blacks: number;
    saturation: number;
    vibrance: number;
    temperature: number;
    tint: number;
    texture: number;
    clarity: number;
    dehaze: number;
    sharpness: number;
}

export type MaskType = "linear" | "radial" | "brush";

export interface BrushDab {
    x: number;
    y: number;
    radius: number;
    erase: boolean;
    feather: number;
    opacity?: number;
    flow?: number;
    strokeStart?: boolean;
    tip?: string;
    angle?: number;
}

export interface LinearMaskGeo {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
}

export interface RadialMaskGeo {
    cx: number;
    cy: number;
    rx: number;
    ry: number;
    feather: number;
    angle: number;
}

export interface BrushMaskGeo {
    dabs: BrushDab[];
    feather: number;
}

export interface LumRangeGeo {
    lo: number;
    hi: number;
    loFeather: number;
    hiFeather: number;
}

export interface ColorRangeGeo {
    r: number;
    g: number;
    b: number;
    hueRange: number;
    satRange: number;
    smoothness: number;
}

export type MaskComponentKind = MaskType | "lumRange" | "colorRange";

export type MaskComponentMode = "add" | "subtract" | "intersect";

export interface MaskComponent {
    id: string;
    kind: MaskComponentKind;
    mode: MaskComponentMode;
    invert: boolean;
    linear?: LinearMaskGeo;
    radial?: RadialMaskGeo;
    brush?: BrushMaskGeo;
    lumRange?: LumRangeGeo;
    colorRange?: ColorRangeGeo;
}

export interface Mask {
    id: string;
    name: string;
    visible: boolean;
    invert: boolean;
    opacity: number;
    adj: MaskAdjustments;
    panels: string[];
    hsl?: HSLAdjustments;
    toneCurve?: ToneCurves;
    /** Mask-scoped extension params, keyed by qualified key ("{stageId}.{key}")
     *  like DevelopParams.paramBag. Extension sub-panels store their values here,
     *  and a maskable stage with any key here runs once more inside this mask
     *  with these values (version 2 and later; mask-stage-instances.ts).
     *  Unknown keys are preserved, mirroring the global bag. */
    bag?: Record<string, unknown>;
    components: MaskComponent[];
}

export interface RetouchSpot {
    id: string;
    shape: "circle" | "brush";
    mode: "heal" | "clone";
    visible: boolean;
    dstX: number;
    dstY: number;
    srcX: number;
    srcY: number;
    radius: number;
    feather: number;
    opacity: number;
    angle?: number;
    scale?: number;
    recolorR?: number;
    recolorG?: number;
    recolorB?: number;
    dabs?: BrushDab[];
}

export interface DevelopParams {
    exposure: number;
    contrast: number;
    highlights: number;
    shadows: number;
    highlightDetail: number;
    shadowDetail: number;
    whites: number;
    blacks: number;
    texture: number;
    clarity: number;
    dehaze: number;
    sharpening: number;
    sharpenRadius: number;
    sharpenDetail: number;
    sharpenMasking: number;
    luminanceNR: number;
    luminanceNRDetail: number;
    luminanceNRContrast: number;
    luminanceNRShadows: number;
    luminanceNRHighlights: number;
    colorNR: number;
    colorNRDetail: number;
    colorNRSmoothness: number;
    vibrance: number;
    saturation: number;
    temperature: number;
    tint: number;
    straighten: number;
    crop: CropRect;
    transform: TransformParams;
    uprightMode: UprightMode;
    guidedLines: GuidedLine[];
    toneCurve: ToneCurves;
    hsl: HSLAdjustments;
    colorGrading: ColorGradingParams;
    vignette: VignetteParams;
    grain: GrainParams;
    masks: Mask[];
    retouch: RetouchSpot[];
    /** Display transform (tone mapper) picked for this photo, by pipeline id,
     *  or null to follow the Preferences default. Resolved by
     *  resolvePipelineFor in extensions/pipelines.ts. */
    displayTransform: string | null;
    /** The rendering generation this edit was made with. Edits saved before
     *  process versions existed carry none and read as LEGACY_PROCESS_VERSION,
     *  so they render exactly as they always have; new edits get
     *  CURRENT_PROCESS_VERSION. Presets and pasted settings never change it. */
    processVersion: number;
}

// src/extensions/api/export.ts

export type ExportFormat = "image/jpeg" | "image/png" | "image/webp" | "image/tiff";

export type DeliveryMode = "zip" | "files" | "folder";

/** Per-processor settings, keyed by export processor id. */
export type ProcessorSettings = Record<string, Record<string, unknown>>;

export interface ExportSettings {
    format: ExportFormat;
    /** 0..1, used by JPEG and WebP (ignored for PNG). */
    quality: number;
    /** null = original (largest decodable) size. */
    longEdge: number | null;
    /** @deprecated Use delivery instead */
    bundle: boolean;
    delivery: DeliveryMode;
    /** Output colour space (pixel convert + embedded ICC). Defaults to sRGB. */
    colorSpace?: ColorSpaceId;
    /** Current values for each registered export processor, keyed by processor
     *  id. Missing keys fall back to the processor's declared field defaults. */
    processorSettings?: ProcessorSettings;
    /** Active filename template id (from a FilenameTemplateContribution), or
     *  undefined to use the built-in base-name + extension behaviour. */
    filenameTemplateId?: string;
    /** Output sharpening amount (0–150). 0 disables sharpening. */
    sharpenAmount?: number;
    /** Output sharpening radius in pixels (0.3–3.0). */
    sharpenRadius?: number;
    /** Bits per sample for TIFF export. 16-bit falls back to 8-bit where the
     *  device can't render a 16-bit frame. Ignored for non-TIFF formats. */
    tiffBitDepth?: 8 | 16;
    /** Bits per sample for PNG export, 8 unless asked. 16-bit falls back to
     *  8-bit where the device can't render a 16-bit frame. Ignored for non-PNG
     *  formats. */
    pngBitDepth?: 8 | 16;
    /** Carry the source photo's EXIF (camera, lens, exposure, capture date)
     *  into the exported file. Off unless enabled. */
    includeMetadata?: boolean;
    /** Keep GPS location tags when metadata is included. Also off unless
     *  enabled. */
    includeLocation?: boolean;
    /** A folder export's answer to a file of the same name already there:
     *  "number" writes beside it as "name (2).ext", "replace" writes over it.
     *  The original of a photo in the catalogue is never replaced; it gets a
     *  number either way. Left out, the Preference decides. */
    ifExists?: "number" | "replace";
}

/** The output an export asks for, as an export processor is told it: the
 *  export settings without the delivery, the filename template or the
 *  processors' own settings. */
export type ExportOutput = Pick<ExportSettings, "format" | "quality" | "longEdge" | "colorSpace" | "tiffBitDepth" | "pngBitDepth" | "sharpenAmount" | "sharpenRadius" | "includeMetadata" | "includeLocation">;

export interface ExportProgress {
    done: number;
    total: number;
    filename: string;
}

export interface ExportResult {
    exported: number;
    /** Filenames that could not be rendered. */
    failed: string[];
    /** Why some of them failed, worded for the user, where that is known. */
    failures?: {
        filename: string;
        reason: string;
    }[];
    /** Count of photos whose 16-bit export fell back to 8-bit because the
     *  device can't render or read back a 16-bit frame. */
    degradedTo8Bit: number;
    /** Count of photos whose 16-bit export was drawn at reduced precision (half
     *  float) because the device can't render to a full-precision target. */
    reducedPrecision: number;
    /** True when a requested ZIP overflowed the ZIP32 limits and the batch was
     *  delivered as individual files instead. */
    zipFellBack?: boolean;
    /** True when the caller's signal ended the batch before every photo was
     *  tried. `exported` counts what was done by then. */
    cancelled?: true;
    /** Why the batch ended early on a failure that every later photo would meet
     *  too (a full disk, a read-only folder, a graphics driver that stopped),
     *  worded for the user. */
    stopped?: string;
    /** Count of the exported photos drawn without an extension's effect because
     *  it couldn't run on this graphics card: its shader failed to build during
     *  the batch, or it got no texture unit or layer. */
    withoutStages?: number;
}

/** What a headless render (api.export.renderPhotos) takes beyond the export
 *  settings. */
export interface RenderPhotosOptions {
    /** Merged over each photo's own extension-stage params for this render
     *  only. */
    paramBag?: Record<string, unknown>;
    /** Stop before the next photo once this fires. The photos not reached are
     *  left out of the result. */
    signal?: AbortSignal;
    /** Run the registered export processors (a watermark, say) on each render.
     *  Defaults to true. Pass false for a frame you use as source pixels rather
     *  than as a delivered file. */
    processors?: boolean;
}

/** What a batch export takes beyond the photos and settings. */
export interface ExportPhotosOptions {
    /** Stop before the next photo once this fires. The result says how many were
     *  exported and `cancelled`. A ZIP in progress is delivered with what it holds. */
    signal?: AbortSignal;
}

export interface RenderedPhoto {
    photo: CatalogPhoto;
    /** The rendered image, or null if the photo couldn't be decoded/rendered. */
    blob: Blob | null;
    /** The encoded image's pixel size (0 when blob is null). */
    width: number;
    height: number;
}

/** The settings proPhotoAt8Bit reads. */
export type BitDepthSettings = Pick<ExportSettings, "format" | "tiffBitDepth" | "pngBitDepth" | "colorSpace">;

// src/rendering/color-space.ts

export type ColorSpaceId = "srgb" | "display-p3" | "adobe-rgb" | "prophoto-rgb";

/** The spaces a screen frame can encode for: the ones a canvas can be tagged with. */
export type DisplaySpace = Extract<ColorSpaceId, "srgb" | "display-p3">;

// src/extensions/api/components.ts

export interface PanelProps {
    title: string;
    defaultOpen?: boolean;
    children: ReactNode;
}

export interface SliderProps {
    label: string;
    /** Accessible name when `label` is intentionally empty. */
    ariaLabel?: string;
    /** Slider-icon contribution id (e.g. "core.exposure"); renders nothing if
     *  unregistered. */
    icon?: string;
    value: number;
    min?: number;
    max?: number;
    step?: number;
    /** Double-clicking the track resets to this. */
    defaultValue?: number;
    /** Hide the editable numeric field. */
    hideValue?: boolean;
    /** Narrow label and value, for tight columns. */
    compact?: boolean;
    /** CSS background for the track (e.g. a hue gradient), drawn with a thumb
     *  marker instead of the filled bar. */
    trackBackground?: string;
    onChange: (value: number) => void;
    onCommit?: () => void;
    /** Fired with true while a drag is held with Alt or Ctrl down, and false
     *  when that ends. */
    onModifierPreview?: (active: boolean) => void;
}

/** Tonal zones across the histogram, left (dark) to right (light). */
export type HistogramZone = "blacks" | "shadows" | "exposure" | "highlights" | "whites";

export interface HistogramProps {
    data: HistogramData | null;
    onAdjust?: (zone: HistogramZone, deltaPx: number, phase: "start" | "move" | "end") => void;
    onReset?: (zone: HistogramZone) => void;
    showClipping?: ClippingMask;
    onToggleClipping?: () => void;
    onSetClipping?: (mode: ClippingMask) => void;
}

export interface CurveEditorProps {
    curves: ToneCurves;
    onChange: (channel: ToneCurveChannel, points: CurvePoint[]) => void;
    onCommit: () => void;
    /** Compact mode for embedding inside another panel (mask sub-panels). */
    compact?: boolean;
    /** Show the selected point's In/Out row even without keyboard canvas editing. */
    showPointValues?: boolean;
}

/** Callbacks take the photo id, so one stable function serves every cell. */
export interface ThumbnailProps {
    photo: CatalogPhoto;
    selected: boolean;
    active: boolean;
    size: number;
    onClick: (id: string, e: MouseEvent) => void;
    onDoubleClick?: (id: string) => void;
    onContextMenu?: (id: string, e: MouseEvent) => void;
    onRatingChange?: (id: string, rating: number) => void;
    onDragStart?: (id: string, e: DragEvent) => void;
}

export interface PhotoListRowProps {
    photo: CatalogPhoto;
    selected: boolean;
    active: boolean;
    /** Drop the dimension and camera columns, for rows in a narrow container. */
    compact?: boolean;
    onClick: (id: string, e: MouseEvent) => void;
    onDoubleClick: (id: string) => void;
    onContextMenu?: (id: string, e: MouseEvent) => void;
    onDragStart?: (id: string, e: DragEvent) => void;
}

export interface ContextMenuItem {
    label: string;
    onClick: () => void;
    /** Render in the red danger colour (e.g. Remove). */
    danger?: boolean;
    disabled?: boolean;
}

/** A horizontal divider between groups of items. */
export type ContextMenuEntry = ContextMenuItem | "separator";

export interface ContextMenuProps {
    x: number;
    y: number;
    items: ContextMenuEntry[];
    onClose: () => void;
}

export interface ScaleStepperProps {
    value: number;
    onChange: (value: number) => void;
    label: string;
}

export interface SlotProps {
    name: SlotName;
    fallback?: ReactNode;
}

export interface MaskScopeProps {
    maskId: string;
    children: ReactNode;
}

export interface DevelopCanvasProps {
    /** The view's zoom: null fits the photo, 1 is 100%. */
    zoom: number | null;
    onZoomChange(zoom: number | null): void;
    /** Shown in the surround while no photo is open. */
    empty?: ReactNode;
}

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: ButtonVariant;
    size?: "sm" | "md";
    /** Render as the selected/active state (accent fill), overriding the variant. */
    active?: boolean;
    /** Stretch to the container width. */
    full?: boolean;
}

export interface SelectOption {
    value: string;
    label: string;
    disabled?: boolean;
}

export interface SelectGroup {
    /** Optional heading shown above the group (like <optgroup label>). */
    title?: string;
    items: SelectOption[];
}

export interface SelectProps {
    value: string;
    onChange: (value: string) => void;
    /** Flat options, or `groups` for headed sections. */
    options?: SelectOption[];
    groups?: SelectGroup[];
    placeholder?: string;
    disabled?: boolean;
    className?: string;
    ariaLabel?: string;
    title?: string;
}

export interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value"> {
    value: string;
    onChange: (value: string) => void;
}

export interface NumberInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value" | "type"> {
    value: number;
    onChange: (value: number) => void;
    /** CSS width (e.g. "54px"); defaults to a compact fixed width. */
    width?: string;
}

export interface TextAreaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "onChange" | "value"> {
    value: string;
    onChange: (value: string) => void;
    /** Use the monospace font (for code / SVG markup). */
    mono?: boolean;
}

export interface ToggleProps {
    checked: boolean;
    onChange: (checked: boolean) => void;
    /** Optional inline label shown before the switch. */
    label?: ReactNode;
    ariaLabel?: string;
}

export interface SegmentedOption {
    value: string;
    label: ReactNode;
    title?: string;
}

export interface SegmentedControlProps {
    value: string;
    onChange: (value: string) => void;
    options: SegmentedOption[];
    size?: "sm" | "md";
}

export interface FieldProps {
    label?: ReactNode;
    hint?: ReactNode;
    children: ReactNode;
}

export interface SectionProps {
    title: ReactNode;
    /** Optional control rendered at the right of the section header. */
    right?: ReactNode;
    children: ReactNode;
}

export interface CardProps {
    children: ReactNode;
    className?: string;
}

export interface BadgeProps {
    children: ReactNode;
    /** Explicit background colour; defaults to a neutral surface chip. */
    color?: string;
}

export interface ProgressBarProps {
    /** 0..1. */
    value: number;
}

export interface StackProps {
    children: ReactNode;
    /** Gap in pixels. */
    gap?: number;
    style?: CSSProperties;
}

export interface RowProps {
    children: ReactNode;
    gap?: number;
    align?: CSSProperties["alignItems"];
    justify?: CSSProperties["justifyContent"];
    wrap?: boolean;
    style?: CSSProperties;
}

/** The canonical theme CSS-variable strings, for the rare inline-style case. */
export interface UITokens {
    readonly surface0: "var(--color-surface-0)";
    readonly surface1: "var(--color-surface-1)";
    readonly surface2: "var(--color-surface-2)";
    readonly surface3: "var(--color-surface-3)";
    readonly surface4: "var(--color-surface-4)";
    readonly border: "var(--color-border)";
    readonly borderSubtle: "var(--color-border-subtle)";
    readonly textPrimary: "var(--color-text-primary)";
    readonly textSecondary: "var(--color-text-secondary)";
    readonly textMuted: "var(--color-text-muted)";
    readonly accent: "var(--color-accent)";
    readonly accentHover: "var(--color-accent-hover)";
    readonly sliderFill: "var(--color-slider-fill)";
    readonly rating: "var(--color-rating)";
    readonly labelRed: "var(--color-label-red)";
    readonly labelYellow: "var(--color-label-yellow)";
    readonly labelGreen: "var(--color-label-green)";
    readonly labelBlue: "var(--color-label-blue)";
    readonly labelPurple: "var(--color-label-purple)";
    readonly white: "var(--color-white)";
    readonly fontMono: "var(--font-mono)";
    readonly fontCode: "var(--font-code)";
}

export interface UIKit {
    Button: (props: ButtonProps) => JSX.Element;
    Select: (props: SelectProps) => JSX.Element;
    TextInput: (props: TextInputProps) => JSX.Element;
    NumberInput: (props: NumberInputProps) => JSX.Element;
    TextArea: (props: TextAreaProps) => JSX.Element;
    Toggle: (props: ToggleProps) => JSX.Element;
    SegmentedControl: (props: SegmentedControlProps) => JSX.Element;
    Field: (props: FieldProps) => JSX.Element;
    Section: (props: SectionProps) => JSX.Element;
    Card: (props: CardProps) => JSX.Element;
    Badge: (props: BadgeProps) => JSX.Element;
    ProgressBar: (props: ProgressBarProps) => JSX.Element;
    Stack: (props: StackProps) => JSX.Element;
    Row: (props: RowProps) => JSX.Element;
    tokens: UITokens;
}

export interface DevFolderControlsProps {
    /** Laid out for the Developer Tools tab or a settings dialogue. */
    variant: "tab" | "settings";
}

// src/ui/components/Rating.ts

export interface RatingProps {
    value: number;
    onChange?: (rating: number) => void;
    size?: "sm" | "md";
}

declare function Rating({ value, onChange, size }: RatingProps): import("react").JSX.Element;

// src/modules/export/ResolutionControl.ts

declare const VARIANTS: {
    panel: {
        container: string;
        input: string;
        chip: (active: boolean) => string;
    };
    preferences: {
        container: string;
        input: string;
        chip: (active: boolean) => string;
    };
};

declare function ResolutionControl({ value, onChange, variant, }: {
    value: number | null;
    onChange: (v: number | null) => void;
    variant: keyof typeof VARIANTS;
}): import("react").JSX.Element;

// src/ui/components/VirtualGrid.ts

export interface VirtualGridProps<T> {
    items: T[];
    /** Cell width in pixels (ignored when columns=1 — cells stretch to fill). */
    cellWidth?: number;
    /** Cell height in pixels. */
    cellHeight: number;
    /** Gap between cells in pixels. */
    gap?: number;
    /** Padding around the grid in pixels. */
    padding?: number;
    /** Fixed column count. When omitted, columns are calculated from container width. */
    columns?: number;
    /** Rows of extra cells to render above and below the viewport. */
    overscan?: number;
    /** Render a single cell. The wrapper handles positioning. */
    renderCell: (item: T, index: number) => React.ReactNode;
    /** Stable key extractor. */
    getKey: (item: T) => string;
    /** Index to keep visible (keyboard navigation). Scrolls into view when it changes. */
    scrollToIndex?: number;
    /** Notified whenever the computed column count changes (for row-wise nav). */
    onColumnsChange?: (columns: number) => void;
    /** Click on the scroll container (e.g. empty space between/around cells). */
    onClick?: (e: React.MouseEvent) => void;
    className?: string;
    /** ARIA role of the scroll container, e.g. "listbox" when cells render as options. */
    role?: "listbox";
    "aria-label"?: string;
}

declare function VirtualGrid<T>({ items, cellWidth, cellHeight, gap, padding, columns: fixedColumns, overscan, renderCell, getKey, scrollToIndex, onColumnsChange, onClick, className, role, "aria-label": ariaLabel, }: VirtualGridProps<T>): import("react").JSX.Element;

// src/ui/ZoomControls.ts

declare function ZoomControls({ zoom, onChange, }: {
    zoom: number | null;
    onChange: (zoom: number | null) => void;
}): import("react").JSX.Element;

// src/ui/components/PickerIcon.ts

export interface PickerIconProps {
    size?: number;
}

declare function PickerIcon({ size }: PickerIconProps): import("react").JSX.Element;

// src/ui/components/AutoButton.ts

export interface AutoButtonProps {
    onClick: () => void;
    disabled?: boolean;
    title?: string;
}

declare function AutoButton({ onClick, disabled, title }: AutoButtonProps): import("react").JSX.Element;

// src/ui/components/ConfirmDialog.ts

export interface ConfirmDialogOptions {
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    /** "danger" paints the confirm button in the destructive red and opens with
     *  Cancel focused — reserve it for actions that destroy data (deleting files,
     *  irreversible removals). */
    variant?: "default" | "danger";
}

export type AlertDialogOptions = Pick<ConfirmDialogOptions, "title" | "message" | "confirmLabel">;

declare function confirmDialog(options: ConfirmDialogOptions): Promise<boolean>;

declare function alertDialog(options: AlertDialogOptions): Promise<void>;

// src/state/presets-store.ts

export interface Preset {
    id: string;
    name: string;
    /** Optional group/folder name. Presets without a group render ungrouped. */
    group?: string;
    /** Only the adjustments this preset carries. Applying merges these over the
     *  photo's current params (Lightroom-style partial presets), so a preset can
     *  hold as little as a single slider. Older full-snapshot presets simply carry
     *  every key. */
    params: Partial<DevelopParams>;
    /** Extension-contributed processing-stage params (e.g. denoise), keyed by
     *  qualified key. Stored whole; merged over the photo's current bag on apply.
     *  Absent on older presets and on file-imported presets. */
    paramBag?: Record<string, unknown>;
}

export interface PresetsState {
    presets: Preset[];
    /** Returns false, leaving the list unchanged, when the preset couldn't be saved
     *  (storage full): it would otherwise vanish on the next launch. */
    add: (name: string, params: Partial<DevelopParams>, group?: string, paramBag?: Record<string, unknown>) => boolean;
    /** Replace an existing preset's params/group in place (keeps id, name, position).
     *  Returns false, leaving the preset as it was, when the change couldn't be saved. */
    update: (id: string, params: Partial<DevelopParams>, group?: string, paramBag?: Record<string, unknown>) => boolean;
    /** Rename a preset, leaving its params/group/position untouched. */
    rename: (id: string, name: string) => void;
    /** Move a preset to another group (empty/undefined clears it to ungrouped). */
    setGroup: (id: string, group?: string) => void;
    remove: (id: string) => void;
}

declare const usePresetsStore: import("zustand").UseBoundStore<import("zustand").StoreApi<PresetsState>>;

// src/state/keybindings-store.ts

/** Maps action id → combo. Only overrides are stored. */
declare const useKeybindings: import("zustand").UseBoundStore<import("zustand").StoreApi<{
    overrides: Record<string, string>;
}>>;

// src/extensions/api/registry.ts

export interface RegisteredPanel extends PanelContribution {
    extensionId: string;
}

export interface RegisteredTheme extends ThemeContribution {
    extensionId: string;
}

export interface RegisteredIcon extends SliderIconContribution {
    extensionId: string;
}

export interface RegisteredLayout extends LayoutContribution {
    extensionId: string;
}

export interface RegisteredSettings extends SettingsContribution {
    extensionId: string;
}

export interface RegisteredPipeline extends PipelineContribution {
    extensionId: string;
}

export interface RegisteredExportProcessor extends ExportProcessorContribution {
    extensionId: string;
    /** Insertion index; processors run in registration order. */
    order: number;
}

export interface RegisteredFilenameTemplate extends FilenameTemplateContribution {
    extensionId: string;
}

export interface RegisteredProcessingStage extends ProcessingStageContribution {
    extensionId: string;
}

export interface RegisteredCatalogHooks extends CatalogHooksContribution {
    extensionId: string;
}

export interface RegisteredPresetImporter extends PresetImporterContribution {
    extensionId: string;
}

export interface RegisteredGridFilter extends GridFilterContribution {
    extensionId: string;
}

export interface RegisteredGridMenuItem extends GridMenuItemContribution {
    extensionId: string;
}

export interface RegisteredSlot extends SlotContribution {
    extensionId: string;
}

export interface RegisteredPanelHeaderAccessory extends PanelHeaderAccessoryContribution {
    extensionId: string;
}

export interface RegisteredLibrarySort extends LibrarySortContribution {
    extensionId: string;
}

export interface RegisteredStylesheet extends StylesheetContribution {
    extensionId: string;
}

export interface RegisteredModule extends ModuleContribution {
    extensionId: string;
}

export interface RegistryState {
    panels: Record<string, RegisteredPanel>;
    themes: Record<string, RegisteredTheme>;
    sliderIcons: Record<string, RegisteredIcon>;
    layouts: Record<string, RegisteredLayout>;
    /** Keyed by extension id — one settings dialogue per extension. */
    settings: Record<string, RegisteredSettings>;
    pipelines: Record<string, RegisteredPipeline>;
    exportProcessors: Record<string, RegisteredExportProcessor>;
    filenameTemplates: Record<string, RegisteredFilenameTemplate>;
    processingStages: Record<string, RegisteredProcessingStage>;
    /** Keyed by contribution id. */
    catalogHooks: Record<string, RegisteredCatalogHooks>;
    presetImporters: Record<string, RegisteredPresetImporter>;
    /** Keyed by contribution id. Extra predicates that narrow the Library grid. */
    gridFilters: Record<string, RegisteredGridFilter>;
    /** Keyed by contribution id. Extra items appended to the grid's right-click menu. */
    gridMenuItems: Record<string, RegisteredGridMenuItem>;
    /** Keyed by contribution id. Components mounted into named core UI slots. */
    slots: Record<string, RegisteredSlot>;
    /** Keyed by contribution id. Controls rendered in every panel's dock header. */
    panelHeaderAccessories: Record<string, RegisteredPanelHeaderAccessory>;
    /** Keyed by contribution id. Extra Library sort orders. */
    librarySorts: Record<string, RegisteredLibrarySort>;
    /** Keyed by contribution id, in registration order. CSS applied to every
     *  window after the core styles. */
    stylesheets: Record<string, RegisteredStylesheet>;
    /** Keyed by module id. Top-level modules, Library and Develop among them. */
    modules: Record<string, RegisteredModule>;
}

/** A stage uniform another extension contributed, as api.params lists it. */
export interface ParamDescriptor {
    qualifiedKey: string;
    localKey: string;
    stageId: string;
    /** Human-facing name of the owning stage (ProcessingStageContribution.name). */
    stageName: string;
    extensionId: string;
    /** Human-facing name of the owning extension (its manifest name). */
    extensionName: string;
    glslType: GlslType;
    default: number | number[] | boolean;
    range?: {
        min: number;
        max: number;
        step?: number;
    };
    label?: string;
}

// src/ui/preferences/fields.ts

/** A field wrapper is visible when there's no active filter, or its text matches it.
 *  Exported so extension-contributed settings sections (e.g. Accessibility)
 *  can reuse the same search-aware field primitives. */
declare function useFieldVisible(label: string, hint?: string): boolean;

declare function Field({ label, hint, children, }: {
    label: string;
    hint?: string;
    children: React.ReactNode;
}): import("react").JSX.Element | null;

declare function ToggleField({ label, hint, checked, onChange, }: {
    label: string;
    hint?: string;
    checked: boolean;
    onChange: (v: boolean) => void;
}): import("react").JSX.Element | null;

declare function OptionRow<T extends string | number>({ value, options, onChange, }: {
    value: T;
    options: {
        value: T;
        label: string;
    }[];
    onChange: (v: T) => void;
}): import("react").JSX.Element;

// src/extensions/api/develop.ts

/** Where a panel's extension params live: the photo's bag, or one mask's.
 *  Reads see the store as it is now, not as the render was handed it, so a
 *  drag's handler can start each step from the last one's write. */
export interface ParamScope {
    /** The mask being edited, or null for the photo's own values. */
    maskId: string | null;
    /** A param by qualified key ("{stageId}.{key}"). Reads fall back to the
     *  param's registered default when the scope stores nothing. */
    getParam(key: string): unknown;
    /** The values the scope stores, by qualified key, without defaults: the
     *  photo's paramBag or the mask's bag. */
    getParams(): Readonly<Record<string, unknown>>;
    /** Writes several params in one update; an undefined value clears its key. */
    setParams(patch: Record<string, unknown>): void;
    /** End the gesture: one undo step with this label. */
    commit(label: string): void;
}

export interface MaskParamScope extends ParamScope {
    maskId: string;
    /** Core local adjustments — relative strengths, all -100..100, 0 = none. */
    adj: MaskAdjustments;
    setAdj(patch: Partial<MaskAdjustments>): void;
    /** Structured blocks; present only while their sub-panel is added. */
    hsl: HSLAdjustments | undefined;
    setHsl(value: HSLAdjustments): void;
    toneCurve: ToneCurves | undefined;
    setToneCurve(value: ToneCurves): void;
    setParam(key: string, value: unknown): void;
}

/** The box the displayed image occupies, in the canvas's pixels. */
export interface OverlayRect {
    x: number;
    y: number;
    w: number;
    h: number;
}

/** An extension's on-image tool that takes the canvas over while it is held. */
export interface CanvasTool {
    /** Drawn over the image, inside the view: `rect` is the box the frame
     *  shows. Reads the canvas mapping with api.develop.useDevelopOverlay. */
    overlay: ComponentType<{
        rect: OverlayRect;
    }>;
    /** Whether zoom and pan still reach the canvas under the overlay. */
    zoomable?: boolean;
    /** The params the live view draws while the tool is held, from the edit's
     *  (crop mode draws the whole image past the crop). View-only: the edit is
     *  untouched. */
    viewParams?(params: DevelopParams): DevelopParams;
    /** Escape was pressed: core lets the tool go after this. */
    onEscape?(): void;
    /** A shortcut's action (keybinding id, e.g. "brush.larger") pressed while
     *  the tool is held: whether the tool took it. Core acts on one it didn't. */
    onAction?(action: string): boolean;
    /** Whether the tool would take `action` now, without acting: a key another
     *  handler also binds (Delete) is left to the tool when it would. */
    wants?(action: string): boolean;
}

/** "pre-output": the signed colour every stage has finished with, as the
 *  output stage receives it. "output": what the output stage makes of it in
 *  sRGB, in [0, 1]. "scene": the scene-linear colour the display transform
 *  receives, signed, before any display tool. */
export type CapturePoint = "pre-output" | "output" | "scene";

export interface FloatCaptureOptions {
    /** Default linear Rec.709. */
    space?: StageSpace;
    /** Default "pre-output". */
    point?: CapturePoint;
    /** Merged over the photo's extension-stage params for this capture only. */
    paramBag?: Record<string, unknown>;
}

/** What a live capture (captureFloatFrame) takes: the options of any float
 *  frame, and the size it is read at. */
export type LiveFloatCaptureOptions = FloatCaptureOptions & {
    /** The frame's long edge in pixels. */
    maxEdge?: number;
};

/** A frame as floats: RGBA, top-down, in `space`. Alpha is 1. */
export interface FloatFrame {
    data: Float32Array;
    width: number;
    height: number;
    space: StageSpace;
    point: CapturePoint;
}

/** The developed frame of the whole image, untransformed and uncropped, as
 *  RGBA8 rows from the top. */
export interface DevelopedPixels {
    data: Uint8Array;
    width: number;
    height: number;
}

/** A panel that can be added to a mask (PanelContribution.mask). */
export interface MaskPanelEntry {
    /** The panel's id: what a mask's `panels` list holds. */
    id: string;
    title: string;
    /** The values the sub-panel owns on a mask (MaskPanelContribution.owns). */
    owns: readonly string[];
    component: ComponentType;
    /** Whether it owns an extension's params, which run in the mask only at
     *  the current processing. */
    extensionParams: boolean;
}

/** Core's auto adjustments (api.develop.autoAdjust). */
export interface AutoAdjust {
    whiteBalance: () => Promise<void>;
    whiteBalanceAt: (point: CanvasPoint) => Promise<void>;
    tone: () => Promise<void>;
}

/** How a non-RAW photo's 8-bit codes become linear Rec.709
 *  (api.develop.registerInputProfiles). Nothing is clamped, so a colour
 *  outside sRGB arrives as negative channels, as it does from a RAW. */
export interface InputTransform {
    /** Encoded [0, 1] to linear, one table a channel (red, green, blue), each
     *  2 to 65536 finite samples at even steps, all three the same length. A
     *  code between two samples is interpolated linearly. */
    trc: [Float32Array, Float32Array, Float32Array];
    /** Profile-linear RGB to linear Rec.709 (D65), row-major: 9 finite numbers. */
    toRec709: number[];
}

/** The photo an InputProfileResolver is asked about. */
export interface InputProfilePhoto {
    id: string;
    filename: string;
    /** The token api.catalog.setInputProfile stored for it, if any. */
    inputProfile?: string;
}

/** The one extension that turns non-RAW photos into linear Rec.709
 *  (api.develop.registerInputProfiles). */
export interface InputProfileResolver {
    /** The transform for `photo`, whose original is `file`; null leaves the
     *  photo to the browser's own decode (sRGB, as without a resolver). A
     *  throw, an answer later than 3 s or an invalid transform counts as null. */
    resolve(photo: InputProfilePhoto, file: Blob): Promise<InputTransform | null>;
}

// src/rendering/source-sample.ts

export interface SourceSample {
    /** RGBA, rows top-down, linear Rec.709 as decoded: white balance applied,
     *  before the baseline tone and before any edit. Alpha is 1. */
    data: Float32Array;
    width: number;
    height: number;
    /** Where the sample sits in the decoded frame, in that frame's pixels. */
    x: number;
    y: number;
    /** The decoded frame's size. */
    sourceWidth: number;
    sourceHeight: number;
}

// src/modules/develop/pick-drag.ts

/** A point on the canvas, in its pixels, from its top-left corner. */
export interface CanvasPoint {
    x: number;
    y: number;
}

export interface PickDragTool {
    /** A press on the image, as it happens. */
    onPress?(point: CanvasPoint): void;
    /** A press on the image with the colour the view shows there, sRGB 0-1,
     *  once the probe answers; never for a press released before that. */
    onDown?(rgb: readonly [number, number, number], point: CanvasPoint): void;
    /** The drag, after an onDown. */
    onMove?(point: CanvasPoint): void;
    /** The drag ended, after an onDown. */
    onUp?(): void;
}

// src/rendering/source-pixels.ts

/** RGBA8 rows from the top. */
export interface SourcePixels {
    data: Uint8ClampedArray;
    width: number;
    height: number;
}

// src/catalog/normalize.ts

declare function normalizeParams(p: Partial<DevelopParams> | undefined): DevelopParams;

// src/extensions/api/library.ts

export type RenamePhotoResult = {
    ok: true;
    filename: string;
} | {
    ok: false;
    reason: string;
};

/** The Library's photo right-click menu, for a surface that lists photos. */
export interface PhotoActions {
    /** Right-click handler for a photo cell. Right-clicking a photo that's part
     *  of the current selection targets the whole selection; right-clicking an
     *  unselected one selects just it first. */
    onContextMenu: (id: string, e: MouseEvent) => void;
    /** The menu and its dialogues. Render them inside the surface. */
    overlays: ReactNode;
}

export interface CullingShortcutOptions {
    /** Handle the thumbnail-size actions (- / =), which step the Library grid's
     *  cell size. Surfaces whose cells are sized by their container (a filmstrip
     *  follows its rail) pass false and leave the keys alone. Default true. */
    sizeSteps?: boolean;
}

/** One line of a preset's summary. */
export interface PresetDiff {
    label: string;
    value: string;
}

/** One selectable adjustment in the Save Preset dialogue. `keys` are the
 *  DevelopParams keys copied when the field is checked; `changed` marks fields
 *  that differ from the defaults (pre-checked by default). */
export interface PresetField {
    id: string;
    label: string;
    keys: (keyof DevelopParams)[];
    changed: boolean;
    /** Short current value, shown beside scalar fields. */
    value?: string;
    /** Qualified paramBag keys copied when checked (extension-stage fields and
     *  the Display transform field; core fields copy `keys` instead). */
    bagKeys?: string[];
    /** The Display transform field's defaults for `bagKeys`, copied in place of
     *  a key the bag holds no value for. */
    bagDefaults?: Record<string, unknown>;
    /** "global" (default) is offered and pre-checked when changed; "per-image" is
     *  hidden under "Show all" and never pre-selected — spatial edits (crop,
     *  retouch, warp …) that don't transfer meaningfully to another photo. */
    scope?: "global" | "per-image";
    /** Set on extension-contributed stage fields (drives the "per-image" tag). */
    extension?: boolean;
}

export interface ImportedPreset {
    name: string;
    group?: string;
    params: Partial<DevelopParams>;
    paramBag?: Record<string, unknown>;
}

export type PresetImportOutcome = {
    status: "imported";
    preset: ImportedPreset;
}
/** No installed importer claims this file type. */
 | {
    status: "no-importer";
    extension: string;
}
/** An importer claimed the file but found no develop settings in it. */
 | {
    status: "no-settings";
}
/** An importer claimed the file but threw or ran out of time reading it. */
 | {
    status: "failed";
    reason: string;
}
/** A .json file that isn't a Safelight preset this build can read. */
 | {
    status: "unreadable";
};

// src/rendering/histogram.ts

export interface HistogramData {
    r: Uint32Array;
    g: Uint32Array;
    b: Uint32Array;
    luma: Uint32Array;
    extended?: ExtendedHistogramData;
}

export interface ExtendedHistogramData {
    r: Uint32Array;
    g: Uint32Array;
    b: Uint32Array;
    luma: Uint32Array;
    rangeMin: number;
    rangeMax: number;
    clipLow: number;
    clipHigh: number;
}

// src/catalog/copy-name.ts

export type Named = Pick<CatalogPhoto, "filename" | "copyName">;

/** Human display name, e.g. "IMG_0001_copy.NEF" for a copy, or the plain
 *  filename for a master (or any record without a copy name). */
declare function photoDisplayName(photo: Named): string;

// src/state/broadcast.ts

/** What one catalogue write stored: edit histories, photo records as catalog.json
 *  holds them, and the ids of photos removed from the catalogue. */
export interface CatalogRecords {
    edits: EditState[];
    photos: StoredPhoto[];
    deletedIds: string[];
}

/** Catalogue records as a window's ProjectStorage sends them to the others. */
export interface SentCatalogRecords extends CatalogRecords {
    /** The catalogue file they belong to (see catalogKey in project-storage). */
    catalog: string;
    /** The sending storage, not just its window. */
    origin: string;
    /** When the records entered the sender's copy (Date.now()): any save of it
     *  that began later holds them. */
    since: number;
    /** Set, with no records, by a sender whose window left the catalogue and whose
     *  writes kept failing: what it sent from `since` on may be in no file, so each
     *  window that holds all of it saves: one listening from before then, or one
     *  that had the sender's answer. */
    unsaved?: true;
    /** The change stamps of these records (see project/change-stamps). */
    changed?: ChangeStamps;
    /** Set on a storage's answer to another's hello: every record it changed or took
     *  in since it opened, its removals, and the files it removed (`removed`). */
    answer?: true;
    /** In an answer: the files removed from the catalogue in the sender's session that
     *  are still on disk, so a window opening now doesn't import them again. */
    removed?: string[];
    /** In an answer: the storage whose hello it answers, the only one that takes it. */
    to?: string;
}

/** A storage that has just read catalog.json, asking the others on it for the
 *  changes the file may not hold yet. `since` is when it began listening: what the
 *  others wrote before then is in the file it read. */
export interface CatalogHello {
    catalog: string;
    origin: string;
    since: number;
}

export type BroadcastMessage = {
    type: "selection-change";
    payload: {
        activePhotoId: string;
    };
} | {
    type: "edit-update";
    payload: {
        photoId: string | null;
        params: DevelopParams;
    };
} | {
    type: "catalog-change";
    payload: {
        action: string;
        id?: string;
        origin: string;
    };
} | {
    type: "detach" | "attach";
    payload: {
        module: AppModule;
    };
} | {
    type: "navigate";
    payload: {
        module: AppModule;
    };
} | {
    type: "catalog-records";
    payload: SentCatalogRecords;
} | {
    type: "catalog-hello";
    payload: CatalogHello;
};

declare function onBroadcast(handler: (message: BroadcastMessage) => void): () => void;

// src/modules/library/import-files.ts

export interface IngestFile {
    name: string;
    data: Blob;
}

export interface IngestOptions {
    /** A folder of the project, relative to its root with "/" between names; created
     *  if it isn't there. The project root when omitted. */
    folder?: string;
    /** Added to the keywords the file itself carries. */
    keywords?: string[];
}

export type IngestResult = {
    name: string;
    id: string;
} | {
    name: string;
    error: string;
};

/** Write each file into the open project and import it as a photo. Results come
 *  back in the order given; a file that can't be taken, whatever the reason, is
 *  reported and leaves the rest unaffected. Nothing is overwritten and nothing
 *  lands outside the project folder. Calls run one after another, since imports
 *  share the decode pool. */
declare function importFiles(files: readonly IngestFile[], options?: IngestOptions): Promise<IngestResult[]>;

// src/extensions/api/devtools.ts

export type ProcessVersion = 1 | 2 | 3;

/** Whether a stage's block sees scene-linear or display-encoded values. */
export type StageDomain = "scene" | "display";

/** When a clip runs: on every frame; while the tool above it is in use; inside
 *  each mask that uses it, blended in by the mask's coverage; only for a
 *  fallback preview's source, which has no headroom above 1; only when the
 *  output isn't sRGB (an export to a wider space, or a monitor profile); only
 *  on a GPU without float render targets (or none it can mipmap), where an
 *  intermediate is stored in a format that holds [0, 1]. */
export type ClipWhen = "always" | "while-active" | "per-mask" | "fallback-preview" | "non-srgb-output" | "no-float-targets";

/** One row of the develop program as the Pipeline tab lists it. */
export type PipelineRow = {
    kind: "core";
    label: string;
    note?: string;
} | {
    kind: "stage";
    id: string;
    name: string;
    phase: ProcessingPhase;
    priority: number;
    /** The extension that registered it; null for Safelight's own. */
    owner: string | null;
    space: StageSpace | null;
    /** The values its block sees: scene-linear `lin`, display-encoded `c`,
     *  or none for geometry, which moves pixels and holds no colour. */
    domain: StageDomain | null;
    reads: "source" | "current";
    maskable: boolean;
    /** Floors and clips found in its GLSL. */
    floors: string[];
    /** How many mask copies run it again. They have no rows of their own:
     *  `note` says what is written for each. */
    copies?: number;
    note?: string;
} | {
    kind: "convert";
    from: string;
    to: string;
    elided: boolean;
} | {
    kind: "clamp";
    /** One of the develop shader's own blocks (the core row above it), or
     *  the output encode. */
    reason: "core" | "output";
    /** The values coming in, or what the block made. */
    where: "input" | "result";
    when: ClipWhen;
    detail: string;
} | {
    kind: "clamp";
    reason: "legacy-display-stage";
    /** The stage that declares no space. */
    stageId: string;
    /** Its block's input, or what its passes read (their split draw only,
     *  not the frame). */
    where: "input" | "pass-input";
    when: "always";
    detail: string;
} | {
    kind: "clamp";
    /** A clip inside one of Safelight's own stages that a scan of its GLSL
     *  can't see, such as one in its passes. */
    reason: "builtin-stage";
    stageId: string;
    where: "result";
    when: "while-active";
    detail: string;
} | {
    kind: "transform";
    /** null for the built-in transform. */
    id: string | null;
    /** The flags the transform sets, each with whether this version honours it. */
    flags: {
        flag: "skipBaseCurve" | "skipToneShoulder";
        honoured: boolean;
    }[];
} | {
    kind: "output";
    mapped: boolean;
    detail: string;
};

/** Where the view's frames go. */
export interface ScreenTarget {
    space: DisplaySpace;
    /** The active monitor profile's description; null without one. */
    profile: string | null;
}

export type VariableOutcome = "accepted" | "stale" | "invalid" | "lost";

export interface VariableHistoryItem {
    time: number;
    writer: VariableWriter;
    /** accepted and lost: the write's own revision. stale and invalid: the
     *  current revision the write was refused against. */
    revision: VariableRevision;
    outcome: VariableOutcome;
    /** stale: who wrote the revision the writer hadn't seen. lost: who won. */
    other?: VariableWriter;
    /** invalid: why. */
    message?: string;
}

export interface VariableInspection {
    snapshot: VariableSnapshot<unknown>;
    size: number;
    history: readonly VariableHistoryItem[];
    /** Extension ids subscribed in this window, in subscription order. */
    subscribers: string[];
}

/** Every shared variable in this window, as the Variables tab reads them. */
export interface VariablesInspector {
    inspect(): VariableInspection[];
    /** For useSyncExternalStore: fires on every change the Variables tab shows. */
    subscribeChanges(listener: () => void): () => void;
    changeCount(): number;
    /** "this window", another window's label, or the first four characters of its id. */
    windowName(id: string): string;
}

export interface WebGLInfo {
    vendor: string;
    renderer: string;
    glsl: string;
    maxTexture: number;
    /** MAX_FRAGMENT_UNIFORM_VECTORS: the develop program's uniforms must fit in it to link. */
    fragmentUniformVectors: number;
    /** EXT_color_buffer_float: without it the render pipeline's intermediates are 8-bit. */
    colorBufferFloat: boolean;
}

// src/project/folder-node.ts

export interface FolderNode {
    name: string;
    /** Path relative to the project root; "" for the root itself. */
    path: string;
    children: FolderNode[];
    /** Direct (non-recursive) photo count. */
    count: number;
    /** Set when the folder couldn't be listed, so its contents are unknown. */
    unreadable?: boolean;
}

// src/project/change-stamps.ts

/** When a change was made, by the clock of the storage that made it, and that
 *  storage's origin, which orders two changes stamped at the same time. */
export type ChangeStamp = [at: number, by: string];

export type PhotoGroup = "location" | "shape" | "file" | "rating" | "colorLabel" | "flag" | "keywords" | "decodeError" | "copyName" | "stack" | "inputProfile" | "created";

/** A photo record's stamps, by group. */
export type PhotoStamps = Partial<Record<PhotoGroup, ChangeStamp>>;

/** The stamps of some records, as catalog.json and catalog-records carry them. */
export interface ChangeStamps {
    photos: Record<string, PhotoStamps>;
    edits: Record<string, ChangeStamp>;
}
