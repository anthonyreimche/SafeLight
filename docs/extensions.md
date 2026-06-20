# Safelight Extensions

Safelight's extension system is inspired by modern IDE plugin architectures. The core app is a **blind orchestrator**: it doesn't know what panels, themes, display transforms, or metadata sidecars exist — it exposes contribution points, and extensions fill them. Every panel in Safelight, including the histogram, is a registered contribution, and every stock panel is a pre-installed extension that can be disabled and replaced by a community version. Anyone can publish an extension as a GitHub repo.

For exact type signatures, see the [API Documentation](api-documentation.md); `src/extensions/types.ts` is the source of truth.

## Managing extensions

The Extensions panel (**View ▸ Extensions**, or **Ctrl+Shift+X**) is a GitHub-backed app store with master/detail browsing, READMEs, categories, and update checks. It covers the full lifecycle:

- **Install** — browse official extensions (GitHub repos tagged with the `safelight-extension` topic; configurable in Preferences ▸ Extensions) or enter `owner/repo`, `owner/repo#branch`, or a github.com URL. The repo is downloaded into `<userData>/plugins/<id>/` and activated live — no restart.
- **Disable / enable** — the toggle on each row deactivates an extension and removes its contributions while keeping its files and settings. Re-enabling is instant.
- **Settings** — extensions that call `registerSettings` get a section in **Preferences ▸ Extensions**.
- **Update** — the store checks each installed extension's latest GitHub release; updates can be applied manually or, opt-in, automatically (Preferences ▸ Extensions). Settings survive updates.
- **Uninstall** — removes the extension *and deletes its files and stored settings*.

Built-in panels appear under **Built-in**; they can be disabled but not uninstalled. **Safelight Core** (the extension manager, stock themes, the Classic layout, and the built-in display transform) is locked and always on.

Safelight ships three example extensions in the repo's `extensions/` folder that double as working references: **Advanced Library Sort** (custom sorts, a live search bar, smart searches), **Image Comparison** (before/after via the develop-canvas-overlay slot), and **XMP Tools** (catalog hooks + Lightroom preset import).

## Anatomy of an extension

A repo needs two things: a `safelight.json` manifest at the root, and a prebuilt ESM bundle (commit your `dist/`, or attach it to the branch you install from).

```json
{
  "id": "com.example.histogram-pro",
  "name": "Histogram Pro",
  "version": "1.0.0",
  "description": "RGB parade + waveform histogram",
  "author": "You <you@example.com>",
  "main": "dist/index.js",
  "categories": ["Panels"],
  "keywords": ["histogram", "waveform"],
  "license": "MIT",
  "minAppVersion": "2.0.0"
}
```

Only `id`, `name`, `version`, and `main` are required; everything else (`description`, `author`, `icon`, `categories`, `keywords`, `homepage`, `repository`, `screenshots`, `license`, `minAppVersion`) is optional and enriches the store detail view. `minAppVersion` blocks installs on older Safelight builds.

The bundle must export `activate(api)` (and optionally `deactivate()`). **Do not bundle React** — use `api.react`, the app's own instance. The example extensions are built with [rolldown](https://rolldown.rs/); any bundler that emits a single ESM file with React left external works.

```js
export function activate(api) {
  const { react: React, stores } = api;

  function WaveformPanel() {
    const histogram = stores.useDevelopStore((s) => s.histogram);
    return React.createElement("div", { className: "p-3" }, /* ... */);
  }

  api.registerPanel({
    id: "com.example.histogram-pro.waveform",
    title: "Waveform",
    component: WaveformPanel,
    defaultDock: { module: "develop", direction: "right", order: 1, width: 280, height: 150 },
  });

  api.registerSettings({
    fields: [
      { key: "mode", label: "Mode", type: "select", default: "parade",
        options: [{ value: "parade", label: "RGB parade" }, { value: "wave", label: "Waveform" }] },
      { key: "opacity", label: "Opacity", type: "number", default: 80, min: 10, max: 100 },
    ],
  });
  api.settings.onChange((key, value) => {/* re-render with the new value */});
}

export function deactivate() {/* tear down listeners / side effects */}
```

