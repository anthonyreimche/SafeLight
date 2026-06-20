# API Documentation

Reference for the extension API surface and the data structures extensions interact with. Every extension receives a scoped `SafelightAPI` (`version: 1`) whose full TypeScript definition lives in `src/extensions/types.ts` — that file is the source of truth; this page summarizes it. For a tutorial-style introduction with examples, see [Extensions](extensions.md).

## The `SafelightAPI` object

```typescript
interface SafelightAPI {
  version: 1;
  extensionId: string;        // your extension's id; contributions are auto-tagged with it
  react: any;                 // the app's React instance — use this, never bundle your own

  // ── Contribution registration ──────────────────────────────────────────
  registerPanel(c: PanelContribution): void;
  registerTheme(c: ThemeContribution): void;
  registerLayout(c: LayoutContribution): void;
  registerSliderIcon(c: SliderIconContribution): void;
  registerPipeline(c: PipelineContribution): void;            // display transform
  registerProcessingStage(c: ProcessingStageContribution): void; // GPU stage (forward path)
  registerKeybinding(c: KeyActionContribution): void;
  registerSettings(c: SettingsContribution): void;
  registerExportProcessor(c: ExportProcessorContribution): void;
  registerFilenameTemplate(c: FilenameTemplateContribution): void;
  registerLensProfile(c: LensProfileContribution): void;
  registerCatalogHooks(c: CatalogHooksContribution): void;
  registerPresetImporter(c: PresetImporterContribution): void;
  registerGridFilter(c: GridFilterContribution): void;
  registerLibrarySort(c: LibrarySortContribution): void;
  registerSlot(c: SlotContribution): void;

  // ── Persisted per-extension settings ───────────────────────────────────
  settings: {
    get<T>(key: string, fallback: T): T;
    set(key: string, value: unknown): void;
    onChange(cb: (key: string, value: unknown) => void): () => void; // returns unsubscribe
  };

  // ── Shared building blocks ─────────────────────────────────────────────
  components: Record<string, ComponentType>; // Panel, Slider, Histogram, CurveEditor, Rating, Thumbnail
  stores: Record<string, any>;               // see "State Stores" below, plus zustand `create`

  // ── Imperative app control ─────────────────────────────────────────────
  dock:        { togglePanel(id: string): void };
  themes:      { apply(id: string): void };
  layouts:     { apply(id: string): void };
  pipelines:   { apply(id: string): void };
  preferences: { open(sectionId?: string): void; close(): void; toggle(): void };
  navigation:  { goTo(module: "library" | "develop"): void };
  keybindings: { getBinding(actionId: string): string };

  // ── Develop-canvas integration (for overlay extensions) ────────────────
  develop: {
    useDevelopOverlay(): { rect: { x: number; y: number; w: number; h: number } | null; nonce: number };
    captureFrame(params: DevelopParams): Promise<ImageBitmap>;
  };
}
```

An extension bundle exports `activate(api)` and optionally `deactivate()`:

```typescript
interface ExtensionModule {
  activate(api: SafelightAPI): void;
  deactivate?(): void;
}
```

All contributions are tagged with the calling extension's `extensionId` and swept automatically when it is disabled or uninstalled.

## Contribution types

### `PanelContribution`

```typescript
interface PanelContribution {
  id: string;                 // globally unique, e.g. "my-ext.waveform"
  title: string;
  component: ComponentType;   // a React component built with api.react
  slot?: "develop-right" | "develop-left" | "none"; // composite stack slot (default "none")
  order?: number;             // sort within slot (default 100)
  defaultDock?: {             // initial placement when the user has no saved layout
    module: "library" | "develop";
    direction: "left" | "right";
    order?: number; width?: number; height?: number;
  };
}
```

### `ThemeContribution`

```typescript
interface ThemeContribution {
  id: string; name: string;
  colorScheme?: "light" | "dark";
  vars: Record<string, string>; // CSS custom properties applied to :root
}
```

The full themable surface is the set of `--color-*` variables in the stock themes (`src/extensions/builtin.tsx`): surfaces 0–4, border / border-subtle, text primary/secondary/muted, accent / accent-hover, slider-fill.

