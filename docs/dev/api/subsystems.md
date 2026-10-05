# Subsystems

← [API Reference](README.md)

Lower-level systems extensions occasionally touch. Most extensions never need these directly — they're documented for advanced tools and for understanding how the pieces fit.

- [Storage](#storage) · [Rendering](#rendering) · [RAW](#raw) · [Presets](#presets) · [Export](#export) · [Cross-window broadcast](#cross-window-broadcast) · [Keybindings](#keybindings) · [Electron bridge](#electron-bridge-windowsafelightnative)

## Storage

`src/catalog/storage.ts`, `src/project/`

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

## Rendering

`src/rendering/`

The renderer runs in a Web Worker on an `OffscreenCanvas`; the main thread talks to it through `RenderBridge` (`render-bridge.ts`):

```typescript
class RenderBridge {                                     // selected members
  setImage(image, maxEdge?, isFallbackPreview?, baseCurveForBitmap?): void;
  setParams(params: DevelopParams): void;                // posts each params object once (replace params, never mutate them); re-sends the live pipeline when displayTransform changes
  setContributedParams(bag: Record<string, unknown>): void; // extension stage params (the param bag); posts only what differs from the last bag (replace the bag and its values, never mutate them)
  setStages(stages: ProcessingStageContribution[]): void;
  setStageTextures(bag: Record<string, StageTextureData>): void;
  render(wantHistogram?, wantExtended?): void;
  capture(params: DevelopParams): Promise<ImageBitmap>;   // off-screen render, pipeline resolved from params
  uploadSource(target, key, image, maxEdge?, isFallbackPreview?, baseCurveForBitmap?, bind?): void; // budget-bounded GPU source cache
  bindSource(key): Promise<boolean>;                     // false on a cache miss: decode + uploadSource
  hasSource(target, key): Promise<boolean>;
  setCacheBudget(bytes): void;
  renderThumbnailFromSource(opts): Promise<Blob | null>; // per-render params + param bag
  setPipeline(pipeline): void;
  syncPipeline(): void;                                   // re-sends the live photo's pipeline
  setAsShotTemperature(kelvin): void;
}
```

Supporting utilities: `buildRGBCurveLUT(curves)`, histogram computation (`histogram.ts`), crop/transform/upright math (`crop-transform.ts`, `transform.ts`, `upright.ts`), color-space conversion + ICC (`color-space.ts`), and retouch helpers (`heal-source.ts`, `content-aware-fill.ts`).

## RAW

`src/raw/`

`decodeRawToFloat(file)` returns a linear-float RGBA image via libraw-wasm or the in-house CFA path, or `null` (caller falls back to the embedded preview). `raw-cache.ts` reads/writes the decoded-preview cache.

## Presets

`src/modules/develop/preset-io.ts`

Presets are open JSON files:

```json
{
  "format": "safelight-preset",
  "version": 1,
  "name": "Punchy",
  "group": "Landscape",
  "params": { /* Partial<DevelopParams> */ },
  "paramBag": { /* extension stage params by qualified key; omitted when empty */ }
}
```

Presets are Lightroom-style — they carry only the adjustments they set. `exportPreset(name, params, group?, paramBag?)` downloads one as `<name>.safelight.json`. On import, params are sanitized (unknown keys and wrong-typed values are dropped) and normalized so older presets stay compatible; a file with a newer `version` than the build reads is refused rather than applied with misread keys. Which extension params a preset saves is governed by each stage's [`presetScope`](contributions.md#processingstagecontribution--gpu-stage).

The Import picker tries Safelight's own JSON first, then the [`registerPresetImporter`](contributions.md#presetimportercontribution) contribution that claims the file's extension. `.xmp` and `.lrtemplate` stay selectable even with no importer installed, so choosing one tells the user an importer extension is needed instead of the folder looking empty.

## Export

`src/modules/export/export-image.ts`

```typescript
interface ExportSettings {
  format: "image/jpeg" | "image/png" | "image/webp" | "image/tiff";
  quality: number;              // 0..1 (JPEG/WebP)
  longEdge: number | null;      // null = original size
  delivery: "zip" | "files" | "folder";
  bundle: boolean;              // deprecated; use delivery
  colorSpace?: ColorSpaceId;    // default "srgb"
  sharpenAmount?: number;       // output sharpening, 0..150 (0 = off)
  sharpenRadius?: number;       // 0.3..3.0 px
  tiffBitDepth?: 8 | 16;        // TIFF only; 16-bit falls back to 8 where float targets are unavailable
  includeMetadata?: boolean;    // carry camera, lens, exposure and capture date (off by default)
  includeLocation?: boolean;    // keep GPS when metadata is included (off by default)
  processorSettings?: Record<string, Record<string, unknown>>; // per-processor field values
  filenameTemplateId?: string;
}
```

Each photo renders through the worker renderer with its saved params, converts to the chosen output color space, applies output sharpening, encodes to a Blob, embeds the output ICC profile, then passes through every registered [export processor](contributions.md#exportprocessorcontribution) (in registration order) before being written or bundled. Exports carry no EXIF unless `includeMetadata` is set, and no GPS unless `includeLocation` is set as well. To render without writing files, use [`api.export.renderPhotos`](stores.md#apiexport).

`resolveFilenameTemplate(template, photo, format)` substitutes the built-in variables from the `CatalogPhoto` record; unknown variables are left as-is.

## Cross-Window Broadcast

`src/state/broadcast.ts`

Detached windows synchronize over BroadcastChannel:

```typescript
broadcast({ type: "selection-change", payload: { activePhotoId: "..." } });
broadcast({ type: "edit-update",      payload: { photoId: "...", params: {...} } });
broadcast({ type: "catalog-change",   payload: { action: "add" } });
```

Preferences, themes, layouts, keybindings, and extension settings synchronize separately via the localStorage `storage` event.

## Keybindings

`src/state/keybindings-store.ts`

Every shortcut is an action (`id`, `label`, `category: "General" | "Develop" | "Library"`, default combo, optional alternate). User overrides persist in localStorage and sync across windows. Combo format: `"Ctrl+Shift+Alt+<Key>"` with single characters uppercased and named keys as-is (`"Tab"`, `"ArrowLeft"`). Module-scoped actions only fire in their module, so combos may be reused across scopes. Extensions add actions via [`registerKeybinding`](contributions.md#keyactioncontribution).

## Electron bridge (`window.safelightNative`)

Present only in the desktop build (absent in the plain-browser dev build). Locked-down surface defined in `electron/preload.cjs` and typed in `src/extensions/types.ts`:

| Member | What it does |
|---|---|
| `platform`, `versions`, `appVersion()` | Host OS, Electron/Chrome versions, and the live app version |
| `releases.fetch(repo)` | GitHub Releases proxy (runs in the main process, outside the renderer CSP) |
| `github.{repoMeta, readme, iconUrl, thumbnails, onThumbnail}` | Extensions-store metadata, README and thumbnail proxy (optional) |
| `plugins.{list, install, uninstall, search}` | The plugin host; optional `remoteManifest`, `settleUpdate` and `trustList` on newer builds |
| `devtools.{open, close, toggle, isOpen, reload, syncDevFolder}` | Chrome DevTools control for the Developer Tools extension (optional) |
| `diagnostics.{gpuInfo, metrics}` | GPU feature status and per-process metrics (optional) |
| `titlebar.setOverlay(color, symbolColor)` | Recolor the native window controls to match the theme (optional) |
| `claimPrivileged()` | One-shot handover of the path-based filesystem (`fs`) and update installer (`updates`) |

Raw filesystem access and the update installer are privileged: core calls `claimPrivileged()` once at boot and every later call returns `null`, so extension code, which shares the renderer, can never acquire them. Extensions work with files through the handles core hands them, such as `CatalogPhoto.fileHandle` and the `dir` passed to catalog hooks. Feature-detect the optional members before use; they are absent on older Electron builds.
