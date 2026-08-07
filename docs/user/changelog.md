# Changelog

All notable changes to Safelight are documented in this file.

## [Unreleased]

### Added
- **Delete from disk** — the Library grid's context menu can move selected photos' files to the OS Recycle Bin / Trash (recoverable — never a hard delete) and remove the photos from the catalog. A photo stays in the catalog if its file couldn't be trashed (e.g. a write-protected card), with the reason reported. Virtual copies are skipped, since a copy shares its master's file. The action is also available as a rebindable shortcut that ships unbound.
- **Thumbnail size from the keyboard** — **- / =** shrink and grow the Library grid thumbnails one slider stop per press (rebindable, numpad **+** works too).
- **More app shortcuts** — **Ctrl+O** opens a folder, **F2** renames the active photo, and **Ctrl+R** shows it in the OS file manager. All rebindable in Preferences ▸ Shortcuts.

### Changed
- **The Library remembers your view** — the sort order chosen in the toolbar (imported, captured, name, rating, direction — including extension-contributed sorts) and the thumbnail size now persist across restarts. Preferences ▸ Library ▸ Default sort now applies immediately; the Preferences defaults seed fresh profiles.
- **Faster imports and folder opens** — embedded camera previews are decoded once instead of twice per RAW; the embedded-JPEG search hops between markers natively instead of walking every byte; sibling folders are listed concurrently; the per-file sidecar probe only runs for sidecars that exist; catalog progress saves re-serialize less often during a long import; and cached grid previews load three at a time when reopening a catalog.

### Planned
- B&W and HDR image support
- HDR / focus stacking and photo merge
- AI masking via ONNX.js (Select Subject, Sky)
- Lightroom catalog import (sql.js)
- Mobile-responsive viewing
- Camera profile / base tuning controls
- Stage-by-stage migration of the develop shader to extension-contributed processing stages

## [2.4.4] - 2026-06-29

### Added
- **Read-only sources (memory cards, immutable systems)** — Safelight can now open folders it can't write to, such as a mounted SD card or a read-only mount on systems like Fedora Silverblue. When the photo folder can't host its `.safelight` catalog, the catalog, previews, and cache are redirected to a writeable location automatically and a non-blocking banner shows where they went; when the folder later becomes writeable, edits made during the read-only session are folded back into the in-folder catalog.
- **Catalog storage preferences** — Preferences ▸ Previews now lets you keep each project's `.safelight` catalog **in the photo folder** (default) or in a **separate folder** (to keep photo folders clean), choose where separate catalogs live, and browse and delete every catalog stored outside its photo folder to reclaim disk space.
- **Sliders jump to cursor** — an optional toggle (Preferences ▸ Interface): click anywhere on a slider track to snap the value to that point and drag from there, instead of grabbing the current value.
- **Display-transform quick switch** — a status-bar control next to Assess in Develop switches the active display transform when an extension provides one (for example a film-simulation or denoise look) without opening Preferences.
- **Black and white surround endpoints** — the neutral canvas surround adds pure black and white beyond the five-shade grey ladder; middle grey stays the default and the colour-assessment standard.
- **Extension network permissions** — extensions can declare the network origins they need in their manifest; the store shows them, and requests to undeclared origins are blocked.
- **Full-resolution rendering for extensions** — extensions such as web-gallery publishers and batch / sync-edit tools can render any library photo through the full develop pipeline at export resolution, not just from low-resolution previews.

### Changed
- **Back to pure GPLv3** — the dual-licensing scheme and Contributor License Agreement introduced in 2.4.1 are removed. Safelight is free software under the GNU GPL v3 with the standard inbound = outbound model: you license your contribution under GPL v3 and keep your copyright, with no agreement to sign. Added `THIRD-PARTY-NOTICES.md`, `TRADEMARKS.md`, `PRIVACY.md`, `EXTENSIONS.md`, and a security policy, all linked from Preferences ▸ About.
- **Clearer extension trust states** — install prompts and detail pages now distinguish *verified* (reviewed at a point in time), *stale* (verified, but the installed version is newer than the reviewed one, shown as an amber ✓*), and *unverified*, and spell out that verification is not a guarantee of safety — extensions run with full access to your photos, metadata, and files.

