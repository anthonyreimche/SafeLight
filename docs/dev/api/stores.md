# State Stores & Tools

← [API Reference](README.md)

The live app state extensions read and drive, the interactive brush/mask/retouch model, and the Develop-canvas integration hooks.

- [State stores (`api.stores`)](#state-stores-apistores)
- [Brushes, masks & retouch](#brushes-masks--retouch-interactive-develop-tools)
- [`api.develop`](#apidevelop)

## State stores (`api.stores`)

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

The other stores — `usePresetsStore`, `useKeybindings`, `useThemeStore`, `useLayoutStore`, `usePipelineStore` — back the presets list, rebindable actions, active theme, dock layouts, and active pipeline respectively; prefer the imperative wrappers (`api.themes.apply`, `api.layouts.apply`, `api.pipelines.apply`, `api.keybindings.getBinding`) over poking these directly.

## Brushes, masks & retouch (interactive Develop tools)

Brushes are not a single component — they are an interaction pattern over `useDevelopStore`'s tool state. A tool (built-in or extension) takes over the Develop canvas by setting `activeTool`, reads the shared brush size/feather, paints by appending dabs/spots to the params, and commits to history. Pair it with a `develop-canvas-overlay` [slot](ui-shell.md#slots-registerslot) (`api.develop.useDevelopOverlay()` for the image rect, `api.develop.setCanvasCursor` for a brush cursor) to draw the brush ring.

Tool state on `useDevelopStore`:

| Field / action | Type | Notes |
|---|---|---|
| `activeTool` | `ToolMode` | The active canvas tool (`"none"`, masking, retouch, …). `setActiveTool(t)` to claim/release the canvas. |
| `brushSize` | `number` | Brush radius as a **fraction of image height** (default `0.08`). `setBrushSize(n)`. Shared by every brush tool. |
| `brushFeather` | `number` | `0`..`1` edge softness (default `0.5`). `setBrushFeather(n)`. |
| `wbPicking` / `hslPicking` | `boolean` | Eyedropper modes; `setWbPicking(b)` etc. |

Masking actions (a `Mask` holds one or more `MaskComponent`s — `radial`, `linear`, `brush`, `lumRange`, `colorRange`):

| Action | Signature | Notes |
|---|---|---|
| `addMask` | `(mask: Mask) => void` | Add a new mask group. Limit `MAX_MASKS` (8). |
| `updateMask` | `(id, patch) => void` | Patch a mask (its adjustment params, name, etc.). |
| `removeMask` | `(id) => void` | — |
| `addComponent` | `(maskId, comp: MaskComponent) => void` | Add a shape/range component to a mask, combined via mode `add` / `subtract` / `intersect`. |
| `addRangeComponent` | `(kind: "lumRange" \| "colorRange") => void` | Convenience for a luminance/color-range component on the active mask. |
| `addBrushDab` | `(maskId, compId, dab: BrushDab) => void` | Append one stroke dab to a `brush` component — call repeatedly as the pointer moves, then `commitEdit("Brush mask")` on pointer-up. |

Retouch (heal/clone) actions — each `RetouchSpot` has a `mode` (`"heal"` \| `"clone"`), position, source, radius, feather, opacity; limit `MAX_RETOUCH` (16), of which `MAX_RETOUCH_BRUSH` (4) may be brush-shaped:

| Action | Signature |
|---|---|
| `addSpot` | `(spot: RetouchSpot) => void` |
| `updateSpot` | `(id, patch: Partial<RetouchSpot>) => void` |
| `removeSpot` | `(id) => void` |

The whole-image limits (`MAX_MASKS`, `MAX_MASK_COMPONENTS`, `MAX_RETOUCH`, `MAX_RETOUCH_BRUSH`) and the shape types live in `src/catalog/types.ts` (see [Core Data Types](types.md)). Mutate during a gesture with these actions for a live preview, then call `commitEdit(label)` once when the gesture ends to write a single undo step.

## `api.develop`

The hooks an overlay or canvas tool uses to align to, capture, and decorate the live Develop view.

| Member | Signature | Notes |
|---|---|---|
| `useDevelopOverlay` | `() => { rect: {x,y,w,h} \| null; nonce: number }` | React hook — call from a `develop-canvas-overlay` component. `rect` is the displayed image's rectangle in the overlay's local coordinates; `nonce` bumps on any view-geometry change (zoom, pan, resize, photo switch) so you can re-align/re-capture. |
| `captureFrame` | `(params: DevelopParams) => Promise<ImageBitmap>` | Renders the pipeline with arbitrary params off-screen, aligned to the current view — the basis of before/after overlays. |
| `setCanvasCursor` | `(cursor: string \| CursorContribution \| null, opts?: { priority?: number }) => () => void` | Drive the canvas cursor while a tool is active. Pass a registered cursor id, an inline [`CursorContribution`](contributions.md#cursorcontribution), or a raw CSS value; `null` clears. Higher `priority` wins when several tools request at once (default 10). Returns a **release function** — call it on tool deactivate (the request is also swept if the extension unloads). Built-in zoom/pan/pick cursors take over during an active drag, so a passive tool cursor never fights a live gesture. |
| `putPhotoData` | `(key: string, data: Uint8Array \| null) => void` | Persist (or delete, with `null`) an opaque binary blob for the **currently loaded** Develop photo. Key is namespaced per extension. Stored as a sidecar outside `catalog.json`, so large payloads (e.g. a warp displacement field) don't bloat the whole-file JSON rewrite. The extension owns the byte format and load/save timing. |
| `getPhotoData` | `(key: string) => Promise<Uint8Array \| null>` | Read the blob stored under `key` for the current photo, or `null` if none exists (or no photo/project is open). |
