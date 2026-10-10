# Architecture

Safelight is a React + TypeScript application with a WebGL2 image pipeline, shipped both as a browser app and as a packaged Electron desktop app. Four ideas shape the design:

- **Project-based storage** — the catalog lives with the photos, in a `.safelight/` folder inside the project.
- **A worker-isolated GPU render path** — every preview, edit, thumbnail, and export goes through one WebGL2 renderer that runs in a Web Worker on an `OffscreenCanvas`; no render-path code touches the DOM.
- **Everything-is-an-extension** — all panels, themes, layouts, display transforms, keyboard shortcuts, and side concerns flow through one registry. Every stock panel is itself a pre-installed extension that can be disabled and replaced.
- **A blind orchestrator core** — the core app does not know what panels exist, which display transform is active, or who owns metadata sidecars. It exposes contribution points; extensions fill them.

## Technology Stack

- **UI**: React 19, TypeScript 6, TailwindCSS 4
- **State**: Zustand 5 stores
- **Docking**: dockview 6 (panel rails, tabs, floating windows)
- **Rendering**: WebGL2 in a Web Worker (`OffscreenCanvas`); 16-bit float textures
- **RAW**: libraw-wasm built against LibRaw 0.22.1, vendored in `src/raw/vendor/libraw-wasm/` (aliased in `vite.config.ts`; local fixes listed in its `PATCHES.md`), run as a pool of workers on SharedArrayBuffer; plus an in-house TIFF/CFA decoder
- **Build**: Vite 8; Electron 42 + electron-builder 26 for the desktop app

## Project Structure

```
electron/             # Desktop shell: app:// scheme, COOP/COEP, GPU flags, plugin host
src/
├── App.tsx            # Module router (Library, Develop, registered modules) + detached windows
├── main.tsx           # React bootstrap; boots the extension host before first render
├── catalog/           # Photo records, EXIF, DevelopParams, storage interface, limits
├── project/           # Project folders: scan, .safelight/ storage, recents
├── raw/               # RAW decoding: libraw-wasm adapter, TIFF/CFA, cache
├── modules/
│   ├── library/       # Grid/list, folders, filters, culling, import, keywords, metadata
│   ├── develop/       # Canvas, overlays, and all tool panels
│   └── export/        # Export panel, render-to-blob, output sharpening, ZIP writer
├── extensions/        # Registry, host API, loader, docking, themes, pipelines, builtins
├── rendering/         # Render worker + bridge, WebGL renderer, shaders, image math
├── state/             # Zustand stores: catalog, develop, ui, settings, keybindings,
│                      #   presets, broadcast, detach
├── hooks/             # Develop renderer hook, keyboard shortcuts, window sync
├── update/            # In-app update checker
├── types/             # Shared types
└── ui/                # Shell, top bar, menus, Preferences, Extensions store, components
```

## The Orchestrator Model

The core is intentionally **blind**: `App.tsx` routes between modules and renders the shell, but it has no list of panels, tools, themes, or display transforms baked in. Everything visible — including the histogram and every Develop tool — is a *contribution* registered against a central reactive registry (`extensions/registry.ts`).

- **Built-ins** (`extensions/builtin.tsx`) — every stock panel, the two stock themes, the Classic layout, and the built-in display transform are pre-installed extension entries, each registered through the *same* scoped API external plugins use. Any of them can be disabled (and most replaced) from the Extensions panel. **Safelight Core** (the extension manager, stock themes, Classic layout, built-in pipeline) is locked and always on.
- **Host** (`extensions/host.tsx`) — builds the scoped `SafelightAPI` handed to every extension, boots the system once before first render, and exposes the host-scoped API as `window.safelight`.
- **Registry** (`extensions/registry.ts`) — a Zustand store of all contributions, each tagged with its owning extension id so disabling or uninstalling sweeps everything it contributed. Emits lifecycle events (metadata change, edit commit, photo remove) that hook contributions subscribe to.
- **Loader** (`extensions/loader.ts`) — loads built-ins, then external plugins from `<userData>/plugins/<id>/`; imports each ESM bundle and calls `activate(api)`; persists enablement in localStorage (synced across windows).

Contribution points an extension can fill (see [API Reference](api/README.md) for signatures): **modules**, panels (including per-mask panels), panel header accessories, themes, stylesheets, layouts, slider icons, cursors, **render pipelines** (display transforms), **GPU processing stages**, keyboard shortcuts, settings, export processors, filename templates, **catalog lifecycle hooks**, preset importers, **grid filters**, **library sorts**, grid menu items, and **UI slots** (named mount points in core chrome).

