# API Reference

Every extension's `activate(api)` receives a scoped `SafelightAPI`. These pages summarize it. The exact definitions are the TypeScript files in [`src/extensions/api/`](../../../src/extensions/api/): `scoped-api.ts` is the `SafelightAPI` itself, `contributions.ts` holds every `register*` shape, and `develop.ts`, `stores.ts`, `export.ts`, `components.ts`, `library.ts` and `variables.ts` cover the rest. `src/extensions/types.ts` only re-exports them. New here? Read [How Safelight works](../concepts.md) and [Building Extensions](../extensions/README.md) first.

## Pages

| Page | Covers |
|---|---|
| [UI Shell](ui-shell.md) | Modules, panels, per-mask panels, header accessories, slots, layouts |
| [UI Components](components.md) | `api.components`, `api.ui`, theming tokens, styling hooks |
| [Contribution Types](contributions.md) | Every other `register*` contribution: stages, pipelines, export, hooks, cursors |
| [State Stores & Data APIs](stores.md) | `api.stores`, Develop tools, `api.develop`, `api.catalog`, `api.export`, `api.params`, `api.variables` |
| [Core Data Types](types.md) | `CatalogPhoto`, `DevelopParams`, masks, `EditState` |
| [Subsystems](subsystems.md) | Storage, rendering, RAW, presets, export, keybindings, the Electron bridge |

## The `SafelightAPI` object

```typescript
interface SafelightAPI {
  version: 1;
  extensionId: string;              // your id; contributions are tagged with it
  react: typeof import("react");    // the app's React; never bundle your own

  register*(c): void;               // see Contribution Types for every call
  unregisterProcessingStage(id: string): void;
  unregisterSlot(id: string): void;
  unregisterStylesheet(id: string): void;
  setStageTexture(stageId: string, key: string, tex: StageTextureData | null): void;

  components: { Panel; Slider; Histogram; CurveEditor; Rating; Thumbnail; PhotoListRow };
  ui: { Button; Select; TextInput; NumberInput; TextArea; Toggle; SegmentedControl;
        Field; Section; Card; Badge; ProgressBar; Stack; Row; tokens };
  stores: { useDevelopStore; useCatalogStore; useUIStore; useSettings; usePresetsStore;
            useKeybindings; useThemeStore; useLayoutStore; usePipelineStore; create };

  // Imperative surfaces, see the table below
  settings; params; dock; themes; layouts; pipelines; preferences; navigation;
  keybindings; cursors; variables; develop; export; catalog;
}

interface ExtensionModule {        // what your bundle exports
  activate(api: SafelightAPI): void;
  deactivate?(): void;
}
```

Notes:

- If `activate` throws, or returns a promise that rejects, the extension counts as failed to start: what it registered is swept and the error is logged. One that hasn't finished starting within 15 seconds counts as failed too, so Safelight can go on to the next extension.
- Everything you register is swept when the extension is disabled, uninstalled or updated. You don't need to unregister in `deactivate`.
- Registering the same id again replaces the earlier contribution.
- Call `setStageTexture` from `activate`, not from module top-level code. Disabling or updating drops stage textures, and a re-enabled extension's module is not re-run. Bump the texture's `version` to swap its data without a recompile.

### Imperative control surfaces

| Surface | Methods |
|---|---|
| `settings` | `get(key, fallback)`, `set(key, value)`, `onChange(cb)`. Per extension, any window. Kept on disable, deleted on uninstall. |
| `params` | `list()`, `get(qualifiedKey)`. Read-only metadata for every stage uniform. See [`api.params`](stores.md#apiparams). |
| `dock` | `togglePanel(id)`, `usePanelPlacement()`. See [Panels](ui-shell.md#panels-registerpanel). |
| `themes`, `layouts` | `apply(id)` |
| `pipelines` | `apply(id)` sets the Preferences default. `effectiveId(displayTransform)` is the transform a photo renders with. `paramKeys(id)` lists a transform's bag keys. |
| `preferences` | `open(sectionId?)`, `close()`, `toggle()`. `sectionId` is a core section or an extension id. |
| `navigation` | `goTo(id)`: `"library"`, `"develop"` or a registered module id. |
| `keybindings` | `getBinding(actionId)` returns the live combo, `""` when unbound. `list()` returns every built-in action. |
| `cursors` | `labels`, `resolve(token)`. See [Cursors](contributions.md#cursorcontribution). |
| `develop` | Develop canvas: overlays, mask scope, frame capture, cursors, per-photo data. See [`api.develop`](stores.md#apidevelop). |
| `export` | `getDefaultSettings()`, `renderPhotos(photos, settings?, onProgress?, options?)` (render without writing), `exportPhotos(photos, settings, onProgress?, destDir?, options?)` (the Export panel's whole run, into a folder from `project.pickDirectory`). See [`api.export`](stores.md#apiexport). |
| `catalog` | Records, edit stacks, rename, photo surfaces. See [`api.catalog`](stores.md#apicatalog). |
| `project` | `pickDirectory(id)` asks the user for a folder to write into (null if they cancel). `pathOf(handle)` and `reveal(path)` show it in the file manager on the desktop. `createFolder`, `renameFolder`, `moveFolder`, `movePhotos`, `deleteFolder` change the project's folders on disk, with paths relative to the project root. |
| `presets` | `importFile`, `exportFile`, `pickFile`, `fields`, `summarize`, `describeBag`, `useImporters()`: what the Presets panel and Copy Settings use. |
| `appSettings` | `update(patch)` writes Preferences and runs their side effects. Read them with `stores.useSettings`. |
| `registry` | `use(selector)`: a React hook over every registered contribution (panels, stages, modules and so on). |
| `events` | `onBroadcast(cb)`: messages between windows, such as catalogue and edit changes. Returns an unsubscribe function. |
| `extensions` | `openStore(category?)` opens the Extensions window, on a category's list if given. |
| `accessibility` | `useKeyboardCanvasEditing()`: whether an on-image tool should show number fields instead of drag handles. `activate()` / `deactivate()` are for the Accessibility extension. |
| `titleBar` | `useOverlay(bgVar)` recolours the window controls over a custom title bar. |
| `variables` | `register`, `get`, `subscribe`, `set`, `update`. Named JSON values shared by every extension and window. Needs Safelight 3.0.1. See [`api.variables`](stores.md#apivariables-shared-variables). |

In the desktop build, `window.safelightNative` is a locked-down native bridge (plugin host, GitHub proxy, DevTools, diagnostics). It is absent in the browser, so feature-detect it. Raw filesystem access and the updater are not on it. See [Electron bridge](subsystems.md#electron-bridge-windowsafelightnative).
