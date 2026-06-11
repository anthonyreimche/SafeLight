# Architecture

SafeLight is built as a modern web application using React, TypeScript, and WebGL2 for GPU-accelerated image processing. The architecture is designed around a modular system with clear separation of concerns, inspired by the extensibility and customization patterns of modern IDEs.

## Technology Stack

- **Frontend Framework**: React 19 with TypeScript
- **Build Tool**: Vite 8
- **Styling**: TailwindCSS 4
- **State Management**: Zustand 5
- **Routing**: React Router DOM 7
- **Rendering**: WebGL2 with custom shaders
- **Storage**: IndexedDB for persistent data
- **File Access**: File System Access API

## Project Structure

```
src/
├── App.tsx                 # Main application component
├── main.tsx               # Application entry point
├── catalog/               # Photo catalog and metadata
│   ├── db.ts             # IndexedDB wrapper
│   ├── types.ts          # TypeScript interfaces
│   ├── exif.ts           # EXIF data extraction
│   ├── load-image.ts     # Image loading utilities
│   ├── orient.ts         # Image orientation handling
│   ├── permissions.ts    # File system permissions
│   └── edit-params.ts   # Edit parameter utilities
├── modules/              # Feature modules
│   ├── library/          # Photo library management
│   ├── develop/          # Image editing interface
│   ├── loupe/            # Detailed image viewer
│   └── export/           # Export functionality
├── state/                # Zustand state stores
│   ├── catalog-store.ts  # Photo catalog state
│   ├── develop-store.ts  # Edit parameters state
│   ├── ui-store.ts       # UI state (active module, detached windows)
│   ├── presets-store.ts  # Preset management
│   ├── detach.ts         # Window detachment logic
│   ├── broadcast.ts      # Cross-window communication
│   └── edited-thumbnails.ts # Thumbnail cache
├── rendering/            # Image rendering pipeline
│   ├── webgl/            # WebGL renderer and shaders
│   ├── crop-transform.ts # Crop and transform math
│   ├── curve.ts          # Tone curve LUT generation
│   ├── histogram.ts      # Histogram computation
│   ├── transform.ts      # Matrix transformations
│   └── thumbnail-renderer.ts # Thumbnail generation
├── ui/                   # Shared UI components
│   ├── ViewportImage.tsx # Image viewport component
│   ├── ZoomControls.tsx # Zoom controls
│   └── components/       # Reusable UI components
├── hooks/                # Custom React hooks
│   ├── use-keyboard-shortcuts.ts
│   └── use-window-sync.ts
└── types/                # Shared type definitions
```

## Core Architecture Patterns

### Module System

SafeLight is organized into four main modules, each with its own view and responsibilities:

- **Library Module**: Photo import, organization, culling, and metadata viewing
- **Develop Module**: Image editing with GPU-accelerated adjustments
- **Loupe Module**: Detailed viewing with zoom, pan, and multi-monitor support
- **Export Module**: Batch export with format and resolution options

Modules can be detached into separate windows for multi-monitor workflows. The `detach.ts` file manages window detachment and synchronization.

### Extension System

SafeLight's extension system is inspired by IDE plugin architectures, enabling deep customization:

- **Panel Registration**: Extensions can register new panels or replace existing ones
- **Theme System**: CSS variable-based theming allows complete visual customization
- **Contribution Points**: Well-defined extension points for panels, themes, and UI elements
- **Hot Reloading**: Extensions can be installed and activated without restarting the application
- **API Surface**: Extensions access SafeLight's React instance, state stores, and rendering pipeline through `window.safelight`

The extension system is implemented in `src/extensions/` with built-in extensions serving as examples.

### State Management

State is managed using Zustand stores:

- **catalog-store**: Manages photos, collections, selections, ratings, and flags
- **develop-store**: Manages edit parameters, history (undo/redo), and crop UI state
- **ui-store**: Manages active module, detached windows, and UI preferences
- **presets-store**: Manages preset save/load functionality

State changes are broadcast across windows using the `broadcast.ts` system, enabling synchronization between detached windows.

### Rendering Pipeline

The rendering pipeline uses WebGL2 for GPU-accelerated image processing:

1. **Image Loading**: Images are loaded as ImageBitmap objects
2. **Texture Upload**: Images are uploaded as WebGL textures with mipmaps
3. **Shader Processing**: Custom fragment shaders apply:
   - Exposure, contrast, highlights, shadows adjustments
   - Tone curve adjustments via LUT texture
   - HSL color adjustments
   - Crop and geometric transforms
   - White balance (temperature/tint)
4. **Output**: Rendered canvas can be exported or displayed

The shader pipeline is defined in `rendering/webgl/shaders.ts` and the renderer in `rendering/webgl/renderer.ts`.

### Data Persistence

SafeLight uses IndexedDB for persistent storage:

- **Photos**: Full photo metadata, thumbnails, and file handles
- **Collections**: Regular and smart collections with criteria
- **Edit States**: Edit history with parameters for each photo
- **Presets**: Saved edit parameter sets

The `catalog/db.ts` file provides a typed wrapper around IndexedDB operations.

### File System Integration

SafeLight uses the File System Access API for direct file system access:

- Directory handles for folder imports
- File handles for individual photo access
- Permission management and reconnection after browser sessions
- Fallback to traditional file input for unsupported browsers

The `catalog/permissions.ts` file handles permission requests and verification.

### Cross-Window Communication

When modules are detached into separate windows, SafeLight uses the BroadcastChannel API for synchronization:

- Selection changes across windows
- Edit parameter updates
- Catalog modifications
- UI state synchronization

The `broadcast.ts` file implements this messaging system.

## Type System

The `catalog/types.ts` file defines the core data structures:

- **CatalogPhoto**: Photo metadata, EXIF data, thumbnails, and file handles
- **Collection**: Regular and smart collections with photo IDs
- **DevelopParams**: All edit parameters (exposure, contrast, curves, HSL, crop, transform)
- **EditState**: Edit history with undo/redo stack
- **ToneCurves**: RGB and per-channel tone curve points
- **HSLAdjustments**: Per-color HSL adjustments

## Performance Considerations

- **Thumbnail Caching**: Edited thumbnails are cached to avoid re-rendering
- **Resolution Capping**: Interactive rendering is capped at 2560px for performance
- **Mipmap Usage**: Texture mipmaps enable efficient multi-scale blurs for texture/clarity/dehaze
- **Lazy Loading**: Photos are loaded on-demand rather than all at once
- **WebGL Acceleration**: All image processing happens on the GPU
