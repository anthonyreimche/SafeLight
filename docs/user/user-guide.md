# User Guide

This guide covers Safelight's two modules — **Library** and **Develop** — plus exporting, the dockable workspace, and customization. Defaults follow familiar, industry-standard conventions wherever one exists.

## Projects

Safelight stores everything inside the folder you edit:

- **Open Folder** (Folders panel, Library) opens a project. The folder is scanned recursively; dot-folders are skipped.
- Catalog data lives in `<project>/.safelight/`: `catalog.json` (photo records and edit histories), `previews/` (grid thumbnails), and `raw/` (a decoded-RAW cache so Develop opens instantly).
- Reopening a project reconciles the catalog against the disk: new files are picked up, deleted files drop out, everything else keeps its ratings and edits.
- Originals are never written to. Deleting `.safelight/` simply discards Safelight's data for that folder.
- The last project is reopened on launch when **Restore last project** is enabled. In the browser, click **Reconnect** in the top bar when permissions expire between sessions.

## Library Module

<img width="3840" height="2067" alt="Library grid view" src="https://github.com/user-attachments/assets/4d9fc0f7-1af9-4040-8684-f927cc7fa757" />
<img width="3840" height="2067" alt="Library with metadata and filters" src="https://github.com/user-attachments/assets/2066274e-aa17-43ce-b67e-46f7234c56aa" />

### Browsing

- **Folders panel** — the project's folder tree; click a folder to scope the grid to it. Folders can be renamed, moved, created, and deleted in place.
- **Grid / List views** — toggle in the toolbar; the grid thumbnail size is adjustable (also in Preferences).
- **Sorting** — by date imported, date created, filename, or rating, ascending or descending. Extensions can add more sort orders (e.g. by camera or lens).
- **Metadata panel** — EXIF for the selected photo: camera, lens, focal length, aperture, shutter speed, ISO, capture date, and GPS if present.
- **Keywords panel** — add and remove keyword tags on the selection, with suggestions from existing keywords.

### Culling

Selection: click to select, **Shift+click** for a range, **Ctrl+click** to toggle. Actions apply to the whole selection. Default keys (all rebindable):

| Action | Key |
|---|---|
| Rating | **1–5**, **0** clears |
| Color label (red/yellow/green/blue) | **6 / 7 / 8 / 9** |
| Pick / Reject / Unflag | **P / X / U** |
| Previous / Next photo | **← / →** |
| Rotate left / right | **Alt+[ / Alt+]** |
| Focus keyword input | **K** |
| Remove from catalog | **Delete** |

Navigation follows the filtered, sorted grid, so it never lands on a hidden photo. (Photos also carry a sixth **purple** color label, available from the Info panel even though it has no default key.)

### Filters

The Filters panel narrows the grid by minimum rating (with a comparison operator), flag status, and color label, with quick "All / Picks / Rejects" scopes. Extensions can add further filters (e.g. a text/EXIF search bar) that combine with the built-in ones; **Clear filters** resets them all.

## Develop Module

Open a photo by double-clicking it in the Library (or press **D** for the Develop module). Editing is non-destructive; every change is recorded in the photo's history.

<img width="3840" height="2067" alt="Develop module" src="https://github.com/user-attachments/assets/960afdee-95d0-498b-9988-6c9b63a285a6" />
<img width="3840" height="2067" alt="Develop with masking" src="https://github.com/user-attachments/assets/ca9f9fbb-6fd7-463d-8e6c-42f47165806e" />
<img width="3840" height="2067" alt="Develop detail and color tools" src="https://github.com/user-attachments/assets/fe9c8403-b46c-4f71-bf99-ed3c9b11104f" />

### Canvas and history

- **Zoom and pan** — loupe-style 1:1 inspection with the zoom controls or scroll/drag (smooth drag, no momentum). Opening zoom (fit or 100%) is configurable.
- **Undo / redo / reset** — undo (**Ctrl+Z**), redo (**Ctrl+Shift+Z** or **Ctrl+Y**), reset all edits (**Ctrl+Shift+R**).
- **Sliders** — hold **Shift** while dragging for fine adjustment (or widen the panel); double-click to reset.
- **Clipping indicators** — toggle shadow/highlight clipping warnings on the canvas.

### Tone and color

