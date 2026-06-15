# API Documentation

Reference for the data structures and stores extensions interact with. Extensions receive these through the scoped `SafelightAPI` (`api.stores`, `api.components`, …) — see [Extensions](extensions.md) for the contribution API (`registerPanel`, `registerTheme`, `registerLayout`, `registerSliderIcon`, `registerSettings`, `settings`, `dock`, `themes`, `layouts`).

## Core Types (`src/catalog/types.ts`)

### CatalogPhoto

A photo record in the project catalog.

```typescript
interface CatalogPhoto {
  id: string;
  filename: string;
  directoryHandle: FileSystemDirectoryHandle | null;
  fileHandle: FileSystemFileHandle | null;
  thumbnailBlob: Blob | null;
  thumbnailUrl: string | null;
  width: number;
  height: number;
  fileSize: number;
  mimeType: string;
  rating: number;            // 0–5
  colorLabel: ColorLabel;    // "none" | "red" | "yellow" | "green" | "blue"
  flag: FlagStatus;          // "none" | "pick" | "reject"
  rotation: number;          // 0 / 90 / 180 / 270
  keywords: string[];
  dateCreated: number;
  dateImported: number;
  exif: ExifData;
}
```

Handles, blobs, and URLs are runtime-only — they are stripped before the record is written to `catalog.json`.

### DevelopParams

The complete non-destructive edit recipe for a photo.

```typescript
interface DevelopParams {
  // Basic
  exposure: number;            // -5..5 EV
  contrast: number;            // -100..100 (likewise for the sliders below)
  highlights: number;
  shadows: number;
  whites: number;
  blacks: number;
  texture: number;
  clarity: number;
  dehaze: number;
  vibrance: number;
  saturation: number;
  // White balance
  temperature: number;
  tint: number;
  // Detail
  sharpening: number;          // 0..100 capture sharpening amount
  sharpenRadius: number;       // 1..3
  sharpenDetail: number;       // 0..100 halo suppression
  sharpenMasking: number;      // 0..100 edge masking
  luminanceNR: number;         // 0..100 + detail / contrast
  luminanceNRDetail: number;
  luminanceNRContrast: number;
  colorNR: number;             // 0..100 + detail / smoothness
  colorNRDetail: number;
  colorNRSmoothness: number;
  // Geometry
  straighten: number;          // degrees, -45..45
  crop: CropRect;
  transform: TransformParams;  // perspectiveV/H, aspect, scale, offset
  // Color
  toneCurve: ToneCurves;       // rgb + red/green/blue point curves
  hsl: HSLAdjustments;         // 8 bands × hue/saturation/luminance
  colorGrading: ColorGradingParams; // shadows/midtones/highlights wheels
  // Optics & effects
  lensCorrection: LensCorrectionParams; // distortion, CA, defringe, vignetting
  vignette: VignetteParams;    // amount, midpoint, roundness, feather, highlights
  grain: GrainParams;          // amount, size, roughness
  // Local
  masks: Mask[];               // radial | linear | brush, ≤ MAX_MASKS (8)
  retouch: RetouchSpot[];      // heal | clone spots, ≤ MAX_RETOUCH (16)
}
```

Each `Mask` carries geometry (or brush dabs), an optional invert, and `MaskAdjustments` (exposure, contrast, highlights, shadows, saturation, temperature, tint, clarity, sharpness). Each `RetouchSpot` has a mode (`"heal"` | `"clone"`), position, source, radius, feather, and opacity.

## State Stores

All stores are Zustand stores; subscribe in React with a selector or read imperatively with `getState()`.

### useCatalogStore

Photos, selection, and culling for the open project.

State: `photos`, `selectedIds: Set<string>`, `activePhotoId`, `loading`, `needsReconnect`, `reconnecting`.

Actions: `loadCatalog()`, `reconnectFiles()`, `replaceCatalog(photos)`, `removePhoto(id)` / `removePhotos(ids)`, `setRating(id, rating)`, `setColorLabel(id, label)`, `setFlag(id, flag)`, batch variants `applyRating` / `applyColorLabel` / `applyFlag` `(ids, value)`, `rotatePhotos(ids, deg)`, `select(id)`, `selectRange(id, orderedIds?)`, `toggleSelect(id)`, `selectAll()`, `deselectAll()`, `setActivePhoto(id)`.

### useDevelopStore

The active edit session.

State: `photoId`, `params: DevelopParams`, `history` / `historyIndex` (undo stack), `histogram`, crop UI (`cropping`, `constrainCrop`, `cropAspect`, `cropGuide`, `cropGuideFlip`), and tool state (`activeTool`, `maskToolType`, `selectedMaskId`, `selectedSpotId`, `brushSize`, `brushFeather`, `brushErase`, `retouchMode`, `retouchSize`, `retouchFeather`, `retouchOpacity`).

Actions:

- Edits: `loadEdit(photoId)`, `setParam(key, value)`, `setToneCurve(channel, points)`, `setHslValue(band, channel, value)`, `applyPreset(params)`, `commitEdit(label)`, `undo()`, `redo()`, `reset()`, `canUndo()`, `canRedo()`.
- Masks: `addMask(mask)`, `updateMask(id, patch)`, `updateMaskAdj(id, patch)`, `addBrushDab(id, dab)`, `removeMask(id)`.
- Retouch: `addSpot(spot)`, `updateSpot(id, patch)`, `removeSpot(id)`.
- Tools: `setActiveTool`, `setMaskToolType`, `selectMask`, `selectSpot`, `setBrushSize/Feather/Erase`, `setRetouchMode/Size/Feather/Opacity`, crop setters, `setHistogram`.

