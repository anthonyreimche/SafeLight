# Architecture

Safelight is a React + TypeScript application with a WebGL2 image pipeline, shipped both as a browser app and as a packaged Electron desktop app. Three ideas shape the design: **project-based storage** (the catalog lives with the photos), **a GPU-only render path** (every preview, edit, thumbnail, and export goes through the same shader pipeline), and **everything-is-an-extension** (all panels, themes, and layouts flow through one registry).

## Technology Stack

- **UI**: React 19, TypeScript, TailwindCSS 4
- **State**: Zustand 5 stores
- **Docking**: dockview (panel rails, tabs, floating windows)
- **Rendering**: WebGL2 with custom shaders; optional 16-bit float textures
- **RAW**: libraw-wasm (worker + SharedArrayBuffer) and an in-house TIFF/CFA decoder
- **Build**: Vite 8; Electron 42 + electron-builder for the desktop app

## Project Structure

```
electron/             # Desktop shell: app:// scheme, COOP/COEP, GPU flags
src/
├── App.tsx            # Module router (Library / Develop) + detached windows
├── catalog/           # Photo records, EXIF, edit params, storage interface
├── project/           # Project folders: scan, .safelight/ storage, recents
├── raw/               # RAW decoding: libraw-wasm adapter, TIFF/CFA, cache
├── modules/
│   ├── library/       # Grid/list, folders, filters, culling, import
│   ├── develop/       # Canvas, overlays, and all tool panels
│   ├── export/        # Export panel, render-to-blob pipeline, ZIP writer
│   └── loupe/         # Standalone loupe canvas/renderer
├── extensions/        # Registry, host API, loader, docking, themes, builtins
├── rendering/         # WebGL renderer, shaders, curves, histogram, heal/fill
├── state/             # Zustand stores: catalog, develop, ui, settings,
│                      #   keybindings, presets, broadcast, detach
├── hooks/             # Renderer hooks, keyboard shortcuts, window sync
└── ui/                # Shell, top bar, menus, shared components
```

## Projects and Persistence

Opening a folder installs a `ProjectStorage` (implementing the pluggable `CatalogStorage` interface in `catalog/storage.ts`) backed by that folder's `.safelight/` directory:

```
<project>/.safelight/
├── catalog.json   # photo records + edit histories (debounced whole-file writes)
├── previews/      # <photoId>.jpg grid thumbnails
└── raw/           # decoded-RAW develop cache
```

Opening reconciles `catalog.json` against a fresh recursive disk scan: new files are decoded and thumbnailed, vanished files are dropped, and everything else keeps its ratings and edits. File handles and blobs are never serialized. The last project's `FileSystemDirectoryHandle` persists in IndexedDB (`project/recent.ts`); only its permission resets between browser sessions, which the reconnect flow re-requests.

## RAW Pipeline

`raw/decode.ts` orchestrates decoding with a best-available strategy:

1. **libraw-wasm** — handles every compression scheme (including lossless NEF), applies camera white balance and orientation, and outputs full-precision linear data. Runs in a worker on shared memory, which requires a cross-origin-isolated context.
2. **In-house decoder** (`raw/tiff.ts`, `raw/pixels.ts`) — uncompressed CFA TIFF-based RAW/DNG, float-capable.
3. **Embedded JPEG preview** — final fallback, so RAW files always display.

Decoded previews are cached (IndexedDB, or `<project>/.safelight/raw/` in a project) at a configurable long edge so reopening a photo in Develop is instant. Newly discovered RAW files are pre-decoded in the background after a project opens.

## Rendering Pipeline

A single `WebGLRenderer` (`rendering/webgl/`) serves the Develop canvas, the loupe, thumbnail regeneration, and export:

1. The decoded image is uploaded as a texture (8-bit, or 16-bit float when `highBitDepth` is on and supported) with mipmaps.
2. Fragment shaders apply the full develop recipe: white balance, exposure/contrast/parametric tone recovery, tone curve LUT, HSL, color grading, sharpening and noise reduction, lens corrections, vignette and grain, geometric transform and crop, plus per-mask local adjustments (brush coverage packs into RGBA textures) and heal/clone retouching (`rendering/heal-source.ts`, `rendering/content-aware-fill.ts`).
3. The interactive render buffer is capped at a configurable long edge (4096/6144/8192); export renders at output resolution.

The histogram is computed from the rendered output, optionally on every frame (`liveHistogram`).

## Extension System

`extensions/` implements the everything-is-an-extension model:

- **Registry** (`registry.ts`) — panels, themes, layouts, and slider icons, each tagged with its owning extension id so disable/uninstall can sweep contributions.
- **Host** (`host.tsx`) — builds the scoped `SafelightAPI` handed to every extension and boots the system once before first render; the host-scoped API is exposed as `window.safelight`.
- **Built-ins** (`builtin.tsx`) — every stock panel is a pre-installed extension entry, registered through the same scoped API external plugins use, so any of them can be disabled and replaced.
- **Loader** (`loader.ts`) — downloads GitHub repos into local storage, imports their ESM bundle, and calls `activate(api)`; persists enablement.
- **Dock** (`dock.tsx`, `PanelStack.tsx`) — dockview-backed rails with per-module persisted layouts; panels can dock, tab, minimize, or float.
- **Themes** (`themes.ts`) — CSS-variable themes applied to `:root`.

## State and Multi-Window

Zustand stores back each domain: `catalog-store` (photos, selection, culling), `develop-store` (params, undo/redo history, crop/mask/brush UI state), `ui-store` (active module, view mode, detached modules), `settings-store` (preferences), `keybindings-store` (rebindable actions with module scoping), and `presets-store`.

Library and Develop can detach into separate OS windows (`state/detach.ts`). Stores synchronize across windows via BroadcastChannel (`state/broadcast.ts`) for catalog/selection/edit updates, and via the localStorage `storage` event for settings, themes, layouts, and keybindings.

## Electron Shell

`electron/main.cjs` exists chiefly to make the RAW path fast and reliable:

- Registers a privileged `app://` scheme serving the built `dist/`, attaching COOP/COEP headers so the page is cross-origin isolated and libraw-wasm can use SharedArrayBuffer workers.
- Forces Chromium's fast GPU path (D3D11 ANGLE, discrete GPU, no software WebGL fallback, zero-copy rasterization).
- Disables renderer/background throttling so decodes and renders continue while the window is occluded.

The renderer is identical to the web build; there is no Node integration in app code beyond a minimal preload.

## Performance Notes

- Decoded-RAW and thumbnail caches avoid repeat work; edited thumbnails re-render lazily.
- Mipmapped textures power efficient multi-scale operations (texture/clarity/dehaze).
- Catalog writes are debounced whole-file JSON; thumbnails write only when changed.
- All pixel work happens on the GPU; the CPU never touches full-resolution pixels after decode.