### `LayoutContribution`

```typescript
interface LayoutContribution {
  id: string; name: string; description?: string;
  modules?: Partial<Record<"library" | "develop", {
    rails: { side: "left" | "right"; width?: number; panels: string[] }[];
    floating?: Record<string, { x: number; y: number; width: number }>;
  }>>;
}
```

A layout with no `modules` resolves to the registry's `defaultDock` placements — that is what the built-in **Classic** layout does, so extension panels join it automatically.

### `SliderIconContribution`

```typescript
interface SliderIconContribution { id: string; svg: string; } // inline SVG, rendered 12×12
```

Keyed by the slider's `icon` id (e.g. `core.exposure`).

### `PipelineContribution` — display transform

```typescript
interface PipelineContribution {
  id: string; name: string; description?: string;
  glsl?: string;          // body defining: vec3 pipelineToDisplay(vec3 lin)
  skipBaseCurve?: boolean; // set when the transform brings its own contrast curve (AgX/ACES)
}
```

`glsl` maps scene-linear RGB (sRGB primaries, HDR — values may exceed 1.0) to display-encoded output. Helpers available: `luma()`, `srgbToLinear()`, `linearToSrgb()`, `linearToSrgbU()`. Transforms appear in **Preferences ▸ Rendering ▸ Display transform** and apply everywhere the pipeline renders.

### `ProcessingStageContribution` — GPU stage (forward path)

```typescript
type ProcessingPhase =
  | "decode" | "noise-reduction" | "scene-linear"
  | "tone-map" | "display-adjust" | "effects" | "output-encode";

interface ProcessingStageContribution {
  id: string; name: string;
  phase: ProcessingPhase;     // order enforced by the shader compiler
  priority?: number;          // within phase, lower runs first (default 100)
  glsl: string;               // fragment operating on `vec3 color` (read/write)
  helpers?: string;           // helper functions (namespaced by the compiler)
  uniforms: UniformDeclaration[];
  produces?: InterStageVariable[];
  consumes?: string[];
  textures?: TextureRequirement[];
  mask?: { maskable: true; maskPhase: "linear" | "display" };
  after?: string[];           // soft dependencies on other stage ids
}
```

The stage model and shader compiler (`src/rendering/webgl/shader-compiler.ts`) are in place as the path for decomposing the monolithic develop shader into individually contributable GPU stages. The type is part of the public API today; built-in tools currently render through the monolithic shader, so prefer `registerPipeline` for shipping GPU effects right now.

### `KeyActionContribution`

```typescript
interface KeyActionContribution {
  id: string; label: string;
  category?: "General" | "Develop" | "Library";
  defaultCombo: string;       // e.g. "Ctrl+Shift+I"; "" for unbound
  handler(): void;
}
```

The action appears in **Preferences ▸ Shortcuts** and is rebindable like any built-in. Read the current binding with `api.keybindings.getBinding(actionId)`.

### `SettingsContribution`

```typescript
interface SettingsContribution {
  title?: string;             // section title (defaults to the extension name)
  fields: SettingsField[];    // auto-rendered, themed, searchable
  order?: number;
  component?: ComponentType;  // escape hatch for fully custom UI
}

type SettingsField =
  | { key; label; hint?; type: "boolean"; default: boolean }
  | { key; label; hint?; type: "number";  default: number; min?; max?; step? }
  | { key; label; hint?; type: "string";  default: string; placeholder? }
  | { key; label; hint?; type: "select";  default: string; options: { value; label }[] };
```

Values persist per-extension; read/write with `api.settings.get/set`, observe with `api.settings.onChange`.

### `ExportProcessorContribution`

```typescript
interface ExportProcessorContribution {
  id: string;     // globally unique, e.g. "my-ext.watermark"
  label: string;  // collapsible section header in the Export panel
  settings?: ExportProcessorField[]; // same shape as SettingsField
  process(blob: Blob, photo: CatalogPhoto, settings: Record<string, unknown>): Promise<Blob>;
}
```

