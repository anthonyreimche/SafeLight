# Safelight

**Safelight** is a fast, free, open-source RAW photo editor for Windows, Linux, macOS, and the browser. It pairs professional, GPU-accelerated imaging tools with the customizability of a modern IDE: the core is a *blind orchestrator* and every panel, tool, and display transform is an extension that can be rearranged, replaced, or supplemented by the community.

- **Non-destructive and project-based** — open a folder of photos and edit. Your originals are never touched; ratings, flags, and edit history live in a `.safelight/` directory inside the project folder, so a project is fully portable.
- **Real RAW support** — full-resolution RAW decoding via libraw-wasm plus an in-house linear-float decoder for uncompressed CFA/DNG, covering NEF, CR2/CR3, ARW, DNG, ORF, RAF, RW2, and many more, with automatic fallback to the embedded preview.
- **GPU pipeline** — every adjustment renders through a WebGL2 shader pipeline that runs in a Web Worker on an `OffscreenCanvas`, with optional 16-bit textures for high-bit-depth editing.
- **Privacy-first** — zero cost, zero subscription, fully offline. No telemetry, no cloud, no data collection. Exports carry no EXIF or location metadata.
- **IDE-like workspace** — Photoshop-style docking (drag, tab, minimize, float any panel), named layouts, themes, rebindable keyboard shortcuts, and detachable modules for multi-monitor work.
- **Open extension system** — install extensions straight from GitHub repos to add panels, themes, layouts, display transforms, lens profiles, export processors, Library sorts/filters, catalog hooks, and more; any stock panel can be disabled and replaced by a community version. Ships with example extensions (Advanced Library Sort, Image Comparison, XMP Tools).

## Features

### Library
<img width="3840" height="2067" alt="image" src="https://github.com/user-attachments/assets/4d9fc0f7-1af9-4040-8684-f927cc7fa757" />
<img width="3840" height="2067" alt="image" src="https://github.com/user-attachments/assets/2066274e-aa17-43ce-b67e-46f7234c56aa" />

- Project folder tree with per-folder browsing
- Grid and list views with adjustable thumbnail size
- Lightroom-style culling: ratings (1–5), color labels (6–9), pick / reject / unflag (P / X / U)
- Filters by rating, flag, and label; sortable by date, name, or rating
- EXIF metadata and histogram in the Info panel
- Background RAW pre-decoding so Develop opens instantly

### Develop
<img width="3840" height="2067" alt="image" src="https://github.com/user-attachments/assets/960afdee-95d0-498b-9988-6c9b63a285a6" />
<img width="3840" height="2067" alt="image" src="https://github.com/user-attachments/assets/ca9f9fbb-6fd7-463d-8e6c-42f47165806e" />
<img width="3840" height="2067" alt="image" src="https://github.com/user-attachments/assets/fe9c8403-b46c-4f71-bf99-ed3c9b11104f" />

- Full undo/redo history with per-edit labels and reset
- White balance, exposure, contrast, highlights/shadows, whites/blacks, texture, clarity, dehaze, vibrance, saturation
- Point tone curves — RGB master plus individual red/green/blue channels
- HSL mixer for 8 color bands
- Color grading wheels (shadows / midtones / highlights / global with luma)
- Detail panel: capture sharpening (amount, radius, detail, masking) and luminance/color noise reduction
- Lens corrections: profile-based (Lensfun database, matched from EXIF) or manual distortion, fringing, defringe, vignetting
- Effects: post-crop vignette and film grain
- Crop with guide overlays, straighten (Ctrl+drag to level), aspect lock, constrain-to-image
- Transform plus Upright perspective correction (Auto / Level / Vertical / Full / Guided)
- Local adjustments: masks built from radial, linear, brush, luminance-range, and color-range components combined with add/subtract/intersect, with per-mask tone, color, clarity, and optional sub-panels
- Heal and clone spot removal with size, feather, and opacity control
- On-canvas shadow/highlight clipping indicators
- Presets in an open, human-readable JSON format with import/export
- 1:1 loupe zoom and pan; hold Shift on any slider for fine adjustment, double-click to reset

### Export

- Batch JPEG, PNG, WebP, and 8/16-bit TIFF export through the same GPU pipeline used for editing
- Output color space — sRGB, Display P3, Adobe RGB, or ProPhoto RGB, with the matching ICC profile embedded so other apps read the pixels correctly
- Quality, long-edge resizing, and output sharpening controls
- Filename templates and post-encode export processors (e.g. watermarking) via extensions
- Multiple photos as a single ZIP, separate files, or into a chosen folder
- Metadata-free output by design

