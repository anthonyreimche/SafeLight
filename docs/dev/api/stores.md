# State Stores & Data APIs

← [API Reference](README.md)

The live app state extensions read and drive, the interactive brush/mask/retouch model, and the imperative APIs for the Develop canvas, headless export, and the catalog.

- [State stores (`api.stores`)](#state-stores-apistores)
- [Brushes, masks & retouch](#brushes-masks--retouch-interactive-develop-tools)
- [`api.develop`](#apidevelop)
- [`api.params`](#apiparams)
- [`api.export`](#apiexport)
- [`api.catalog`](#apicatalog)

## State stores (`api.stores`)

All stores are Zustand stores; subscribe in React with a selector or read imperatively with `getState()`. Available via `api.stores`: `useDevelopStore`, `useCatalogStore`, `useUIStore`, `useSettings`, `usePresetsStore`, `useKeybindings`, `useThemeStore`, `useLayoutStore`, `usePipelineStore`, plus the zustand `create` factory for your own store. They are typed to the real hooks, so you get each store's actual state shape.

### useCatalogStore

State: `photos`, `selectedIds: Set<string>`, `activePhotoId`, `loading`, `needsReconnect`, `reconnecting`, `fileAccessNonce`.

Actions (selected): `loadCatalog()`, `reconnectFiles()`, `replaceCatalog(photos)`, `addPhotos(photos, opts?)`, `updatePhoto(…)`, `removePhoto(id)` / `removePhotos(ids)`, `setRating/setColorLabel/setFlag(id, value)`, batch `applyRating/applyColorLabel/applyFlag(ids, value)`, `rotatePhotos(ids, deg)`, `addKeyword/removeKeyword` and batch `addKeywords/removeKeywords`, `setCopyName` (virtual copies), selection (`select`, `selectRange`, `toggleSelect`, `selectAll`, `deselectAll`), `setActivePhoto(id)`. For durable writes, prefer [`api.catalog`](#apicatalog).

### useDevelopStore

State: `photoId`, `params: DevelopParams`, `paramBag` (extension stage params by qualified key, see [`api.params`](#apiparams)), `previewParams` / `previewParamBag` (transient preset-hover preview), `history`/`historyIndex`, `histogram`, `asShotTemperature`, `sourceSize` (true dimensions of the decoded source; derive image aspect from this, not `photo.width/height`), crop UI (`cropping`, `constrainCrop`, `cropAspect`, `cropGuide`, `cropGuideFlip`), view state (`showClipping: 0|1|2|3`, `colorAssessment`, `bypassedPanels`, `selectedHslBand`), and tool state (`activeTool`, `wbPicking`, `hslPicking`, `maskColorPicking`, mask/component/brush/retouch fields).

Actions (selected): `loadEdit(photoId, asShotTemperature?)`, `setParam(key, value)`, `setDynParam(qualifiedKey, value)` / `setDynParams(patch)`, `setToneCurve`, `setHslValue`, `applyPreset(params, paramBag?)`, `setPreviewParams(params, paramBag?)`, `commitEdit(label)`, `resetParams(keys, label)`, `undo`/`redo`/`reset`, `updateProcessing()`, `canUndo`/`canRedo`; masks (`addMask`, `updateMask`, `addComponent`, `addRangeComponent`, `addBrushDab`, `removeMask`); retouch (`addSpot`, `updateSpot`, `removeSpot`); `setShowClipping(mode)`, `setPanelBypass(panelId, on)`. `setParam` and `setDynParam` update live; `commitEdit(label)` snapshots into history and persists. `applyPreset` takes **full** params: merge a partial preset over the current params first, or every omitted adjustment resets to its default. `updateProcessing()` raises the open photo from process version 1 to the current version as one undoable step ("Update processing") and keeps every other setting; it does nothing with no photo open or on a photo that is already current.

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
| Export | `exportFormat` ("image/jpeg"), `exportQuality` (90), `exportLongEdge` (null), `exportBundle` (true), `exportColorSpace` ("srgb"), `exportTiffBitDepth` (16), `exportIncludeMetadata` (false), `exportIncludeLocation` (false), `exportPresets` ([]) |
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
| `captureFrame` | `(params: DevelopParams) => Promise<ImageBitmap>` | Renders the live photo with arbitrary params off-screen, aligned to the current view — the basis of before/after overlays. |
| `renderPhotoFrame` | `(photoId, params, paramBag?) => Promise<ImageBitmap \| null>` | Renders **any** catalog photo through the full pipeline with `params` (and optionally its extension `paramBag`), small, for measurement. Not tied to the live Develop source, so it works while another photo (or none) is open, e.g. batch Auto Tone across a Library selection. `null` if the photo can't render. |
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
| `getDefaultSettings` | `() => ExportSettings` | The persisted defaults from Preferences ▸ Export: `format`, `quality` (0..1), `longEdge` (null = original), `colorSpace`, `tiffBitDepth`, … See [Subsystems → Export](subsystems.md#export). |
| `renderPhotos` | `(photos, settings?, onProgress?) => Promise<RenderedPhoto[]>` | `settings` is merged **over** the defaults, so pass only what you override (e.g. `{ format: "image/jpeg", longEdge: 2048, quality: 0.85 }`). One WebGL context serves the batch. Returns one `{ photo, blob, width, height }` per input, in order; `blob` is `null` for a photo that couldn't be decoded. `onProgress` receives `{ done, total, filename }`. |

## `api.catalog`

Lower-level catalog access, for extensions that add records the scan didn't produce (virtual copies), copy edits between photos, or build their own photo surfaces.

| Member | Signature | Notes |
|---|---|---|
| `addPhotos` | `(photos: CatalogPhoto[], opts?: { afterId?: string }) => Promise<void>` | Durably write new records and insert them into the live grid, optionally right after a given photo. |
| `getEditState` | `(photoId) => Promise<EditState \| null>` | A photo's saved develop recipe (its undo stack). See [Core Data Types → EditState](types.md#editstate). |
| `putEditState` | `(editState: EditState) => Promise<void>` | Write one back, e.g. to clone one photo's edits onto another. |
| `renamePhoto` | `(photoId, newBaseName) => Promise<RenamePhotoResult>` | Core's own rename: an atomic native rename in the same folder that keeps the extension and carries the `.safelight.json` sidecar and any virtual copies along, so ratings, edits and cached previews survive. Pass the name **without** extension. Returns `{ ok: true, filename }` or `{ ok: false, reason }` and never throws for ordinary failures (collision, missing photo, virtual copy, disk error). For batch renames that shuffle a numbering range, rename through a temporary pass first to dodge the collision guard. |
| `useVisiblePhotos` | `(options?: { without?: string[] }) => CatalogPhoto[]` | React hook: the photos the Library grid shows, in display order, with every filter and sort applied. |
| `usePhotoActions` | `() => { onContextMenu; overlays }` | React hook: the Library right-click menu and its dialogs. |
| `useCullingShortcuts` | `(options?: { sizeSteps?: boolean }) => void` | React hook: the Library's culling shortcuts, live while the component is mounted. |
| `requestThumbnail` | `(photoId) => void` | Queue a photo's grid preview through core's on-demand loader. |

The last four are covered with examples in [UI Components → Photo surfaces](components.md#photo-surfaces-menu-and-shortcuts).
