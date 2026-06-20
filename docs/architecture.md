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
- **Rendering**: WebGL2 in a Web Worker (`OffscreenCanvas`); optional 16-bit float textures
- **RAW**: libraw-wasm 1.4 (worker + SharedArrayBuffer) and an in-house TIFF/CFA decoder
- **Build**: Vite 8; Electron 42 + electron-builder 26 for the desktop app

## Project Structure

```
electron/             # Desktop shell: app:// scheme, COOP/COEP, GPU flags, plugin host
src/
├── App.tsx            # Module router (Library / Develop) + detached windows
├── main.tsx           # React bootstrap; boots the extension host before first render
├── catalog/           # Photo records, EXIF, DevelopParams, storage interface, limits
├── project/           # Project folders: scan, .safelight/ storage, recents
├── raw/               # RAW decoding: libraw-wasm adapter, TIFF/CFA, cache
├── lens-profiles/     # Lensfun-derived lens correction database + resolver
├── modules/
│   ├── library/       # Grid/list, folders, filters, culling, import, keywords, metadata
│   ├── develop/       # Canvas, overlays, and all tool panels
│   ├── export/        # Export panel, render-to-blob, output sharpening, ZIP writer
│   └── loupe/         # Standalone loupe canvas/renderer
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

Contribution points an extension can fill (see [API Documentation](api-documentation.md) for signatures): panels, themes, layouts, slider icons, **render pipelines** (display transforms), **GPU processing stages**, keyboard shortcuts, settings, export processors, filename templates, lens profiles, **catalog lifecycle hooks**, preset importers, **grid filters**, **library sorts**, and **UI slots** (named mount points in core chrome).

## Projects and Persistence

Opening a folder installs a `ProjectStorage` (implementing the pluggable `CatalogStorage` interface in `catalog/storage.ts`) backed by that folder's `.safelight/` directory:

```
<project>/.safelight/
├── catalog.json   # photo records + edit histories (debounced whole-file writes)
├── previews/      # <photoId>.jpg grid thumbnails
└── raw/           # decoded-RAW develop cache
```

Opening reconciles `catalog.json` against a fresh recursive disk scan: new files are decoded and thumbnailed, vanished files are dropped, and everything else keeps its ratings and edits. File handles and blobs are never serialized. The last project's `FileSystemDirectoryHandle` persists in IndexedDB (`project/recent.ts`); only its permission resets between browser sessions, which the reconnect flow re-requests. With no project open, catalog writes are no-ops.

Catalog hook contributions run alongside this lifecycle, so an extension (e.g. XMP Tools) can own sidecar files without the core knowing: `onPhotoImport` merges sidecar metadata onto new records, `onMetadataChange`/`onEditCommit` write changes back out, and `onPhotoRemove` cleans up.

## RAW Pipeline

`raw/decode.ts` orchestrates decoding with a best-available strategy:

1. **libraw-wasm** — handles every compression scheme (including lossless NEF), applies camera white balance and orientation, and outputs full-precision linear data. Runs in a worker on shared memory, which requires a cross-origin-isolated context.
2. **In-house decoder** (`raw/tiff.ts`, `raw/pixels.ts`) — uncompressed CFA TIFF-based RAW/DNG, float-capable.
3. **Embedded JPEG preview** — final fallback, so RAW files always display.

Decoded previews are cached (IndexedDB, or `<project>/.safelight/raw/` in a project) at a configurable long edge so reopening a photo in Develop is instant. Newly discovered RAW files are pre-decoded in the background after a project opens (when prefetch is enabled).

## Rendering Pipeline

A single `WebGLRenderer` (`rendering/webgl/renderer.ts`) serves the Develop canvas, the loupe, thumbnail regeneration, and export. It does **not** run on the main thread:

- **`render-worker.ts`** owns the `WebGLRenderer` on an `OffscreenCanvas` inside a Web Worker. It keeps a full-res develop renderer plus a low-res thumbnail renderer, the current `DevelopParams`, the active display pipeline, and an LRU GPU source cache.
- **`render-bridge.ts`** is the main-thread handle (`RenderBridge`): `setImage`, `setParams`, `render`, `capture` (off-screen render of arbitrary params, used by overlay extensions), `uploadSource`/`bindSource` (GPU source cache), `setActivePipeline`, `setLensProfile`, `setAsShotTemperature`. The `useDevelopRenderer` hook drives it and blits the returned `ImageBitmap` to a 2D display canvas.

What the renderer does per frame:

1. The decoded image is uploaded as a texture (8-bit, or 16-bit float when `highBitDepth` is on and supported) with mipmaps, keyed in a budget-bounded GPU cache so switching photos avoids re-upload.
2. A monolithic fragment shader (`rendering/webgl/shaders.ts`, `buildFragmentShader`) applies the full develop recipe: white balance, exposure/contrast/parametric tone recovery, tone curve LUT, HSL, color grading (shadows/midtones/highlights/global), sharpening and noise reduction, lens corrections, geometric transform/upright/crop, vignette and grain, plus per-mask local adjustments (component coverage packs into textures) and heal/clone retouching (`rendering/heal-source.ts`, `rendering/content-aware-fill.ts`). The **active display transform** (pipeline) is injected into this shader as the `pipelineToDisplay()` function — that is where a `registerPipeline` extension takes effect.
3. The interactive render buffer is capped at a configurable long edge (4096/6144/8192); export renders at output resolution and converts to the chosen output color space.

The histogram is computed from the rendered output, optionally on every frame (`liveHistogram`).

### Display transforms vs. processing stages

There are two GPU extension points, at different maturity:

- **Render pipelines** (`registerPipeline`) are **live**. A pipeline supplies a GLSL `vec3 pipelineToDisplay(vec3 lin)` (scene-linear → display) that is compiled into the renderer's program. The built-in transform plus any extension transforms appear in **Preferences ▸ Rendering ▸ Display transform** and apply everywhere the pipeline renders (develop, loupe, thumbnails, export).
- **Processing stages** (`registerProcessingStage`) are the **forward path**. The phase-ordered stage model and shader compiler (`rendering/webgl/shader-compiler.ts`) are in place so the monolithic shader can be decomposed into individually contributable GPU stages over time. The contribution type is part of the public API today; the built-in develop tools still run through the monolithic shader.

## State and Multi-Window

Zustand stores back each domain (`state/`):

- `catalog-store` — photos, selection, culling, keywords, reconnect state.
- `develop-store` — params, undo/redo history, crop/mask/component/brush/retouch UI state, clipping mode, picker tools, transient preview params.
- `ui-store` — active module, view mode, grid size, sort, filter, active folder, detached modules.
- `settings-store` — preferences (read with `getSettings()`, write with `updateSettings(patch)`).
- `keybindings-store` — rebindable actions with module scoping.
- `presets-store` — saved develop presets.

Library and Develop can detach into separate OS windows (`state/detach.ts`). Stores synchronize across windows via BroadcastChannel (`state/broadcast.ts`) for catalog/selection/edit updates, and via the localStorage `storage` event for settings, themes, layouts, keybindings, and extension settings.

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
- Catalog writes are debounced whole-file JSON; thumbnails write only when changed.
- All pixel work happens on the GPU in a worker; the main thread never touches full-resolution pixels after decode.