`setParam` updates live; `commitEdit(label)` snapshots into history and persists.

### useUIStore

Active module (`"library" | "develop"`), grid view mode and size, sorting, and the set of detached modules. Actions: `setActiveModule(module)`, view/sort setters, `markDetached` / `markAttached`.

### useSettings

Application preferences (see Preferences in the [User Guide](user-guide.md)): `uiScale`, `reduceMotion`, `uiFont`, `defaultGridSize`, `defaultSortField/Direction`, `thumbMaxEdge`, `rawCacheEnabled`, `rawCacheMaxEdge`, `developMaxEdge`, `highBitDepth`, `liveHistogram`, `exportFormat/Quality/LongEdge/Bundle`, `singleKeyShortcuts`, `extensionTopic`. Read imperatively with `getSettings()`; write with `updateSettings(patch)`.

## Storage (`src/catalog/storage.ts`, `src/project/`)

Catalog persistence is pluggable:

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

Opening a project installs a `ProjectStorage` backed by `<project>/.safelight/` (`catalog.json`, `previews/`, `raw/`); with no project open, writes are no-ops. `project/scan.ts` provides the recursive folder scan (`scanProject(root)` → `{ files, tree }`), and `project/recent.ts` persists the last project handle in IndexedDB.

## Rendering (`src/rendering/`)

```typescript
class WebGLRenderer {
  constructor(canvas: HTMLCanvasElement)
  setImage(bitmap, maxEdge?): void   // upload texture (+ float path for RAW)
  setParams(params: DevelopParams): void
  render(): void
  dispose(): void
}
```

Supporting utilities: `buildRGBCurveLUT(curves)` (tone-curve LUTs), histogram computation (`rendering/histogram.ts`), crop/transform math (`crop-transform.ts`, `transform.ts` — `buildInverseTransform`, `computeCropForAspect`, `constrainCropToImage`, …), and retouch helpers (`heal-source.ts`, `content-aware-fill.ts`).

## RAW (`src/raw/`)

`decodeRawToFloat(file)` returns a linear-float RGBA image via libraw-wasm or the in-house CFA path, or `null` (caller falls back to the embedded preview). `raw-cache.ts` reads/writes the decoded-preview cache.

## Presets (`src/modules/develop/preset-io.ts`)

Presets are open JSON files:

```json
{ "format": "safelight-preset", "version": 1, "name": "Punchy", "params": { /* DevelopParams */ } }
```

`exportPreset(name, params)` downloads one; importing normalizes params through `normalizeParams` so older presets stay compatible.

## Export (`src/modules/export/export-image.ts`)

```typescript
type ProcessorSettings = Record<string, Record<string, unknown>>;

interface ExportSettings {
  format: "image/jpeg" | "image/png" | "image/webp";
  quality: number;              // 0..1 (JPEG/WebP)
  longEdge: number | null;      // null = original size
  delivery: "zip" | "files" | "folder";
  colorSpace?: ColorSpaceId;    // default "srgb"
  processorSettings?: ProcessorSettings; // per-processor field values keyed by processor id
  filenameTemplateId?: string;  // active FilenameTemplateContribution id; undefined = default
}
```

Each photo renders through `WebGLRenderer` with its saved params, encodes to a Blob, embeds the output ICC profile, then passes through every registered export processor in registration order before being written to disk or bundled. Output carries no EXIF metadata.

`resolveFilenameTemplate(template, photo, format)` substitutes built-in variables (`{filename}`, `{ext}`, `{year}`, `{month}`, `{day}`, `{rating}`, `{camera}`, `{lens}`) from the `CatalogPhoto` record; unknown variables are left as-is.

### Export processor contributions (`ExportProcessorContribution`)

```typescript
interface ExportProcessorContribution {
  id: string;      // globally unique, e.g. "my-ext.watermark"
  label: string;   // section header in the Export panel
  settings?: ExportProcessorField[];  // fields rendered in the Export panel
  process(blob: Blob, photo: CatalogPhoto, settings: Record<string, unknown>): Promise<Blob>;
}
```

`ExportProcessorField` mirrors `SettingsField` — `boolean`, `number`, `string`, and `select` variants. Each field's `default` is merged with the user's current values before calling `process`. Processor errors are caught and logged; the unmodified input Blob is forwarded so a broken extension never silently drops an export.

### Filename template contributions (`FilenameTemplateContribution`)

```typescript
interface FilenameTemplateContribution {
  id: string;      // globally unique
  label: string;   // shown in the Filename picker in the Export panel
  template: string; // e.g. "{year}-{month}-{day}_{filename}"
}
```

Built-in variables: `{filename}` (base name without extension), `{ext}`, `{year}`, `{month}`, `{day}`, `{rating}`, `{camera}`, `{lens}`. Unknown variables are left as `{variableName}`.

## Cross-Window Broadcast (`src/state/broadcast.ts`)

Detached windows synchronize over BroadcastChannel:

```typescript
broadcast({ type: "catalog-change", payload: { action: "add" } })
broadcast({ type: "selection-change", payload: { activePhotoId: "..." } })
broadcast({ type: "edit-update", payload: { photoId: "...", params: {...} } })
```

Preferences, themes, layouts, keybindings, and extension settings synchronize separately via the localStorage `storage` event.

## Keybindings (`src/state/keybindings-store.ts`)

Every shortcut is an action (`id`, `label`, `category: "General" | "Develop" | "Library"`, default combo, optional alternate). User overrides persist in localStorage and sync across windows. Combo format: `"Ctrl+Shift+Alt+<Key>"` with single characters uppercased and named keys as-is (`"Tab"`, `"ArrowLeft"`). Module-scoped actions only fire in their module, so combos may be reused across scopes.