### Workspace
<img width="3837" height="2065" alt="image" src="https://github.com/user-attachments/assets/811242de-0973-4378-bfb5-7add1433595e" />
<img width="3840" height="2067" alt="image" src="https://github.com/user-attachments/assets/b5808eae-aa0b-4f2a-b1f4-08fd5c45e62b" />
<img width="3840" height="2067" alt="image" src="https://github.com/user-attachments/assets/4b4fb272-2835-4c1c-9933-20e5e4408dc8" />

- Dock, tab, float, or minimize every panel; layouts persist per module
- Detach Library or Develop into its own window for multi-monitor culling
- Dark and light themes, UI scale, and custom fonts
- Every keyboard shortcut is rebindable in Preferences

## Installation

**Windows desktop (recommended):** download the latest `Safelight Setup` installer from the [releases page](../../releases), or build it yourself with `build-scripts\build-electron-windows-exe.bat`. The desktop app enables the fastest RAW decode path and full GPU acceleration.

**Linux:** grab the package for your distro from the [releases page](../../releases) — `.deb` (Debian/Ubuntu), `.rpm` (Fedora/openSUSE), `.pacman` (Arch/Manjaro), Flatpak, or portable AppImage. See [Installation](docs/user/installation.md) for install commands and how to build them yourself from `build-scripts\`.

**macOS:** download the universal `.dmg` (Intel + Apple Silicon) from the [releases page](../../releases), or build it on a Mac with `build-scripts/build-macos-dmg.sh`. See [Installation](docs/user/installation.md#macos-dmg).

**From source:**

```bash
git clone https://github.com/anthonyreimche/SafeLight.git
cd SafeLight
npm install
npm run dev          # browser (Chromium-based recommended)
npm run electron:dev # desktop window
npm run build:electron # Windows installer in release/
```

See [docs/user/installation.md](docs/user/installation.md) for details.

## Roadmap

Because everything in Safelight is an extension, planned work falls into two tracks. **Core** features are critical to a photo workflow and ship built in (as pre-installed extensions you can disable). **Extensions** are advanced or process-heavy tools that ship as separate, optional packages — install them from another repo only if you need them, so the base app stays lean.

### Core (built-in)

**Develop**
- B&W and HDR editing support

**Library and organization**
- Virtual copies — multiple edit versions of one photo without duplicating the file
- Collections and smart collections — virtual groupings independent of folder structure
- Hierarchical keywording (flat keyword tagging already ships)
- IPTC/XMP metadata editing — copyright, caption, creator, rights fields (XMP sidecar read/write already ships via the XMP Tools extension)

**Export and output**
- Input color profile support — assign and convert ICC profiles on import (output-side ICC export already ships)

**Platform**
- Mobile-responsive viewing

### Planned as extensions

**Develop**
- Flat field and dark frame correction — subtract fixed-pattern sensor noise and lens illumination falloff
- Focus mask overlay — highlight in-focus areas in the develop canvas

**Library and organization**
- Photo stacking — collapse burst/similar shots into a single stack
- Duplicate photo detection — find visually similar or hash-identical photos
- Face detection and tagging
- Map module — GPS/geolocation-based photo browsing and tagging

**Export and output**
- Soft proofing — simulate paper or screen output using ICC profiles
- Web gallery / publish services — generate HTML galleries or push to Flickr, SmugMug, etc.

**AI features** (ONNX.js models, downloaded on demand)
- AI masking (Select Subject, Sky)
- AI sky replacement
- AI object removal / content-aware fill
- AI portrait enhancement — skin, eyes, and portrait retouching
- HDR / focus stacking and photo merge

**Platform and integration**
- Lightroom catalog import (sql.js)
- Tethered shooting — live capture from camera via USB/WiFi

## Documentation

Full docs are in [`docs/`](docs/README.md), split into two tracks:

**📖 [User Guide](docs/user/README.md)** — using Safelight
- [Getting Started](docs/user/getting-started.md) — first project and first edit
- [Installation](docs/user/installation.md) — desktop app and source builds
- [User Guide](docs/user/user-guide.md) — complete feature documentation
- [Using Extensions](docs/user/using-extensions.md) — install and manage add-ons
- [FAQ](docs/user/faq.md) · [Changelog](docs/user/changelog.md)

**🛠 [Developer Docs](docs/dev/README.md)** — building for Safelight
- [Architecture](docs/dev/architecture.md) — technical overview
- [Building Extensions](docs/dev/extensions/README.md) — anatomy, contributions, debugging, publishing
- [API Reference](docs/dev/api/README.md) — the extension API surface
- [Contributing](docs/dev/contributing.md) — development guidelines

## Contributing

Safelight is community-driven. Bug reports, code, extensions, documentation, and feedback are all welcome — see [docs/dev/contributing.md](docs/dev/contributing.md).

## License

GPL v3 — see [LICENSE](LICENSE).
