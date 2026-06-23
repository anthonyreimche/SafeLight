# Changelog

All notable changes to Safelight are documented in this file.

## [Unreleased]

### Planned
- Red eye correction
- B&W and HDR image support
- HDR / focus stacking and photo merge
- Batch editing / sync edits
- AI masking via ONNX.js (Select Subject, Sky)
- Lightroom catalog import (sql.js)
- Mobile-responsive viewing
- Camera profile / base tuning controls
- Stage-by-stage migration of the develop shader to extension-contributed processing stages

## [2.0.0] - 2026-06

The orchestrator release. The core became a **blind orchestrator**: it exposes contribution points and extensions fill them, with every stock panel and tool now a pre-installed extension registered through the same public API external plugins use.

### Architecture
- Rendering moved into a **Web Worker on an `OffscreenCanvas`** (`render-worker` + `RenderBridge`); no render-path code touches the DOM. Added a budget-bounded GPU source cache for instant photo switching.
- Greatly expanded the extension API beyond panels/themes/layouts/slider icons/settings to include: render pipelines (display transforms), GPU processing stages (forward path), keyboard shortcuts, export processors, filename templates, lens profiles, catalog lifecycle hooks, preset importers, grid filters, library sorts, and named UI slots — plus `preferences`, `navigation`, `keybindings`, `pipelines`, and `develop` (overlay + off-screen capture) API objects.
- Installable extensions now live at the repo-root `extensions/` folder, are built with rolldown, and install into `<userData>/plugins/` served under the cross-origin-isolated `app://` origin.
- Extensions store rebuilt as a GitHub-backed app store (master/detail, READMEs, categories, update checks).

### Develop
- **Upright** perspective correction (Auto / Level / Vertical / Full / Guided, with on-canvas guide lines).
- **Mask components** model: each mask combines radial / linear / brush / luminance-range / color-range components with add / subtract / intersect, plus opt-in per-mask sub-panels (white balance, HSL, tone curve, detail).
- **Global** color-grading wheel alongside shadows / midtones / highlights; white-balance and HSL eyedroppers; on-canvas clipping indicators.

### Library & Export
- Keyword tagging and a dedicated Metadata panel; sixth **purple** color label.
- Export gained output color-space conversion with embedded ICC profiles (sRGB / Display P3 / Adobe RGB / ProPhoto), output sharpening, folder delivery, filename templates, and export-processor extensions.

### Bundled extensions
- **Advanced Library Sort** — sort by camera / lens / focal length / ISO, a live search bar, and saved smart searches.
- **Image Comparison** — hold-to-preview and draggable before/after split in Develop.
- **XMP Tools** — XMP sidecar read/write and Lightroom preset import via catalog hooks.

### Platform
- Built-in Lensfun-derived lens-correction database with EXIF matching.
- Linux packaging across deb / rpm / pacman / AppImage / Flatpak; macOS universal `.dmg`; in-app update checker with patch/minor channels.
- Stack: React 19, TypeScript 6, Vite 8, TailwindCSS 4, Zustand 5, dockview 6, Electron 42.

## [1.0.4] - 2026-06-14

### Changed
- Reworked the Masking panel and the mask/heal workflow for clearer per-mask controls
- Faster application startup

### Fixed
- Re-importing a folder no longer duplicates or mis-keys existing photos

## [1.0.3] - 2026-06-13

### Fixed
- Black-image rendering issue on certain RAW files
- Folder support / project scanning fixes

## [1.0.2] - 2026-06-13

### Fixed
- Assorted stability and rendering bug fixes

## [1.0.1] - 2026-06-12

### Added
- `build-scripts/` folder with one-click builds for every distribution target: Windows NSIS installer, Linux `.deb`, `.rpm`, `.pacman` (Arch/Manjaro), Flatpak, and AppImage (built via WSL2 on Windows), and a macOS `.dmg` script (run on a Mac)
- Linux packaging config (`build.linux`) in package.json

