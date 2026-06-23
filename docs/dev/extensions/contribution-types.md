# Contribution Types

← [Building Extensions](README.md)

What an extension can register. Each is auto-tagged with the extension's id and swept when it is disabled or uninstalled. For exact signatures, see the [API Reference → Contribution Types](../api/contributions.md); this page is the at-a-glance map plus worked examples.

## What you can register

**UI** (see [UI Shell](../api/ui-shell.md) and [UI Components](../api/components.md))
- **Panels** (`registerPanel`) — a React component placed via `defaultDock`; dockable, tabbable, floatable like any built-in.
- **Slots** (`registerSlot`) — render into a named region of core chrome: `library-toolbar`, `library-subbar`, `develop-toolbar`, `develop-canvas-overlay`, or `develop-detail`.
- **Cursors** (`registerCursor`) — a named canvas cursor (semantic token or custom image), driven via `api.develop.setCanvasCursor` while a tool is active.
- **Themes** (`registerTheme`) — a named set of CSS custom properties applied to `:root`.
- **Layouts** (`registerLayout`) — a named dock arrangement for the Layout menu.
- **Slider icons** (`registerSliderIcon`) — inline SVG beside a slider label.

**Imaging**
- **Render pipelines** (`registerPipeline`) — a display transform (tone mapper) selectable in **Preferences ▸ Rendering**; supply GLSL for `vec3 pipelineToDisplay(vec3 lin)`. The simplest way to ship a whole-image GPU effect.
- **Processing stages** (`registerProcessingStage`) — a phase-ordered GPU stage compiled into the develop shader. Live: all phases, custom uniforms, multi-pass pre-passes, texture/LUT binding (`setStageTexture`), and a special `geometry` phase that warps source coordinates. Reach for it when you need phase ordering, uniforms, multiple passes, or coordinate warping.
- **Lens profiles** (`registerLensProfile`) — distortion/TCA/vignetting coefficients that supplement or override the built-in Lensfun database.

**Catalog & workflow**
- **Catalog hooks** (`registerCatalogHooks`) — own a side concern (sidecars, metadata) by subscribing to import / metadata-change / edit-commit / photo-remove without core knowing.
- **Grid filters** (`registerGridFilter`) — narrow the Library grid with a predicate (e.g. text/EXIF search).
- **Library sorts** (`registerLibrarySort`) — add a sort order to the toolbar dropdown.
- **Preset importers** (`registerPresetImporter`) — teach the Presets panel to read other apps' preset files.

**Export**
- **Export processors** (`registerExportProcessor`) — a post-encode step (watermark, border, …) with its own Export-panel settings.
- **Filename templates** (`registerFilenameTemplate`) — a named `{variable}` template for output names.

**Input & settings**
- **Keyboard shortcuts** (`registerKeybinding`) — an action that appears in Preferences ▸ Shortcuts and is user-rebindable.
- **Settings** (`registerSettings`) — a declarative settings section (`boolean`/`number`/`string`/`select` fields) or a custom component.

## Example: export processor (watermark)

```js
export function activate(api) {
  api.registerExportProcessor({
    id: "com.example.watermark",
    label: "Watermark",
    settings: [
      { key: "enabled",  label: "Enable",         type: "boolean", default: true },
      { key: "text",     label: "Watermark text", type: "string",  default: "© My Name" },
      { key: "opacity",  label: "Opacity",        type: "number",  default: 50, min: 0, max: 100 },
      { key: "position", label: "Position",       type: "select",  default: "bottom-right",
        options: [
          { value: "bottom-right", label: "Bottom right" },
          { value: "bottom-left",  label: "Bottom left" },
          { value: "top-right",    label: "Top right" },
          { value: "top-left",     label: "Top left" },
        ] },
    ],
    async process(blob, photo, settings) {
      if (!settings.enabled) return blob;
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0);
      ctx.globalAlpha = settings.opacity / 100;
      ctx.font = `${Math.round(bitmap.width * 0.02)}px sans-serif`;
      ctx.fillStyle = "#ffffff";
      const pad = bitmap.width * 0.02;
      const [vert, horiz] = settings.position.split("-");
      const x = horiz === "right" ? bitmap.width - pad : pad;
      const y = vert === "bottom" ? bitmap.height - pad : pad * 2;
      ctx.textAlign = horiz === "right" ? "right" : "left";
      ctx.fillText(settings.text, x, y);
      return canvas.convertToBlob({ type: blob.type, quality: 0.95 });
    },
  });

  api.registerFilenameTemplate({
    id: "com.example.dated",
    label: "Date + filename",
    template: "{year}-{month}-{day}_{filename}",
  });
}
```

## Example: before/after overlay (canvas slot)

The before/after pattern, as used by the bundled Image Comparison extension, combines three pieces: a keyboard shortcut, a `develop-canvas-overlay` slot, and the [`api.develop`](../api/stores.md#apidevelop) integration.

```js
export function activate(api) {
  const { react: React } = api;

  api.registerKeybinding({
    id: "com.example.compare.toggle",
    label: "Show original (hold or toggle)",
    category: "Develop",
    defaultCombo: "\\",
    handler: () => {/* drive previewParams from window listeners */},
  });

  function SplitOverlay() {
    const { rect, nonce } = api.develop.useDevelopOverlay(); // image rect + change nonce
    const before = React.useRef(null);
    React.useEffect(() => {
      if (!rect) return;
      // capture an off-screen "before" frame aligned to the live view
      api.develop.captureFrame(/* original params */).then((bmp) => { before.current = bmp; });
    }, [nonce]);
    // ...draw a draggable divider that reveals `before` on one side...
    return React.createElement("div", { /* positioned over rect, click-through */ });
  }

  api.registerSlot({
    id: "com.example.compare.overlay",
    slot: "develop-canvas-overlay",
    component: SplitOverlay,
    order: 50,
  });
}
```

`useDevelopOverlay()` returns the displayed image's rect (in the overlay's local coordinates) and a `nonce` that bumps whenever the view geometry changes (zoom, pan, resize, photo switch) — re-capture/re-align when it changes. `captureFrame(params)` renders the live pipeline with arbitrary params off-screen and returns an `ImageBitmap` aligned to the current view. For brush/mask/retouch tools that paint on the canvas, see [State Stores & Tools → Brushes, masks & retouch](../api/stores.md#brushes-masks--retouch-interactive-develop-tools).

## Example: catalog hooks (sidecar ownership)

```js
export function activate(api) {
  api.registerCatalogHooks({
    id: "com.example.xmp",
    async onPhotoImport({ dir, fileName }) {
      const xmp = await readSidecar(dir, fileName);
      return xmp ? { rating: xmp.rating, keywords: xmp.keywords } : undefined; // merged onto the record
    },
    async onMetadataChange({ photos }) { /* write ratings/labels/keywords back out */ },
    async onEditCommit({ photo, editState }) { /* persist develop params */ },
    async onPhotoRemove({ dir, fileName }) { /* delete the sidecar */ },
  });
}
```