- **White Balance** — temperature and tint, with an eyedropper that solves both from a neutral target you click.
- **Basic** — exposure (±5 EV), contrast, highlights, shadows, whites, blacks, texture, clarity, dehaze, vibrance, saturation, plus Auto Tone.
- **Tone Curve** — point curves for the RGB master and individual red, green, and blue channels. Click to add a point, drag to shape, double-click a point to remove/reset.
- **HSL** — hue, saturation, and luminance for 8 bands: red, orange, yellow, green, aqua, blue, purple, magenta. A picker lets you click the image to adjust the band under the cursor.
- **Color Grading** — shadows / midtones / highlights / global color wheels with per-wheel luma and shadow/highlight range. Drag to set hue and saturation, Shift for precision; double-click resets hue and saturation only (not luma).

### Detail

- **Sharpening** — amount, radius, detail (halo suppression), and edge masking.
- **Noise reduction** — luminance (amount, detail, contrast, plus shadow/highlight balance) and color (amount, detail, smoothness).

### Optics and effects

- **Lens Correction** — Off / Profile / Manual. Profiles come from the built-in Lensfun-derived database (matched from EXIF) and any lens-profile extensions; manual exposes distortion, chromatic aberration, defringe, and vignetting.
- **Effects** — post-crop vignette (amount, midpoint, roundness, feather, highlights) and film grain (amount, size, roughness, color).

### Geometry

- **Crop & Straighten** — drag handles to crop, cycle guide overlays (**O**) and flip them (**Shift+O**), lock an aspect ratio, **Ctrl+drag** to level the horizon, and optionally constrain the crop to the image bounds.
- **Transform** — vertical/horizontal perspective, aspect, scale, offset, and flips.
- **Upright** — automatic perspective correction with modes Off, Auto, Level, Vertical, and Full, plus **Guided**, where you draw reference lines on the image and the solver levels to them.

### Local adjustments

- **Masking** — up to 8 masks per photo. Each mask is built from **components** — radial, linear, brush, luminance-range, or color-range — combined with **add**, **subtract**, or **intersect** (up to 16 components total across all masks). Per-mask adjustments cover exposure, contrast, tone, color, clarity, and sharpness; masks can opt into extra sub-panels (white balance, HSL, tone curve, detail) and be inverted. Brush components support size (**[ / ]**), feather (**Shift+[ / Shift+]**), and an erase mode.
- **Heal / Clone** — up to 16 retouch spots (circle or brush; up to 4 brush-shaped). Heal blends with surroundings via content-aware source selection; clone copies a source area exactly. Each spot has size, feather, and opacity, toggles between heal and clone, and its source can be repositioned.

### Presets

The Presets panel saves the current edit as a named preset and applies presets to other photos. Presets are additive — they carry only the adjustments they set — in an open, human-readable JSON format (`safelight-preset`, version 1) that you can export and import. Hovering a preset previews it without touching history. Extensions can teach the importer to read other apps' preset files (e.g. Lightroom `.xmp` via the XMP Tools extension).

## Exporting

Open the **Export** panel (docked in Library by default, or via **View ▸ Export** from either module):

- **Format** — JPEG, PNG, WebP, or TIFF, with a quality slider for JPEG/WebP and an 8- or 16-bit depth choice for TIFF (16-bit needs float render targets and falls back to 8-bit when unavailable).
- **Color space** — sRGB, Display P3, Adobe RGB, or ProPhoto RGB; the matching ICC profile is embedded so other apps read the pixels correctly.
- **Size** — limit the long edge or keep the original size, with optional output sharpening (amount and radius).
- **Delivery** — multiple photos as a single ZIP, separate files, or into a chosen folder.
- **Filename** — choose a filename template; extensions can add templates.
- **Processors** — registered export extensions (e.g. watermarking) appear as collapsible sections and run after encoding.

Exports render through the same worker WebGL pipeline as the Develop view, so output matches what you see. Because output goes through a canvas, exported files carry **no EXIF or location metadata** — fitting for a privacy-first tool. Defaults are configurable in Preferences, and named export presets save full recipes.

## Workspace

