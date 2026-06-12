# Safelight Extensions

Safelight's extension system is inspired by modern IDE plugin architectures. Every panel in Safelight — including the histogram — is a registered extension contribution, and every stock panel is a pre-installed extension that can be disabled and replaced by a community version. Anyone can publish an extension as a GitHub repo.

## Managing extensions

The Extensions panel (**View ▸ Extensions**) covers the full lifecycle:

- **Install** — browse official extensions (GitHub repos tagged with the `safelight-extension` topic; configurable in Preferences ▸ Extensions) or enter `owner/repo`, `owner/repo#branch`, or a github.com URL. The repo is downloaded and activated live — no restart.
- **Disable / enable** — the toggle on each row deactivates an extension and removes its contributions while keeping its files and settings. Re-enabling is instant.
- **Settings** — extensions that call `registerSettings` get a ⚙ button opening their settings dialog.
- **Uninstall** — removes the extension *and deletes its files and stored settings*.

Built-in panels appear under **Built-in**; they can be disabled but not uninstalled. **Safelight Core** (the extension manager, stock themes, and the Classic layout) is locked and always on.

## Anatomy of an extension

A repo needs two things: a `safelight.json` manifest at the root, and a prebuilt ESM bundle (commit your `dist/` or attach it to the branch you install from).

```json
{
  "id": "histogram-pro",
  "name": "Histogram Pro",
  "version": "1.0.0",
  "description": "RGB parade + waveform histogram",
  "main": "dist/index.js"
}
```

The bundle must export `activate(api)` (and optionally `deactivate()`). Do **not** bundle React — use `api.react`, the app's own instance:

```js
export function activate(api) {
  const { react: React, stores } = api;

  function WaveformPanel() {
    const histogram = stores.useDevelopStore((s) => s.histogram);
    return React.createElement("div", { className: "p-3" }, /* ... */);
  }

  api.registerPanel({
    id: "histogram-pro.waveform",
    title: "Waveform",
    component: WaveformPanel,
    defaultDock: { module: "develop", direction: "right", order: 1, width: 280, height: 150 },
  });

  api.registerTheme({
    id: "histogram-pro.solarized",
    name: "Solarized",
    colorScheme: "dark",
    vars: { "--color-surface-0": "#002b36" /* ... */ },
  });

  api.registerSliderIcon({
    id: "core.exposure", // shows beside the Basic panel's Exposure slider
    svg: "<svg viewBox='0 0 16 16'>...</svg>",
  });

  // Declarative settings dialog (⚙ in the Extensions panel). Values persist
  // per-extension; read them with api.settings.get and react to edits live.
  api.registerSettings({
    fields: [
      { key: "mode", label: "Mode", type: "select", default: "parade",
        options: [{ value: "parade", label: "RGB parade" },
                  { value: "wave", label: "Waveform" }] },
      { key: "opacity", label: "Opacity", type: "number", default: 80, min: 10, max: 100 },
      { key: "showClipping", label: "Show clipping", type: "boolean", default: true },
    ],
  });
  api.settings.onChange((key, value) => {/* re-render with the new value */});
}
```

## Contribution types

- **Panels** (`registerPanel`) — a React component with a unique id and title. `defaultDock` places it in a module's rail (`library` or `develop`, `left` or `right`, with `order`, `width`, and a relative `height`) when the user has no saved layout; without it the panel is available from the View menu. Panels can be docked, tabbed, floated, and persisted like any built-in.
- **Themes** (`registerTheme`) — a named set of CSS custom properties applied to `:root` (surfaces, borders, text, accent, slider fill — see the stock themes in `src/extensions/builtin.tsx` for the full themable surface), plus a `colorScheme` hint.
- **Layouts** (`registerLayout`) — a named dock arrangement for the Layout menu. Each module defines rails (`side`, `width`, ordered panel ids) and optional floating panels. A layout with no `modules` resolves to the registry's `defaultDock` placements (this is what Classic does), so extension panels join it automatically.
- **Slider icons** (`registerSliderIcon`) — inline SVG rendered at 12×12 beside a slider label, keyed by the slider's icon id (e.g. `core.exposure`).
- **Settings** (`registerSettings`) — a declarative settings dialog with `boolean`, `number`, `string`, and `select` fields.

All contributions are auto-tagged with the extension's id and swept when it is disabled or uninstalled.

## The API surface (`window.safelight`)

Each extension receives a scoped `SafelightAPI` (`version: 1`):

- `react` — the app's React instance (never bundle your own).
- `registerPanel / registerTheme / registerLayout / registerSliderIcon / registerSettings` — contributions, described above.
- `settings.get(key, fallback)` / `settings.set(key, value)` / `settings.onChange(cb)` — persisted per-extension key/value settings (kept on disable, deleted on uninstall).
- `components` — Safelight's stock `Panel`, `Slider`, and `Histogram` components, so extension UI matches the app.
- `stores` — the live Zustand stores: `useDevelopStore` (edit params, history, histogram, mask/brush state), `useCatalogStore` (photos, selection, culling), `useUIStore` (active module, view options), `useSettings` (app preferences), plus `create` for an extension's own store.
- `dock.togglePanel(id)` — open/close a panel programmatically.
- `themes.apply(id)` / `layouts.apply(id)` — switch theme or layout.

See [API Documentation](api-documentation.md) for the underlying types and store contents.

## Tips

- Namespace contribution ids with your extension id (`my-ext.panel-name`); `core.*` is reserved for built-ins.
- To *replace* a stock panel, register your own panel and instruct users to disable the built-in (e.g. "Histogram") in the Extensions panel.
- Keep bundles dependency-light. React, the component kit, and state come from the API.
- Tag the repo with the `safelight-extension` topic so it appears in the in-app browser.
