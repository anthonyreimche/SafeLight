# Subsystems

← [API Reference](README.md)

The core systems behind the API, from an extension's point of view: what each one does, what it means for your code, and which `api` member to use instead of reaching in. You rarely need this page to write an extension. For the core's own code, see [Architecture](../architecture.md).

- [Storage](#storage) · [Rendering](#rendering) · [RAW](#raw) · [Presets](#presets) · [Export](#export) · [Cross-window broadcast](#cross-window-broadcast) · [Keybindings](#keybindings) · [Electron bridge](#electron-bridge-windowsafelightnative)

## Storage

A project keeps its catalog with the photos, in `<project>/.safelight/`:

```
<project>/.safelight/
├─ catalog.json   # photo records and edit histories
├─ previews/      # stored previews
└─ raw/           # decoded RAW cache (see RAW)
```

- Read and write records and edits through [`api.catalog`](stores.md#apicatalog) and the catalog store, not the storage object. Writes there reach every window.
- An edit you put is visible to `getEditState` as soon as the call returns, before the file is saved, so you can reload Develop right after.
- With no project open, writes do nothing.

## Rendering

The renderer runs in a Web Worker on an `OffscreenCanvas`. Your JavaScript never talks to it directly. It receives your stages, textures and the photo's param bag from the core.

- **Replace bag values, never mutate them.** Only values whose identity changed are sent to the worker. An array or object edited in place never reaches the renderer.
- To get pixels back, use [`api.develop`](stores.md#apidevelop): `captureFrame` for what Develop shows, `renderPhotoFrame` for any photo.
- The worker also renders thumbnails and exports, from the same program as Develop.
- Render order, phases and colour handling: [How a photo is rendered](../rendering.md).

## RAW

RAWs are decoded in a pool of workers to linear float RGB, with the camera's colour matrix and as-shot white balance applied. When a RAW can't be decoded (an unsupported camera, a timeout), Safelight falls back to the camera's embedded preview and marks the photo.

- Until the RAW decodes, Develop shows the embedded preview. Captures taken then are drawn from it too.
- Decoded previews are cached in `.safelight/raw/` (about 43 MB per photo at the default size), so reopening a photo skips the decode.
- Decode failures are remembered, so a file the decoder can't read isn't decoded again on every open.

## Presets

Presets are open JSON files that carry only the settings they set:

```json
{
  "format": "safelight-preset",
  "version": 1,
  "name": "Punchy",
  "group": "Landscape",
  "params": { },
  "paramBag": { }
}
```

- `params` is a partial `DevelopParams`. `paramBag` holds extension stage values by qualified key, and is omitted when empty.
- On import, unknown keys and wrong-typed values are dropped. A file with a newer `version` than the build knows is refused.
- Which of your stage's values a preset saves is set by its [`presetScope`](contributions.md#processingstagecontribution--gpu-stage).
- Other apps' preset files are read by [`registerPresetImporter`](contributions.md#presetimportercontribution) contributions.

## Export

```typescript
interface ExportSettings {
  format: "image/jpeg" | "image/png" | "image/webp" | "image/tiff";
  quality: number;              // 0..1 (JPEG, WebP)
  longEdge: number | null;      // null = original size
  delivery: "zip" | "files" | "folder";
  colorSpace?: ColorSpaceId;    // default "srgb"
  sharpenAmount?: number;       // output sharpening, 0..150 (0 = off)
  sharpenRadius?: number;       // 0.3..3.0 px
  tiffBitDepth?: 8 | 16;        // TIFF only
  pngBitDepth?: 8 | 16;         // PNG only, default 8 (3.1.0)
  includeMetadata?: boolean;    // camera, lens, exposure, date (off)
  includeLocation?: boolean;    // GPS, with includeMetadata (off)
  processorSettings?: Record<string, Record<string, unknown>>; // per processor
  filenameTemplateId?: string;
}
```

Each photo goes through these steps:

1. Render with its saved edit, in the worker.
2. Convert to the export colour space and apply output sharpening.
3. Every export processor's `processPixels`.
4. Encode, with the colour space's ICC profile.
5. Every export processor's `process`.

- 16-bit output falls back to 8-bit on GPUs without float render targets.
- Files carry no EXIF unless `includeMetadata` is on, and no GPS unless `includeLocation` is on too.
- A photo whose original is out of reach fails instead of exporting its stored preview. `ExportResult.failures` lists it.
- To render without writing files, use [`api.export.renderPhotos`](stores.md#apiexport). Filename templates: [`registerFilenameTemplate`](contributions.md#filenametemplatecontribution).

## Cross-Window Broadcast

Every Safelight window runs its own copy of the app and of each extension. The windows keep each other up to date:

- **Catalog records and edits** reach every window on the same catalog when they are written, through `api.catalog` or the catalog store. Each change is stamped, so the newest wins whatever order messages arrive in. Never post these messages yourself.
- **Edits** reach other windows when they are committed (a slider released, undo, redo, paste), not on every slider tick. Only the window doing the editing shows the in-progress look.
- **Preferences, themes, layouts, shortcuts and extension settings** sync between windows on their own.
- For your own state across windows, use [`api.settings`](README.md#imperative-control-surfaces) (persisted) or [`api.variables`](stores.md#apivariables-shared-variables) (for the session).

## Keybindings

Every shortcut is an action with an id, a label, a category (`"General"`, `"Develop"` or `"Library"`) and a default combo. Users can rebind any of them in **Preferences ▸ Shortcuts**.

- **Combo format:** `"Ctrl+Shift+Alt+<Key>"`. Single characters are uppercase, named keys are written as-is (`"Tab"`, `"ArrowLeft"`). `""` means unbound.
- Actions scoped to a module fire only in that module, so the same combo can be reused in another module.
- Add your own with [`registerKeybinding`](contributions.md#keyactioncontribution). Read live combos with `api.keybindings`.

## Electron bridge (`window.safelightNative`)

Present only in the desktop app. Feature-detect it, and its optional members, before use.

| Member | What it does |
|---|---|
| `platform`, `versions`, `appVersion()` | Host OS, Electron and Chrome versions, the app version |
| `releases.fetch(repo)` | GitHub Releases, fetched outside the app's content-security policy |
| `github.{repoMeta, readme, iconUrl, thumbnails, onThumbnail}` | Store metadata, READMEs and thumbnails |
| `plugins.{list, install, uninstall, search}` | The extension host's install folder |
| `devtools.{open, close, toggle, isOpen, reload, syncDevFolder}` | Chrome DevTools, for the Developer Tools extension |
| `diagnostics.{gpuInfo, metrics}` | GPU feature status and per-process metrics |
| `titlebar.setOverlay(color, symbolColor)` | Recolour the native window controls |

Raw filesystem access by path and the update installer are not on the bridge. The core claims them once at boot, before any extension loads, so extension code can't reach them. Work with files through the handles the core gives you, such as `CatalogPhoto.fileHandle` and the `dir` passed to catalog hooks.
