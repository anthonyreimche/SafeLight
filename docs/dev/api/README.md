# API Reference

Reference for the extension API surface and the data structures extensions interact with. Every extension receives a scoped `SafelightAPI` (`version: 1`) whose full TypeScript definition lives in `src/extensions/types.ts` — that file is the source of truth; these pages summarize it. For the tutorial-style authoring guide, see [Building Extensions](../extensions/README.md).

## Pages

| Page | Covers |
|---|---|
| [UI Shell](ui-shell.md) | Modules, panels, and slots — where your UI mounts |
| [UI Components](components.md) | The `api.components` kit (Slider, Panel, …), theming tokens, and building custom controls (buttons) |
| [Contribution Types](contributions.md) | Signatures for every `register*` contribution (themes, layouts, pipelines, GPU stages, export, hooks, …) |
| [State Stores & Tools](stores.md) | The Zustand stores in `api.stores`, the brush/mask/retouch tool model, and `api.develop` |
| [Core Data Types](types.md) | `CatalogPhoto`, `DevelopParams`, and the edit recipe |
| [Subsystems](subsystems.md) | Storage, rendering, RAW, presets, export, broadcast, keybindings, and the Electron bridge |

## The `SafelightAPI` object

```typescript
interface SafelightAPI {
  version: 1;
  extensionId: string;        // your extension's id; contributions are auto-tagged with it
  react: any;                 // the app's React instance — use this, never bundle your own

  // ── Contribution registration ──────────────────────────────────────────
  registerPanel(c: PanelContribution): void;
  registerTheme(c: ThemeContribution): void;
  registerLayout(c: LayoutContribution): void;
  registerSliderIcon(c: SliderIconContribution): void;
  registerPipeline(c: PipelineContribution): void;            // display transform
  registerProcessingStage(c: ProcessingStageContribution): void; // GPU stage
  unregisterProcessingStage(id: string): void;               // remove one stage you registered
  setStageTexture(stageId, key, tex: StageTextureData | null): void; // (re)upload a stage texture/LUT
  registerKeybinding(c: KeyActionContribution): void;
  registerSettings(c: SettingsContribution): void;
  registerExportProcessor(c: ExportProcessorContribution): void;
  registerFilenameTemplate(c: FilenameTemplateContribution): void;
  registerLensProfile(c: LensProfileContribution): void;
  registerCatalogHooks(c: CatalogHooksContribution): void;
  registerPresetImporter(c: PresetImporterContribution): void;
  registerGridFilter(c: GridFilterContribution): void;
  registerLibrarySort(c: LibrarySortContribution): void;
  registerSlot(c: SlotContribution): void;
  registerCursor(c: CursorContribution): void;               // a named/custom canvas cursor

  // ── Persisted per-extension settings ───────────────────────────────────
  settings: {
    get<T>(key: string, fallback: T): T;
    set(key: string, value: unknown): void;
    onChange(cb: (key: string, value: unknown) => void): () => void; // returns unsubscribe
  };

  // ── Shared building blocks ─────────────────────────────────────────────
  components: Record<string, ComponentType>; // see UI Components
  stores: Record<string, any>;               // see State Stores, plus zustand `create`

  // ── Imperative app control ─────────────────────────────────────────────
  dock:        { togglePanel(id: string): void };
  themes:      { apply(id: string): void };
  layouts:     { apply(id: string): void };
  pipelines:   { apply(id: string): void };
  preferences: { open(sectionId?: string): void; close(): void; toggle(): void };
  navigation:  { goTo(module: "library" | "develop"): void };
  keybindings: { getBinding(actionId: string): string };

  // ── Develop-canvas integration (for overlay & tool extensions) ─────────
  develop: { /* see State Stores & Tools → api.develop */ };
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
| `dock` | `togglePanel(id)` |
| `themes` / `layouts` / `pipelines` | `apply(id)` |
| `preferences` | `open(sectionId?)` / `close()` / `toggle()` — `sectionId` deep-links to a core section or an extension id |
| `navigation` | `goTo("library" \| "develop")` |
| `keybindings` | `getBinding(actionId)` — current combo for any action (built-in or extension) |

In the desktop build, `window.safelightNative` exposes a locked-down native bridge (plugin host, updater, GitHub proxy, path-based filesystem, diagnostics) — feature-detect it, as it's absent in the browser. See [Subsystems → Electron bridge](subsystems.md#electron-bridge-windowsafelightnative).
