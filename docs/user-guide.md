# User Guide

This guide covers Safelight 1.0's two modules — **Library** and **Develop** — plus exporting, the dockable workspace, and customization. Defaults follow Lightroom conventions wherever one exists.

## Projects

Safelight stores everything inside the folder you edit:

- **Open Folder** (Folders panel, Library) opens a project. The folder is scanned recursively; dot-folders are skipped.
- Catalog data lives in `<project>/.safelight/`: `catalog.json` (photo records and edit histories), `previews/` (grid thumbnails), and `raw/` (a decoded-RAW cache so Develop opens instantly).
- Reopening a project reconciles the catalog against the disk: new files are picked up, deleted files drop out, everything else keeps its ratings and edits.
- Originals are never written to. Deleting `.safelight/` simply discards Safelight's data for that folder.
- The last project is remembered and reopened on launch. In the browser, click **Reconnect** in the top bar when permissions expire between sessions.

## Library Module

### Browsing

- **Folders panel** — the project's folder tree; click a folder to scope the grid to it.
- **Grid / List views** — toggle in the toolbar; the grid thumbnail size is adjustable (also in Preferences).
- **Sorting** — by date imported, date created, filename, or rating, ascending or descending.
- **Info panel** — EXIF metadata for the selected photo: camera, lens, focal length, aperture, shutter speed, ISO, capture date.

### Culling

Selection: click to select, **Shift+click** for a range, **Ctrl+click** to toggle. Actions apply to the whole selection. Default keys (all rebindable):

| Action | Key |
|---|---|
| Rating | **1–5**, **0** clears |
| Color label (red/yellow/green/blue) | **6 / 7 / 8 / 9** |
| Pick / Reject / Unflag | **P / X / U** |
| Previous / Next photo | **← / →** |
| Rotate left / right | **[ / ]** |
| Remove from catalog | **Delete** |

Navigation follows the filtered, sorted grid, so it never lands on a hidden photo.

### Filters

The Filters panel narrows the grid by minimum rating, flag status, and color label.

## Develop Module

Open a photo by double-clicking it in the Library (or press **D** for the Develop module). Editing is non-destructive; every change is recorded in the photo's history.

### Canvas and history

- **Zoom and pan** — loupe-style 1:1 inspection with the zoom controls or scroll/drag.
- **Edit panel** — undo (**Ctrl+Z**), redo (**Ctrl+Shift+Z** or **Ctrl+Y**), and reset all edits (**Ctrl+Shift+R**).
- **Sliders** — hold **Shift** while dragging for fine adjustment (or widen the panel); double-click to reset.

### Tone and color

- **White Balance** — temperature and tint.
- **Basic** — exposure (±5 EV), contrast, highlights, shadows, whites, blacks, texture, clarity, dehaze, vibrance, saturation.
- **Tone Curve** — point curves for the RGB master and individual red, green, and blue channels. Click to add a point, drag to shape, double-click a point to remove/reset.
- **HSL** — hue, saturation, and luminance for 8 bands: red, orange, yellow, green, aqua, blue, purple, magenta.
- **Color Grading** — shadows / midtones / highlights color wheels with per-wheel luma. Drag to set hue and saturation, Shift for precision, double-click to reset.

### Detail

- **Sharpening** — amount, radius, detail (halo suppression), and edge masking.
- **Noise reduction** — luminance (amount, detail, contrast) and color (amount, detail, smoothness).

### Optics and effects

- **Lens Correction** — distortion, fringing, defringe, and vignetting correction.
- **Effects** — post-crop vignette (amount, midpoint, roundness, feather, highlights) and film grain (amount, size, roughness).

### Geometry

- **Crop & Straighten** — drag handles to crop, choose guide overlays, lock an aspect ratio, **Ctrl+drag** to level the horizon, and optionally constrain the crop to the image bounds.
- **Transform** — vertical/horizontal perspective, aspect, scale, and offset.

### Local adjustments

- **Masking** — up to 8 masks per photo, each **radial**, **linear**, or **brush**. Per-mask adjustments: exposure, contrast, highlights, shadows, saturation, temperature, tint, clarity, and sharpness. Brush masks support size (**[ / ]**), feather, and an erase mode; radial masks have edge feather; masks can be inverted.
- **Heal / Clone** — up to 16 retouch spots. Heal blends with surroundings (content-aware source selection); clone copies a source area exactly. Each spot has size, feather, and opacity, can be toggled between heal and clone, and its source can be repositioned.

### Presets

The Presets panel saves the current edit as a named preset and applies presets to other photos. Presets use an open, human-readable JSON format (`safelight-preset`, version 1) and can be exported to and imported from disk — share them freely.

## Exporting

Open the **Export** panel (docked in Library by default, or via **View ▸ Export** from either module):

- **Format** — JPEG, PNG, or WebP, with a quality slider for JPEG/WebP.
- **Size** — limit the long edge or keep the original size (bounded by the largest decodable resolution).
- **Delivery** — multiple photos download as one ZIP archive or as separate files.

Exports render through the same WebGL pipeline as the Develop view, so output matches what you see. Because output goes through a canvas, exported files carry **no EXIF or location metadata** — fitting for a privacy-first tool. Default format, quality, size, and bundling are configurable in Preferences.

## Workspace

### Docking

Safelight uses Lightroom-style rails with Photoshop-style docking. Every panel can be dragged to either rail, tabbed with other panels, resized, minimized, or floated as its own window. The **View** menu toggles any registered panel; the **Layout** menu switches named layouts (the built-in **Classic** layout restores the default arrangement). Layouts persist per module.

### Multi-window

Library and Develop can each be detached into a separate OS window from the top bar — ideal for a grid on one monitor and a 1:1 view on another. Selection, edits, and settings stay synchronized across windows.

### Preferences (Ctrl+,)

- **Interface** — UI scale (0.8–1.3), reduce motion, custom UI font.
- **Library** — default grid size, sort field/direction, thumbnail resolution (320/640/960 px).
- **Develop / performance** — RAW preview cache on/off and size (2048/3072/4096 px), develop render cap (4096/6144/8192 px), 16-bit GPU textures, live histogram.
- **Export defaults** — format, quality, long edge, ZIP bundling.
- **Shortcuts** — rebind every action; single-letter shortcuts (G/D/F…) can be disabled, while Tab and Ctrl-combos always work.
- **Extensions** — the GitHub topic used to discover official extensions.

### Keyboard shortcuts (defaults)

| Action | Key | Scope |
|---|---|---|
| Go to Library / Develop | **G / D** | Global |
| Hide/show all panels | **Tab** | Global |
| Fullscreen | **F** | Global |
| Preferences | **Ctrl+,** | Global |
| Undo / Redo | **Ctrl+Z / Ctrl+Shift+Z** (or **Ctrl+Y**) | Develop |
| Reset all edits | **Ctrl+Shift+R** | Develop |
| Brush smaller / larger | **[ / ]** | Develop |
| Rate, label, flag, navigate, rotate, remove | see [Culling](#culling) | Library |

Develop and Library shortcuts only fire in their module, so the same key can serve both (e.g. **[ ]** rotates in Library and resizes the brush in Develop).

## Themes and Extensions

- **Themes** — switch between Safelight Dark, Safelight Light, and any extension-provided theme from the View menu.
- **Extensions** — every stock panel is itself a pre-installed extension that can be disabled and replaced by a community version. Install new ones from GitHub via **View ▸ Extensions**. See the [Extensions guide](extensions.md).