<img width="3837" height="2065" alt="Dockable workspace" src="https://github.com/user-attachments/assets/811242de-0973-4378-bfb5-7add1433595e" />
<img width="3840" height="2067" alt="Floating and tabbed panels" src="https://github.com/user-attachments/assets/b5808eae-aa0b-4f2a-b1f4-08fd5c45e62b" />
<img width="3840" height="2067" alt="Multi-window layout" src="https://github.com/user-attachments/assets/4b4fb272-2835-4c1c-9933-20e5e4408dc8" />

### Docking

Safelight uses collapsible edge rails with Photoshop-style docking. Every panel can be dragged to either rail, tabbed with other panels, resized, minimized, or floated as its own window. The **View** menu toggles any registered panel; the **Layout** menu switches named layouts (the built-in **Classic** layout restores the default arrangement). Layouts persist per module.

### Multi-window

Library and Develop can each be detached into a separate OS window from the top bar — ideal for a grid on one monitor and a 1:1 view on another. Selection, edits, and settings stay synchronized across windows.

### Preferences (Ctrl+,)

Preferences is organized into sections: **Interface**, **Library**, **Rendering**, **Performance**, **Export**, **Shortcuts**, **Extensions**, **Updates**, and **About**.

- **Interface** — UI scale (0.8–1.3), reduce motion, custom UI font.
- **Library** — default grid size, sort field/direction, confirm-before-remove, thumbnail source and resolution (320/640/960 px), preview persistence.
- **Rendering** — the **Display transform** (tone mapper); the built-in transform plus any extension-provided transforms appear here and apply everywhere the pipeline renders.
- **Performance** — RAW preview cache on/off, prefetch, and size (2048/3072/4096 px); Develop render cap (4096/6144/8192 px); GPU source-cache budget; neighbor prefetch; 16-bit GPU textures; live histogram; opening zoom.
- **Export** — default format, quality, long edge, color space, ZIP bundling, and saved export presets.
- **Shortcuts** — rebind every action; single-letter shortcuts (G/D/F…) can be disabled, while Tab and Ctrl-combos always work.
- **Extensions** — each installed extension's settings, the GitHub topic used to discover official extensions, and update preferences. This includes the built-in **Accessibility** extension (below).
- **Updates** — check for updates and choose the patch/minor channel.

The built-in **Accessibility** extension (under **Extensions**) adds opt-in accommodations that layer on top of the active theme without changing it: match the OS's accessibility settings, **High contrast** (a maximal-contrast WCAG-AA palette), interface scale up to 200%, larger text and controls, Title-Case headings, a strong keyboard-focus indicator, reduced transparency and motion, **colour-vision simulation** (protanopia / deuteranopia / tritanopia), **keyboard canvas editing** (drive the tone curve and masks with the arrow keys plus a numeric editor), and per-colour overrides. Disable the extension entirely if you don't need any of it.

### Keyboard shortcuts (defaults)

| Action | Key | Scope |
|---|---|---|
| Go to Library / Develop | **G / D** | General |
| Hide/show all panels | **Tab** | General |
| Fullscreen | **F** | General |
| Preferences | **Ctrl+,** | General |
| Extensions | **Ctrl+Shift+X** | General |
| Undo / Redo | **Ctrl+Z / Ctrl+Shift+Z** (or **Ctrl+Y**) | Develop |
| Reset all edits | **Ctrl+Shift+R** | Develop |
| Brush smaller / larger | **[ / ]** | Develop |
| Brush feather less / more | **Shift+[ / Shift+]** | Develop |
| Delete mask component | **Delete / Backspace** | Develop |
| Cycle / flip crop guide | **O / Shift+O** | Develop |
| Rate, label, flag, navigate, rotate, remove, keyword | see [Culling](#culling) | Library |

Develop and Library shortcuts only fire in their module, so the same key can serve both (e.g. **[ ]** resizes the brush in Develop while **Alt+[ ]** rotates in Library). Extensions can add their own rebindable shortcuts.

## Themes and Extensions

- **Themes** — switch between Safelight Dark, Safelight Light, and any extension-provided theme from the View menu.
- **Extensions** — every stock panel is itself a pre-installed extension that can be disabled and replaced by a community version. Install new ones from GitHub via **View ▸ Extensions** (or **Ctrl+Shift+X**). Safelight ships with example extensions (Advanced Library Sort, Image Comparison, XMP Tools). See [Using Extensions](using-extensions.md).
