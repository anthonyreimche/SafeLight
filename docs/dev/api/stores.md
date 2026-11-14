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
| Develop | `developMaxEdge`, `developDynamicDetail`, `gpuSourceCacheBytes`, `developPrefetchNeighbors`, `highBitDepth`, `liveHistogram`, `developOpenZoom` |
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
prewarmStages(): void;                            // 3.2.4
registerBrushTip(tip: BrushTipContribution): void; // 3.2.1: { id, label, alpha: { width, height, data: Uint8Array } }
unregisterBrushTip(id: string): void; // 3.2.5: one of your own
brushTips(): readonly BrushTipContribution[]; // 3.2.5: every extension's tips, in order
useBrushTips(): readonly BrushTipContribution[]; // 3.2.5: React hook
registerInputProfiles(resolver: InputProfileResolver): void; // 3.2.3: { resolve(photo, file) }
invalidateInputProfiles(): void;                   // 3.2.3
useMaskPanels(): MaskPanelEntry[];                 // 3.2.0: { id, title, owns, component, extensionParams }
useOlderProcessing(): boolean;                     // 3.2.0
autoAdjust: { whiteBalance(); whiteBalanceAt(point); tone() }; // 3.2.0, each a Promise<void>
```

**Overlays and tools**

- Call `useDevelopOverlay` from a `develop-canvas-overlay` component. `rect` is the image in the overlay's local coordinates; `nonce` changes on zoom, pan, resize and photo switch, so re-align then.
- `useParamScope` lets one component serve as a panel's `component` and its `mask.component` (`maskId` is null outside a mask). Call `commit(label)` at the end of a gesture.
- `setCanvasCursor` takes a cursor id, a [`CursorContribution`](contributions.md#cursorcontribution) or raw CSS. The highest `priority` wins (default 10). Call the returned release function when your tool deactivates.
- `setPickDrag` holds the canvas's pick-drag tool, an on-image drag that starts from a colour (HSL's target tool). While you hold it, a press on the image calls `onPress(point)` at once, with the point in the canvas's pixels. If your tool has `onDown`, it then gets `onDown(rgb, point)` with the colour the view shows there (sRGB, 0 to 1) once that is read, then `onMove(point)` and `onUp()`; a press released before the colour is read starts no drag. Every handler is optional. Holding Ctrl, Cmd or Space pans instead, and Escape lets go of the tool. The last extension to set a tool holds it; `setPickDrag(null)` lets go of yours only, and stopping your extension lets go too. `usePickDragHeld` re-renders when yours is taken or dropped, for a pressed button.
- `setCanvasTool` hands the canvas to an on-image tool (crop mode, Guided Upright's lines, the heal brush). While it is held, its `overlay` component draws over the image inside the view and reads the mapping with `useDevelopOverlay` (`region`, `imageAspect`). It stacks above every `develop-canvas-overlay` component, so no other extension's overlay covers the tool or takes its pointer. The overlay re-renders when the view moves or what it subscribes to changes, not on every edit, so select what it draws with `useDevelopStore((s) => …)` rather than reading `getState()` while rendering. Core's own canvas gestures stand aside, zoom and pan too unless `zoomable`, and the live view draws `viewParams(params)` when given; the edit is untouched. Escape calls `onEscape` and lets the tool go. `onAction(action)` gets the Develop shortcuts pressed while it is held (`"brush.larger"` and so on) and returns whether it took one; core acts on those it didn't. As with `setPickDrag`, the last extension to set a tool holds it, and `useCanvasToolHeld` re-renders when yours is taken or dropped.
- `readDevelopedPixels` reads the open photo's developed frame of the whole image, before the crop and transform, as RGBA8 rows from the top with its long edge at `edge` px (Upright detects lines in it).
- `sourcePixels` is a small 8-bit sRGB copy of the open photo's source (RGBA8 rows from the top, about 1024 px on its long edge), for searches of the image itself (Heal's source pick). It is `null` before the first frame. `onSourcePixels` calls you with each new one: another photo, or a new decode.
- `probeMaskColour` reads the colour a mask's colour range compares at a point of the live frame buffer (0 to 1 across `useDevelopOverlay` `rect`): scene-linear, before the display transform.
- `showMaskCoverage` tints a mask's coverage over the image, fading in and out, or with `null` none: the mask a masking panel points at.
- `setViewValues` gives the live view values for your own stages' params and textures, by qualified key (`"{stageId}.{key}"`), drawn over the photo's own: feedback that is not part of the edit, such as Paint Layers tinting the layer you hover. They are never saved, undone, exported or drawn in thumbnails. Each call replaces your last set, `null` clears it, keys of other extensions' stages are ignored, and holding your panel's preview off drops them. They are cleared when your extension stops. A stage that only ever shows feedback, such as a focus overlay, should also declare [`viewOnly`](contributions.md#view-aids-viewonly), which keeps it out of captures, probes and the histogram as well.
- `prewarmStages` hints that your stages are about to be needed, when nothing else says so: a view aid the user can turn on with a key at any moment. The live view starts building, in the background, the programs their first frame would build: their passes' programs, and while a stage is dormant the program with it in. That frame then waits for none. A hint for programs already built costs nothing. Opening or hovering your panel gives the same hint by itself. Send it once the user is idle in Develop, not on every frame.
- `registerBrushTip` adds a brush shape that masks and paint strokes can stamp with, named by a dab's `tip` (see [`BrushDab`](types.md)). `alpha` is the shape's coverage, one byte a pixel, at most 128 px a side (`MAX_BRUSH_TIP_EDGE`). Tip ids are shared by every extension: registering your own id again replaces it, and another extension's id is refused with a warning, as is a malformed tip. Your tips go when your extension stops, and strokes that name them stamp the round disc until they are back. A tip may carry a `group` (a picker heading) and `brush`, the settings it was made for: `spacing`, `scatter`, `count`, `sizeJitter`, `angleJitter`, `flowJitter`, `angle`, `followStroke`. Core clamps them into range and stamps nothing by them; a painter loads them when the tip is picked (3.2.5).
- `unregisterBrushTip` takes back one tip of your own, as when the person removes it from your library; strokes that name it stamp the round disc from then on (3.2.5).
- `brushTips` and `useBrushTips` list every registered tip, whichever extension registered it, so a brush can offer another extension's tips in its picker (3.2.5).
- `registerInputProfiles` lets one extension read non-RAW photos (JPEG, PNG, WebP, AVIF, TIFF, NetPBM) through their colour profiles. Each load of such a photo calls `resolve(photo, file)` with `{ id, filename, inputProfile }` and the original as a `Blob`. Answer an `InputTransform` (below) or `null`. Core then decodes the file's 8-bit codes without colour management, puts each channel through its `trc` table and the three through `toRec709`, and clamps nothing. Colour outside sRGB arrives as negative channels, as it does from a RAW. Develop, exports, headless renders and edited thumbnails use the result; the Library's plain grid previews stay the browser's.
  - `null`, a throw, an answer later than 3 s or an invalid transform leaves the photo to the browser's decode, which converts to sRGB as before. So does a decode or conversion that fails afterwards.
  - One extension holds the resolver. Another's is refused with a warning naming the holder. Registering again replaces your own, and it is dropped when your extension stops.
  - Safelight remembers the last extension that registered one. While the app starts, a non-RAW photo opened in Develop waits for that extension to register, for at most 3 s, if it is installed and turned on. Without one, no photo waits.
  - The converted photo renders display-referred: no base curve, no camera baseline and no clipped-highlight reconstruction. Texture, Clarity and noise reduction treat it as a linear source, so it differs slightly from the same file on the browser's path.
  - Call `invalidateInputProfiles` when your answers change with no photo's token changing: a setting, or a profile added or removed. Converted photos load again and their edited thumbnails are drawn again.

```ts
interface InputTransform {
  trc: [Float32Array, Float32Array, Float32Array]; // encoded [0, 1] to linear, 2 to 65536 samples at even steps, all the same length
  toRec709: number[];                              // profile-linear RGB to linear Rec.709 (D65), row-major, 9 numbers
}
```

  A code `c` is read at `p = c / 255 * (n - 1)`, interpolated linearly between the samples around it. Every sample and matrix entry must be finite.
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
exportPhotos(                          // several exports of one selection (3.2.4)
  photos: CatalogPhoto[],
  jobs: { settings: ExportSettings; destDir?: FileSystemDirectoryHandle }[],
  onProgress?: (p: { done; total; filename; job }) => void,
  options?: { signal? },
): Promise<ExportResult[]>;            // one per job, in order
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
- `exportPhotos` names files by the registered template `filenameTemplateId` names, else by the template string in `filenameTemplate` (the same variables), else by the photo's base name. `filenameTemplate` lets an extension name its own exports without adding an entry to the Export panel's Filename list (3.2.4).
- If the graphics driver resets mid-batch, the photo being drawn fails with nothing written, and the batch ends there: `exportPhotos` sets `stopped` to `"the graphics driver reset"`, and `renderPhotos` returns a null blob for that photo and every one after it, without rendering them.
- `withoutStages` counts the exported photos drawn without an extension's effect because it couldn't run on this graphics card: its shader failed to build during the batch, or it got no texture unit or layer. `exportStatus(result)` says so (3.2.0).
- With a list of jobs, `exportPhotos` decodes each photo once, at the largest size any job asks for, and draws it once per job, photo by photo, into each job's own folder with its own settings, names and numbering. Progress counts every file of every job (`total` is photos × jobs) and `job` is the index of the job the file was for. A job that stops on its own (its disk is full) leaves the others running; a graphics driver reset stops them all. A `signal` stops every job before its next file, and each result says `cancelled`. A ZIP delivery makes one archive per job.
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
setStack(ids, opts?: { cover?: string }): Promise<void>; // 3.2.1: group as one stack
clearStack(ids): Promise<void>;                    // 3.2.1: take out of their stacks
stackOf(id): { stackId; ids; cover } | null;       // 3.2.1
setInputProfile(ids, token: string | null): Promise<void>; // 3.2.3: the resolver's owner only
```