## Projects and Persistence

Opening a folder installs a `ProjectStorage` (implementing the pluggable `CatalogStorage` interface in `catalog/storage.ts`) backed by that folder's `.safelight/` directory:

```
<project>/.safelight/
├── catalog.json                       # photo records + edit histories (debounced whole-file writes)
├── catalog.bak.json                   # catalog.json as a session opened it, kept by that session's first save
├── catalog.corrupt-<time>.json        # a damaged catalog.json, kept before it was replaced
├── catalog.before-merge-<time>.json   # the catalog a fold of read-only edits replaced (working-dir.ts)
├── previews/                          # <photoId>.jpg grid thumbnails
└── raw/                               # decoded-RAW develop cache and decode markers
```

Opening reconciles `catalog.json` against a fresh recursive disk scan: new files are decoded and thumbnailed, vanished files are dropped, and everything else keeps its ratings and edits. File handles and blobs are never serialized. The last project's `FileSystemDirectoryHandle` persists in IndexedDB (`project/recent.ts`); only its permission resets between browser sessions, which the reconnect flow re-requests. With no project open, catalog writes are no-ops.

The storage is installed, and the saved photos shown, as soon as `catalog.json` is read, before the folder scan (a first open installs it before importing). Ratings, labels, flags, keywords, rotations, removals, virtual copies, moves and edits made while the scan runs land in it and are kept. Opening another folder or closing the project first saves the old storage and closes it (`setCatalogStorage`), and the next open waits for that save before it reads `catalog.json`.

`catalog.json` is classified before anything else (`readJSONFile`, `project/fs.ts`): missing, ok, corrupt (empty, cut short, not JSON, or not an object) or unreadable (EBUSY, EPERM, NotReadableError; the desktop bridge keeps the errno only in the message). An unreadable catalog is read again after 250, 500, 1000 and 2000 ms, then the open throws `CatalogUnreadableError` with nothing written, sent or installed. A corrupt one is first copied byte for byte to `catalog.corrupt-<time>.json` (`CatalogDamagedError` if that copy fails). A corrupt or missing catalog is then restored from `catalog.bak.json` when that opens; otherwise the folder is imported again, a damaged backup being kept aside first as `catalog.bak.corrupt-<time>.json`. `OpenedProject.recovered` says which, and the open schedules a save so the restored copy replaces the damaged file. A `version` above 1 throws `CatalogTooNewError`. Records this build can't open are skipped, the file being kept aside first, and unknown top-level keys are written back as read. A session's first save other than an unloading flush writes the bytes it opened `catalog.json` from to `catalog.bak.json` once that write has ended. A fold of read-only edits keeps the catalog it replaces as `catalog.before-merge-<time>.json`, and folds nothing an open would refuse: a damaged spillover is left where it is, and one a newer version saved fails the open with `CatalogTooNewError`. A restore keeps every photo id; a rebuild makes fresh ids, and in the browser build a fresh catalog id, so other windows open on the old catalog stop syncing with it.

Catalog hook contributions run alongside this lifecycle, so an extension (e.g. XMP Tools) can own sidecar files without the core knowing: `onPhotoImport` merges sidecar metadata onto new records, `onMetadataChange`/`onEditCommit` write changes back out, and `onPhotoRemove` cleans up.

## RAW Pipeline

`raw/decode.ts` orchestrates decoding with a best-available strategy:

1. **libraw-wasm** — handles every compression scheme (including lossless NEF), applies camera white balance and orientation, and outputs full-precision linear data. Runs in a worker on shared memory, which requires a cross-origin-isolated context.
2. **In-house decoder** (`raw/tiff.ts`, `raw/pixels.ts`) — uncompressed CFA TIFF-based RAW/DNG, float-capable.
3. **Embedded JPEG preview** — final fallback, so RAW files always display.

`decodeRawToFloat` answers a `DecodeFailure` when it has no image: `unsupported` (reading the file again won't help until the decoder changes), `transient` (the decoder or the file wasn't available this time; `timedOut` when libraw gave no answer within its time limit) or `aborted`, with the decoder's `reason`. Every call on a pooled libraw instance is watched: one that rejects (a trap or an abort) or outlives the limit (a minute plus 20 s per 25 MB, extended once the frame is known to a minute plus 2 s per megapixel, that part capped at five minutes) has its worker terminated and replaced, so a hung file can't hold a decoder for good. A file that timed out is passed over by background requests for the rest of the session, as is one already being decoded (`passedOver`); an interactive open always decodes.

