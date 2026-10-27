# Building Extensions

An extension is a GitHub repo with a `safelight.json` manifest and a prebuilt ES module. This page covers the repo layout, the manifest, the build and the store listing. For how the core runs extensions, read [How Safelight works](../concepts.md). For GPU code, read [How a photo is rendered](../rendering.md).

Next: [Contribution Types](contribution-types.md) (every `register*` call), [Debugging](debugging.md) (Developer Tools, live-loading, load errors), [Publishing](publishing.md) (store page and releases). Exact signatures are in the [API Reference](../api/README.md) and `src/extensions/types.ts`. Users install extensions as described in [Using Extensions](../../user/using-extensions.md).

## Anatomy of an extension

Safelight installs an extension by downloading the repo or its release zip and importing `main` as it is. Nothing is built on the user's machine.

### Repo layout

**No build** (themes, small panels). Hand-write one ESM file and point `main` at it. This is the whole [Slate theme](https://github.com/anthonyreimche/Slate-Theme):

```
safelight-theme-slate/
├─ safelight.json     # "main": "index.js"
├─ index.js           # exports activate(api)
└─ README.md          # shown on the store page
```

```js
// index.js
export function activate(api) {
  api.registerTheme({
    id: "theme-slate.theme",
    name: "Slate",
    colorScheme: "dark",
    vars: { "--color-surface-0": "#0d1117", "--color-accent": "#58a6ff" /* ... */ },
  });
}
```

**With a build** (JSX, TypeScript or npm dependencies). Author in `src/`, bundle to `dist/`, ship `dist/`:

```
my-extension/
├─ safelight.json       # "main": "dist/index.js"
├─ src/index.js         # your source
├─ dist/index.js        # built bundle: zip it into a release, or commit it
├─ rolldown.config.mjs
├─ package.json
└─ README.md
```

```js
// rolldown.config.mjs (any bundler that can mark React external works)
export default {
  input: "src/index.js",
  external: ["react", "react-dom", "react/jsx-runtime"],
  output: { file: "dist/index.js", format: "esm" },
};
```

Build rules, whatever the bundler:

- **One self-contained ESM file** that exports `activate(api)` and optionally `deactivate()`.
- **React stays external.** Use `api.react`. A second copy of React breaks hooks.
- **Ship the built bundle.** Attach a zip to a [GitHub Release](publishing.md#releases-and-versions) or commit `dist/`. The store downloads files. It never runs your build.

### Manifest

```json
{
  "id": "com.example.histogram-pro",
  "name": "Histogram Pro",
  "version": "1.0.0",
  "description": "RGB parade + waveform histogram",
  "author": "You <you@example.com>",
  "main": "dist/index.js",
  "categories": ["Detail"],
  "keywords": ["histogram", "waveform"],
  "license": "MIT",
  "minAppVersion": "2.0.0",
  "permissions": { "network": ["https://api.example.com"], "reason": "Syncs presets to your account." }
}
```

`id`, `name`, `version` and `main` are required. The rest is optional: `description`, `author`, `icon`, `categories`, `keywords`, `homepage`, `repository`, `screenshots`, `worksWith`, `license`, `minAppVersion`, `permissions`.

- **`id`** names the extension and its install folder. It starts with a letter or digit and holds only letters, digits, `.`, `_` and `-`. `core` and anything under `core.`, in any letter case, is reserved for built-ins and refused (`corel` or `my.core` are fine). Pick one that is yours alone, such as `com.example.histogram-pro`.
- **`minAppVersion`** is the oldest Safelight the extension works on. Set it whenever you use an API added in a specific release. Installs and updates on an older build are refused before any files are written, and the installed version keeps running. A newer version that needs a newer Safelight is shown as needing it and never auto-installed. Versions compare as `major.minor.patch` (a `v` prefix is fine).
- **`permissions.network`** lists the HTTPS origins the extension may reach. Only this field is enforced: the origins join the app's content-security policy at the next launch, and every other host is blocked. It does not limit access to the catalog or files. See [EXTENSIONS.md](../../../EXTENSIONS.md).
- An update that installs but fails to start is rolled back, and auto-update won't retry it until you publish a newer version.

### Store listing

Tag the GitHub repo with the `safelight-extension` topic so it appears in the in-app store. The store groups extensions by purpose: add one to three of these topics beside it.

| Topic | Category |
|---|---|
| `safelight-library` | Library |
| `safelight-metadata` | Metadata |
| `safelight-tone` | Tone |
| `safelight-color` | Colour |
| `safelight-look` | Looks |
| `safelight-detail` | Detail and repair |
| `safelight-workflow` | Workflow |
| `safelight-export` | Export and sharing |
| `safelight-preset` | Presets |
| `safelight-theme` | Themes and interface |

- `categories` in `safelight.json` overrides the topics when a value names a category by slug or label, in any case. Values that name none are ignored.
- `safelight-module`, `safelight-pipeline` and `safelight-panel` aren't categories. The store shows the first one present as a badge (Module, Processing, Panel).
- The store also searches `keywords`. The category list lives in [safelight-registry's `categories.json`](https://github.com/anthonyreimche/safelight-registry/blob/main/categories.json).
- `screenshots` (at most 6, https URLs or repo paths) show on your store page. `worksWith` (at most 6 `"owner/repo"`) lists extensions yours pairs with. Yours appears on theirs when it is verified.

### The entry bundle

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
    fields: [{ key: "opacity", label: "Opacity", type: "number", default: 80, min: 10, max: 100 }],
  });
  api.settings.onChange((key, value) => {/* re-render with the new value */});
}

export function deactivate() {/* tear down listeners and side effects */}
```

Notes:

- Prefix contribution ids with your extension id (`com.example.panel-name`).
- Arbitrary Tailwind classes have no CSS in runtime bundles. Use `api.ui`, `api.components` or theme CSS variables with inline styles. See [Theming tokens](../api/components.md#theming-tokens).
- Keep bundles small. React, the [component kit](../api/components.md) and [app state](../api/stores.md) come from the API.
- To replace a stock panel, register your own and tell users to disable the built-in in the Extensions panel.
