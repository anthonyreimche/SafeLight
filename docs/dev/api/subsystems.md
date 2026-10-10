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
  putPhotos(photos): Promise<void>;           // records stored, then changed previews written; a preview that can't be written doesn't reject
  deletePhoto(id): Promise<void>;
  getEditState(photoId): Promise<EditState | undefined>;
  getAllEditStates(): Promise<EditState[]>;
  putEditState(editState): Promise<void>;     // held once the call returns, before its save settles
  putEditStates(editStates): Promise<void>;   // stores them all, then persists once; held as putEditState
  getPhotoBlob?(photoId, key): Promise<Uint8Array | null>;
  putPhotoBlob?(photoId, key, data): Promise<void>;
  flush?(options?: { unloading?: boolean }): Promise<void>;
  close?(): void;
}
```

Opening a project installs a `ProjectStorage` backed by `<project>/.safelight/` (`catalog.json`, `previews/`, `raw/`); with no project open, writes are no-ops. An edit state is held as soon as `putEditState(s)` returns: `getEditState` gives it back at once, before the save settles, so a caller may reload Develop right after (the extension host does for `api.catalog.putEditState`). `flush` writes pending changes now; with none, it waits for a write still running and writes again if that one failed, and with `unloading` (the window is closing) the write starts at once, beside one still running. `setCatalogStorage` closes the storage it replaces: nothing it takes on is reported any more, writes made through it still persist, and it stops following the other windows once it has nothing left to write. `project/scan.ts` provides the recursive scan (`scanProject(root)` → `{ files, tree }`); `project/recent.ts` persists the last project handle in IndexedDB.

## Rendering

`src/rendering/`

The renderer runs in a Web Worker on an `OffscreenCanvas`; the main thread talks to it through `RenderBridge` (`render-bridge.ts`):

```typescript
class RenderBridge {                                     // selected members
  setImage(image, maxEdge?, isFallbackPreview?, baseCurveForBitmap?): void;
  clearSource(): void;                                   // the view moved to another photo: nothing drawn until its source is set or bound
  get sourceGen(): number;                               // number of the develop source handed over last; frames carry theirs
  setParams(params: DevelopParams): void;                // first params whole, then only the top-level fields that changed identity (replace params and each changed field, never mutate them); re-sends the live pipeline when displayTransform changes
  setContributedParams(bag: Record<string, unknown>): void; // extension stage params (the param bag); posts only what differs from the last bag (replace the bag and its values, never mutate them)
  setStages(stages: ProcessingStageContribution[]): void;
  setStageTextures(bag: Record<string, StageTextureData>): void;
  render(wantHistogram?, wantExtended?): void;           // one in flight; the newest request waits (histogram flags merged) until the worker answers
  computeHistogram(wantExtended?): void;                 // rides on a waiting render, else posts at once
  capture(params: DevelopParams): Promise<ImageBitmap>;   // off-screen render, pipeline resolved from params
  uploadSource(target, key, image, maxEdge?, isFallbackPreview?, baseCurveForBitmap?, bind?): void; // budget-bounded GPU source cache
  bindSource(key): Promise<boolean>;                     // false on a cache miss (or a bind that threw): decode + uploadSource
  setOnSourceError(cb: (sourceGen: number) => void): void; // a develop source the worker couldn't take
  hasSource(target, key): Promise<boolean>;
  setCacheBudget(bytes): void;
  renderThumbnailFromSource(opts): Promise<Blob | null>; // per-render params + param bag
  setPipeline(pipeline): void;
  syncPipeline(): void;                                   // re-sends the live photo's pipeline
  setAsShotTemperature(kelvin): void;
}
```

The worker answers every render: with a frame (`setOnFrame`; it carries the size and `sourceGen` of the source it was drawn from), with nothing to draw (no renderer, or no source yet for the photo the view moved to), or with an error. A render not answered in 2 s, or in 3× the slowest of the last eight answers once one of them took longer, is given up on with one console warning, and the waiting request goes; nothing more is posted until the worker answers one of the two, unless it says nothing for 30 s. A develop source the worker can't take goes to `setOnSourceError` with its number, and nothing is drawn until the next source.

Supporting utilities: `buildRGBCurveLUT(curves)`, histogram computation (`histogram.ts`), crop/transform/upright math (`crop-transform.ts`, `transform.ts`, `upright.ts`), color-space conversion + ICC (`color-space.ts`), and retouch helpers (`heal-source.ts`, `content-aware-fill.ts`).

## RAW

`src/raw/`

`decodeRawToFloat(file, request?)` returns a linear-float RGBA image (`RawFloatImage`) via libraw-wasm or the in-house CFA path, or a `DecodeFailure` saying why there is none, and the caller falls back to the embedded preview:

```typescript
interface DecodeFailure {
  failure: "unsupported" | "transient" | "aborted"; // unsupported: decoding again won't help until the decoder changes
  reason?: string;       // the decoder's words, never shown to the user; none for an abandoned request
  timedOut?: boolean;    // libraw gave no answer within its time limit
  passedOver?: boolean;  // background work skipped the file: it timed out earlier this session, or is being decoded already
}
```

`request` is `{ background?, signal? }`. A background decode waits behind every interactive one and never holds every libraw instance; `signal` abandons a request still waiting for an instance (`{ failure: "aborted" }`). The time limit is a minute plus 20 s per 25 MB, extended once the frame is known to a minute plus 2 s per megapixel (that part capped at five minutes); an instance whose call outlives it, or traps, is terminated and replaced. `raw-cache.ts` reads/writes the decoded-preview cache and the decode markers that keep a RAW the decoder can't use from being decoded again.

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

Each photo renders through the worker renderer with its saved params, converts to the chosen output color space, applies output sharpening, encodes to a Blob, embeds the output ICC profile, then passes through every registered [export processor](contributions.md#exportprocessorcontribution) (in registration order) before being written or bundled. Exports carry no EXIF unless `includeMetadata` is set, and no GPS unless `includeLocation` is set as well. A photo whose load falls back on its edited stored preview (`fallback.from === "stored-edited"`, the original out of reach) isn't rendered: it fails, and `ExportResult.failures` gives `{ filename, reason }` for it, which the Export panel lists. To render without writing files, use [`api.export.renderPhotos`](stores.md#apiexport).

`resolveFilenameTemplate(template, photo, format)` substitutes the built-in variables from the `CatalogPhoto` record; unknown variables are left as-is.

## Cross-Window Broadcast

`src/state/broadcast.ts`

Detached windows synchronize over BroadcastChannel:

```typescript
broadcast({ type: "selection-change", payload: { activePhotoId: "..." } });
broadcast({ type: "edit-update",      payload: { photoId: "...", params: {...} } });
broadcast({ type: "catalog-change",   payload: { action: "add", origin: WINDOW_ID } });
```

`edit-update` is announced by commits, undo and redo, and stored edits (such as pasted settings), not by live slider ticks or brush dabs. Other windows see an edit when it commits; only the window doing the editing holds the in-progress look, in its develop store.

`catalog-change` carries `origin`, the sending window's `WINDOW_ID`, so a window can skip its own echo. An `update` that names a photo (`id`) means that photo's preview was rewritten, and the other windows reload it, so name a photo for nothing else.

`catalog-records` is sent by each window's `ProjectStorage` with every catalog write (`putEditState(s)`, `putPhoto(s)`, `deletePhoto`, and the photos an open finds in the folder): the edit histories, photo records as stored and removed ids it wrote, tagged with the catalog file they belong to. The other windows on that catalog apply it to their own copy, their catalog store and the photo open in Develop, so writing through `api.catalog` or the catalog store reaches every window; never post it yourself. Each record carries change stamps, so a window keeps the newer change to each group of a photo's fields, and to each edit history, whatever order the messages arrive in. A window's storage that has just read `catalog.json` sends `catalog-hello`, and every other storage on that catalog answers it alone with the changes it holds, which the file may not have yet. A photo a window adds while another is open (a virtual copy, a newly found file) is kept by the other window for its saves, and shows there once it reopens the project.

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
