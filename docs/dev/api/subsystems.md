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

## RAW

`src/raw/`

`decodeRawToFloat(file)` returns a linear-float RGBA image via libraw-wasm or the in-house CFA path, or `null` (caller falls back to the embedded preview). `raw-cache.ts` reads/writes the decoded-preview cache.

## Presets

`src/modules/develop/preset-io.ts`

Presets are open JSON files:

```json
{ "format": "safelight-preset", "version": 1, "name": "Punchy", "params": { /* Partial<DevelopParams> */ } }
```

Presets are Lightroom-style — they carry only the adjustments they set. `exportPreset(name, params)` downloads one; importing normalizes params so older presets stay compatible. Extensions can teach the importer new file types via [`registerPresetImporter`](contributions.md#presetimportercontribution).

## Export

`src/modules/export/export-image.ts`

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

Each photo renders through the worker renderer with its saved params, converts to the chosen output color space, applies output sharpening, encodes to a Blob, embeds the output ICC profile, then passes through every registered [export processor](contributions.md#exportprocessorcontribution) (in registration order) before being written or bundled. Output carries no EXIF metadata.

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

Present only in the desktop build (absent in the plain-browser dev build). Locked-down surface defined in `electron/preload.cjs` and typed in `src/extensions/types.ts`: `platform`, `versions`, `appVersion()`, `updates.install(repo, tag)`, `releases.fetch(repo)`, optional `github.repoMeta/readme`, `plugins.{list,install,uninstall,search}`, optional `devtools.*`, optional `diagnostics.{gpuInfo,metrics}`, and optional `fs.*` (path-based read/write/list/mkdir/remove/move/exists/pickDirectory). Extensions should feature-detect these before use.
