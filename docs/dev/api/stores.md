# State Stores & Data APIs

← [API Reference](README.md)

Live app state, the brush and mask model, and the APIs for the Develop canvas, rendering photos without opening them, the catalogue and variables shared across windows.

- [State stores (`api.stores`)](#state-stores-apistores)
- [Masks](#masks-the-develop-stores-mask-edits)
- [`api.develop`](#apidevelop)
- [`api.params`](#apiparams)
- [`api.export`](#apiexport)
- [`api.catalog`](#apicatalog)
- [`api.variables` (shared variables)](#apivariables-shared-variables)

## State stores (`api.stores`)

Zustand stores, typed to the app's real hooks. Subscribe in React with a selector, or read once with `getState()`.

```ts
useCatalogStore   // photos, selection, ratings, keywords
useDevelopStore   // the open photo's edit, history, tools
useUIStore        // active module, grid, sort, filters
useSettings       // app preferences (read-only)
usePresetsStore   // presets list
useKeybindings    // rebindable actions
useThemeStore     // active theme
useLayoutStore    // dock layouts
usePipelineStore  // default display transform
create            // zustand's create, for your own store
```

For presets, keybindings, themes, layouts and pipelines, prefer `api.themes.apply`, `api.layouts.apply`, `api.pipelines.apply` and `api.keybindings.getBinding`. A photo's own display transform is `params.displayTransform` in `useDevelopStore`; `api.pipelines.effectiveId` resolves it.

### useCatalogStore

The catalogue as the Library shows it. Read it in a component with `useCatalogStore((s) => s.photos)`, or anywhere with `useCatalogStore.getState()`. The rating, label, flag and keyword actions save straight away: they store the records, update other windows and fire every extension's `onMetadataChange` hook, so `await` them and there's nothing else to do. For adding records or editing edit stacks, use [`api.catalog`](#apicatalog).

```ts
photos; selectedIds: Set<string>; activePhotoId; loading;
needsReconnect; reconnecting; fileAccessNonce;
loadCatalog(); reconnectFiles(); replaceCatalog(photos);
addPhotos(photos, opts?); updatePhoto(…); removePhoto(id); removePhotos(ids);
setRating / setColorLabel / setFlag(id, v);
applyRating / applyColorLabel / applyFlag(ids, v); // batch
rotatePhotos(ids, deg);
addKeyword(id, keyword) / removeKeyword(id, keyword);      // Promise<void>
addKeywords(ids, keywords) / removeKeywords(ids, keywords); // Promise<void>, batch
setCopyName;                                      // virtual copies
select; selectRange; toggleSelect; selectAll; deselectAll; setActivePhoto(id);
```

### useDevelopStore

The open photo's edit. Change values live with `setParam` or `setDynParam`, then call `commitEdit(label)` once when the gesture ends.

```ts
photoId; params: DevelopParams;
paramBag;                        // extension stage values, see api.params
previewParams; previewParamBag;  // transient preset-hover preview
history; historyIndex; histogram; asShotTemperature;
sourceSize;                      // size of the drawn source, upright
editError;                       // why the photo's edit couldn't be read, or null
showClipping;                    // bits: 1 shadows, 2 highlights, 4 gamut (v3)
colorAssessment; bypassedPanels;

loadEdit(photoId, asShotTemperature?);
reloadEdit();                    // take on the open photo's stored edit
setParam(key, value);            // live, no history entry
setDynParam(qualifiedKey, value); setDynParams(patch);
setToneCurve; setHslValue;
applyPreset(params, paramBag?);  // takes full params
setPreviewParams(params, paramBag?);
commitEdit(label);               // one undo step, then saved
resetParams(keys, label); undo; redo; reset; canUndo; canRedo;
updateProcessing();              // version 1 to current, one undo step
setShowClipping(mode); setPanelBypass(panelId, on);
```

**Notes**

- Never edit an array or object in place. Pass a new one whenever it changes (`masks` and `retouch` included), or the change never reaches the renderer.
- `applyPreset` takes full params. Merge a partial preset over the current params first, or every omitted adjustment resets.
- `commitEdit` does nothing when nothing changed: no history entry, and the redo steps stay.
- Opening another photo commits a live change you haven't committed yet to the photo you left, labelled "Edit". Commit with your own label before then if the label matters.
- `reloadEdit` reads the open photo's edit back from the catalogue after something else wrote it. If a live change is still uncommitted, the change stays and only the history behind it is renewed.
- If the open photo's stored edit can't be read, `loadEdit` still opens the photo, but with no history and `editError` set to the reason. Commits, undo and redo do nothing for it until it opens again (`reloadEdit` retries) or another photo opens.
- Commits build on the edit the catalogue holds, one at a time per photo, so steps another window stored are kept under yours.
- Derive image aspect from `sourceSize`, not `photo.width/height`. It is `{0, 0}` until a frame is drawn. `fullWidth`/`fullHeight` are the decoded size before the upload cap; `native` is true while `api.develop.readSourceSample` has a sample (3.1.0).

### useUIStore

```ts
activeModule;   // "library" | "develop" or a registered module id
viewMode; gridSize; gridColumns; sortField; sortDirection;
filter; activeFolder; detached: Set<string>;
setActiveModule; setViewMode; setSort; setFilter; clearFilters;
setActiveFolder; setGridSize; stepGridSize; setGridColumns;
markDetached; markAttached;
```

`setSort`, `setGridSize` and `stepGridSize` are saved and restored on the next launch.

### useSettings

The user's preferences. The state is the settings object itself: `useSettings((s) => s.exportFormat)` or `useSettings.getState()`.

Treat it as read-only. Core writes through its own `updateSettings`, which saves the change and applies side effects such as UI scale; a raw `setState` does neither. Keep your own options in [`api.settings`](README.md#imperative-control-surfaces).

| Group | Keys |
|---|---|
| Interface | `uiScale`, `reduceMotion`, `uiFont`, `sliderJumpToCursor`, `dropdownWheelSelect`, `editingHighlights`, `colorOverrides` |
| Canvas | `canvasSurroundOverride`, `canvasSurround`, `assessBorderPct`, `windowDim` |
| Accessibility | `highContrast`, `strongFocus`, `largerText`, `largerControls`, `lowercaseHeadings`, `reduceTransparency`, `keyboardCanvasEditing`, `colorVisionFilter`, `syncOSAccessibility` |
| Startup, Library | `restoreLastProject`, `defaultGridSize`, `defaultSortField`, `defaultSortDirection`, `confirmRemovePhotos`, `showSubfolderPhotos` |
| Catalogue | `catalogLocation` (`"in-folder"` or `"external"`), `externalCatalogDir` |
| Previews, cache | `previewSource`, `thumbMaxEdge`, `persistPreviews`, `rawCacheEnabled`, `rawCachePrefetch`, `rawCacheMaxEdge` |
| Develop | `developMaxEdge`, `gpuSourceCacheBytes`, `developPrefetchNeighbors`, `highBitDepth`, `liveHistogram`, `developOpenZoom` |
| Export | `exportFormat`, `exportQuality`, `exportLongEdge`, `exportBundle`, `exportColorSpace`, `exportTiffBitDepth`, `exportPngBitDepth`, `exportIncludeMetadata`, `exportIncludeLocation`, `exportIfExists` (`"number"` or `"replace"`), `exportPresets` |
| Other | `singleKeyShortcuts`, `extensionTopic`, `checkExtensionUpdates`, `autoUpdateExtensions`, `onlyVerifiedExtensions`, `extensionsMaximized`, `checkForUpdates`, `updateChannel` |

## Masks (the develop store's mask edits)

The masks, the tools that draw them and their selection are the Masking extension's (3.2.0); an on-image tool takes the canvas with [`api.develop.setCanvasTool`](#apidevelop). Core keeps the edits its mask scope makes:

```ts
updateMask(id, patch);            // a field of the mask; undefined drops it
updateMaskAdj(id, patch);         // the mask's core adjustments
updateMaskBag(id, patch);         // the mask's extension param bag
seedMaskPanelValues(maskId, owns); clearMaskPanelValues(maskId, owns);
```

**Notes**

- Write the masks themselves with `setParam("masks", next)`, a new array each time, and call `commitEdit(label)` once at the end of a gesture for a single undo step.
- Limits: `MAX_MASKS` 16, `MAX_MASK_COMPONENTS` 24 in total, `MAX_BRUSH_MASKS` 4. See [Core Data Types](types.md).
- Per-mask sub-panels edit through [`useMaskScope` or `useParamScope`](ui-shell.md#per-mask-panels-panelcontributionmask), not `updateMaskAdj`/`updateMaskBag`.
- `seedMaskPanelValues` sets a sub-panel's owned values to their defaults when it is added to a mask (or the mask is reset); `clearMaskPanelValues` clears them when it is taken off.

## `api.develop`

Hooks to align to, capture and decorate the live Develop view, plus helpers that render any catalogue photo.

```ts
useDevelopOverlay(): { rect: { x; y; w; h } | null; nonce: number };
useMaskScope(): MaskParamScope;   // only inside a PanelContribution.mask
useParamScope(): ParamScope;      // mask's values in a mask panel, else photo's
setCanvasCursor(cursor, opts?: { priority?: number }): () => void;
adjustments: { list(); get(key); set(key, value) };
captureFrame(params, opts?: { asShown?; paramBag? }): Promise<ImageBitmap>;
captureFloatFrame(params, opts?: {                 // 3.1.0
  space?: StageSpace;                              // default linear Rec.709
  point?: "pre-output" | "output" | "scene";       // default "pre-output"
  paramBag?; maxEdge?: number;                     // default 1280 px
}): Promise<FloatFrame | null>;  // { data: Float32Array; width; height; space; point }
readSourceSample(): Promise<SourceSample | null>;  // 3.1.0
renderPhotoFrame(photoId, params, paramBag?, opts?: { lossless? }): Promise<ImageBitmap | null>;
renderPhotoFloatFrame(photoId, params, opts?: { space?; point?; paramBag? }): Promise<FloatFrame | null>; // 3.1.0
putPhotoData(key, data: Uint8Array | null): void;  // null deletes
getPhotoData(key): Promise<Uint8Array | null>;
setPickDrag(tool: PickDragTool | null): void;      // 3.2.0
usePickDragHeld(): boolean;                        // 3.2.0
probe(point): Promise<[r, g, b] | null>;            // 3.2.0
setCanvasTool(tool: CanvasTool | null): void;      // 3.2.0
useCanvasToolHeld(): boolean;                      // 3.2.0
readDevelopedPixels(edge: number): Promise<{ data: Uint8Array; width; height } | null>; // 3.2.0
sourcePixels(): { data: Uint8ClampedArray; width; height } | null; // 3.2.0
onSourcePixels(listener): () => void;              // 3.2.0
probeMaskColour(u, v): Promise<[r, g, b] | null>;  // 3.2.0
showMaskCoverage(maskId: string | null): void;     // 3.2.0
setViewValues(values: Record<string, unknown> | null): void; // 3.2.1
useMaskPanels(): MaskPanelEntry[];                 // 3.2.0: { id, title, owns, component, extensionParams }
useOlderProcessing(): boolean;                     // 3.2.0
autoAdjust: { whiteBalance(); whiteBalanceAt(point); tone() }; // 3.2.0, each a Promise<void>
```

**Overlays and tools**

- Call `useDevelopOverlay` from a `develop-canvas-overlay` component. `rect` is the image in the overlay's local coordinates; `nonce` changes on zoom, pan, resize and photo switch, so re-align then.
- `useParamScope` lets one component serve as a panel's `component` and its `mask.component` (`maskId` is null outside a mask). Call `commit(label)` at the end of a gesture.
- `setCanvasCursor` takes a cursor id, a [`CursorContribution`](contributions.md#cursorcontribution) or raw CSS. The highest `priority` wins (default 10). Call the returned release function when your tool deactivates.
- `setPickDrag` holds the canvas's pick-drag tool, an on-image drag that starts from a colour (HSL's target tool). While you hold it, a press on the image calls `onPress(point)` at once, with the point in the canvas's pixels. If your tool has `onDown`, it then gets `onDown(rgb, point)` with the colour the view shows there (sRGB, 0 to 1) once that is read, then `onMove(point)` and `onUp()`; a press released before the colour is read starts no drag. Every handler is optional. Holding Ctrl, Cmd or Space pans instead, and Escape lets go of the tool. The last extension to set a tool holds it; `setPickDrag(null)` lets go of yours only, and stopping your extension lets go too. `usePickDragHeld` re-renders when yours is taken or dropped, for a pressed button.
- `setCanvasTool` hands the canvas to an on-image tool (crop mode, Guided Upright's lines, the heal brush). While it is held, its `overlay` component draws over the image inside the view and reads the mapping with `useDevelopOverlay` (`region`, `imageAspect`). Core's own canvas gestures stand aside, zoom and pan too unless `zoomable`, and the live view draws `viewParams(params)` when given; the edit is untouched. Escape calls `onEscape` and lets the tool go. `onAction(action)` gets the Develop shortcuts pressed while it is held (`"brush.larger"` and so on) and returns whether it took one; core acts on those it didn't. As with `setPickDrag`, the last extension to set a tool holds it, and `useCanvasToolHeld` re-renders when yours is taken or dropped.
- `readDevelopedPixels` reads the open photo's developed frame of the whole image, before the crop and transform, as RGBA8 rows from the top with its long edge at `edge` px (Upright detects lines in it).
- `sourcePixels` is a small 8-bit sRGB copy of the open photo's source (RGBA8 rows from the top, about 1024 px on its long edge), for searches of the image itself (Heal's source pick). It is `null` before the first frame. `onSourcePixels` calls you with each new one: another photo, or a new decode.
- `probeMaskColour` reads the colour a mask's colour range compares at a point of the live frame buffer (0 to 1 across `useDevelopOverlay` `rect`): scene-linear, before the display transform.
- `showMaskCoverage` tints a mask's coverage over the image, fading in and out, or with `null` none: the mask a masking panel points at.
- `setViewValues` gives the live view values for your own stages' params and textures, by qualified key (`"{stageId}.{key}"`), drawn over the photo's own: feedback that is not part of the edit, such as Paint Layers tinting the layer you hover. They are never saved, undone, exported or drawn in thumbnails. Each call replaces your last set, `null` clears it, keys of other extensions' stages are ignored, and holding your panel's preview off drops them. They are cleared when your extension stops.
- `useMaskPanels` lists the panels that can be added to a mask (`PanelContribution.mask`), in their `order` then by title. `extensionParams` is true for one that owns an extension's params, which run inside the mask only at the current processing. Draw one inside `components.MaskScope`; the develop store's `seedMaskPanelValues` and `clearMaskPanelValues` set or clear its values when it is added or removed.
- `probe` reads the colour the canvas shows at a point in its pixels (sRGB, 0 to 1) from the live frame, or `null` with no frame.
- `autoAdjust` runs core's Auto White Balance, the white-balance eyedropper at a canvas point, or Auto Tone to convergence, then commits one undo step. Each needs the frame's histogram (`useDevelopStore` `histogram`) and does nothing without one, and only one runs at a time. Pair `whiteBalanceAt` with `setPickDrag`: call it from `onPress` with the point.
- `adjustments` reaches core values inside structured params (`"vignette.amount"`, `"grain.size"`) that `setParam` can't set alone. `set` is live with no history entry: call `commitEdit` yourself.

**Captures of the live view**

- `captureFrame` renders the open photo with any params, aligned to the view. By default it is a measurement frame: sRGB, without the clipping warning, mask overlay or sharpening preview. `asShown: true` keeps them, for drawing over the canvas.
- A capture's params and `paramBag` never reach the live view or the histogram, Auto Tone, Auto White Balance or Upright. Use `paramBag` to render an auxiliary image (a gain map, a mask) aligned to the view.
- `captureFloatFrame` returns RGBA floats, rows top-down. `"pre-output"` is the signed colour the output stage receives (clamped to [0, 1] on version 1 photos), `"output"` is sRGB in [0, 1], `"scene"` is what the display transform receives. It is `null` without float render targets, with no photo open, or when the GPU can't hold the frame.
- `maxEdge: Infinity` gives the full view (about 180 MB at 4096 px, more on the GPU). A smaller frame is the full one averaged down, so ask for full size only when you need the detail.
- `readSourceSample` gives up to 1024 px from the centre of the open RAW at native resolution: linear Rec.709, white balance applied, before every edit. It is `null` for bitmaps and until the RAW decodes; wait for `useDevelopStore` `sourceSize.native` to be true. Each call copies about 16 MB.

**Rendering any photo**

- `renderPhotoFrame` and `renderPhotoFloatFrame` render any catalogue photo small, for measurement, whatever Develop has open (batch Auto Tone, say). `null` if the photo can't render.
- Built-in stages add their entries from `params` (Detail noise reduction) and win over the same keys in `paramBag`. Set `luminanceNR` and `colorNR` to 0 for a frame without it.
- `renderPhotoFrame` decodes from a JPEG. Pass `lossless: true` (PNG, 3.0.1) for a frame that carries data. A lossless or float frame is `null` where only the grid's camera preview could stand in for the photo.

**Per-photo data.** `putPhotoData` stores an opaque blob for the photo open in Develop, under a key namespaced to your extension, outside the catalogue file. Use it for large payloads such as a warp field. You own the format and when to load and save.

Members marked 3.1.0 are undefined on older builds: check for them, or set `minAppVersion` in the [manifest](../extensions/README.md#manifest). `minAppVersion` gates store installs only, so test dev-folder copies on a matching build.

## `api.params`

Read-only metadata for the stage uniforms every installed extension contributes. Use it to drive or inspect another extension's sliders (a speed-edit scrubber, a preset browser).

```typescript
api.params.list(): ParamDescriptor[];
api.params.get(qualifiedKey: string): ParamDescriptor | undefined;

interface ParamDescriptor {
  qualifiedKey: string;    // "<stageId>.<uniform>", e.g. "film-sim.halation.amount"
  localKey: string;
  stageId: string;
  stageName: string;       // the owning stage's display name
  extensionId: string;
  extensionName: string;   // the owning extension's manifest name
  glslType: GlslType;
  default: number | number[] | boolean;
  range?: { min: number; max: number; step?: number };
  label?: string;
}
```

**Notes**

- Values live in `useDevelopStore`'s `paramBag`. Read `paramBag[qualifiedKey] ?? descriptor.default`, write with `setDynParam(qualifiedKey, value)`.
- Pass a new array or object whenever one changes (a painted `BrushDab[]` included). A value edited in place never reaches the renderer.
- The list is not reactive. It changes only as extensions load and unload.

## `api.export`

Renders catalogue photos through the full pipeline to in-memory blobs at export size, using the user's export settings. Use it to ship full-size images (a web gallery) instead of the catalogue preview.

```ts
getDefaultSettings(): ExportSettings;  // Preferences ▸ Export
renderPhotos(
  photos: CatalogPhoto[],
  settings?: Partial<ExportSettings>,  // merged over the defaults
  onProgress?: (p: { done; total; filename }) => void,
  options?: { paramBag?; signal?; processors? }, // this render only
): Promise<RenderedPhoto[]>;           // { photo; blob; width; height }
exportPhotos(
  photos: CatalogPhoto[],
  settings: ExportSettings,            // the whole of them, not merged
  onProgress?: (p: { done; total; filename }) => void,
  destDir?: FileSystemDirectoryHandle, // for delivery "folder"
  options?: { signal? },
): Promise<ExportResult>;
```

**Notes**

- A PNG renders at 8 bits whatever the Preference says, unless you pass `pngBitDepth: 16` (3.1.0).
- `blob` is `null` for a photo that couldn't be decoded, or an edited photo whose original is out of reach.
- `width` and `height` include a `processPixels` mat. If a `process(blob)` resizes the file, read the size from the blob.
- Export processors (a watermark, say) run on every `renderPhotos` render, as they do on an export. Pass `processors: false` to run none, for a frame you use as source pixels rather than as a delivered file (Safelight 3.2.0).
- Export processors don't run for a render started from inside them, or for a photo another batch is rendering at the same time.
- Pass `signal` to stop a batch. It is checked before each photo, so the photo in flight finishes. `renderPhotos` then returns only the photos it reached. `exportPhotos` returns `cancelled: true` and the count it exported; a ZIP in progress is delivered with what it holds.
- `exportPhotos` also stops on its own, with `stopped` set to the reason (`"the disk is full"`), when a write fails in a way every later write would too: a full disk or a read-only folder. A refusal that one locked file also gives (`EPERM`, `EACCES`, a withdrawn folder grant) stops it only when the same refusal comes twice in a row; a successful write in between starts the count again. Photos after that are not rendered. A failure that belongs to one file is listed in `failures` and the batch goes on. `exportStatus(result)` words either ending for the user.
- `delivery: "folder"` never writes over a file without being asked. With `ifExists: "number"` (the default), a name already in the folder, in any case or Unicode form, gets the next free `"name (2).ext"`. Each name is checked again right before its write, so a file another batch or app wrote since is safe too. `ifExists: "replace"` writes over a file of the same name, but never the original of a photo in the catalogue: that one still gets a number. Leave `ifExists` out and the user's Preference decides (3.2.0).
- `withoutStages` counts the exported photos drawn without an extension stage whose shader failed to build during the batch, so its effect is missing from them. `exportStatus(result)` says so (3.2.0).
- `delivery: "files"` hands each file to the browser's download, which can't report a cancelled Save dialogue. Those files count as exported once handed over.

## `api.catalog`

Lower-level catalogue access, for extensions that add records the scan didn't produce (virtual copies), copy edits between photos, or build their own photo surfaces.

```ts
addPhotos(photos, opts?: { afterId?: string }): Promise<void>; // saved + in grid
getEditState(photoId): Promise<EditState | null>;  // recipe + undo stack
putEditState(editState): Promise<void>;
renamePhoto(photoId, newBaseName): Promise<RenamePhotoResult>;
useVisiblePhotos(opts?: { without?: string[] }): CatalogPhoto[]; // grid order
usePhotoActions(): { onContextMenu; overlays };    // Library menu
useCullingShortcuts(opts?: { sizeSteps?: boolean }): void;
requestThumbnail(photoId): void;                   // queue a grid preview
readPreview(photoId): Promise<Blob | null>;        // read a grid preview, keep nothing
```

**Notes**

- Writing the photo open in Develop with `putEditState` reloads it there, which clears the active tool and the mask and spot selection.
- `renamePhoto` takes the name without its extension and keeps the sidecar, virtual copies, ratings and edits. It returns `{ ok: false, reason }` rather than throwing. To shuffle a numbering range, rename through temporary names first.
- `useVisiblePhotos`'s `without` names grid filters to ignore, for a surface that registers a filter of its own.
- A photo's `thumbnailBlob` and `thumbnailUrl` are a cache, not a promise. In a big project core keeps the previews it loaded last (a few thousand) and releases the rest, so a photo far from view has both set to `null` until its cell scrolls back. A surface that draws a photo calls `requestThumbnail`. Code that walks the whole catalogue (a duplicate scan, a contact sheet) should not read the record at all.
- `readPreview` reads the preview from the project for one photo and hands you the blob. Nothing else changes: the record, the memory core holds and the grid are as they were, so a loop over every photo does not fill memory, and the blob is yours to drop. It resolves to `null` for a photo with no preview, or when no project is open. Photos far from view are slower to read than loaded ones, so read a few at a time.
- Hook examples: [UI Components: Photo surfaces](components.md#photo-surfaces-menu-and-shortcuts).

## `api.variables` (shared variables)

Named JSON values any extension can register, read, subscribe to and write, kept in step across every Safelight window. Values last for the session. Needs Safelight 3.0.1 (set `minAppVersion` to `"3.0.1"`).

```ts
register<T>(name, { initial: T, description?: string }): VariableSnapshot<T>
get<T>(name): VariableSnapshot<T> | undefined
subscribe<T>(name, listener: (s: VariableSnapshot<T>) => void): () => void
set<T>(name, value: T): VariableWriteResult<T>
update<T>(name, fn: (current: T) => T): VariableWriteResult<T>
// VariableSnapshot = { name, value, revision: { n, window }, writer, registeredBy, description? }
// VariableWriteResult = { ok: true, revision } | { ok: false, reason: "stale" | "unregistered" | "invalid", … }
```

**Notes**

- **Names:** lower-case letters, digits, `.`, `_`, `-`, starting with a letter or digit, at most 128 characters. `core` and `core.*` are reserved. Prefix with the owning extension's id (`map.overlays`).
- **Register before writing.** The first `register` sets the initial value; later callers get the current snapshot. Pass the same constant `initial` in every window.
- **Values** are plain JSON and snapshots are frozen: change them only with `set` or `update`. Any extension can read any variable, so keep secrets out.
- **Stale writes.** `set` is refused when someone wrote since you last saw the value. Subscribe before you set, and for shared collections use `update` on your own key: `update<Record<string, Entry>>(name, (o) => ({ ...o, [myId]: entry }))`.
- **Races between windows.** A write that returned `ok` can still lose to a simultaneous write from another window. Treat the subscriber's value as the truth. Developer Tools ▸ Issues lists refused writes and lost races.
- **`update`'s function** must be pure: no writing the same variable, no throwing, no Promise. Otherwise the write is refused as `"invalid"`. Give `update` its type argument, since `T` can't be inferred.
- **Subscribers** get the current value at once, then every write, your own included. A listener that writes its own variable unguarded loops and freezes the window. Remove your entries in `deactivate()`.

**Developer Tools ▸ Variables** shows every variable with its writers and history.

```ts
// The extension that owns the contract:
api.variables.register("map.overlays", { initial: {}, description: "Lines and points drawn on the Map. One entry per extension, keyed by its id." });
api.variables.subscribe("map.overlays", (s) => drawOverlays(s.value));

// Any extension that draws on it (either may load first):
api.variables.register("map.overlays", { initial: {} });
api.variables.update<Record<string, unknown>>("map.overlays", (o) => ({ ...o, "gps-track": { label: "ride.gpx", geojson } }));
```