### Fixed
- Read-only source folders (mounted memory cards, immutable Linux systems) no longer fail silently when opened.

## [2.4.3] - 2026-06-29

### Added
- **Rename and re-import in the Library** — rename a photo's file on disk from the grid context menu (the original extension is preserved), and **Re-import** selected photos to rebuild thumbnails and re-read EXIF/file metadata while keeping ratings, labels, keywords, and edits.
- **Show in folder / Open folder** (desktop) — reveal a photo in the OS file manager from the Library, and jump straight to the export destination after a folder export.
- **HSL "All" layout** — show every HSL band stacked at once (in addition to the one-band-at-a-time tabs), with a compact band selector while the on-image target picker is active.
- **Coloured slider tracks** — sliders can draw a hue / lightness gradient behind the track (used by the HSL mixer).

### Changed
- **Lens correction is now an extension** — distortion, chromatic-aberration, defringe, and vignetting correction, along with the bundled Lensfun profile database, move out of the core app into a standalone Lens Correction extension, keeping the base app lean. Install it from its repository if you need it.
- **More mask adjustments** — local-adjustment masks gain whites, blacks, vibrance, texture, and dehaze.
- **Smarter preset saving** — the save dialog separates global adjustments (offered when changed) from per-image edits like crop and retouch (hidden under "Show all," since they don't transfer meaningfully to other photos), and presets can include extension-stage adjustments.
- **Hold-to-preview on more panels** — the per-panel preview-off eye is now momentary (press and hold) and works on Crop & Straighten and Transform, hiding their on-canvas overlays while held.

### Fixed
- **Accurate crop dimming** — the crop overlay dims only the image area, not the canvas surround, so straightened photos no longer show a dark frame in colour-assessment (Assess) mode.
- **Colour picker when zoomed** — eyedroppers sample the correct pixel when the canvas is zoomed or panned into a region.
- **HSL target picker accuracy** — the on-image picker uses the same band weights as the shader, so dragging matches the result.
- Keyboard input on a focused slider no longer creates spurious undo steps when a global shortcut (Ctrl+Z / Ctrl+Y) is released over it.

## [2.4.2] - 2026-06-27

### Fixed
- **macOS "Safelight is damaged" guidance** — the app isn't notarized by Apple, so macOS can block the unsigned download with a misleading "damaged" message. Installation and the FAQ now document the one-time `xattr -cr /Applications/Safelight.app` fix (with a code-signing fallback for macOS Sequoia and later) and explain why an un-notarized build is shipped.

## [2.4.1] - 2026-06-27

### Added
- **Rebuilt noise reduction** — the Detail panel's noise controls expand into separate luminance and colour sliders (amount and detail, plus contrast, shadow / highlight balance, and chroma smoothness) driven by a new multi-pass, edge-aware wavelet denoiser. It only runs when an amount is above zero, so there's no cost when unused, and Alt/Ctrl-drag previews the luminance and colour passes on the canvas.
- **Per-panel preview-off** — each adjustment panel header gains an eye toggle that temporarily renders the photo as if that panel's adjustments weren't there, for a quick before/after of a single panel, without touching your edit history.
- **Clearer Library labels** — grid thumbnails and list rows gain colour-label bars and a faint cell tint, keyword-count badges, and repositioned pick / reject flags for easier at-a-glance culling.
- **Web-gallery publishing support** — the desktop app now lets extensions reach gallery backends (Cloudflare Workers and configurable origins), enabling the Web Tools extension to publish proofing galleries.

### Changed
- **Dual licensing and sponsorware funding** — Safelight gained a commercial license alongside GPL v3 and a Contributor License Agreement for core contributions, under a sponsorware funding model (the app stays free; features are funded through sponsorship). *(Reverted in 2.4.4 — see above.)*
- **Refined Clarity and masked Sharpness** — Clarity uses an edge-aware blur to avoid halos on hard edges, and mask Sharpness blends fine and broad detail to tame overshoot at bright edges.

### Fixed
- A failed processing stage (including the new denoiser) is now disabled for the session instead of stalling the Develop view.
- When a community extension provides its own noise reduction, the built-in denoiser steps aside instead of stacking with it.

## [2.4.0] - 2026-06-25

### Added
- **Accessibility tools** — a new built-in **Accessibility** extension (Preferences ▸ Extensions; disable it if you don't need it) layers opt-in accommodations *on top of* any theme without altering the theme itself:
  - **Match system accessibility settings** — also honour the operating system's reduced-motion, increased-contrast and reduced-transparency preferences (Windows High Contrast mode is always respected). The options below add to these; they never switch a system preference back off.
  - **High contrast** — override the active theme with a maximal-contrast WCAG-AA palette (the Dark and Neutral themes switch to a high-contrast dark palette, the Light theme to a high-contrast light one). Your default theme is untouched while this is off.
  - **Interface scale** up to 200%, **Larger text** (enlarges the smallest labels and drops their all-caps styling), and **Larger controls** (≥24px hit targets).
  - **Lowercase headings** (Title Case instead of UPPERCASE), **Strong focus indicator**, **Reduce transparency**, and **Reduce motion**.
  - **Colour-vision simulation** — preview the whole window through protanopia / deuteranopia / tritanopia filters to check how the interface and your photo read to colour-blind viewers (turn off for colour-critical editing).
  - **Keyboard canvas editing** — drive direct-manipulation tools with the keyboard: focus a tool such as the tone curve or a mask and use the arrow keys, with a numeric point/geometry editor. **Editing highlights** toggles the on-canvas selection/focus ring.
  - **Colour overrides** — fine-tune individual interface colours on top of the active theme.

### Fixed
- **Accurate Develop histogram** — the live histogram is now computed in the render worker from the float (RGBA16F) render pipeline instead of being read back from the 8-bit display canvas, so it no longer shows comb/banding gaps after a tonal stretch (exposure, white balance, or curve adjustment).
- **Black exports from some extensions** — exports now seed the export renderer with the active display pipeline and the live stage-texture set (film LUTs, spectral tables, …), so extension GPU processing stages (e.g. custom film simulations or denoise) bake into the output correctly instead of rendering pure black.

## [2.3.1] - 2026-06-24

### Added
- **Copy/paste develop settings in the Library** — right-click a photo and choose **Copy settings…** to pick adjustments from the same checklist used for presets (including extension stages); **Paste settings** then merges the chosen adjustments onto every selected photo, undoably, without opening Develop.

### Changed
- **Faster Extensions store thumbnails** — browse cards now resolve their image in the main process (manifest icon → custom social preview → owner avatar), batched with per-fetch timeouts and pushed progressively, so a single slow repo no longer stalls the whole grid.

### Fixed
- **Removed photos stay removed** — a photo removed from the catalog is no longer re-imported on the next folder open. Its file is tombstoned (the original on disk is untouched); the tombstone clears automatically once the file leaves the folder.
- **Embedded-preview orientation** — RAW thumbnails from cameras that store the embedded preview already upright no longer double-rotate; orientation is disambiguated against the master RAW's EXIF using the preview's aspect.

## [2.3.0] - 2026-06-23

### Added
- Geometry/warp tool extension APIs — a `geometry`-phase processing stage that warps source coordinates, plus per-photo opaque sidecar storage (`api.develop.putPhotoData` / `getPhotoData`) for large tool payloads such as warp displacement fields.
- Extension trust registry — a GitHub-backed verified/banned list with a sealed privileged bridge so extensions can't reach raw filesystem or the update installer.

### Changed
- More usable Library grid selection.

### Fixed
- Heal tool and develop-canvas render fixes.

## [2.2.0] - 2026-06-21

### Added
- **TIFF export** — 8-bit and 16-bit TIFF output through the same GPU pipeline as editing, with the selected color space's ICC profile embedded. 16-bit uses float render targets and falls back to 8-bit when unavailable.

## [2.1.1] - 2026-06-21

### Fixed
- Assorted bug fixes.

## [2.1.0] - 2026-06-21

### Added
- Expanded the extension API surface and filled in previously missing extension UI.
- Network connectivity handling for the Extensions store, plus documentation updates.

### Fixed
- Extension updater fixes.

## [2.0.1] - 2026-06-20

### Fixed
- Extension store thumbnails failing to display.

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
- Full culling workflow: ratings 1–5, color labels 6–9, pick/reject/unflag, rotate, filters by rating/flag/label
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
- Camera EXIF, GPS, and XMP stripped from output (wide-gamut exports embed a standard ICC color profile)

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
