# Building Extensions

Safelight's extension system is inspired by modern IDE plugin architectures. The core app is a **blind orchestrator**: it doesn't know what panels, themes, display transforms, or metadata sidecars exist — it exposes contribution points, and extensions fill them. Every panel in Safelight, including the histogram, is a registered contribution, and every stock panel is a pre-installed extension that can be disabled and replaced by a community version. Anyone can publish an extension as a GitHub repo.

## In this guide

| Page | Covers |
|---|---|
| **This page** | The orchestrator model, repo anatomy, the manifest, and the build |
| [Contribution Types](contribution-types.md) | What an extension can register, with worked examples |
| [Debugging](debugging.md) | The in-app Developer Tools, live-loading, and common load errors |
| [Publishing](publishing.md) | Store listing — thumbnail, README, and metadata |

For exact type signatures, see the [API Reference](../api/README.md); `src/extensions/types.ts` is the source of truth. To *install and manage* extensions as a user, see [Using Extensions](../../user/using-extensions.md).

## Anatomy of an extension

A repo needs two things: a `safelight.json` manifest at the root, and a prebuilt ESM bundle (commit your `dist/`, or attach it to the branch you install from). Safelight installs an extension by downloading the repo and importing `main` **as-is** — there is no build step on the user's machine.

### Repo layout

How much structure you need depends on whether you have a build step.

**No build (themes and small panels).** Hand-write a single ESM file and point `main` straight at it. This is the *entire* [Slate theme](https://github.com/anthonyreimche/Slate-Theme-for-Safelight) — three files:

```
safelight-theme-slate/
├─ safelight.json     # manifest — "main": "index.js"
├─ index.js           # the bundle; exports activate(api)
└─ README.md          # rendered in the store detail view
```

```js
// index.js — Slate, a cool blue-gray dark theme.
export function activate(api) {
  api.registerTheme({
    id: "theme-slate.theme",
    name: "Slate",
    colorScheme: "dark",
    vars: {
      "--color-surface-0": "#0d1117",
      "--color-accent": "#58a6ff",
      // …the rest of the theme's CSS variables
    },
  });
}
```

```json
// safelight.json
{ "id": "theme-slate", "name": "Slate", "version": "1.0.0",
  "description": "Cool blue-gray dark theme.", "author": "Tokyo", "main": "index.js" }
```

**With a build (anything using JSX/TypeScript or npm dependencies).** Author in `src/`, bundle to `dist/`, and commit `dist/` so installs need no toolchain:

```
my-extension/
├─ safelight.json       # "main": "dist/index.js"
├─ src/
│  └─ index.js          # your source
├─ dist/
│  └─ index.js          # built ESM bundle — COMMIT THIS (or attach to a release)
├─ rolldown.config.mjs  # bundler config
├─ package.json
└─ README.md
```

Three build invariants, regardless of bundler:

- **Emit one self-contained ESM file** with an `activate(api)` export (and optional `deactivate()`).
- **Leave React external.** Safelight injects its own instance as `api.react`; a second copy breaks hooks. The example extensions build UI with `React.createElement` off `api.react` rather than JSX imports. The bundled examples use [rolldown](https://rolldown.rs/), but any bundler that can mark React external works:

  ```js
  // rolldown.config.mjs
  export default {
    input: "src/index.js",
    external: ["react", "react-dom", "react/jsx-runtime"],
    output: { file: "dist/index.js", format: "esm" },
  };
  ```

- **Commit the built `dist/`** (or attach it to the branch/release you tell users to install from) — the store fetches files, it does not run your build.

Finally, **tag the GitHub repo with the `safelight-extension` topic** so it appears in the in-app store, and (optionally) add an [icon / og:image](publishing.md) for a good thumbnail.

### Manifest

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
  "minAppVersion": "2.0.0",
  "permissions": { "network": ["https://api.example.com"], "reason": "Syncs presets to your account." }
}
```

Only `id`, `name`, `version`, and `main` are required; everything else (`description`, `author`, `icon`, `categories`, `keywords`, `homepage`, `repository`, `screenshots`, `license`, `minAppVersion`, `permissions`) is optional and enriches the store detail view. `minAppVersion` is the **minimum supported Safelight version** — the oldest build the extension works on. Installs (and updates) on an older build are refused before any files are written, and the app reports the version it needs; the extension's detail page also flags the mismatch. Set it whenever you depend on an API or contribution point added in a specific release. Versions are compared as dotted `major.minor.patch` (a `v` prefix and missing parts are tolerated).

**`permissions`** declares capabilities the extension needs, shown to the user on its store page. Only `network` is **enforced**: the listed HTTPS origins are added to the app's content-security policy, so the extension can reach **only** the hosts it declares — any other host is blocked. A new declaration takes effect on the next app launch (installing a network-using extension prompts the user to restart before it can connect). Because extensions run in-app, ambient access to the user's catalog and files is **not** confined by this field — it is a consent/disclosure layer, not a sandbox. See [Extensions — safety & terms](../../../EXTENSIONS.md).

### The entry bundle

The bundle must export `activate(api)` (and optionally `deactivate()`). **Do not bundle React** — use `api.react`, the app's own instance.

```js
export function activate(api) {
  const { react: React, stores } = api;

  function WaveformPanel() {
    const histogram = stores.useDevelopStore((s) => s.histogram);
    return React.createElement("div", { /* ... */ });
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

The `api` object is a scoped [`SafelightAPI`](../api/README.md). Its UI building blocks (Slider, Panel, theming tokens, building buttons) are in [UI Components](../api/components.md); the full list of what you can register is in [Contribution Types](contribution-types.md).

> **Styling note:** runtime-loaded bundles are not scanned by Tailwind, so arbitrary Tailwind utility classes won't have CSS generated for them. Use the theme CSS variables (`var(--color-surface-1)`, etc.) with inline styles, or reuse `api.components` (which are already themed). See [UI Components → Theming tokens](../api/components.md#theming-tokens).

## Tips

- Namespace contribution ids with your extension id (`com.example.panel-name`); `core.*` is reserved for built-ins.
- To *replace* a stock panel, register your own and tell users to disable the built-in (e.g. "Histogram") in the Extensions panel.
- Keep bundles dependency-light. React, the [component kit](../api/components.md), and [state](../api/stores.md) come from the API.
- Style with theme CSS variables and `api.components`, not ad-hoc Tailwind classes (they aren't compiled for runtime bundles).
- Tag the repo with the `safelight-extension` topic so it appears in the in-app store.