Called once per exported image after the WebGL pipeline encodes it. Processors run in registration order, each receiving the previous step's Blob. Each declared field's `default` is merged with the user's current values before `process`. Processor errors are caught and logged and the unmodified Blob is forwarded, so a broken extension never silently drops an export.

### `FilenameTemplateContribution`

```typescript
interface FilenameTemplateContribution { id: string; label: string; template: string; }
```

Built-in variables resolved from `CatalogPhoto`: `{filename}` (base name without extension), `{ext}`, `{year}`, `{month}`, `{day}`, `{rating}`, `{camera}`, `{lens}`. Unknown variables are left as `{name}`.

### `LensProfileContribution`

```typescript
interface LensProfileContribution {
  id: string; lensMake: string; lensModel: string;
  priority?: number;          // > 0 checked before Lensfun; <= 0 is a fallback (default 0)
  resolve(exif: ExifData): ResolvedProfile | null; // interpolated distortion / TCA / vignetting
}
```

Supplements or overrides the built-in Lensfun-derived database in `src/lens-profiles/`. See that folder's `types.ts` for `ResolvedProfile`, `ResolvedDistortion` (`poly3`/`poly5`/`ptlens`), `ResolvedTca`, and `ResolvedVignetting`.

### `CatalogHooksContribution`

```typescript
interface CatalogHooksContribution {
  id: string;
  onPhotoImport?(ctx: { photo: CatalogPhoto; dir: FileSystemDirectoryHandle; fileName: string })
    : Promise<Partial<CatalogPhoto> | void>;        // merge sidecar metadata onto the record
  onMetadataChange?(ctx: { photos: CatalogPhoto[]; getEditState(id): Promise<EditState | null> })
    : Promise<void>;                                // rating/label/flag/keywords committed
  onEditCommit?(ctx: { photo: CatalogPhoto; editState: EditState }): Promise<void>;
  onPhotoRemove?(ctx: { photo: CatalogPhoto; dir: FileSystemDirectoryHandle; fileName: string })
    : Promise<void>;
}
```

Lets an extension own a side concern (e.g. XMP sidecars) without the core depending on it. All handlers are awaited; a throwing handler is logged and skipped so one extension can't break a save or import. From `onPhotoImport`, return a partial `CatalogPhoto` to merge onto the record; later handlers' fields win.

### `PresetImporterContribution`

```typescript
interface PresetImporterContribution {
  id: string; label: string;       // e.g. "Lightroom preset (.xmp)"
  extensions: string[];            // lowercase with dot, e.g. [".xmp"]
  parse(file: File): Promise<{ name: string; params: Partial<DevelopParams> } | null>;
}
```

Teaches the Presets panel's Import picker to read preset files from other apps.

### `GridFilterContribution`

```typescript
interface GridFilterContribution {
  id: string;
  test(photo: CatalogPhoto): boolean; // return false to hide from the grid (and culling nav)
  onClear?(): void;                   // invoked by Library "Clear filters"
}
```

Applied as an extra AND step in the Library's visible-photos derivation. Re-register with the same id to update the predicate as your query changes.

### `LibrarySortContribution`

```typescript
interface LibrarySortContribution {
  id: string; label: string;          // also the persisted sort id
  compare(a: CatalogPhoto, b: CatalogPhoto): number; // ascending; the toolbar toggle flips it
}
```

Adds an entry to the Library toolbar's sort dropdown.

### `SlotContribution`

```typescript
interface SlotContribution {
  id: string;
  slot: "library-toolbar" | "library-subbar" | "develop-toolbar" | "develop-canvas-overlay";
  component: ComponentType;
  order?: number;
}
```

Named mount points in core chrome. `library-subbar` is a full-width bar below the Library toolbar (rendered only when something contributes to it). `develop-canvas-overlay` is a click-through layer over the Develop canvas — pair it with `api.develop.useDevelopOverlay()` (image rect + change nonce) and `api.develop.captureFrame(params)` (off-screen render aligned to the live view) to build before/after overlays.

## Core Types (`src/catalog/types.ts`)

### CatalogPhoto

