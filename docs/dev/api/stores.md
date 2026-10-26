# State Stores & Data APIs

← [API Reference](README.md)

The live app state extensions read and drive, the interactive brush/mask/retouch model, and the imperative APIs for the Develop canvas, headless export, the catalog, and variables shared across windows.

- [State stores (`api.stores`)](#state-stores-apistores)
- [Brushes, masks & retouch](#brushes-masks--retouch-interactive-develop-tools)
- [`api.develop`](#apidevelop)
- [`api.params`](#apiparams)
- [`api.export`](#apiexport)
- [`api.catalog`](#apicatalog)
- [`api.variables` (shared variables)](#apivariables-shared-variables)

## State stores (`api.stores`)

All stores are Zustand stores; subscribe in React with a selector or read imperatively with `getState()`. Available via `api.stores`: `useDevelopStore`, `useCatalogStore`, `useUIStore`, `useSettings`, `usePresetsStore`, `useKeybindings`, `useThemeStore`, `useLayoutStore`, `usePipelineStore`, plus the zustand `create` factory for your own store. They are typed to the real hooks, so you get each store's actual state shape.

### useCatalogStore

State: `photos`, `selectedIds: Set<string>`, `activePhotoId`, `loading`, `needsReconnect`, `reconnecting`, `fileAccessNonce`.

Actions (selected): `loadCatalog()`, `reconnectFiles()`, `replaceCatalog(photos)`, `addPhotos(photos, opts?)`, `updatePhoto(…)`, `removePhoto(id)` / `removePhotos(ids)`, `setRating/setColorLabel/setFlag(id, value)`, batch `applyRating/applyColorLabel/applyFlag(ids, value)`, `rotatePhotos(ids, deg)`, `addKeyword/removeKeyword` and batch `addKeywords/removeKeywords`, `setCopyName` (virtual copies), selection (`select`, `selectRange`, `toggleSelect`, `selectAll`, `deselectAll`), `setActivePhoto(id)`. For durable writes, prefer [`api.catalog`](#apicatalog).

### useDevelopStore

State: `photoId`, `params: DevelopParams`, `paramBag` (extension stage params by qualified key, see [`api.params`](#apiparams)), `previewParams` / `previewParamBag` (transient preset-hover preview), `history`/`historyIndex`, `histogram`, `asShotTemperature`, `sourceSize` (the size of the source the last frame was drawn from, upright, as the renderer holds it, `{0, 0}` until a frame of the photo is drawn, with `fullWidth`/`fullHeight`, the decoded frame's size before the upload cap, and `native`, true while `api.develop.readSourceSample` has a sample of the source: the live float decode, or a cached preview stored with one (3.1.0 and later); derive image aspect from this, not `photo.width/height`), crop UI (`cropping`, `constrainCrop`, `cropAspect`, `cropGuide`, `cropGuideFlip`), view state (`showClipping: 0–7`, a bitfield of `1` shadow clipping, `2` highlight clipping and `4` the gamut warning, which only version 3 photos show; `colorAssessment`, `bypassedPanels`, `selectedHslBand`), and tool state (`activeTool`, `wbPicking`, `hslPicking`, `maskColorPicking`, mask/component/brush/retouch fields).

Actions (selected): `loadEdit(photoId, asShotTemperature?)`, `setParam(key, value)`, `setDynParam(qualifiedKey, value)` / `setDynParams(patch)`, `setToneCurve`, `setHslValue`, `applyPreset(params, paramBag?)`, `setPreviewParams(params, paramBag?)`, `commitEdit(label)`, `resetParams(keys, label)`, `undo`/`redo`/`reset`, `updateProcessing()`, `canUndo`/`canRedo`; masks (`addMask`, `updateMask`, `addComponent`, `addRangeComponent`, `addBrushDab`, `removeMask`); retouch (`addSpot`, `updateSpot`, `removeSpot`); `setShowClipping(mode)`, `setPanelBypass(panelId, on)`. `setParam` and `setDynParam` update live; `commitEdit(label)` records a history entry when the edit changed and persists it; with nothing changed it does nothing (no entry, the redo steps stay, nothing is written or announced). The render worker is sent only the top-level `params` fields whose identity changed, so give `setParam` a new array or object whenever one changes (a `masks` or `retouch` array included), never the one set before edited in place: a field edited in place no longer reaches the renderer. The same holds for `paramBag` values (see [`api.params`](#apiparams)). `applyPreset` takes **full** params: merge a partial preset over the current params first, or every omitted adjustment resets to its default. `updateProcessing()` raises the open photo from process version 1 to the current version as one undoable step ("Update processing") and keeps every other setting; it does nothing with no photo open or on a photo that is already current.

### useUIStore

`activeModule` (`ModuleId` = `"library" | "develop"` or a registered id), `viewMode`, `gridSize`, `gridColumns`, `sortField`/`sortDirection`, `filter`, `activeFolder`, `detached: Set`. Actions: `setActiveModule`, `setViewMode`, `setSort`, `setFilter`, `clearFilters`, `setActiveFolder`, `setGridSize`, `stepGridSize`, `setGridColumns`, `markDetached`/`markAttached`. `setSort` persists the choice (`sl_sort_v1`) and `setGridSize`/`stepGridSize` persist the thumbnail size (`sl_grid_size_v1`); both are restored on boot, with the settings-store defaults only seeding a fresh profile.

### useSettings

The user's app preferences. The store's state is the settings object itself: subscribe with a selector (`api.stores.useSettings((s) => s.exportFormat)`) or read once with `api.stores.useSettings.getState()`. Treat it as read-only. Core writes through its own `updateSettings`, which also persists the change and applies side effects such as UI scale; a raw `setState` from an extension does neither. Keep your own options in [`api.settings`](README.md#imperative-control-surfaces) instead. Keys (with defaults):

| Group | Keys |
|---|---|
| Interface | `uiScale` (1), `reduceMotion` (false), `uiFont` (""), `sliderJumpToCursor` (false), `basicDetailSliders` (false), `editingHighlights` (true), `colorOverrides` ({}) |
| Canvas | `canvasSurroundOverride` (true), `canvasSurround` ("#777777"), `assessBorderPct` (4.5), `windowDim` (0.6) |
| Accessibility | `highContrast`, `strongFocus`, `largerText`, `largerControls`, `lowercaseHeadings`, `reduceTransparency`, `keyboardCanvasEditing` (all false), `colorVisionFilter` ("none"), `syncOSAccessibility` (true) |
| Startup | `restoreLastProject` (false) |
| Library | `defaultGridSize` (200), `defaultSortField` ("dateImported"), `defaultSortDirection` ("desc"), `confirmRemovePhotos` (true), `showSubfolderPhotos` (false) |
| Catalog | `catalogLocation` ("in-folder"; "external" keeps it in a separate folder), `externalCatalogDir` ("") |
| Previews | `previewSource` ("auto"), `thumbMaxEdge` (640), `persistPreviews` (true) |
| RAW cache | `rawCacheEnabled` (true), `rawCachePrefetch` (true), `rawCacheMaxEdge` (3072) |
| Develop / render | `developMaxEdge` (4096), `gpuSourceCacheBytes` (512 MB), `developPrefetchNeighbors` (true), `highBitDepth` (true), `liveHistogram` (true), `developOpenZoom` ("fit") |
| Export | `exportFormat` ("image/jpeg"), `exportQuality` (90), `exportLongEdge` (null), `exportBundle` (true), `exportColorSpace` ("srgb"), `exportTiffBitDepth` (16), `exportPngBitDepth` (8), `exportIncludeMetadata` (false), `exportIncludeLocation` (false), `exportPresets` ([]) |
| Shortcuts | `singleKeyShortcuts` (true) |
| Extensions | `extensionTopic` ("safelight-extension"), `checkExtensionUpdates` (true), `autoUpdateExtensions` (false), `onlyVerifiedExtensions` (false) |
| Updates | `checkForUpdates` (true), `updateChannel` ("stable"; "all" also notifies for pre-releases) |

The other stores — `usePresetsStore`, `useKeybindings`, `useThemeStore`, `useLayoutStore`, `usePipelineStore` — back the presets list, rebindable actions, active theme, dock layouts, and the default pipeline respectively (a photo's own pick is `params.displayTransform` in `useDevelopStore`; `api.pipelines.effectiveId` resolves it); prefer the imperative wrappers (`api.themes.apply`, `api.layouts.apply`, `api.pipelines.apply`, `api.keybindings.getBinding`) over poking these directly.

## Brushes, masks & retouch (interactive Develop tools)

Brushes are not a single component — they are an interaction pattern over `useDevelopStore`'s tool state. A tool (built-in or extension) takes over the Develop canvas by setting `activeTool`, reads the shared brush settings, paints by appending dabs/spots to the params, and commits to history. Pair it with a `develop-canvas-overlay` [slot](ui-shell.md#slots-registerslot) (`api.develop.useDevelopOverlay()` for the image rect, `api.develop.setCanvasCursor` for a brush cursor) to draw the brush ring.

Tool state on `useDevelopStore`:

| Field / action | Type | Notes |
|---|---|---|
| `activeTool` | `ToolMode` | `"none" \| "mask" \| "retouch" \| "hsl-picker"`. `setActiveTool(t)` to claim/release the canvas. |
| `brushSize` | `number` | Brush radius as a **fraction of image height** (default `0.08`). `setBrushSize(n)`. Shared by every brush tool. |
| `brushFeather` | `number` | `0`..`1` edge softness (default `0.5`). `setBrushFeather(n)`. |
| `brushOpacity` / `brushFlow` | `number` | `0`..`1` coverage ceiling / per-dab deposit (default `1` each). `setBrushOpacity(n)`, `setBrushFlow(n)`. |
| `brushErase` | `boolean` | Paint erasing dabs. `setBrushErase(b)`. |
| `wbPicking` / `hslPicking` / `maskColorPicking` | `boolean` | Eyedropper modes; `setWbPicking(b)` etc. |

Masking actions (a `Mask` holds one or more `MaskComponent`s — `radial`, `linear`, `brush`, `lumRange`, `colorRange`):

| Action | Signature | Notes |
|---|---|---|
| `addMask` | `(mask: Mask) => void` | Add a new mask group. Limit `MAX_MASKS` (16). |
| `updateMask` | `(id, patch) => void` | Patch a mask (name, opacity, sub-panels, etc.). |
| `updateMaskAdj` / `updateMaskBag` | `(id, patch) => void` | Patch the mask's core adjustments / its extension param bag. Mask sub-panels should go through [`useMaskScope`](ui-shell.md#per-mask-panels-panelcontributionmask) instead. |
| `removeMask` | `(id) => void` | — |
| `addComponent` | `(maskId, comp: MaskComponent) => void` | Add a shape/range component to a mask, combined via mode `add` / `subtract` / `intersect`. |
| `updateComponent` / `removeComponent` | `(maskId, compId, patch?) => void` | — |
| `addRangeComponent` | `(kind: "lumRange" \| "colorRange") => void` | Convenience for a luminance/color-range component on the active mask. |
| `addBrushDab` | `(maskId, compId, dab: BrushDab) => void` | Append one stroke dab to a `brush` component — call repeatedly as the pointer moves, then `commitEdit("Brush mask")` on pointer-up. |

Retouch (heal/clone) actions — each `RetouchSpot` has a `shape` (`"circle"` \| `"brush"`), a `mode` (`"heal"` \| `"clone"`), destination, source, radius, feather, opacity; limit `MAX_RETOUCH` (32), of which `MAX_RETOUCH_BRUSH` (4) may be brush-shaped:

| Action | Signature |
|---|---|
| `addSpot` | `(spot: RetouchSpot) => void` |
| `updateSpot` | `(id, patch: Partial<RetouchSpot>) => void` |
| `removeSpot` | `(id) => void` |

The whole-image limits (`MAX_MASKS`, `MAX_MASK_COMPONENTS`, `MAX_BRUSH_MASKS`, `MAX_RETOUCH`, `MAX_RETOUCH_BRUSH`) and the shape types live in `src/catalog/types.ts` (see [Core Data Types](types.md)). Mutate during a gesture with these actions for a live preview, then call `commitEdit(label)` once when the gesture ends to write a single undo step.

## `api.develop`

The hooks an overlay or canvas tool uses to align to, capture, and decorate the live Develop view, plus helpers for rendering and driving any photo's edit.

| Member | Signature | Notes |
|---|---|---|
| `useDevelopOverlay` | `() => { rect: {x,y,w,h} \| null; nonce: number }` | React hook — call from a `develop-canvas-overlay` component. `rect` is the displayed image's rectangle in the overlay's local coordinates; `nonce` bumps on any view-geometry change (zoom, pan, resize, photo switch) so you can re-align/re-capture. |
| `useMaskScope` | `() => MaskParamScope` | React hook for a per-mask sub-panel: the mask it belongs to. Valid only inside a `PanelContribution.mask` component. See [UI Shell → Per-mask panels](ui-shell.md#per-mask-panels-panelcontributionmask). |
| `captureFrame` | `(params: DevelopParams, options?: { asShown?: boolean; paramBag?: Record<string, unknown> }) => Promise<ImageBitmap>` | Renders the live photo with arbitrary params off-screen, aligned to the current view — the basis of before/after overlays. The frame always covers the region the view shows, whatever crop `params` carry: in crop mode that is the whole photo with the margin around it, as the canvas shows it. By default the frame is for measuring: sRGB, without the clipping warning, the mask overlay or the sharpening preview the view may be showing. `asShown: true` returns the frame as the screen shows it (converted to the Linux display profile when one is set, with those overlays), for drawing over the canvas. `paramBag` is merged over the photo's extension-stage params for this capture only, so a stage can render an auxiliary image (a gain map, a mask) aligned to the view. Neither the capture's params nor its `paramBag` reach the live view or the core's measurements of it (the histogram, Auto Tone, Auto White Balance, Upright). |
| `captureFloatFrame` | `(params: DevelopParams, options?: { space?: StageSpace; point?: "pre-output" \| "output" \| "scene"; paramBag?: Record<string, unknown>; maxEdge?: number }) => Promise<FloatFrame \| null>` | `captureFrame`'s frame as floats, for values an 8-bit sRGB bitmap can't hold. A `FloatFrame` is `{ data: Float32Array; width; height; space; point }`: RGBA, top-down, alpha 1. `point: "pre-output"` (the default) is the signed colour every stage has finished with, as the output stage receives it, so a bright sky reads above 1 and a colour outside the Rec.709 primaries reads below 0; version 1 photos clamp it to [0, 1] after the display transform and hand over that. `"output"` is what the output stage makes of it in sRGB, in [0, 1]. `"scene"` is the scene-linear colour the display transform receives: after the core's linear edits, the masks and every `scene-linear` and `tone-map` stage, signed, before any display tool (for a tone mapper's auto levels, say). The core shoulder has already compressed its highlights wherever it runs: always on version 1, and on version 2 and later unless the photo's display transform sets `skipToneShoulder`. Where the shoulder is skipped it is unclamped. It's drawn by its own program, so the live view never carries it. The frame is converted into `space` (a [`StageSpace`](contributions.md#values-a-stage-sees-space)), by default `{ encoding: "linear", primaries: "rec709" }`, on the GPU, pixel by pixel before any averaging. It is always a measurement: sRGB, unproofed, without the clipping warning, the mask overlay or the sharpening preview. `paramBag` works as it does for `captureFrame`, and neither it nor the params reach the live view or the core's measurements of it. The floats are read straight from the render target, never through an image encoder, so this supersedes `renderPhotoFrame`'s `lossless` for frames that carry data. `null` on a GPU without float render targets, with no photo open, or when the GPU can't hold the frame, so feature-detect with it. `maxEdge` is the frame's long edge in pixels: 1280 by default (about 17 MB of floats for a 3:2 frame), and the default for anything but a positive number. A frame is never upscaled. A smaller frame is the full view's frame averaged down, each pixel the mean, in `space`, of the area it covers: tone, colour and detail (sharpening, noise reduction, texture) as the view shows them, at the smaller size. In a linear `space` that is the mean of linear values, where a smaller view averages encoded ones. `maxEdge: Infinity` asks for the full view at 16 bytes a pixel: at fit at most the Develop render resolution in Preferences ▸ Performance (4096 px on the long edge by default, about 180 MB for a 3:2 photo, up to 8192 px), and zoomed in the visible window at the screen's device pixels. Its cost is reading that back, and in any `space` but perceptual Rec.709 the GPU holds a second frame of that size during the capture (about 360 MB together at 4096 px, 1.4 GB at 8192 px), so ask for it only when you need detail finer than a smaller frame holds. While Develop still shows the camera preview, before the RAW decodes, the frame is drawn from that preview, as `captureFrame`'s is. Needs Safelight 3.1.0: on an older build `api.develop.captureFloatFrame` is undefined, so check for it before calling, or set `minAppVersion` to `"3.1.0"` in the [manifest](../extensions/README.md#manifest). |
| `renderPhotoFrame` | `(photoId, params, paramBag?, options?: { lossless?: boolean }) => Promise<ImageBitmap \| null>` | Renders **any** catalog photo through the full pipeline with `params` (and optionally its extension `paramBag`), small, for measurement. Not tied to the live Develop source, so it works while another photo (or none) is open, e.g. batch Auto Tone across a Library selection. `null` if the photo can't render. A `paramBag` is drawn the way the live Develop view draws one: Safelight adds the entries its built-in stages take from `params` (the Detail panel's noise reduction), and those win where the bag names the same key, so set `luminanceNR` and `colorNR` to 0 in `params` for a frame without it. The frame comes back from a JPEG at quality 0.9, which suits a picture. `lossless: true` returns it from a PNG instead, so every 8-bit channel value the pipeline wrote reaches the bitmap exactly: use it for a frame that carries data (a stage's measurement encoding, say), which a JPEG would smear across neighbouring values. A lossless frame is `null` where only the grid's camera preview could stand in for the photo, since that is another source; a frame that is not lossless still falls back on it. A PNG costs more to encode than a JPEG, so leave it off for a frame you only look at. Safelight builds from before 3.0.1 ignore the option and return the JPEG; set `minAppVersion` to `"3.0.1"` in the [manifest](../extensions/README.md#manifest) when you rely on it. `minAppVersion` gates store installs and updates only, so run a dev-folder copy of such an extension on 3.0.1 or later too. |
| `renderPhotoFloatFrame` | `(photoId, params: DevelopParams, options?: { space?: StageSpace; point?: "pre-output" \| "output" \| "scene"; paramBag?: Record<string, unknown> }) => Promise<FloatFrame \| null>` | `renderPhotoFrame`'s frame as floats: the `FloatFrame` that `captureFloatFrame` (above) hands over, with the same `point` and `space` and the same defaults, converted on the GPU in the same way, for any catalog photo. It renders small, like `renderPhotoFrame`: at most 640 px on the long edge, about 4 MB of floats against about 17 MB for a default `captureFloatFrame` frame, so it suits measuring a whole selection. `paramBag` is drawn as `renderPhotoFrame` draws its `paramBag`, under the entries Safelight's built-in stages take from `params`. When Safelight can't decode the original (an unsupported RAW, or an offline original), the frame is drawn from the photo's stored or embedded preview, as a lossless `renderPhotoFrame`'s frame is, so its values stay within [0, 1]. `null` for a photo the catalog doesn't hold, on a GPU without float render targets, and where only the grid's camera preview could stand in for the photo: that is another source, so, as for a lossless `renderPhotoFrame`, no frame is better than a wrong one. Needs Safelight 3.1.0: on an older build `api.develop.renderPhotoFloatFrame` is undefined, so check for it before calling, or set `minAppVersion` to `"3.1.0"` in the [manifest](../extensions/README.md#manifest). |
| `readSourceSample` | `() => Promise<SourceSample \| null>` | The centre of the open photo's decoded source at native resolution. Safelight keeps it from the live RAW decode before capping the GPU texture to the Develop render resolution (Preferences ▸ Performance, 4096 px by default), and in the RAW cache beside each preview written from 3.1.0 on, so a photo opened from the cache has it too: a `SourceSample` is `{ data: Float32Array; width; height; x; y; sourceWidth; sourceHeight }`, up to 1024 px on each side, taken from the centre (a side shorter than that is kept whole), RGBA, rows top-down, linear Rec.709 with white balance applied and before the baseline tone and every edit, with `x`, `y` placing it in the decoded frame of `sourceWidth` × `sourceHeight`. It is for measuring the sensor's own pixels (a deconvolution radius, noise), which `captureFloatFrame` can't give on a photo larger than the render resolution. `null` while no photo is open, between photos, for a bitmap (JPEG, TIFF, HEIF), for the camera preview shown before the RAW decodes, for a stored preview standing in for the photo, and for a cache entry written before 3.1.0 until the cache pass or a later open rewrites it: subscribe to `useDevelopStore().sourceSize.native` and ask once it is true. Each call hands over a fresh copy, about 16 MB; keep it if you need it twice. Safelight keeps 8 MB per source that has a sample in its GPU source cache. Needs Safelight 3.1.0: on an older build `api.develop.readSourceSample` is undefined, so check for it before calling, or set `minAppVersion` in the [manifest](../extensions/README.md#manifest). |
| `setCanvasCursor` | `(cursor: string \| CursorContribution \| null, opts?: { priority?: number }) => () => void` | Drive the canvas cursor while a tool is active. Pass a registered cursor id, an inline [`CursorContribution`](contributions.md#cursorcontribution), or a raw CSS value; `null` clears. Higher `priority` wins when several tools request at once (default 10). Returns a **release function** — call it on tool deactivate (the request is also swept if the extension unloads). Built-in zoom/pan/pick cursors take over during an active drag, so a passive tool cursor never fights a live gesture. |
| `putPhotoData` | `(key: string, data: Uint8Array \| null) => void` | Persist (or delete, with `null`) an opaque binary blob for the **currently loaded** Develop photo. Key is namespaced per extension. Stored as a sidecar outside `catalog.json`, so large payloads (e.g. a warp displacement field) don't bloat the whole-file JSON rewrite. The extension owns the byte format and load/save timing. |
| `getPhotoData` | `(key: string) => Promise<Uint8Array \| null>` | Read the blob stored under `key` for the current photo, or `null` if none exists (or no photo/project is open). |
| `adjustments` | `{ list(); get(key); set(key, value) }` | The core scalars that live **inside** a structured param (`"vignette.amount"`, `"grain.size"`, …), which a top-level `setParam` can't reach without merging the owning object. `list()` gives each one's `key`, `label`, section `group`, `min`/`max`/`step` and `default`; `get`/`set` route to the right `setParam` path. `set` is live with no history entry, so call `commitEdit` yourself when the gesture ends. |

## `api.params`

Read-only metadata for the stage uniforms every installed extension contributes. Use it for tools that drive or inspect **another** extension's sliders (a speed-edit scrubber, a preset browser).

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

The values themselves live in the develop store's `paramBag`: read `paramBag[qualifiedKey] ?? descriptor.default`, write with `setDynParam(qualifiedKey, value)`. The list is non-reactive and only changes as extensions load and unload, so read it when you need it.

The render worker is sent only the bag values whose identity changed, so `setDynParam` and `setDynParams` must be given a new array or object whenever an array or object value changes (a painted `BrushDab[]` included), never the one set before and edited in place. A value edited in place no longer reaches the renderer.

## `api.export`

Headless export: render catalog photos through the full develop pipeline to in-memory blobs, honoring the user's export settings. Unlike `develop.captureFrame` (the live photo, view-sized), this renders **any** photos at export resolution, so an extension such as a web-gallery publisher can ship full-resolution images instead of the catalog preview.

| Member | Signature | Notes |
|---|---|---|
| `getDefaultSettings` | `() => ExportSettings` | The persisted defaults from Preferences ▸ Export: `format`, `quality` (0..1), `longEdge` (null = original), `colorSpace`, `tiffBitDepth`, `pngBitDepth` (Needs Safelight 3.1.0: older builds don't carry it), … See [Subsystems → Export](subsystems.md#export). |
| `renderPhotos` | `(photos, settings?, onProgress?, options?) => Promise<RenderedPhoto[]>` | `settings` is merged **over** the defaults, so pass only what you override (e.g. `{ format: "image/jpeg", longEdge: 2048, quality: 0.85 }`). The one exception is `pngBitDepth`: a PNG renders at 8 bits whatever Preferences ▸ Export holds, unless you pass `pngBitDepth: 16` (Needs Safelight 3.1.0: older builds ignore it and write 8-bit); `tiffBitDepth` still follows the Preference. One WebGL context serves the batch. Returns one `{ photo, blob, width, height }` per input, in order; `blob` is `null` for a photo that couldn't be decoded, or for an edited photo whose load fell back on its stored preview (the original out of reach): that preview already shows the edit, so it isn't rendered over. `width` and `height` are the encoded image's size, a `processPixels` hook's mat included (0 without a `blob`); a `process(blob)` that resizes the file isn't reflected, so read that size from the blob. `onProgress` receives `{ done, total, filename }`. `options.paramBag` is merged over each photo's own extension-stage params for this render only, so a stage can render an auxiliary image (a gain map, a mask) at export size. A render of a photo while its export processors are running runs none: one started from inside them (they would otherwise run again, the caller included), and also one of the same photo that another batch runs at the same time. Renders of other photos, such as another batch's, run theirs. |

## `api.catalog`

Lower-level catalog access, for extensions that add records the scan didn't produce (virtual copies), copy edits between photos, or build their own photo surfaces.

| Member | Signature | Notes |
|---|---|---|
| `addPhotos` | `(photos: CatalogPhoto[], opts?: { afterId?: string }) => Promise<void>` | Durably write new records and insert them into the live grid, optionally right after a given photo. |
| `getEditState` | `(photoId) => Promise<EditState \| null>` | A photo's saved develop recipe (its undo stack). See [Core Data Types → EditState](types.md#editstate). |
| `putEditState` | `(editState: EditState) => Promise<void>` | Write one back, e.g. to clone one photo's edits onto another. `getEditState` returns it as soon as the call returns, before the save settles. If the photo is open in Develop, Develop reloads its edit from the catalog, which also clears the active tool and the mask and spot selection there. |
| `renamePhoto` | `(photoId, newBaseName) => Promise<RenamePhotoResult>` | Core's own rename: an atomic native rename in the same folder that keeps the extension and carries the `.safelight.json` sidecar and any virtual copies along, so ratings, edits and cached previews survive. Pass the name **without** extension. Returns `{ ok: true, filename }` or `{ ok: false, reason }` and never throws for ordinary failures (collision, missing photo, virtual copy, disk error). For batch renames that shuffle a numbering range, rename through a temporary pass first to dodge the collision guard. |
| `useVisiblePhotos` | `(options?: { without?: string[] }) => CatalogPhoto[]` | React hook: the photos the Library grid shows, in display order, with every filter and sort applied. |
| `usePhotoActions` | `() => { onContextMenu; overlays }` | React hook: the Library right-click menu and its dialogs. |
| `useCullingShortcuts` | `(options?: { sizeSteps?: boolean }) => void` | React hook: the Library's culling shortcuts, live while the component is mounted. |
| `requestThumbnail` | `(photoId) => void` | Queue a photo's grid preview through core's on-demand loader. |

The last four are covered with examples in [UI Components → Photo surfaces](components.md#photo-surfaces-menu-and-shortcuts).

## `api.variables` (shared variables)

Named JSON values that any extension can register, read, subscribe to and write. Each window holds a copy kept in step with every other Safelight window (main, module pop-outs, detached Developer Tools). Values last for the session.

Needs Safelight 3.0.1 or later: on an older build `api.variables` is undefined, so `activate` would throw. Set `minAppVersion` to `"3.0.1"` in the [manifest](../extensions/README.md#manifest) (`safelight.json`) when you use it. `minAppVersion` gates store installs and updates only, so run a dev-folder copy of such an extension on 3.0.1 or later too.

```ts
register<T>(name, { initial: T, description?: string }): VariableSnapshot<T>
get<T>(name): VariableSnapshot<T> | undefined
subscribe<T>(name, listener: (s: VariableSnapshot<T>) => void): () => void
set<T>(name, value: T): VariableWriteResult<T>
update<T>(name, fn: (current: T) => T): VariableWriteResult<T>
// VariableSnapshot = { name, value, revision: { n, window }, writer, registeredBy, description? }
// VariableWriteResult = { ok: true, revision } | { ok: false, reason: "stale" | "unregistered" | "invalid", … }
```

- **Names:**
  - Lower-case letters, digits, `.`, `_` and `-`, starting with a letter or digit, at most 128 characters. `core` and `core.*` are reserved.
  - By convention, prefix a name with the id of the extension that defines the contract (`map.overlays`).
  - `register` is idempotent: whoever registers first sets the initial value and description. Later callers (any extension, any window) join and get the current snapshot. Register before writing: a write to a name nobody registered is refused.
  - Extensions activate in every window, so pass the same constant `initial` everywhere: when two windows register a name at the same moment, one registration replaces the other.
  - `register` throws on an invalid or reserved name, an `initial` that isn't JSON data, or a `description` that isn't a string.
- **Values:**
  - Plain JSON data: objects, arrays, strings, finite numbers, booleans and `null`. Dates, Maps, Sets, typed arrays, class instances, NaN and Infinity are refused by `set` and `update`, and the result names where they are.
  - Snapshots are deep-frozen. Change a value with `set` or `update`, never in place.
- **Visibility:** Every installed extension, and Developer Tools, can read and write every variable. Don't put secrets or anything private in one.
- **Write rule (optimistic locking):**
  - Core remembers the latest revision of each variable your extension has seen in this window, through `register`, `get`, a subscriber delivery or your own write.
  - A `set` after someone else wrote a newer revision is refused as `"stale"`, with the current snapshot.
  - `update(fn)` runs `fn` on the latest value and writes its result, so use it for collections that several extensions add to.
  - `update`'s function must not write the same variable itself, throw, or return a Promise; any of these makes the update refuse as `"invalid"`.
- **Subscribers:** `subscribe` calls the listener at once, or right after a delivery already in progress, with the current snapshot (or on registration, if nobody has registered the name yet), then on every accepted write, local or from another window, your own included, in revision order. A listener that writes the same variable is called again with its own write. Guard such a write, for example by comparing with the current value first: a listener that writes its own variable unconditionally runs again for every write it makes and freezes the window.
- **Patterns:**
  - **Subscribe before you set.** An extension that subscribes always holds the latest revision, so its `set` only fails in a real race.
  - **Collections shared by several writers:** each writer adds or removes its own key with `update`, as in `update<Record<string, Entry>>(name, (o) => ({ ...o, [myId]: entry }))`. Give `update` its type argument: TypeScript can't infer `T` from the name.
  - **Remove your entries in `deactivate()`.** Values outlive the extension that wrote them, but subscriptions don't: disabling an extension drops its subscriptions.
- **Across windows:** if two windows write at the same moment, the higher revision wins everywhere, and the window whose write lost logs it. A `set` or `update` result describes this window only: a write that then loses a simultaneous race with another window has already returned `ok`. The losing window logs the loss, and subscribers receive the winning value.
- **Reports:** refused writes, lost races, throwing subscribers and writes over 8 MB are logged as `[variables] …` warnings, which **Developer Tools ▸ Issues** shows. **Developer Tools ▸ Variables** lists every variable with its writers, subscribers, value and recent history, and can edit a value.

Example (Map draws what other extensions add to `map.overlays`):

```ts
// In the extension that owns the contract:
api.variables.register("map.overlays", { initial: {}, description: "Lines and points drawn on the Map. One entry per extension, keyed by its id." });
api.variables.subscribe("map.overlays", (s) => drawOverlays(s.value));

// In any extension that draws on it:
api.variables.register("map.overlays", { initial: {} }); // either may load first
api.variables.update<Record<string, unknown>>("map.overlays", (o) => ({ ...o, "gps-track": { label: "ride.gpx", geojson } }));
```
