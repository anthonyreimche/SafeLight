# State Stores & Data APIs

← [API Reference](README.md)

Live app state, the brush and mask model, and the APIs for the Develop canvas, rendering photos without opening them, the catalog and variables shared across windows.

- [State stores (`api.stores`)](#state-stores-apistores)
- [Brushes, masks & retouch](#brushes-masks--retouch-interactive-develop-tools)
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

The catalog as the Library shows it. For durable writes, use [`api.catalog`](#apicatalog).

```ts
photos; selectedIds: Set<string>; activePhotoId; loading;
needsReconnect; reconnecting; fileAccessNonce;
loadCatalog(); reconnectFiles(); replaceCatalog(photos);
addPhotos(photos, opts?); updatePhoto(…); removePhoto(id); removePhotos(ids);
setRating / setColorLabel / setFlag(id, v);
applyRating / applyColorLabel / applyFlag(ids, v); // batch
rotatePhotos(ids, deg);
addKeyword / removeKeyword; addKeywords / removeKeywords;
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
cropping; constrainCrop; cropAspect; cropGuide; cropGuideFlip;
showClipping;                    // bits: 1 shadows, 2 highlights, 4 gamut (v3)
colorAssessment; bypassedPanels; selectedHslBand;
activeTool; wbPicking; hslPicking; maskColorPicking; // + brush fields

loadEdit(photoId, asShotTemperature?);
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
| Interface | `uiScale`, `reduceMotion`, `uiFont`, `sliderJumpToCursor`, `basicDetailSliders`, `editingHighlights`, `colorOverrides` |
| Canvas | `canvasSurroundOverride`, `canvasSurround`, `assessBorderPct`, `windowDim` |
| Accessibility | `highContrast`, `strongFocus`, `largerText`, `largerControls`, `lowercaseHeadings`, `reduceTransparency`, `keyboardCanvasEditing`, `colorVisionFilter`, `syncOSAccessibility` |
| Startup, Library | `restoreLastProject`, `defaultGridSize`, `defaultSortField`, `defaultSortDirection`, `confirmRemovePhotos`, `showSubfolderPhotos` |
| Catalog | `catalogLocation` (`"in-folder"` or `"external"`), `externalCatalogDir` |
| Previews, cache | `previewSource`, `thumbMaxEdge`, `persistPreviews`, `rawCacheEnabled`, `rawCachePrefetch`, `rawCacheMaxEdge` |
| Develop | `developMaxEdge`, `gpuSourceCacheBytes`, `developPrefetchNeighbors`, `highBitDepth`, `liveHistogram`, `developOpenZoom` |
| Export | `exportFormat`, `exportQuality`, `exportLongEdge`, `exportBundle`, `exportColorSpace`, `exportTiffBitDepth`, `exportPngBitDepth`, `exportIncludeMetadata`, `exportIncludeLocation`, `exportPresets` |
| Other | `singleKeyShortcuts`, `extensionTopic`, `checkExtensionUpdates`, `autoUpdateExtensions`, `onlyVerifiedExtensions`, `checkForUpdates`, `updateChannel` |

## Brushes, masks & retouch (interactive Develop tools)

A brush is a pattern over `useDevelopStore`'s tool state, not a component. A tool claims the canvas with `setActiveTool`, reads the shared brush settings, appends dabs or spots as the pointer moves, and commits once at the end. Draw the ring in a `develop-canvas-overlay` [slot](ui-shell.md#slots-registerslot) with `api.develop.useDevelopOverlay` and `setCanvasCursor`.

```ts
activeTool; setActiveTool(t);     // "none" | "mask" | "retouch" | "hsl-picker"
brushSize; setBrushSize(n);       // radius, fraction of image height (0.08)
brushFeather; setBrushFeather(n); // 0..1 edge softness (0.5)
brushOpacity; setBrushOpacity(n); // 0..1 coverage ceiling (1)
brushFlow; setBrushFlow(n);       // 0..1 deposit per dab (1)
brushErase; setBrushErase(b);     // paint erasing dabs
wbPicking; hslPicking; maskColorPicking; // eyedroppers, setWbPicking(b) etc.

// Mask components: radial, linear, brush, lumRange, colorRange
addMask(mask); updateMask(id, patch); removeMask(id);
updateMaskAdj(id, patch);         // the mask's core adjustments
updateMaskBag(id, patch);         // the mask's extension param bag
addComponent(maskId, comp);       // mode add, subtract or intersect
updateComponent(maskId, compId, patch); removeComponent(maskId, compId);
addRangeComponent(kind);          // "lumRange" | "colorRange", active mask
addBrushDab(maskId, compId, dab); // one dab per pointer move

// RetouchSpot: shape "circle" | "brush", mode "heal" | "clone"
addSpot(spot); updateSpot(id, patch); removeSpot(id);
```

**Notes**

- Mutate with these actions during the gesture for a live preview, then call `commitEdit(label)` once on pointer-up for a single undo step.
- Limits: `MAX_MASKS` 16, `MAX_MASK_COMPONENTS` 24 in total, `MAX_BRUSH_MASKS` 4, `MAX_RETOUCH` 32 of which `MAX_RETOUCH_BRUSH` 4 may be brushes. See [Core Data Types](types.md).
- Per-mask sub-panels edit through [`useMaskScope` or `useParamScope`](ui-shell.md#per-mask-panels-panelcontributionmask), not `updateMaskAdj`/`updateMaskBag`.

## `api.develop`

Hooks to align to, capture and decorate the live Develop view, plus helpers that render any catalog photo.

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
```

**Overlays and tools**

- Call `useDevelopOverlay` from a `develop-canvas-overlay` component. `rect` is the image in the overlay's local coordinates; `nonce` changes on zoom, pan, resize and photo switch, so re-align then.
- `useParamScope` lets one component serve as a panel's `component` and its `mask.component` (`maskId` is null outside a mask). Call `commit(label)` at the end of a gesture.
- `setCanvasCursor` takes a cursor id, a [`CursorContribution`](contributions.md#cursorcontribution) or raw CSS. The highest `priority` wins (default 10). Call the returned release function when your tool deactivates.
- `adjustments` reaches core values inside structured params (`"vignette.amount"`, `"grain.size"`) that `setParam` can't set alone. `set` is live with no history entry: call `commitEdit` yourself.

**Captures of the live view**

- `captureFrame` renders the open photo with any params, aligned to the view. By default it is a measurement frame: sRGB, without the clipping warning, mask overlay or sharpening preview. `asShown: true` keeps them, for drawing over the canvas.
- A capture's params and `paramBag` never reach the live view or the histogram, Auto Tone, Auto White Balance or Upright. Use `paramBag` to render an auxiliary image (a gain map, a mask) aligned to the view.
- `captureFloatFrame` returns RGBA floats, rows top-down. `"pre-output"` is the signed colour the output stage receives (clamped to [0, 1] on version 1 photos), `"output"` is sRGB in [0, 1], `"scene"` is what the display transform receives. It is `null` without float render targets, with no photo open, or when the GPU can't hold the frame.
- `maxEdge: Infinity` gives the full view (about 180 MB at 4096 px, more on the GPU). A smaller frame is the full one averaged down, so ask for full size only when you need the detail.
- `readSourceSample` gives up to 1024 px from the centre of the open RAW at native resolution: linear Rec.709, white balance applied, before every edit. It is `null` for bitmaps and until the RAW decodes; wait for `useDevelopStore` `sourceSize.native` to be true. Each call copies about 16 MB.

**Rendering any photo**

- `renderPhotoFrame` and `renderPhotoFloatFrame` render any catalog photo small, for measurement, whatever Develop has open (batch Auto Tone, say). `null` if the photo can't render.
- Built-in stages add their entries from `params` (Detail noise reduction) and win over the same keys in `paramBag`. Set `luminanceNR` and `colorNR` to 0 for a frame without it.
- `renderPhotoFrame` decodes from a JPEG. Pass `lossless: true` (PNG, 3.0.1) for a frame that carries data. A lossless or float frame is `null` where only the grid's camera preview could stand in for the photo.

**Per-photo data.** `putPhotoData` stores an opaque blob for the photo open in Develop, under a key namespaced to your extension, outside the catalog file. Use it for large payloads such as a warp field. You own the format and when to load and save.

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

Renders catalog photos through the full pipeline to in-memory blobs at export size, using the user's export settings. Use it to ship full-size images (a web gallery) instead of the catalog preview.

```ts
getDefaultSettings(): ExportSettings;  // Preferences ▸ Export
renderPhotos(
  photos: CatalogPhoto[],
  settings?: Partial<ExportSettings>,  // merged over the defaults
  onProgress?: (p: { done; total; filename }) => void,
  options?: { paramBag? },             // this render only
): Promise<RenderedPhoto[]>;           // { photo; blob; width; height }
```

**Notes**

- A PNG renders at 8 bits whatever the Preference says, unless you pass `pngBitDepth: 16` (3.1.0).
- `blob` is `null` for a photo that couldn't be decoded, or an edited photo whose original is out of reach.
- `width` and `height` include a `processPixels` mat. If a `process(blob)` resizes the file, read the size from the blob.
- Export processors don't run for a render started from inside them, or for a photo another batch is rendering at the same time.

## `api.catalog`

Lower-level catalog access, for extensions that add records the scan didn't produce (virtual copies), copy edits between photos, or build their own photo surfaces.

```ts
addPhotos(photos, opts?: { afterId?: string }): Promise<void>; // saved + in grid
getEditState(photoId): Promise<EditState | null>;  // recipe + undo stack
putEditState(editState): Promise<void>;
renamePhoto(photoId, newBaseName): Promise<RenamePhotoResult>;
useVisiblePhotos(opts?: { without?: string[] }): CatalogPhoto[]; // grid order
usePhotoActions(): { onContextMenu; overlays };    // Library menu
useCullingShortcuts(opts?: { sizeSteps?: boolean }): void;
requestThumbnail(photoId): void;                   // queue a grid preview
```

**Notes**

- Writing the photo open in Develop with `putEditState` reloads it there, which clears the active tool and the mask and spot selection.
- `renamePhoto` takes the name without its extension and keeps the sidecar, virtual copies, ratings and edits. It returns `{ ok: false, reason }` rather than throwing. To shuffle a numbering range, rename through temporary names first.
- `useVisiblePhotos`'s `without` names grid filters to ignore, for a surface that registers a filter of its own.
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
