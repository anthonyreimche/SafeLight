# SafeLight Extensions

SafeLight's extension system is inspired by modern IDE plugin architectures, enabling deep customization of the editing workflow. Every panel in SafeLight—including the histogram—is a registered extension contribution. Enthusiasts can replace or supplement any component by publishing a GitHub repo.

## Installing

View ▸ Extensions ▸ enter `owner/repo` (or `owner/repo#branch`, or a github.com URL) ▸ Install. The repo is downloaded into `userData/plugins/<id>/` and activated live, no restart. Uninstall from the same panel.

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

The bundle must export `activate(api)` (and optionally `deactivate()`). Do **not** bundle React — use `api.react`, the app's instance:

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
    slot: "develop-right", // or "none" for View-menu-only
    order: 0,              // 0 = top of the sidebar, like the stock histogram
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
}
```

## The API surface (`window.safelight`)

- `registerPanel / registerTheme / registerSliderIcon` — contributions, auto-tagged with your extension id and swept on uninstall.
- `react` — the host React (use `React.createElement` or compile JSX against an external `react`).
- `components` — `Panel` (collapsible sidebar chrome), `Slider`, `Histogram`.
- `stores` — `useDevelopStore`, `useCatalogStore`, `useUIStore` (zustand hooks), plus `create` for your own state.
- `dock.togglePanel(id)` — open/close any panel as a floating dockable window.
- `themes.apply(id)` — switch theme.

Every registered panel appears in the **View** menu and can float or dock beside the canvas; layouts persist per window.

## Themable CSS variables

`--color-surface-0…4`, `--color-border`, `--color-border-subtle`, `--color-text-primary/secondary/muted`, `--color-accent`, `--color-accent-hover`, `--color-slider-fill` (see `core.dark` in `src/extensions/builtin.tsx` for the canonical list).

## IDE-like Philosophy

SafeLight's extension system is designed with the same philosophy that powers modern IDEs:

- **Replaceable Components**: Just as IDEs let you replace terminals, debuggers, and file explorers, SafeLight lets you replace any panel or tool
- **Contribution-based Architecture**: Extensions contribute specific functionality through well-defined APIs, ensuring stability and compatibility
- **Hot Reloading**: Install and activate extensions without restarting, enabling rapid iteration
- **Community-driven**: Extensions are distributed through GitHub, making it easy to discover, share, and contribute
- **Open API**: Full access to SafeLight's state stores, rendering pipeline, and UI components

This architecture transforms SafeLight from a fixed photo editor into a customizable platform that adapts to your unique workflow.