> **Styling note:** runtime-loaded bundles are not scanned by Tailwind, so arbitrary Tailwind utility classes won't have CSS generated for them. Use the theme CSS variables (`var(--color-surface-1)`, etc.) with inline styles, or reuse `api.components` (which are already themed), rather than relying on ad-hoc Tailwind classes.

## Contribution types

An extension can register any of these (full signatures in the [API docs](api-documentation.md)). All contributions are auto-tagged with the extension's id and swept when it is disabled or uninstalled.

**UI**
- **Panels** (`registerPanel`) — a React component placed via `defaultDock`; dockable, tabbable, floatable like any built-in.
- **Slots** (`registerSlot`) — render into a named region of core chrome: `library-toolbar`, `library-subbar`, `develop-toolbar`, or `develop-canvas-overlay`.
- **Themes** (`registerTheme`) — a named set of CSS custom properties applied to `:root`.
- **Layouts** (`registerLayout`) — a named dock arrangement for the Layout menu.
- **Slider icons** (`registerSliderIcon`) — inline SVG beside a slider label.

**Imaging**
- **Render pipelines** (`registerPipeline`) — a display transform (tone mapper) selectable in **Preferences ▸ Rendering**; supply GLSL for `vec3 pipelineToDisplay(vec3 lin)`. This is the live way to ship a GPU effect today.
- **Processing stages** (`registerProcessingStage`) — a phase-ordered GPU stage compiled into the develop shader. The contribution point and compiler exist as the forward path for decomposing the monolithic shader; built-in tools still use the monolith, so reach for pipelines for now.
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

### Example: export processor (watermark)

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

### Example: before/after overlay (canvas slot)

The before/after pattern, as used by the bundled Image Comparison extension, combines three pieces: a keyboard shortcut, a `develop-canvas-overlay` slot, and the `api.develop` integration.

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

`useDevelopOverlay()` returns the displayed image's rect (in the overlay's local coordinates) and a `nonce` that bumps whenever the view geometry changes (zoom, pan, resize, photo switch) — re-capture/re-align when it changes. `captureFrame(params)` renders the live pipeline with arbitrary params off-screen and returns an `ImageBitmap` aligned to the current view.

### Example: catalog hooks (sidecar ownership)

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

## The API surface (`window.safelight`)

Each extension receives a scoped `SafelightAPI` (`version: 1`). Highlights:

- `react` — the app's React instance (never bundle your own).
- The `register*` methods above.
- `settings.get(key, fallback)` / `settings.set(key, value)` / `settings.onChange(cb)` — persisted per-extension settings (kept on disable, deleted on uninstall).
- `components` — stock `Panel`, `Slider`, `Histogram`, `CurveEditor`, `Rating`, `Thumbnail`, so extension UI matches the app.
- `stores` — live Zustand stores (`useDevelopStore`, `useCatalogStore`, `useUIStore`, `useSettings`, `usePresetsStore`, `useKeybindings`, `useThemeStore`, `useLayoutStore`, `usePipelineStore`) plus `create` for your own store.
- `dock.togglePanel(id)`, `themes.apply(id)`, `layouts.apply(id)`, `pipelines.apply(id)`.
- `preferences.open(sectionId?)` / `close()` / `toggle()`, `navigation.goTo(module)`, `keybindings.getBinding(actionId)`.
- `develop.useDevelopOverlay()` / `develop.captureFrame(params)` for canvas overlays.

In the desktop build, `window.safelightNative` exposes a locked-down native bridge (plugin host, updater, GitHub proxy, path-based filesystem, diagnostics) — feature-detect it, as it's absent in the browser. See the [API Documentation](api-documentation.md) for the full surface and types.

## Tips

- Namespace contribution ids with your extension id (`com.example.panel-name`); `core.*` is reserved for built-ins.
- To *replace* a stock panel, register your own and tell users to disable the built-in (e.g. "Histogram") in the Extensions panel.
- Keep bundles dependency-light. React, the component kit, and state come from the API.
- Style with theme CSS variables and `api.components`, not ad-hoc Tailwind classes (they aren't compiled for runtime bundles).
- Tag the repo with the `safelight-extension` topic so it appears in the in-app store.
