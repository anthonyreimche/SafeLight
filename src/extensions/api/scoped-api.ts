// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type {
  CatalogHooksContribution,
  BrushTipContribution,
  CursorContribution,
  ExportProcessorContribution,
  FilenameTemplateContribution,
  GridFilterContribution,
  GridMenuItemContribution,
  KeyActionContribution,
  LayoutContribution,
  LibrarySortContribution,
  ModuleContribution,
  ModuleId,
  PanelContribution,
  PanelHeaderAccessoryContribution,
  PanelPlacement,
  PipelineContribution,
  PresetImporterContribution,
  ProcessingStageContribution,
  SettingsContribution,
  SliderIconContribution,
  SlotContribution,
  StageTextureData,
  StylesheetContribution,
  ThemeContribution,
} from "./contributions";
import type { JSX, MemoExoticComponent } from "react";
import type {
  ContextMenuProps,
  CurveEditorProps,
  DevelopCanvasProps,
  DevFolderControlsProps,
  HistogramProps,
  MaskScopeProps,
  PanelProps,
  PhotoListRowProps,
  ScaleStepperProps,
  SliderProps,
  SlotProps,
  ThumbnailProps,
  UIKit,
} from "./components";
import type {
  AutoAdjust,
  CanvasTool,
  DevelopedPixels,
  FloatCaptureOptions,
  FloatFrame,
  InputProfileResolver,
  LiveFloatCaptureOptions,
  MaskPanelEntry,
  MaskParamScope,
  ParamScope,
} from "./develop";
import type {
  ProcessVersion,
  PipelineRow,
  ScreenTarget,
  VariablesInspector,
  WebGLInfo,
} from "./devtools";
import type {
  BitDepthSettings,
  ExportPhotosOptions,
  ExportProgress,
  ExportResult,
  ExportSettings,
  RenderedPhoto,
  RenderPhotosOptions,
} from "./export";
import type {
  CullingShortcutOptions,
  PhotoActions,
  PresetDiff,
  PresetField,
  PresetImportOutcome,
  RenamePhotoResult,
} from "./library";
import type {
  ParamDescriptor,
  RegisteredPresetImporter,
  RegistryState,
} from "./registry";
import type {
  ActiveIdState,
  AppSettings,
  AppStore,
  CatalogState,
  DevelopState,
  ProjectState,
  UIState,
} from "./stores";
import type { SharedVariablesAPI } from "./variables";

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
  setStageTexture(
    stageId: string,
    key: string,
    tex: StageTextureData | null,
  ): void;
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
    Rating: typeof import("@/ui/components/Rating").Rating;
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
    ResolutionControl: typeof import("@/modules/export/ResolutionControl").ResolutionControl;
    /** Mounts every component registered into a named core slot
     *  (registerSlot), in registration order; nothing when there are none. */
    Slot: MemoExoticComponent<(props: SlotProps) => JSX.Element>;
    /** Binds its children to mask `maskId`: a mask sub-panel's component
     *  (PanelContribution.mask) drawn inside reads and writes that mask through
     *  useMaskScope / useParamScope. Needs Safelight 3.2.0. */
    MaskScope: (props: MaskScopeProps) => JSX.Element | null;
    /** The virtualized grid the Library draws its cells with: fixed-size
     *  cells, only the visible rows mounted, `scrollToIndex` kept in view. */
    VirtualGrid: typeof import("@/ui/components/VirtualGrid").VirtualGrid;
    /** Develop's canvas area: the surround (theme shade, or the ISO grey under
     *  colour assessment), the active photo's canvas with every core overlay
     *  (the held canvas tool, extension overlays) and the photo's
     *  edit loaded as it opens. `empty` shows while no photo is open. Fills
     *  its container. */
    DevelopCanvas: (props: DevelopCanvasProps) => JSX.Element;
    /** The zoom readout and fit / 100% / step buttons for a DevelopCanvas
     *  sharing the same `zoom`. */
    ZoomControls: typeof import("@/ui/ZoomControls").ZoomControls;
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
    PickerIcon: typeof import("@/ui/components/PickerIcon").PickerIcon;
    /** The small "Auto" button of the develop panels (Auto Tone, Auto White
     *  Balance). */
    AutoButton: typeof import("@/ui/components/AutoButton").AutoButton;
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
    confirmDialog: typeof import("@/ui/components/ConfirmDialog").confirmDialog;
    /** Tell the person something in the app's dialogue card; resolves when they
     *  close it. Use it instead of `window.alert`. */
    alertDialog: typeof import("@/ui/components/ConfirmDialog").alertDialog;
  };
  /** React DOM's `createPortal`, from the app's copy, for a tooltip or popover
   *  that must escape its panel's clipping. Extension bundles can't import
   *  react-dom themselves. */
  reactDom: { createPortal: typeof import("react-dom").createPortal };
  /** The app's Zustand store hooks and the zustand `create` factory, shared so
   *  plugins read/write the app's stores rather than their own copies. Typed
   *  with each store's actual state shape. */
  stores: {
    useDevelopStore: AppStore<DevelopState>;
    useCatalogStore: AppStore<CatalogState>;
    useUIStore: AppStore<UIState>;
    useSettings: AppStore<AppSettings>;
    usePresetsStore: typeof import("@/state/presets-store").usePresetsStore;
    useKeybindings: typeof import("@/state/keybindings-store").useKeybindings;
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
  themes: { apply(id: string): void };
  layouts: { apply(id: string): void };
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
      Field: typeof import("@/ui/preferences/fields").Field;
      ToggleField: typeof import("@/ui/preferences/fields").ToggleField;
      OptionRow: typeof import("@/ui/preferences/fields").OptionRow;
      useFieldVisible: typeof import("@/ui/preferences/fields").useFieldVisible;
    };
  };
  /** Navigate between app modules: a built-in or a registered module id. The
   *  main window switches to it, or focuses its window if it is popped out,
   *  and ignores an unknown id. A popped-out window leaves its own module
   *  where it is and has the main window go to any other. */
  navigation: { goTo(module: ModuleId): void };
  /** Read the current binding for any action id (built-in or extension), or
   *  `list()` every built-in key action with its current combo (override
   *  applied) + label + category — so a tool can check a remap against the LIVE
   *  shortcuts instead of a hard-coded list. `combo` is "" when unbound. */
  keybindings: {
    getBinding(actionId: string): string;
    list(): { id: string; label: string; category: string; combo: string }[];
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
      rect: { x: number; y: number; w: number; h: number } | null;
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
    captureFrame(
      params: import("@/catalog/types").DevelopParams,
      options?: { asShown?: boolean; paramBag?: Record<string, unknown> },
    ): Promise<ImageBitmap>;
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
    captureFloatFrame(
      params: import("@/catalog/types").DevelopParams,
      options?: LiveFloatCaptureOptions,
    ): Promise<FloatFrame | null>;
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
    renderPhotoFrame(
      photoId: string,
      params: import("@/catalog/types").DevelopParams,
      paramBag?: Record<string, unknown>,
      options?: { lossless?: boolean },
    ): Promise<ImageBitmap | null>;
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
    renderPhotoFloatFrame(
      photoId: string,
      params: import("@/catalog/types").DevelopParams,
      options?: FloatCaptureOptions,
    ): Promise<FloatFrame | null>;
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
    readSourceSample(): Promise<import("@/rendering/source-sample").SourceSample | null>;
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
    /** Hold the canvas's pick-drag tool (an eyedropper or on-image target
     *  tool), or with null let go of it. While it's held, a press on the image
     *  calls `tool.onPress` with the point in the canvas's pixels at once;
     *  with `onDown`, it is also handed the colour the view shows there (sRGB,
     *  0-1) once the probe answers, then the drag to `onMove` and its end to
     *  `onUp`. A held Ctrl, Cmd or Space pans instead, and Escape lets go.
     *  One extension holds it at a time: the last to set it. It is let go when
     *  the extension stops. */
    setPickDrag(tool: import("@/modules/develop/pick-drag").PickDragTool | null): void;
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
    sourcePixels(): import("@/rendering/source-pixels").SourcePixels | null;
    /** Calls `listener` with each new sourcePixels image (another photo, a
     *  new decode); returns the unsubscribe. Needs Safelight 3.2.0. */
    onSourcePixels(listener: (pixels: import("@/rendering/source-pixels").SourcePixels) => void): () => void;
    /** The colour the develop canvas shows at `point` (in its pixels, as the
     *  pick-drag tool gives them), sRGB 0-1, read from the live frame; null
     *  with no canvas or no frame yet. */
    probe(point: import("@/modules/develop/pick-drag").CanvasPoint): Promise<readonly [number, number, number] | null>;
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
    normalizeParams: typeof import("@/catalog/types").normalizeParams;
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
    renderPhotos(
      photos: import("@/catalog/types").CatalogPhoto[],
      settings?: Partial<ExportSettings>,
      onProgress?: (p: ExportProgress) => void,
      options?: RenderPhotosOptions,
    ): Promise<RenderedPhoto[]>;
    /** The Export panel's run: render, run the export processors, name and
     *  deliver the files (downloads, a ZIP, or into `destDir`, a folder from
     *  `api.project.pickDirectory`). `settings` is the whole of them, not
     *  merged over the defaults. A `signal` in `options` stops the batch before
     *  its next photo; a failure every later write would meet (a full disk) stops
     *  it too, with `stopped` set on the result. */
    exportPhotos(
      photos: import("@/catalog/types").CatalogPhoto[],
      settings: ExportSettings,
      onProgress?: (p: ExportProgress) => void,
      destDir?: FileSystemDirectoryHandle,
      options?: ExportPhotosOptions,
    ): Promise<ExportResult>;
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
    addPhotos(
      photos: import("@/catalog/types").CatalogPhoto[],
      opts?: { afterId?: string },
    ): Promise<void>;
    getEditState(
      photoId: string,
    ): Promise<import("@/catalog/types").EditState | null>;
    putEditState(
      editState: import("@/catalog/types").EditState,
    ): Promise<void>;
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
    renamePhoto(
      photoId: string,
      newBaseName: string,
    ): Promise<RenamePhotoResult>;
    /** The photos the Library grid is currently showing, in display order —
     *  active folder, filters, sort direction, extension grid filters and
     *  extension sorts all applied. React hook; the same list core's ←/→
     *  photo navigation walks, so a strip built on it always agrees with the
     *  grid. `without` names grid-filter contribution ids to leave out, for a
     *  surface that registers a filter and must not narrow itself by it. */
    useVisiblePhotos(options?: {
      without?: readonly string[];
    }): import("@/catalog/types").CatalogPhoto[];
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
    useCullingShortcuts(
      options?: CullingShortcutOptions,
    ): void;
    /** Read the full metadata of the photo the person is looking at when
     *  import left it pending (`metadataPending`); null stops. Reads queue, and
     *  only the last photo asked for is read, so arrowing through the grid reads
     *  the photo it stops on. */
    settleSelectedPhoto(id: string | null): Promise<void>;
    /** The histogram of a photo's saved edit (fresh defaults when it has none),
     *  rendered from its grid thumbnail, so it is quick to recompute on every
     *  selection. Null without WebGL or when the photo can't be read. */
    renderHistogram(
      photo: import("@/catalog/types").CatalogPhoto,
    ): Promise<import("@/rendering/histogram").HistogramData | null>;
    /** The photo open in Develop (the active photo), or undefined. React hook;
     *  a write to any other photo leaves it alone. */
    useActivePhoto(): import("@/catalog/types").CatalogPhoto | undefined;
    /** Put the photos in one new stack (a burst, a bracket), `opts.cover` (one
     *  of them) as its cover; a photo in another stack leaves it. The grid shows
     *  a collapsed stack as its cover alone, and ←/→ culling, select all and
     *  `useVisiblePhotos` follow what is shown. Written like a rating: no undo
     *  entry. Does nothing for fewer than two photos in the catalogue. */
    setStack(ids: string[], opts?: { cover?: string }): Promise<void>;
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
    stackOf(id: string): { stackId: string; ids: string[]; cover: string } | null;
    /** The name a photo is shown by: its filename, with a virtual copy's
     *  name added ("IMG_0001_copy.NEF"). */
    photoDisplayName: typeof import("@/catalog/copy-name").photoDisplayName;
    /** Write `.safelight.json` sidecars (ratings, labels, edits) next to the
     *  photos' files; resolves with how many were written. */
    exportPhotoData(ids: string[]): Promise<number>;
    /** The Library's thumbnail sizes in pixels: what `useUIStore`'s
     *  `setGridSize` accepts, in the steps its zoom shortcuts take. */
    gridSize: { readonly min: number; readonly max: number; readonly step: number };
  };
  /** Messages between the app's windows: catalogue changes, edit updates and
   *  the like, from other windows and this one. Returns an unsubscribe fn. */
  events: {
    onBroadcast: typeof import("@/state/broadcast").onBroadcast;
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
    importFiles: typeof import("@/modules/library/import-files").importFiles;
  };
  /** Presets: the file formats and the descriptions the Presets panel and
   *  Copy Settings share. */
  presets: {
    /** The registered preset importers. React hook. */
    useImporters(): RegisteredPresetImporter[];
    /** The labels of the extension stages a preset's paramBag carries. */
    describeBag(bag: Record<string, unknown> | undefined): string[];
    /** What a preset changes, for its tooltip. */
    summarize(params: Partial<import("@/catalog/types").DevelopParams>): PresetDiff[];
    /** The adjustments a preset can be saved with from these params and bag:
     *  core fields, the display transform's params, then every extension
     *  stage's, as the save dialogue lists them. */
    fields(
      params: import("@/catalog/types").DevelopParams,
      paramBag: Record<string, unknown>,
    ): PresetField[];
    /** Download a preset as a Safelight JSON preset file. */
    exportFile(
      name: string,
      params: Partial<import("@/catalog/types").DevelopParams>,
      group?: string,
      paramBag?: Record<string, unknown>,
    ): void;
    /** Read a Safelight JSON preset, or another app's through the importers. */
    importFile(
      file: File,
      importers: readonly PresetImporterContribution[],
    ): Promise<PresetImportOutcome>;
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
      useOpenVersion(): { photoId: string | null; version: ProcessVersion };
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
