# Safelight

**Safelight 1.0** is a fast, free, open-source RAW photo editor for Windows and the browser. It pairs professional, GPU-accelerated imaging tools with the customizability of a modern IDE: every panel is an extension that can be rearranged, replaced, or supplemented by the community.

- **Non-destructive and project-based** — open a folder of photos and edit. Your originals are never touched; ratings, flags, and edit history live in a `.safelight/` directory inside the project folder, so a project is fully portable.
- **Real RAW support** — full-resolution RAW decoding via libraw-wasm plus an in-house linear-float decoder for uncompressed CFA/DNG, covering NEF, CR2/CR3, ARW, DNG, ORF, RAF, RW2, and many more, with automatic fallback to the embedded preview.
- **GPU pipeline** — every adjustment renders through a WebGL2 shader pipeline with optional 16-bit textures for high-bit-depth editing.
- **Privacy-first** — zero cost, zero subscription, fully offline. No telemetry, no cloud, no data collection. Exports carry no EXIF or location metadata.
- **IDE-like workspace** — Photoshop-style docking (drag, tab, minimize, float any panel), named layouts, themes, rebindable keyboard shortcuts, and detachable modules for multi-monitor work.
- **Open extension system** — install extensions straight from GitHub repos to add panels, themes, layouts, and more; any stock panel can be disabled and replaced by a community version.

## Features

### Library
<img width="1919" height="1027" alt="image" src="https://github.com/user-attachments/assets/ecdf475d-7273-4f77-87cb-1baca63bf765" />
<img width="1919" height="1027" alt="image" src="https://github.com/user-attachments/assets/f7caffb5-5708-45d2-b1c1-0c972d94d68b" />

- Project folder tree with per-folder browsing
- Grid and list views with adjustable thumbnail size
- Lightroom-style culling: ratings (1–5), color labels (6–9), pick / reject / unflag (P / X / U)
- Filters by rating, flag, and label; sortable by date, name, or rating
- EXIF metadata and histogram in the Info panel
- Background RAW pre-decoding so Develop opens instantly

### Develop
<img width="1919" height="1027" alt="image" src="https://github.com/user-attachments/assets/410708b2-44d5-4891-93b0-2fdaa95e4a30" />
<img width="1919" height="1027" alt="image" src="https://github.com/user-attachments/assets/f5f36602-1076-446c-9098-1f5d24f881ad" />

- Full undo/redo history with per-edit labels and reset
- White balance, exposure, contrast, highlights/shadows, whites/blacks, texture, clarity, dehaze, vibrance, saturation
- Point tone curves — RGB master plus individual red/green/blue channels
- HSL mixer for 8 color bands
- Color grading wheels (shadows / midtones / highlights with luma)
- Detail panel: capture sharpening (amount, radius, detail, masking) and luminance/color noise reduction
- Lens corrections: distortion, fringing, defringe, vignetting
- Effects: post-crop vignette and film grain
- Crop with guide overlays, straighten (Ctrl+drag to level), aspect lock, constrain-to-image
- Transform: perspective, aspect, scale, and offset geometry corrections
- Local adjustments: radial, linear, and brush masks with per-mask exposure, contrast, tone, color, and clarity
- Heal and clone spot removal with size, feather, and opacity control
- Presets in an open, human-readable JSON format with import/export
- 1:1 loupe zoom and pan; hold Shift on any slider for fine adjustment, double-click to reset

### Export
<img width="1919" height="1027" alt="image" src="https://github.com/user-attachments/assets/d54e132b-fa58-416b-b599-899329cf882e" />

- Batch JPEG, PNG, and WebP export through the same GPU pipeline used for editing
- Quality and long-edge resizing controls
- Multiple photos as a single ZIP or separate files
- Metadata-free output by design

### Workspace
<img width="3829" height="1025" alt="image" src="https://github.com/user-attachments/assets/e9ee2f31-108b-4e36-b318-a559d42bcc85" />

- Dock, tab, float, or minimize every panel; layouts persist per module
- Detach Library or Develop into its own window for multi-monitor culling
- Dark and light themes, UI scale, and custom fonts
- Every keyboard shortcut is rebindable in Preferences

## Installation

**Windows desktop (recommended):** download the latest `Safelight Setup` installer from the [releases page](../../releases), or build it yourself with `build-electron.bat`. The desktop app enables the fastest RAW decode path and full GPU acceleration.

**From source:**

```bash
git clone https://github.com/anthonyreimche/SafeLight.git
cd SafeLight
npm install
npm run dev          # browser (Chromium-based recommended)
npm run electron:dev # desktop window
npm run build:electron # Windows installer in release/
```

See [docs/installation.md](docs/installation.md) for details.

## Roadmap

- Red eye correction
- Image compare view
- B&W and HDR editing support
- HDR / focus stacking and photo merge
- Batch editing
- AI masking via ONNX.js (Select Subject, Sky)
- Lightroom catalog import (sql.js)
- Mobile-responsive viewing
- Extension marketplace and scaffolding tools

## Documentation

- [Getting Started](docs/getting-started.md) — first project and first edit
- [Installation](docs/installation.md) — desktop app and source builds
- [User Guide](docs/user-guide.md) — complete feature documentation
- [Extensions](docs/extensions.md) — install and build extensions
- [Architecture](docs/architecture.md) — technical overview
- [API Documentation](docs/api-documentation.md) — extension API reference
- [FAQ](docs/faq.md) — common questions
- [Contributing](docs/contributing.md) — development guidelines
- [Changelog](docs/changelog.md) — release history

## Contributing

Safelight is community-driven. Bug reports, code, extensions, documentation, and feedback are all welcome — see [docs/contributing.md](docs/contributing.md).

## License

MIT — see [LICENSE](LICENSE).
