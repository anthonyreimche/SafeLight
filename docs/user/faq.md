# FAQ

Frequently asked questions about Safelight.

## General

### What is Safelight?

Safelight is a free, open-source, privacy-first RAW photo editor. It combines GPU-accelerated professional editing tools with an IDE-style extensible interface, and ships as a desktop app (Electron) for Windows, Linux, and macOS, plus a browser app.

### Is Safelight free?

Yes — completely free and open source (GPL v3). No subscriptions, no hidden costs.

### Does Safelight work offline?

Yes, fully. The only network feature is the optional extension installer, which downloads from GitHub when you ask it to.

### Does Safelight collect my data?

No. There is no telemetry, no cloud, no accounts. Photos and edits never leave your computer, and exported images carry no EXIF or location metadata.

### Desktop app or browser — which should I use?

The desktop app. It guarantees the fast libraw RAW decode path (cross-origin isolation + SharedArrayBuffer) and forces the high-performance GPU. The browser version works in recent Chromium-based browsers (Chrome, Edge, Opera) and is mainly useful for development; Firefox and Safari lack the File System Access API Safelight relies on.

## Projects and Files

### Where is my catalog stored?

Inside the project folder you open, in a hidden `.safelight/` directory: `catalog.json` (records and edit histories), `previews/` (thumbnails), and `raw/` (decoded-RAW cache). Move the folder and the project moves with it.

### Does Safelight modify my original files?

Never. All edits are non-destructive parameter sets stored in `.safelight/`. Deleting that directory removes Safelight's data and nothing else.

### What happens if I add or delete photos outside Safelight?

Reopening the project reconciles against the disk: new files appear, missing files drop out, and everything else keeps its ratings and edits.

### Why do I see a "Reconnect" button in the browser?

Browsers reset folder permissions between sessions. One click re-grants access to the project folder.

## Features

### Does Safelight support RAW files?

Yes. Safelight decodes RAW at full resolution via libraw-wasm, with an in-house decoder for uncompressed CFA/DNG, covering NEF, CR2, CR3, ARW, DNG, ORF, RAF, PEF, SRW, RW2, IIQ, 3FR, NRW, KDC, MOS, MRW, ERF, SR2, and X3F. If a file can't be decoded, Safelight falls back to the embedded JPEG preview so it always displays.

### Can I make local adjustments?

Yes — masks built from radial, linear, brush, luminance-range, and color-range components (up to 8 masks per photo, 16 components total) combined with add/subtract/intersect, with per-mask exposure, contrast, tone, color, clarity, and optional sub-panels. Plus heal/clone spot removal (up to 16 spots). Geometry tools include crop, straighten, transform, and automatic/guided Upright perspective correction.

### Can I use presets?

Yes. Presets are an open, human-readable JSON format (`safelight-preset`) that you can save, apply, export, and import — easy to share or generate. The bundled XMP Tools extension also imports Lightroom `.xmp` presets.

### Can I compare before/after?

Yes — the bundled Image Comparison extension adds hold-to-preview and a draggable before/after split to the Develop canvas.

### Can I import Lightroom catalogs?

Full catalog import isn't built in yet (it's on the roadmap via sql.js), but the bundled XMP Tools extension reads/writes XMP sidecars and imports Lightroom presets.

### Does Safelight support batch editing or AI masking?

Both are planned: batch editing, and AI masking (Select Subject, Sky) via ONNX.js.

### Can I rebind keyboard shortcuts?

Every shortcut is rebindable in Preferences (Ctrl+,) ▸ Shortcuts. Single-letter shortcuts can be disabled entirely if they conflict with your workflow.

## Extensions

### What can extensions do?

A lot — the core is a blind orchestrator that extensions fill in. They can add or replace panels (every stock panel can be disabled and swapped), add themes, layouts, slider icons, keyboard shortcuts, and UI slots; contribute display transforms (tone mappers) and lens profiles; own catalog side concerns via lifecycle hooks (e.g. XMP sidecars); add Library sorts, grid filters, and preset importers; and add export processors and filename templates. See [Using Extensions](using-extensions.md).

### Are extensions safe?

Extensions are JavaScript running inside the app, installed from GitHub repos you choose. Install only extensions you trust, the same judgment you'd apply to IDE plugins.

## Technical

### How does multi-window support work?

Library and Develop can detach into separate OS windows; state synchronizes via BroadcastChannel (catalog, selection, edits) and the storage event (settings, themes, layouts).

### What is "high bit depth" in Preferences?

When enabled (and supported by your GPU), cached RAW previews use 16-bit float textures, preserving highlight/shadow precision through heavy edits.

### Performance is slow — what can I try?

Use the desktop app (it forces the discrete GPU), lower the Develop render cap or thumbnail resolution in Preferences, disable the live histogram, and keep the RAW cache enabled.

### Export fails or produces no file

Ensure you have write permission to the destination and that photos finished decoding. When exporting many photos in the browser, prefer the ZIP option — separate files trigger one download prompt each.

## Contributing

### How can I request a feature or report a bug?

Open a GitHub issue. Pull requests are welcome — see [Contributing](../dev/contributing.md).