```typescript
interface CatalogPhoto {
  id: string;
  filename: string;
  relPath: string;           // project-relative path
  folder: string;            // project-relative folder
  directoryHandle: FileSystemDirectoryHandle | null; // runtime-only
  fileHandle: FileSystemFileHandle | null;           // runtime-only
  thumbnailBlob: Blob | null;                         // runtime-only
  thumbnailUrl: string | null;                        // runtime-only
  width: number; height: number;
  fileSize: number; mimeType: string;
  rating: number;            // 0–5
  colorLabel: ColorLabel;    // "none" | "red" | "yellow" | "green" | "blue" | "purple"
  flag: FlagStatus;          // "none" | "pick" | "reject"
  rotation: number;          // 0 / 90 / 180 / 270 display rotation
  keywords: string[];
  dateCreated: number;
  dateImported: number;
  exif: ExifData;
}
```

Handles, blobs, and URLs are runtime-only — stripped before the record is written to `catalog.json`.

### DevelopParams

The complete non-destructive edit recipe. Slider ranges are −100..100 unless noted.

```typescript
interface DevelopParams {
  // Basic tone
  exposure;            // -5..5 EV
  contrast; highlights; shadows; whites; blacks;
  texture; clarity; dehaze; vibrance; saturation;
  // White balance
  temperature;         // Kelvin
  tint;                // -150..150
  // Detail — sharpening
  sharpening;          // 0..100 amount
  sharpenRadius;       // 1..3
  sharpenDetail;       // 0..100 halo suppression
  sharpenMasking;      // 0..100 edge masking
  // Detail — noise reduction
  luminanceNR; luminanceNRDetail; luminanceNRContrast;
  luminanceNRShadows; luminanceNRHighlights;
  colorNR; colorNRDetail; colorNRSmoothness;  // 0..100 each
  // Geometry
  straighten;          // -45..45 degrees
  crop;                // CropRect
  transform;           // perspectiveV/H, aspect, scale, offset, flips
  uprightMode;         // "off" | "auto" | "level" | "vertical" | "full" | "guided"
  guidedLines;         // GuidedLine[] for guided upright
  // Color
  toneCurve;           // ToneCurves: rgb + red/green/blue point curves
  hsl;                 // HSLAdjustments: 8 bands × hue/saturation/luminance
  colorGrading;        // shadows/midtones/highlights/global wheels
  // Optics & effects
  lensCorrection;      // mode, distortion, CA, defringe, vignetting
  vignette;            // amount, midpoint, roundness, feather, highlights
  grain;               // amount, size, roughness, color
  // Local
  masks;               // Mask[], ≤ MAX_MASKS (8); ≤ MAX_MASK_COMPONENTS (16) components total
  retouch;             // RetouchSpot[], ≤ MAX_RETOUCH (16); ≤ MAX_RETOUCH_BRUSH (4) brush-shaped
}
```

A `Mask` carries one or more **components** — `radial`, `linear`, `brush`, `lumRange`, or `colorRange` — each combined with mode `add` | `subtract` | `intersect`, plus opt-in per-mask sub-panels (`basic`, `wb`, `hsl`, `curve`, `detail`). Each `RetouchSpot` has a mode (`"heal"` | `"clone"`), position, source, radius, feather, and opacity.

`normalizeParams` upgrades older/partial params (e.g. from imported presets) so they stay compatible.

## State Stores (`api.stores`)

All stores are Zustand stores; subscribe in React with a selector or read imperatively with `getState()`. Available via `api.stores`: `useDevelopStore`, `useCatalogStore`, `useUIStore`, `useSettings`, `usePresetsStore`, `useKeybindings`, `useThemeStore`, `useLayoutStore`, `usePipelineStore`, plus the zustand `create` factory for your own store.

### useCatalogStore

State: `photos`, `selectedIds: Set<string>`, `activePhotoId`, `loading`, `needsReconnect`, `reconnecting`, `fileAccessNonce`.

Actions (selected): `loadCatalog()`, `reconnectFiles()`, `replaceCatalog(photos)`, `removePhoto(id)` / `removePhotos(ids)`, `setRating/setColorLabel/setFlag(id, value)`, batch `applyRating/applyColorLabel/applyFlag(ids, value)`, `rotatePhotos(ids, deg)`, `addKeyword/removeKeyword`, selection (`select`, `selectRange`, `toggleSelect`, `selectAll`, `deselectAll`), `setActivePhoto(id)`.

