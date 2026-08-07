# Getting Started

Safelight is a fast, project-based RAW photo editor. This guide takes you from launch to your first export.

## Launch Safelight

- **Desktop app**: run the installed `Safelight` shortcut (see [Installation](installation.md)).
- **From source** (Node.js 20.19+/22.12+): `npm install`, then `npm run dev` and open the printed URL in a Chromium-based browser, or `npm run electron:dev` for a desktop window. See [Installation](installation.md) to build your own installer.

## Open a Project

Safelight is project-based: instead of importing photos into a central catalog, you open a folder.

1. In the **Library** module, click **Open Folder** in the Folders panel (or press **Ctrl+O**).
2. Pick any folder containing photos. Safelight scans it (including subfolders) and builds thumbnails.
3. All catalog data — ratings, flags, labels, keywords, and edit history — is written to a hidden `.safelight/` directory inside that folder. Your project travels with the folder; originals are never modified.

Safelight reopens your last project on launch when **Restore last project** is enabled. Browsers reset folder permissions between sessions, so you may see a **Reconnect** prompt — one click re-grants access.

Supported formats: JPEG, PNG, WebP, AVIF, TIFF, and RAW (NEF, CR2, CR3, ARW, DNG, ORF, RAF, PEF, SRW, RW2, IIQ, 3FR, NRW, KDC, MOS, MRW, ERF, SR2, X3F).

## Cull and Organize

In the Library grid (sensible defaults below; everything is rebindable in Preferences ▸ Shortcuts):

- **1–5** rate, **0** clear rating
- **6–9** color labels (red, yellow, green, blue)
- **P** pick, **X** reject, **U** unflag
- **← →** previous/next photo, **Alt+[ ]** rotate, **K** focus keywords
- **- =** smaller/larger thumbnails
- Filter the grid by rating, flag, and label using the Filters panel

## Edit

Double-click a photo (or press **D**) to open it in the **Develop** module. Tool panels stack in rails on either side of the canvas:

- White Balance, Basic, Tone Curve, HSL, and Color Grading for tone and color
- Detail for sharpening and noise reduction; Lens Correction and Effects for optics and finishing
- Crop & Straighten, Transform, and Upright for geometry
- Masking (radial / linear / brush / range components) and Heal/Clone for local adjustments and retouching

Tips: hold **Shift** while dragging a slider for fine control, double-click to reset it, and use **Ctrl+Z / Ctrl+Shift+Z** for undo/redo. All edits are non-destructive.

## Export

Open the **Export** panel (View ▸ Export, docked in Library by default), select photos, choose JPEG/PNG/WebP/TIFF, quality, an output color space, and an optional long-edge limit, then export — multiple photos can be bundled into a single ZIP.

## Make It Yours

- **Panels**: drag to dock, tab, float, or minimize any panel; toggle them from the **View** menu. Layouts persist per module.
- **Layouts and themes**: switch named layouts from the **Layout** menu and themes from the **View** menu.
- **Shortcuts**: rebind any key in **Preferences (Ctrl+,) ▸ Shortcuts**.
- **Extensions**: install community panels, tools, and themes from GitHub via **View ▸ Extensions** (Ctrl+Shift+X) — see [Using Extensions](using-extensions.md).

## Next Steps

- [User Guide](user-guide.md) — every feature in detail
- [Using Extensions](using-extensions.md) — install and manage community add-ons
- [Developer Docs](../dev/README.md) — architecture and the extension API reference
