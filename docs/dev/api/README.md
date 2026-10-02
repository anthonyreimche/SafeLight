# API Reference

Reference for the extension API surface and the data structures extensions interact with. Every extension receives a scoped `SafelightAPI` (`version: 1`) whose full TypeScript definition lives in `src/extensions/types.ts` — that file is the source of truth; these pages summarize it. For the tutorial-style authoring guide, see [Building Extensions](../extensions/README.md).

## Pages

| Page | Covers |
|---|---|
| [UI Shell](ui-shell.md) | Modules, panels, per-mask panels, header accessories, and slots — where your UI mounts |
| [UI Components](components.md) | The `api.components` kit (Slider, Panel, …), the `api.ui` primitives (Button, Select, Toggle, …), theming tokens, and styling hooks |
| [Contribution Types](contributions.md) | Signatures for every other `register*` contribution (themes, pipelines, GPU stages, export, hooks, grid menu items, cursors, …) |
| [State Stores & Data APIs](stores.md) | The Zustand stores in `api.stores`, the brush/mask/retouch tool model, `api.develop`, `api.catalog`, `api.export`, and `api.params` |
| [Core Data Types](types.md) | `CatalogPhoto`, `DevelopParams`, masks, and the edit recipe (`EditState`) |
| [Subsystems](subsystems.md) | Storage, rendering, RAW, presets, export, broadcast, keybindings, and the Electron bridge |

## The `SafelightAPI` object

```typescript
interface SafelightAPI {
  version: 1;
  extensionId: string;        // your extension's id; contributions are auto-tagged with it
  react: typeof import("react"); // the app's React instance — use this, never bundle your own

  // ── Contribution registration ──────────────────────────────────────────
  registerPanel(c: PanelContribution): void;
  registerTheme(c: ThemeContribution): void;
  registerLayout(c: LayoutContribution): void;
  registerModule(c: ModuleContribution): void;                // a top-level module beside Library/Develop
  registerSliderIcon(c: SliderIconContribution): void;
  registerPipeline(c: PipelineContribution): void;            // display transform
  registerProcessingStage(c: ProcessingStageContribution): void; // GPU stage
  unregisterProcessingStage(id: string): void;               // remove one stage you registered
  setStageTexture(stageId, key, tex: StageTextureData | null): void; // (re)upload a stage texture/LUT
  registerKeybinding(c: KeyActionContribution): void;
  registerSettings(c: SettingsContribution): void;
  registerExportProcessor(c: ExportProcessorContribution): void;
  registerFilenameTemplate(c: FilenameTemplateContribution): void;
  registerCatalogHooks(c: CatalogHooksContribution): void;
  registerPresetImporter(c: PresetImporterContribution): void;
  registerGridFilter(c: GridFilterContribution): void;
  registerLibrarySort(c: LibrarySortContribution): void;
  registerGridMenuItem(c: GridMenuItemContribution): void;   // an action in the Library right-click menu
  registerSlot(c: SlotContribution): void;
  unregisterSlot(id: string): void;                          // remove one slot contribution you registered
  registerPanelHeaderAccessory(c: PanelHeaderAccessoryContribution): void; // a control on every panel header
  registerCursor(c: CursorContribution): void;               // a named/custom canvas cursor
  registerStylesheet(c: StylesheetContribution): void;       // CSS applied after core styles (see Styling hooks)
  unregisterStylesheet(id: string): void;                    // remove one stylesheet you registered

  // ── Persisted per-extension settings ───────────────────────────────────
  settings: {
    get<T>(key: string, fallback: T): T;
    set(key: string, value: unknown): void;
    onChange(cb: (key: string, value: unknown) => void): () => void; // any window; returns unsubscribe
  };

  // ── Shared building blocks ─────────────────────────────────────────────
  components: { Panel; Slider; Histogram; CurveEditor; Rating; Thumbnail; PhotoListRow }; // see UI Components
  ui: { Button; Select; TextInput; NumberInput; TextArea; Toggle; SegmentedControl;
        Field; Section; Card; Badge; ProgressBar; Stack; Row; tokens };               // see UI Components → api.ui
  stores: { useDevelopStore; useCatalogStore; useUIStore; useSettings; usePresetsStore;
            useKeybindings; useThemeStore; useLayoutStore; usePipelineStore; create }; // see State Stores
  params: { list(): ParamDescriptor[]; get(qualifiedKey: string): ParamDescriptor | undefined };

  // ── Imperative app control ─────────────────────────────────────────────
  dock: {
    togglePanel(id: string): void;
    usePanelPlacement(): PanelPlacement;                      // React hook: where the calling panel is docked
  };
  themes:      { apply(id: string): void };
  layouts:     { apply(id: string): void };
  pipelines: {
    apply(id: string): void;                                  // sets the Preferences default, followed by photos without their own pick
    effectiveId(displayTransform: string | null): string;    // the transform a photo renders with: its pick, else the default, else the built-in
  };
  preferences: { open(sectionId?: string): void; close(): void; toggle(): void };
  navigation:  { goTo(module: ModuleId): void };              // "library" | "develop" | a registered module id
  keybindings: {
    getBinding(actionId: string): string;
    list(): { id: string; label: string; category: string; combo: string }[]; // built-in actions, live combos
  };
  cursors: {
    labels: Readonly<Record<string, string>>;                 // canonical names of the built-in cursor tokens
    resolve(token: string): string;                           // token → the CSS cursor value the app uses now
  };

  // ── Develop, export & catalog integration ──────────────────────────────
  develop: { /* overlays, mask scope, frame capture, canvas cursor, per-photo data, adjustments — see State Stores → api.develop */ };
  export:  { /* headless full-resolution render — see State Stores → api.export */ };
  catalog: { /* records, edit stacks, rename, photo surfaces — see State Stores → api.catalog */ };
}
```