### Changed
- Improved Library browsing and Export
- Forward-compatibility groundwork for the extension API
- `build-electron.bat` renamed and moved to `build-scripts/build-electron-windows-exe.bat`; it now prunes `release/` to the single signed installer file
- Code-signing certificate subject changed to `CN=Safelight`

## [1.0.0] - 2026-06-11

First stable release.

### Projects & Library
- Project-based catalogs: open any folder; ratings, flags, and edit histories persist in `.safelight/` inside it (portable, originals untouched)
- Catalog reconciliation against the disk on every open; last project remembered
- Folder tree, grid/list views with adjustable thumbnails, sorting
- Lightroom-style culling: ratings 1–5, color labels 6–9, pick/reject/unflag, rotate, filters by rating/flag/label
- EXIF metadata Info panel

### RAW
- Full-resolution RAW decoding via libraw-wasm plus an in-house linear-float decoder for uncompressed CFA/DNG
- 19 RAW formats (NEF, CR2, CR3, ARW, DNG, ORF, RAF, PEF, SRW, RW2, IIQ, 3FR, NRW, KDC, MOS, MRW, ERF, SR2, X3F) with embedded-preview fallback
- Decoded-RAW preview cache and background pre-decoding for instant Develop opens

### Develop
- Non-destructive editing with labeled undo/redo history and reset
- White balance, Basic panel (exposure, contrast, highlights, shadows, whites, blacks, texture, clarity, dehaze, vibrance, saturation)
- Point tone curves (RGB + per-channel), 8-band HSL mixer, color grading wheels (shadows/midtones/highlights + luma)
- Detail: capture sharpening (amount, radius, detail, masking), luminance and color noise reduction
- Lens correction (distortion, fringing, defringe, vignetting); effects (post-crop vignette, film grain)
- Crop & straighten with guide overlays, aspect lock, Ctrl+drag leveling, constrain-to-image; transform (perspective, aspect, scale, offset)
- Local adjustments: radial, linear, and brush masks (up to 8) with per-mask tone/color/clarity/sharpness
- Heal and clone retouching (up to 16 spots) with size, feather, opacity, and content-aware source selection
- Presets in an open JSON format (`safelight-preset` v1) with import/export
- 1:1 loupe zoom/pan; Shift fine-adjust and double-click reset on all sliders

### Export
- Batch JPEG/PNG/WebP export through the same GPU pipeline as editing
- Quality and long-edge controls; single-ZIP or per-file delivery
- Metadata-free output

### Workspace & Customization
- Dockview-based workspace: dock, tab, minimize, or float every panel; per-module persisted layouts; named layouts via the Layout menu
- Detachable Library/Develop windows with synchronized state for multi-monitor work
- Dark and light themes; UI scale and font preferences
- Fully rebindable, module-scoped keyboard shortcuts
- Preferences dialog (Ctrl+,): interface, library, performance, export defaults, shortcuts, extensions

### Extensions
- Everything-is-an-extension architecture: every stock panel is a pre-installed extension that can be disabled and replaced
- Install extensions live from GitHub (`owner/repo`, branch refs, or URL; official topic `safelight-extension`)
- Extension API v1 (`window.safelight`): panels, themes, layouts, slider icons, declarative settings dialogs, persisted per-extension settings, access to the app's React instance, stock components, and state stores

### Desktop App
- Windows desktop app (Electron + NSIS installer) serving the renderer over a cross-origin-isolated `app://` scheme so libraw-wasm runs at full speed on SharedArrayBuffer workers
- Forced high-performance GPU path (D3D11 ANGLE, discrete GPU, no software fallback); background throttling disabled for uninterrupted decodes
- `build-electron.bat` one-step signed installer build

### Technical
- WebGL2 render pipeline with optional 16-bit float textures for high-bit-depth editing
- React 19, TypeScript, Vite 8, TailwindCSS 4, Zustand 5, dockview
- Multi-window sync via BroadcastChannel + storage events
- Fully offline, zero telemetry