Decoded previews are cached in `<project>/.safelight/raw/` (in IndexedDB scoped to the project's path where the cache worker can't reach that folder) at a configurable long edge, so reopening a photo in Develop is instant. Only a decode `acceptDecode` takes is cached: a marginal one (inferred dimensions) or one whose colours disagree with the camera's preview never is. A RAW the decoder can't use gets a marker beside its cache key (`raw-cache.ts`, named for `DECODER_ID`): a session's first verdict is tentative, a session loaded after it makes it final, and only a final marker counts. `unsupported` sends Develop straight to the camera's preview; `suspicious` only keeps the background pass off the file. Re-import, Clear preview cache and an accepted decode remove a photo's markers; a decode that timed out or failed for now is never marked.

After an open, the main window (never a pop-out) runs two background passes: the preview repair for records imported without a preview, and the "Cache all" pre-decode of every uncached RAW when that preference is on. They take the project's passes signal (`projectPassSignal()`), as do the passes the user starts (Preferences ▸ Cache all now and Rebuild thumbnails, Re-import); it aborts as the next project starts opening or this one closes, and a cache write or marker begun in another project's folder is dropped (`rawCacheGeneration`). Background decodes (these passes, grid previews built from the file, Develop's neighbour prefetch, edited-thumbnail regeneration and off-screen measuring) queue behind every interactive one and never hold every pool instance; one abandoned while it waits leaves the queue.

## Rendering Pipeline

A single `WebGLRenderer` (`rendering/webgl/renderer.ts`) serves the Develop canvas, thumbnail regeneration, and export. It does **not** run on the main thread:

- **`render-worker.ts`** owns the `WebGLRenderer` on an `OffscreenCanvas` inside a Web Worker. It keeps a full-res develop renderer plus a low-res thumbnail renderer, the current `DevelopParams`, the active display pipeline, and an LRU GPU source cache.
- **`render-bridge.ts`** is the main-thread handle (`RenderBridge`): `setImage`, `clearSource`, `setParams` (posts the first params whole, then only the top-level fields that are new or not the same value as last posted, as `patchParams`, so callers replace params, and each field they change, and never mutate one in place; re-sends the live pipeline when `displayTransform` changes), `render`, `capture` (off-screen render of arbitrary params, used by overlay extensions; carries the pipeline resolved from its own params, like the thumbnail renders), `uploadSource`/`bindSource` (GPU source cache), `setPipeline`/`syncPipeline` (re-sends the live photo's pipeline), `setStages`/`setContributedParams`/`setStageTextures` (extension GPU stages and their params; `setContributedParams` patches the bag the same way, so callers replace the bag and its values and never mutate them), `setAsShotTemperature`.

Renders go through a mailbox. One render is in flight; the newest request made meanwhile waits, with the histogram flags of the requests it replaced merged in, and goes when the worker answers. The worker answers every render by its `seq`: with a `frame`, `frameSkipped` (no renderer, or no source yet for the photo the view moved to) or `renderError`. A render not answered in 2 s, or in 3× the slowest of the last eight answers once one of them took longer, is given up on with one warning and the waiting request goes; nothing more is posted until the worker answers one of the two, unless it says nothing at all for 30 s. Each frame carries the size and number (`sourceGen`) of the source it was drawn from, which `RenderBridge.sourceGen` counts the same way. A develop source the worker can't take is answered `sourceError` with its number, and nothing is drawn until the next source; a `bindSource` that throws is answered as a miss.

The `useDevelopRenderer` hook drives the bridge. It tiers what the canvas shows of the open photo: `stored` (the stored preview, drawn as it is, and only while its `previewEdit` fingerprint matches the edit open), `preview` (frames of the camera's preview while the decode runs, or for good when the load settled on a fallback) and `final`. It blits each returned `ImageBitmap` to a 2D display canvas: a frame of the size already shown at once, another size in the commit that resizes the canvas's box. A lower tier of the open photo fades out over the next on an overlay canvas (`src/ui/canvas-crossfade.ts`): stored to developed in 150 ms, preview to final in 220 ms. Reduce motion, a photo opened within 150 ms of the one before, and a change of shape or placement cut instead, and so does every move to another photo. DevelopView builds a new canvas view per photo; the picture the old view showed is handed to the new one (`src/ui/canvas-handover.ts`) and held in place, colour-assessment mat included, until the new photo's first picture, for at most 150 ms.

Only an image that may stand for its photo goes into the GPU source cache under the photo's key (`photoSourceKey`): its own pixels, or the camera's preview of a RAW marked unsupported (`standsForPhoto`, `src/state/fallback-rules.ts`). A load that settles on another fallback says so on `DecodedImage.fallback` (`from`: `"embedded"`, `"stored"` or `"stored-edited"`, plus `offline`, `unsupported`, `timedOut`); Develop uploads it under `${key}#fallback`, which no open binds, so the next open loads the photo again, and the camera's preview shown while the decode runs is a plain `setImage`. A `"stored-edited"` fallback, an edited photo's stored preview standing in for an original out of reach, already shows the edit and is never rendered over: Develop shows it as it is while it matches the edit open, the grid's edited thumbnails leave the stored preview as it is, off-screen measuring skips the photo, and export fails it with a reason. The thumbnail renderer and off-screen measuring also never keep, under the photo's key, a fallback that can't stand for it. A background load the decoder passes over resolves null.

What the renderer does per frame:

1. The decoded image is uploaded as a texture with mipmaps, keyed in a budget-bounded GPU cache so switching photos avoids re-upload: RGBA16F for a float RAW decode or a cached float preview, RGBA8 for an 8-bit bitmap. The `highBitDepth` setting does not change that. It only picks the format of the patched copy a photo with heal or clone spots develops from: a version 1 photo (`params.processVersion`) gets RGBA16 (`EXT_texture_norm16`) when the setting is on and the driver supports it, else RGBA8; a version 2 photo gets RGBA16F first, whatever the setting says, and steps down to RGBA16 (setting on) and then RGBA8 only if the driver can't use RGBA16F.
2. A monolithic fragment shader (`rendering/webgl/shaders.ts`, `buildFragmentShader`) applies the full develop recipe: white balance, exposure/contrast/parametric tone recovery, tone curve LUT, HSL, color grading (shadows/midtones/highlights/global), sharpening and noise reduction, lens corrections, geometric transform/upright/crop, vignette and grain, plus per-mask local adjustments (component coverage packs into textures) and heal/clone retouching (`rendering/heal-source.ts`, `rendering/content-aware-fill.ts`). The **active display transform** (pipeline) is injected into this shader as the `pipelineToDisplay()` function — that is where a `registerPipeline` extension takes effect.
3. The interactive render buffer is capped at a configurable long edge (4096/6144/8192); export renders at output resolution and converts to the chosen output color space.

The histogram is computed from the rendered output, once per change: throttled while the change goes on when `liveHistogram` is set, once it settles when not. It always measures the whole picture, also while the view renders only a zoomed window of it.

### Display transforms vs. processing stages

There are two GPU extension points:

- **Render pipelines** (`registerPipeline`) supply a GLSL `vec3 pipelineToDisplay(vec3 lin)` (scene-linear → display) that is compiled into the renderer's program. Transforms are picked per photo from the display transform menu in Develop's bottom bar; **Preferences ▸ Rendering ▸ Default display transform** covers photos without a pick. A photo's transform applies everywhere it renders (develop, thumbnails, export). This is the simplest way to ship a whole-image tone mapper.
- **Processing stages** (`registerProcessingStage`) are phase-ordered GPU stages compiled into the develop shader by the stage injection (`rendering/webgl/stage-injection.ts`, ordered by `stage-order.ts`). The path is live: all phases compile in, stages take custom uniforms and bind textures/LUTs, support multi-pass ping-pong pre-passes, can declare the colour space they work in (`space`) and start their passes from the image as edited up to the stage (`reads: "current"`; see [Contribution Types](api/contributions.md#values-a-stage-sees-space)), and include a special `geometry` phase that warps source coordinates before sampling. Reach for a stage when you need phase ordering, uniforms, multiple passes, or coordinate warping.

## State and Multi-Window

Zustand stores back each domain (`state/`):

- `catalog-store` — photos, selection, culling, keywords, reconnect state.
- `develop-store` — params, undo/redo history, crop/mask/component/brush/retouch UI state, clipping mode, picker tools, transient preview params.
- `ui-store` — active module, view mode, grid size, sort, filter, active folder, detached modules.
- `settings-store` — preferences (read with `getSettings()`, write with `updateSettings(patch)`).
- `keybindings-store` — rebindable actions with module scoping.
- `presets-store` — saved develop presets.

Any module (Library, Develop, or one an extension registered) can detach into its own OS window (`state/detach.ts`). Windows talk over a BroadcastChannel (`state/broadcast.ts`): the active photo (`selection-change`), committed looks for the Library's histograms (`edit-update`), preview reloads (`catalog-change`), catalog records (`catalog-records`, below) and the greeting a window's storage sends once it has read the catalog (`catalog-hello`, below). Settings, themes, layouts, keybindings and extension settings follow through the localStorage `storage` event.

Every window opens the project with its own `ProjectStorage` and writes the whole `catalog.json` from its own copy, one write at a time (a closing window's last flush starts at once instead; the desktop main process lands writes to one file in order). A window writes only when its copy holds a change the file may lack: a change of its own, a repair (below), a change it couldn't send, or a write that failed. So opening, popping out or closing a window with nothing changed writes nothing. A write that fails is tried again after 2, 5, 15 and 30 s, then every minute; `onSaveStatus` reports how each write ended, and the project store shows the open project's failures in every window (`saveError`, `StorageBanner`). So that a save in one window doesn't undo another window's changes, each catalog change is also sent as `catalog-records`: the edit histories, the photo records as stored (no handles, preview blobs or URLs) and the ids of removed photos, tagged with the catalog file they belong to (`catalogKey`: the working folder's path in the desktop build; in the browser build, which has no paths, the folder's name and an id the catalog keeps in `catalog.json`), so a copy of the project elsewhere, which keeps the same photo ids, is left alone. Every other window on that catalog applies the records to its `ProjectStorage`, its catalog store and the photo open in Develop (`state/catalog-sync.ts`), keeping its own handles and previews. Removing a photo removes its virtual copies in every window, including copies a window keeps without showing them. Records of photos it doesn't show (virtual copies made in another window, files another window found when it opened the folder) are kept unshown and written back in its own saves, so they appear once it reopens the project; a record for a file the window already shows under another id is never kept, and when a project opens, a record never takes the place of a file's first saved record. A file removed from the catalog stays out of it (its name is tombstoned) until a photo is stored under that name again, in any window: a photo renamed onto the name of one removed earlier, or a new photo an extension writes under it, stays. Once a window removes a photo, or learns that another window removed it, it refuses every later record of that photo until the project is opened again, so a late message or a stale writer can't bring it back. Edit histories, ratings, labels, flags, keywords and the other photo fields, additions and removals are shared this way.

Each change carries a change stamp (`project/change-stamps.ts`): `[at, by]`, from a clock that moves past every stamp the storage reads, with the storage's origin breaking ties. A photo record is stamped per group of the fields one change writes together (`location`; `shape`, which is rotation, width and height; `file`; `rating`; `colorLabel`; `flag`; `keywords`; `decodeError`; `copyName`; `created`), an edit history whole. A window takes each group, and each history, only where the incoming stamp is newer, so the order messages arrive in doesn't matter, and two windows changing different groups of one photo both keep both changes. A group with no stamp (from an older catalog, or a fresh import) counts as the oldest. The stamps travel beside the records, as one `changed` block in `catalog.json` (left out when there are none, so a catalog nobody changed saves byte-identical) and in each message. The description of the stored preview, `previewEdit` and `previewRotation`, isn't stamped: it follows the preview's own writes, and a window takes the sender's in the order messages arrive.

While a window opens the project, the records that arrive wait until it has read `catalog.json`. From then on the records of photos it shows, and every removal, apply at once; only records of photos it doesn't show wait for the end of the folder scan. Once it has read the file, the storage sends `catalog-hello` with the time it began listening. Every other storage on that catalog answers it alone (`catalog-records` with `answer` and `to`), including one still in its own scan and one whose window has left but still follows (below): with every record and history it changed or took in since it opened, its removals, and the files it removed whose tombstone the file the newcomer read may lack (one no landed write of the answering storage holds yet, or one that landed after the newcomer began listening; landed ones are answered for 60 s). The stamps decide what the newcomer takes. So a change not saved yet when another window opens the project reaches that window, and its next save keeps it.

A window saves again for records it takes on when a save of its own may have landed after the sender's and put the old records back (a repair). A window that leaves a project closes its storage (`close`): it saves what it holds and reports nothing more, but keeps taking on, and answering, the other windows' records while it may still write (its scan, a pending or failing save, a preview write), then lets go. A copy whose save keeps failing tries three more times after its window left, then gives the change up: it sends `catalog-records` with `unsaved` and no records, every window that holds all it sent (one listening from before its oldest unsaved change, or one that took its answer) saves, and the window that left is told (`gaveUp`, `storageNotice`).

Not shared yet:

- Photos one window adds while another is open are written by both windows but shown in the other only after it reopens the project. A window shut, or an app quit, while that window is still importing hasn't sent what it found, so the other window's saves can drop those records; they are imported again, under new ids, the next time the folder opens. A window that leaves the project mid-import sends them when its scan stops.
- Every window scans the folder on its own, so two windows can import the same new file under different ids. Neither keeps the other's record of that file, so when one window removes its photo, the other still has its own, and the file can come back under that id after a reopen.
- A move or rename (`relocatePhotos`) gives the other windows the photo's new location in their records, but they keep the file handles they hold. Until such a window reopens the project it can't open or export that photo, and Delete from disk looks for the file at its old location (`nativePathOf(photo.fileHandle)`).
- Two windows changing the same group of a photo's fields, or its edit history, at the same moment both end with the newer change; the other is lost. Develop reloads the open photo when another window changes its edit, which also drops a slider drag still in progress there.
- Changes made in the last moments before the app quits reach the other windows only if their messages arrive before those windows write: each window holding a change its file may lack writes its own copy as it closes, and the write that lands last wins.
- The description of a stored preview (`previewEdit`, `previewRotation`) follows the order messages arrive in. A late message can leave a window's record naming another edit or rotation than its `<id>.jpg` has, which costs a preview built from the file, or, in a narrow case, a first draw in Develop of a look that isn't the edit.
- Two windows writing one photo's `<id>.jpg` at once can land in either order relative to their records. Each storage orders its own writes; the desktop main process orders the windows' writes as they arrive, while in the browser build each window opens its own writable.
- A record a message can't carry (structured clone throws) reaches no other window. The window holding it writes on every flush, but a window opening meanwhile misses that window's whole answer until its next write lands.
- Browser build: a project folder duplicated together with its `.safelight` keeps the original's catalog id, so if the copy and the original have the same folder name and are open in two browser windows, those windows take on each other's records. Neither window lets those records take the place of photos it shows, or bring back a photo it removed; a photo the other window adds under the name of a file this one removed is kept, though, and stands for that file once the project is opened again. Unrelated projects with the same folder name are told apart. A new project opened in two browser windows before its first save gets a different id in each, so those two share nothing until one of them opens the project again.

One window owning the catalog, with the others as its clients, would fix these; that needs a design of its own.

## Electron Shell

`electron/main.cjs` exists chiefly to make the RAW path fast and reliable, and to host installed extensions:

- Registers a privileged `app://` scheme serving the built `dist/`, attaching COOP/COEP headers so the page is cross-origin isolated and libraw-wasm can use SharedArrayBuffer workers. Installed extensions are served from `<userData>/plugins/` under the same origin (`/__plugins__/`) so their ESM bundles import cleanly under COOP/COEP.
- Forces Chromium's fast GPU path (D3D11 ANGLE on Windows, discrete GPU, no software WebGL fallback, zero-copy rasterization). On Linux it auto-detects a working ANGLE backend and relaunches once if needed.
- Disables renderer/background throttling so decodes and renders continue while the window is occluded.
- `electron/preload.cjs` exposes a locked-down `window.safelightNative` bridge: platform/versions, app version, the in-app updater, a GitHub Releases/repo proxy (for updates and the Extensions store), the plugin host (`list`/`install`/`uninstall`/`search`), path-based filesystem access, devtools control, and GPU/process diagnostics.

The renderer is identical to the web build; there is no Node integration in app code beyond the preload bridge.

## Performance Notes

- Decoded-RAW and thumbnail caches avoid repeat work; edited thumbnails re-render lazily.
- A budget-bounded GPU source cache keeps recently viewed photos resident in VRAM for instant photo switching.
- Mipmapped textures power efficient multi-scale operations (texture/clarity/dehaze).
- Catalog writes are debounced whole-file JSON, made only when a window's copy holds a change; thumbnails write only when changed, at most four at a time per storage, in the order asked for per photo.
- All pixel work happens on the GPU in a worker; the main thread never touches full-resolution pixels after decode.