### useDevelopStore

State: `photoId`, `params: DevelopParams`, `previewParams` (transient preset hover), `history`/`historyIndex`, `histogram`, `asShotTemperature`, `resolvedLensProfile`, crop UI (`cropping`, `constrainCrop`, `cropAspect`, `cropGuide`, `cropGuideFlip`), `showClipping: 0|1|2|3`, and tool state (`activeTool`, `wbPicking`, `hslPicking`, mask/component/brush/retouch fields).

Actions (selected): `loadEdit(photoId)`, `setParam(key, value)`, `setToneCurve`, `setHslValue`, `applyPreset(params)`, `commitEdit(label)`, `undo`/`redo`/`reset`, `canUndo`/`canRedo`; masks (`addMask`, `updateMask`, `addComponent`, `addRangeComponent`, `addBrushDab`, `removeMask`); retouch (`addSpot`, `updateSpot`, `removeSpot`); `setShowClipping(mode)`. `setParam` updates live; `commitEdit(label)` snapshots into history and persists.

### useUIStore

`activeModule` (`"library" | "develop"`), `viewMode`, `gridSize`, `sortField`/`sortDirection`, `filter`, `activeFolder`, `detached: Set`. Actions: `setActiveModule`, `setViewMode`, `setSort`, `setFilter`, `clearFilters`, `setActiveFolder`, `setGridSize`, `markDetached`/`markAttached`.

### useSettings

Read imperatively with `getSettings()`; write with `updateSettings(patch)`. Keys (with defaults):

| Group | Keys |
|---|---|
| Interface | `uiScale` (1), `reduceMotion` (false), `uiFont` ("") |
| Startup | `restoreLastProject` (false) |
| Library | `defaultGridSize` (200), `defaultSortField` ("dateImported"), `defaultSortDirection` ("desc"), `confirmRemovePhotos` (true) |
| Previews | `previewSource` ("auto"), `thumbMaxEdge` (640), `persistPreviews` (true) |
| RAW cache | `rawCacheEnabled` (true), `rawCachePrefetch` (true), `rawCacheMaxEdge` (3072) |
| Develop / render | `developMaxEdge` (4096), `gpuSourceCacheBytes` (512 MB), `developPrefetchNeighbors` (true), `highBitDepth` (true), `liveHistogram` (true), `developOpenZoom` ("fit") |
| Export | `exportFormat` ("image/jpeg"), `exportQuality` (90), `exportLongEdge` (null), `exportBundle` (true), `exportColorSpace` ("srgb"), `exportPresets` ([]) |
| Shortcuts | `singleKeyShortcuts` (true) |
| Extensions | `extensionTopic` ("safelight-extension"), `checkExtensionUpdates` (true), `autoUpdateExtensions` (false) |
| Updates | `checkForUpdates` (true), `updateChannel` ("patch") |

## Storage (`src/catalog/storage.ts`, `src/project/`)

```typescript
interface CatalogStorage {
  getAllPhotos(): Promise<CatalogPhoto[]>;
  putPhoto(photo): Promise<void>;
  putPhotos(photos): Promise<void>;
  deletePhoto(id): Promise<void>;
  getEditState(photoId): Promise<EditState | undefined>;
  getAllEditStates(): Promise<EditState[]>;
  putEditState(editState): Promise<void>;
}
```

Opening a project installs a `ProjectStorage` backed by `<project>/.safelight/` (`catalog.json`, `previews/`, `raw/`); with no project open, writes are no-ops. `project/scan.ts` provides the recursive scan (`scanProject(root)` → `{ files, tree }`); `project/recent.ts` persists the last project handle in IndexedDB.

## Rendering (`src/rendering/`)

The renderer runs in a Web Worker on an `OffscreenCanvas`; the main thread talks to it through `RenderBridge` (`render-bridge.ts`):