An extension bundle exports `activate(api)` and optionally `deactivate()`:

```typescript
interface ExtensionModule {
  activate(api: SafelightAPI): void;
  deactivate?(): void;
}
```

All contributions are tagged with the calling extension's `extensionId` and swept automatically when it is disabled or uninstalled.

### Imperative control surfaces

| Surface | Methods |
|---|---|
| `settings` | `get(key, fallback)` / `set(key, value)` / `onChange(cb)` — persisted per-extension (kept on disable, deleted on uninstall) |
| `params` | `list()` / `get(qualifiedKey)` — read-only metadata for every installed stage uniform; see [State Stores → `api.params`](stores.md#apiparams) |
| `dock` | `togglePanel(id)` / `usePanelPlacement()` — see [UI Shell → Panels](ui-shell.md#panels-registerpanel) |
| `themes` / `layouts` | `apply(id)` |
| `pipelines` | `apply(id)` — sets the Preferences default / `effectiveId(displayTransform)` — the transform a photo renders with |
| `preferences` | `open(sectionId?)` / `close()` / `toggle()` — `sectionId` deep-links to a core section or an extension id |
| `navigation` | `goTo(id)` (`ModuleId` = `"library" \| "develop"` or a registered id) |
| `keybindings` | `getBinding(actionId)` — current combo for any action (built-in or extension), `""` when unbound / `list()` — every built-in action with its live combo, label and category |
| `cursors` | `labels` / `resolve(token)` — see [Contribution Types → Cursors](contributions.md#cursorcontribution) |
| `develop` | Develop-canvas integration — see [State Stores → `api.develop`](stores.md#apidevelop) |
| `export` | `getDefaultSettings()` / `renderPhotos(photos, settings?, onProgress?)` — see [State Stores → `api.export`](stores.md#apiexport) |
| `catalog` | Record, edit-stack, rename and photo-surface helpers — see [State Stores → `api.catalog`](stores.md#apicatalog) |

In the desktop build, `window.safelightNative` exposes a locked-down native bridge (plugin host, GitHub proxy, DevTools, diagnostics). Feature-detect it, as it's absent in the browser. Raw filesystem access and the update installer are not on it: core claims them once at boot, so extension code can't reach them. See [Subsystems → Electron bridge](subsystems.md#electron-bridge-windowsafelightnative).