**Notes**

- Writing the photo open in Develop with `putEditState` reloads it there, which clears the active tool and the mask and spot selection.
- `renamePhoto` takes the name without its extension and keeps the sidecar, virtual copies, ratings and edits. It returns `{ ok: false, reason }` rather than throwing. To shuffle a numbering range, rename through temporary names first.
- `useVisiblePhotos`'s `without` names grid filters to ignore, for a surface that registers a filter of its own.
- A photo's `thumbnailBlob` and `thumbnailUrl` are a cache, not a promise. In a big project core keeps the previews it loaded last (a few thousand) and releases the rest, so a photo far from view has both set to `null` until its cell scrolls back. A surface that draws a photo calls `requestThumbnail`. Code that walks the whole catalogue (a duplicate scan, a contact sheet) should not read the record at all.
- `readPreview` reads the preview from the project for one photo and hands you the blob. Nothing else changes: the record, the memory core holds and the grid are as they were, so a loop over every photo does not fill memory, and the blob is yours to drop. It resolves to `null` for a photo with no preview, or when no project is open. Photos far from view are slower to read than loaded ones, so read a few at a time.
- Hook examples: [UI Components: Photo surfaces](components.md#photo-surfaces-menu-and-shortcuts).

**Stacks (3.2.1).** A stack is photos that share a `stackId` (a burst, a bracket) and show as one tile, their cover, until someone expands it. People stack and unstack from the Library menu; a burst detector calls `setStack`.

- `setStack` puts the photos in one new stack, taking them out of any they were in. The cover is `cover`, or the first of `ids`. Fewer than two known photos do nothing.
- A stack with fewer than two photos is no stack: removing or filtering out members leaves the rest stacked, and a single one shows as an ordinary photo.
- Filters apply to members first. A cover that is filtered out hands over to the next member shown.
- Navigation follows what is shown: `useVisiblePhotos`, the arrow keys and Select all reach a collapsed stack's cover only. Expanding a stack shows its members in grid order.
- Stacking is catalogue data, like a rating: it syncs between windows and has no undo step.
- `stackOf` gives a photo's stack among all photos, filters ignored, or `null`.
- `api.ui.Thumbnail` and `PhotoListRow` draw the stack badge, so a surface built from them needs no change.

**Input profiles (3.2.3).** `setInputProfile` stores an opaque token on photos as `CatalogPhoto.inputProfile`, or with `null` clears it. Your resolver gets it back in `resolve`. Only the extension holding the input profile resolver (`api.develop.registerInputProfiles`) may call it; any other call is rejected.

- It is catalogue data, like a rating: it syncs between windows and has no undo step.
- A photo whose token changes loads again in Develop, and its edited thumbnail is drawn again. A RAW's token changes nothing core draws.

## `api.library`

```ts
importFiles(                                       // 3.2.1
  files: { name: string; data: Blob }[],
  opts?: { folder?: string; keywords?: string[] },
): Promise<({ name; id } | { name; error })[]>;
```

`importFiles` writes files an extension receives (from a tethered camera, a network share, a download) into the open project and imports them as photos, with the given keywords added to their own. Use it for a tether, a camera on Wi-Fi, or an online library you mirror.

- `folder` is a folder of the project, with `/` between names, created if it isn't there. It defaults to the project's root.
- Each `name` must be a plain file name of a supported type. Safelight refuses:
  - path separators, `..`, a leading `.`, Windows device names (`CON`, `COM1`…) and names over 200 characters;
  - folders the project scan skips;
  - a name already in the folder: nothing is overwritten;
  - files over 512 MB.
- Each file comes back with the new photo's `id`, or an `error` saying why it wasn't taken; one refusal leaves the rest unaffected. Nothing throws.
- A file is written whole or not at all, and removed again if its import fails.
- Calls run one after another, because imports share the decoders.
- A folder that is read-only refuses with the reason.

### Library sources (3.2.4)

```ts
registerSource(source: LibrarySourceContribution): void;
unregisterSource(id: string): void;
useSources(): { id; name; extensionId; open: boolean }[];   // React hook
openSource(id: string): Promise<void>;
useOpenSource(): { id; name } | null;                       // React hook
keptOriginals(id: string): Promise<{ count; bytes }>;
clearKeptOriginals(id: string): Promise<{ removed; kept }>;

interface LibrarySourceContribution {
  id: string;            // unique among all extensions' sources
  name: string;          // the project's name: the Folders tree's root row
  library?: string;      // which library it shows now; each has its own catalogue
  list({ signal }): Promise<{ folders?: LibrarySourceFolder[]; items?: LibrarySourceItem[] }>;
  readPreview(item, { maxEdge, signal }): Promise<Blob>;
  readOriginal(item, { signal }): Promise<Blob>;
  keptOriginalsLimit?: number | null;   // bytes of originals kept; default 10 GB, null: no limit
}
```

A library source is a set of photos kept somewhere other than a folder on disk, such as a photo server, that the person opens as a project the way they open a folder. Its folders become the Folders tree and its photos the grid: they are rated, filtered, edited in Develop and exported like any other. **Immich Web Folders** is the first.

- **Where the data lives.** The source has no folder to hold `.safelight`, so its catalogue, previews and edits live in Safelight's own data, one catalogue per extension, source `id` and `library` (desktop: `<app data>/source-catalogs/`; browser: the page's private storage). Change `library` when the person connects to another server or account: registering again with a new value closes the project if it is open on the old one, and `unregisterSource` closes it too. An open project only ever reads through the registration it opened with: while none with its extension and `library` is registered, it reads as offline, so one account's listing or requests never reach another's catalogue.
- **What is read when.** `list` runs each time the project opens, and is stopped through its `signal` when the person opens something else before it ends; the import reads nothing else, so a library of any size shows in the grid as soon as it is listed (and at once on later opens, from the catalogue). A photo's `readPreview` runs when its cell first comes into view in the grid, three at a time in the order the cells asked, and the preview is kept like any other, so it runs once per photo. A read whose cells all leave view first (the person scrolled on or opened another folder) is stopped through its `signal`, and the photos not reached are never asked for. Nothing reads previews ahead of the scroll, nor while the open found the source unreachable. `readOriginal` runs only when the photo is opened in Develop or exported, then the file is kept in the catalogue's folder (`originals/`), so it is fetched once. Background work never fetches one: Develop's neighbour prefetch, Cache all, the Library histogram, the preview repair pass, Rebuild previews and Re-import leave it alone. Rebuild previews and Re-import read nothing from the source either: they forget the kept previews (Re-import also takes the photos' details from the last listing), and the grid reads each again as it comes into view. Kept originals are named by a hash of their key.
- **Kept originals.** They take at most `keptOriginalsLimit` bytes (10 GB when you leave it out; `null` keeps them all). Past it the ones used longest ago are removed, never the photo open in Develop nor the photos of an export under way, in any window (a popped-out Develop included; a window that closes without letting go stops counting within ten minutes; an export holds each photo only while it reads and draws it), and one removed is read again when it is next needed. A lower limit registered takes effect at once. `keptOriginals(id)` tells how many the source's library keeps now and their bytes, and `clearKeptOriginals(id)` removes them but for those in use; both are for your own sources only, and neither reads the source. Show them in your settings, with a confirmation (`api.ui.confirmDialog`) before Clear.
- **Offline.** When `list` fails, the listing kept from the last open is shown and the person is told. Photos whose originals were kept open as usual; the rest show their preview with "the original isn't available". With no kept listing the open fails with your error's message.
- **Read-only.** Nothing is written to the source. Folder and photo operations (new folder, rename, move, delete from disk) do nothing on a source project, and the Folders panel hides them.
- **Keys.** The catalogue knows each photo by its `key` (kept as `CatalogPhoto.sourceKey`), not by its path: a photo moved to another folder or renamed on the source keeps its record, rating and edit, and a photo that takes a removed one's name never takes its record. Its cached RAW decode follows the key too, so a move keeps its cached decode and a photo that takes a removed one's path and size never opens with the other's. Keep keys stable from one listing to the next. A key in two folders is two photos.
- **Names.** Folder and photo names are made plain (`/` becomes `-`, a leading `.` becomes `_`) and unique within their folder. Of folders or photos sharing a name, the lowest `key` keeps it and the rest add part of their key, so names don't depend on listing order; give folders a `key` for that (without one a second folder of a name gets ` (2)`).
- **Items.** Give `size` when you know it (an original of another size is not kept), `width`/`height` (the upright frame: no preview is read at import to turn it by; without them a photo takes its preview's size when the grid first reads it, and its original's when that is first decoded), `exif` (with `orientation` when the file carries one: it turns the photo upright; fields of the wrong type, and those the RAW decode learns, are left out) and `taken`. A name Safelight can't import (a video, HEIC) is left out, as in a folder.
- **Timeouts.** Core bounds `list` at 2 minutes and `readPreview` at 1 minute; bound `readOriginal` yourself by the file's size.
- The last source project opened reopens at the next launch once its extension has registered the source (up to 15 seconds later; the launch doesn't wait for it), as a folder does, unless something else was opened meanwhile.

## `api.network` (3.2.4)

```ts
requestAccess(url: string): Promise<boolean>;
hasAccess(url: string): Promise<boolean>;
revokeAccess(url: string): Promise<void>;
fetch(url: string, init?: { method?; headers?; body?: string | Uint8Array; timeoutMs?; signal? }): Promise<Response>;
```

For a server whose address the person types in, such as a self-hosted photo server on their network, which no manifest can name in `permissions.network`. Declare `"permissions": { "userOrigins": true }` in `safelight.json`.

- `requestAccess` asks the person, in a dialogue that names your extension and the address (and warns when it is plain `http://`), whether you may reach that origin. A yes is kept until `revokeAccess`, or until your extension is uninstalled; an update keeps it. Call it from a click, such as a Test connection button.
- `fetch` reaches allowed origins only. Safelight makes the request itself, outside the page, so plain `http://` on the LAN works and the page's content-security policy stays as it is. No cookies are sent, `Cookie`, `Host`, `Origin` and `Referer` headers are dropped, and a redirect to another origin is refused.
- It resolves with a `Response` whatever the status. It rejects with a `TypeError` when the origin isn't allowed or the server can't be reached, a `TimeoutError` past `timeoutMs` (30 s by default, 1 s to 30 minutes) and an `AbortError` when `signal` aborts. Answers are capped at 1 GiB.
- In the browser build there is no dialogue: requests go through the page's own `fetch` and its policy.
- Never log what you send: the person's key travels in your headers.

### Declared origins and signing in (3.2.5)

```ts
authorizeInBrowser(buildUrl: (redirectUri: string) => string, options?: { timeoutMs?; signal? }): Promise<URLSearchParams>;
```

- **Declared origins.** The HTTPS origins your manifest lists in `permissions.network` count as allowed without asking: `hasAccess` and `requestAccess` answer `true`, and `fetch` reaches them the same way as an allowed address, outside the page. Use it for a web service whose content hosts send no CORS headers. A redirect may go to another declared origin. `https://*.example.com` covers every subdomain of example.com, not example.com itself, at the default port. A wildcard never covers an IP address, and one over a single label (`https://*.com`) covers nothing here. `userOrigins` isn't needed for these. As with the content-security policy, an origin added in an update applies from the next launch.
- **Signing in.** `authorizeInBrowser` is OAuth 2.0 for installed apps. Safelight listens once on `127.0.0.1` at a free port and calls `buildUrl` with the redirect address (`http://127.0.0.1:<port>`, answered at `/`). Put it in the sign-in page's address as `redirect_uri`. Safelight opens the page, which must be `https://`, in the person's own browser, where their sign-in lives. When the provider sends the browser back, the tab shows a page saying it can be closed, and the call resolves with the query: `code` and `state`, or `error`.
- The page's address must carry a `state` (it is refused without one): only an answer carrying the same `state` ends the wait, so a forged request can't. Check it yourself too, and use PKCE (`code_challenge_method=S256`): any program on the computer can reach the listener while it waits. Requests naming another host are refused.
- It rejects with a `TimeoutError` after `timeoutMs` (5 minutes by default, 1 second to 15 minutes), an `AbortError` when `signal` aborts (a Cancel button), a `TypeError` when the page isn't `https://` or the browser can't be opened, and a `NotSupportedError` in the browser build. A new call ends your earlier one.
- A redirect that leaves an origin drops the `Authorization` header, as `fetch` does.
- Exchange the code for tokens with `fetch` to the provider's token origin, declared in `permissions.network`.

## `api.secrets` (3.2.5)

```ts
available(): Promise<boolean>;
get(key: string): Promise<string | null>;
set(key: string, value: string): Promise<void>;
delete(key: string): Promise<void>;
```

Keep a sign-in's refresh token or a key encrypted by the operating system's keychain (DPAPI on Windows, the Keychain on macOS, the Secret Service or KWallet on Linux), for your extension alone, across launches and updates. Uninstalling your extension forgets them.

- Keys are 1 to 64 letters, digits, `.`, `-` or `_`; values are text up to 64 KiB.
- Where there is no keychain (Linux without one, the browser build) `available()` answers `false`, `get` answers `null` and `set` rejects. Keep the value in memory for the session then, and tell the person they will sign in again next time.
- `get` also answers `null` for a value the keychain can no longer read, for example after the computer's account was reset.
- Use it instead of `api.settings` for anything that grants access. Like everything an extension holds, it keeps values off the disk in plain text; it doesn't hide them from other code in the app.

## `api.sockets` (3.2.5)

```ts
type SocketAccess = "allowed" | "after-restart" | "not-allowed";
requestAccess(url: string): Promise<SocketAccess>;
status(url: string): Promise<SocketAccess>;
list(): Promise<string[]>;
revokeAccess(url: string): Promise<void>;
```

Live connections (WebSockets) to a server whose address the person types in, such as a studio's own sync relay, which no manifest can name in `permissions.network`. Declare `"permissions": { "userSockets": true }` in `safelight.json`. `api.network` can't do this: its requests are made outside the page, a request and an answer at a time.

- `requestAccess` asks the person, in a dialogue that names your extension and the address, whether you may keep live connections to that origin. Only `wss://` is taken: no `ws://`, no wildcard, no user name or password. Call it from a click.
- The page opens the socket itself (`new WebSocket(url)`), so an allowed address joins the app's content-security policy, which is built once per launch. `requestAccess` and `status` answer `"after-restart"` until Safelight starts again, then `"allowed"`. Until then, reach the same server over HTTPS with `api.network` if it offers that.
- A yes is kept until `revokeAccess` (from the next launch), the person's Disconnect on your extension's page in the Extensions window, or your extension being uninstalled; an update keeps it.
- The policy is the page's, so once an address is in it, any code in the app could reach it, as with `permissions.network`. A `wss://` source also lets the page `fetch` the same host over `https://` on the same port. It widens where data can go, never where code loads from.
- One consent dialogue per extension at a time: a request made while yours is open answers `"not-allowed"` without asking.
- In the browser build there is no dialogue: `wss://` addresses answer `"allowed"` and the page's own policy decides.
- Keep what you send sealed if the server isn't yours alone to read: the server sees everything a socket carries.

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