```typescript
class RenderBridge {
  setImage(image, maxEdge?, isFallbackPreview?): void;
  setParams(params: DevelopParams): void;
  render(wantHistogram?, wantExtended?): void;
  capture(params: DevelopParams): Promise<ImageBitmap>; // off-screen render for overlays
  uploadSource(key, image, maxEdge?, bind?): void;       // budget-bounded GPU source cache
  bindSource(key): void;
  setCacheBudget(bytes): void;
  setActivePipeline(pipeline): void;
  setLensProfile(profile): void;
  setAsShotTemperature(kelvin): void;
}
```

Supporting utilities: `buildRGBCurveLUT(curves)`, histogram computation (`histogram.ts`), crop/transform/upright math (`crop-transform.ts`, `transform.ts`, `upright.ts`), color-space conversion + ICC (`color-space.ts`), and retouch helpers (`heal-source.ts`, `content-aware-fill.ts`).

## RAW (`src/raw/`)

`decodeRawToFloat(file)` returns a linear-float RGBA image via libraw-wasm or the in-house CFA path, or `null` (caller falls back to the embedded preview). `raw-cache.ts` reads/writes the decoded-preview cache.

## Presets (`src/modules/develop/preset-io.ts`)

Presets are open JSON files:

```json
{ "format": "safelight-preset", "version": 1, "name": "Punchy", "params": { /* Partial<DevelopParams> */ } }
```

Presets are Lightroom-style — they carry only the adjustments they set. `exportPreset(name, params)` downloads one; importing normalizes params so older presets stay compatible. Extensions can teach the importer new file types via `registerPresetImporter`.

## Export (`src/modules/export/export-image.ts`)

```typescript
interface ExportSettings {
  format: "image/jpeg" | "image/png" | "image/webp";
  quality: number;              // 0..1 (JPEG/WebP)
  longEdge: number | null;      // null = original size
  delivery: "zip" | "files" | "folder";
  colorSpace?: ColorSpaceId;    // default "srgb"
  sharpenAmount?: number;       // output sharpening
  sharpenRadius?: number;
  processorSettings?: Record<string, Record<string, unknown>>; // per-processor field values
  filenameTemplateId?: string;
}
```

Each photo renders through the worker renderer with its saved params, converts to the chosen output color space, applies output sharpening, encodes to a Blob, embeds the output ICC profile, then passes through every registered export processor (in registration order) before being written or bundled. Output carries no EXIF metadata.

`resolveFilenameTemplate(template, photo, format)` substitutes the built-in variables from the `CatalogPhoto` record; unknown variables are left as-is.

## Cross-Window Broadcast (`src/state/broadcast.ts`)

Detached windows synchronize over BroadcastChannel:

```typescript
broadcast({ type: "selection-change", payload: { activePhotoId: "..." } });
broadcast({ type: "edit-update",      payload: { photoId: "...", params: {...} } });
broadcast({ type: "catalog-change",   payload: { action: "add" } });
```

Preferences, themes, layouts, keybindings, and extension settings synchronize separately via the localStorage `storage` event.

## Keybindings (`src/state/keybindings-store.ts`)

Every shortcut is an action (`id`, `label`, `category: "General" | "Develop" | "Library"`, default combo, optional alternate). User overrides persist in localStorage and sync across windows. Combo format: `"Ctrl+Shift+Alt+<Key>"` with single characters uppercased and named keys as-is (`"Tab"`, `"ArrowLeft"`). Module-scoped actions only fire in their module, so combos may be reused across scopes. Extensions add actions via `registerKeybinding`.

## Electron bridge (`window.safelightNative`)

Present only in the desktop build (absent in the plain-browser dev build). Locked-down surface defined in `electron/preload.cjs` and typed in `src/extensions/types.ts`: `platform`, `versions`, `appVersion()`, `updates.install(repo, tag)`, `releases.fetch(repo)`, optional `github.repoMeta/readme`, `plugins.{list,install,uninstall,search}`, optional `devtools.*`, optional `diagnostics.{gpuInfo,metrics}`, and optional `fs.*` (path-based read/write/list/mkdir/remove/move/exists/pickDirectory). Extensions should feature-detect these before use.
