# Changelog

All notable changes to SafeLight will be documented in this file.

## [Unreleased]

### Planned Features
- Color, BW, and HDR support
- Image masking and touchup removal/cloning
- Red eye correction
- Image compare / "open in new unsynced loupe tab" support
- HDR / focus stacking and photo merge support
- Batch editing functionality
- AI masking via ONNX.js (Select Subject, Sky)
- Mobile-responsive Loupe view
- Open preset and plugin standard
- Lightroom catalog import (sql.js)

## [0.0.0] - Current Development

### Currently Implemented
- **Image Library**
  - Photo library with grid and list view
  - Collection support
  - Rating (0–5), color code (6–9), and pick(P) / reject(X) / unflag (U) support
  - Library sort tools
  - Single file and folder import support
  - Full and single channel Histogram viewer
  - Metadata viewer

- **Develop Environment**
  - Undo/Redo support
  - Edit reset button
  - Histogram control
  - White balance sliders
  - Full and single-channel RGB tone curve support
  - Basic HSL/Color support
  - Basic preset support
  - Hold shift or widen slider panel for fine adjustment, double-click to reset value
  - Full traditional crop functionality with guides, level (CTRL+drag), and constrain to image option support
  - Transform and warp image crop / geometry and perspective tools
  - Color grading wheels
  - Image sharpen/denoise support (WASM-based)
  - Lens correction profiles
  - Vignette and grain effects

- **Export Settings**
  - Batch JPG, PNG, and WebP export
  - Limited output resolution clamping

### Technical Features
- Privacy-first architecture with no cloud dependencies
- GPU-accelerated rendering using WebGL2
- IndexedDB for persistent storage
- File System Access API integration
- Multi-window support with BroadcastChannel synchronization
- Zustand state management
- React 19 with TypeScript
- TailwindCSS styling
