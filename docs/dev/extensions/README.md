# Building Extensions

An extension is a folder with a `safelight.json` manifest and a ready-to-run ES module. To share it, you put that folder in a GitHub repo. This page covers the layout, the manifest, adding a build step and the store listing. If you haven't made one yet, [Your first extension](first-extension.md) gets one running in about fifteen minutes. For how the core runs extensions, read [How Safelight works](../concepts.md). For GPU code, read [How a photo is rendered](../rendering.md).

Next: [Contribution Types](contribution-types.md) (every `register*` call), [Debugging](debugging.md) (Developer Tools, live-loading, load errors), [Publishing](publishing.md) (store page and releases). Exact signatures are in the [API Reference](../api/README.md) and [`src/extensions/api/`](../../../src/extensions/api/). Users install extensions as described in [Using Extensions](../../user/using-extensions.md).

## Anatomy of an extension

Safelight installs an extension by downloading the repo or its release zip and importing `main` as it is. Nothing is built on the user's machine.

### No build

Themes and small panels can be one hand-written JavaScript file. Point `main` at it. This is the whole [Slate theme](https://github.com/anthonyreimche/Slate-Theme):

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

Without JSX, build UI with `api.react.createElement`, as [Your first extension](first-extension.md) does.

### With a build

Add a build step when you want TypeScript, JSX, several source files or npm packages. Author in `src/`, bundle to `dist/`, and ship `dist/`.

The quickest start is the [extension template](https://github.com/anthonyreimche/Extension-Template). It has everything this section describes already set up: Vite, TypeScript and JSX, the API's [types](#types), a panel and a stage to start from, unit tests against a small fake API, and a [release workflow](publishing.md#releases-and-versions). Copy it, then run `npm install` and `npm run check`. Its README lists what to rename. The rest of this section explains what the template does, for when you set up a build yourself.

```
my-extension/
├─ safelight.json       # "main": "dist/index.js"
├─ src/
│  ├─ index.tsx         # exports activate(api)
│  ├─ rt.ts             # holds the host's React
│  └─ safelight.d.ts    # the API's types (see Types below)
├─ dist/index.js        # built bundle: zip it into a release, or commit it
├─ vite.config.ts
├─ tsconfig.json
└─ package.json
```

Safelight imports your bundle as it is, without an import map, so **the bundle must not import anything at runtime**, React included. A bundle that keeps `import … from "react"` or `"react/jsx-runtime"` fails to load. Instead, compile JSX to `React.createElement` and point `React` at the copy Safelight passes in:

```ts
// src/rt.ts
import type { SafelightAPI } from "./safelight";

export let React!: SafelightAPI["react"];
export let api!: SafelightAPI;

export function initRuntime(host: SafelightAPI): void {
  api = host;
  React = host.react;
}
```

```tsx
// src/index.tsx
import { React, api, initRuntime } from "./rt";
import type { SafelightAPI } from "./safelight";

function Hello() {
  const [n, setN] = React.useState(0);
  return <api.ui.Button onClick={() => setN(n + 1)}>Clicked {n} times</api.ui.Button>;
}

export function activate(host: SafelightAPI): void {
  initRuntime(host);
  host.registerPanel({
    id: "com.example.hello.panel",
    title: "Hello",
    component: Hello,
    defaultDock: { module: "develop", direction: "right" },
  });
}
```

Every file with JSX imports `React` from `./rt`. The build config tells the compiler to use it:

```ts
// vite.config.ts (Vite 8)
import { defineConfig } from "vite";

export default defineConfig({
  oxc: { jsx: { runtime: "classic", pragma: "React.createElement", pragmaFrag: "React.Fragment" } },
  build: {
    lib: { entry: "src/index.tsx", formats: ["es"], fileName: "index" },
    rollupOptions: { external: ["react", "react-dom"] },
    outDir: "dist",
  },
});
```

```jsonc
// tsconfig.json (the parts that matter)
{
  "compilerOptions": {
    "jsx": "react",
    "jsxFactory": "React.createElement",
    "jsxFragmentFactory": "React.Fragment",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true
  }
}
```

On Vite 7 or earlier, replace the `oxc` line with `esbuild: { jsx: "transform", jsxFactory: "React.createElement", jsxFragment: "React.Fragment" }`. Any other bundler works the same way: one ES module out, classic JSX, nothing imported at runtime.

Build rules, whatever the bundler:

- **One self-contained ES module** that exports `activate(api)` and optionally `deactivate()`.
- **No runtime imports.** React comes from `api.react`. Bundling your own copy breaks hooks, and leaving an import in fails the load. Listing React as external only keeps a stray import from pulling a copy in; your code still shouldn't import it at runtime.
- **Ship the built bundle.** Attach a zip to a [GitHub Release](publishing.md#releases-and-versions) or commit `dist/`. The store downloads files. It never runs your build.

[Effects](https://github.com/anthonyreimche/Effects) is a real repo built this way, with tests. Most older extensions carry a hand-written `safelight.d.ts` with only the parts they use, rather than the generated file.

### Types

Safelight's whole extension API is in one generated file, [`extension-types/safelight.d.ts`](../../../extension-types/safelight.d.ts). Copy it into your extension as `src/safelight.d.ts` and import from it with `import type`. `SafelightAPI` is the `api` object, and each `register*` call takes one of the `*Contribution` types. The file also needs React's, React DOM's and zustand's types, so install `@types/react`, `@types/react-dom` and `zustand` as dev dependencies. The [extension template](https://github.com/anthonyreimche/Extension-Template) already has all of this, and its `npm run update-types` downloads the newest copy.

The file is generated from [`src/extensions/api/`](../../../src/extensions/api/) by [`scripts/build-extension-types.mjs`](../../../scripts/build-extension-types.mjs), so it always matches the app's source. Don't edit your copy: update it instead. An extension that keeps a hand-copied part of the API can switch to it, and TypeScript then checks it against the real shapes. There's no types package on npm yet.

When you update the file, set `minAppVersion` to the oldest Safelight that has every API you use.

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
- **`permissions.network`** lists the HTTPS origins the extension may reach. Only this field is enforced: the origins join the app's content-security policy at the next launch, and every other host is blocked. It does not limit access to the catalogue or files. See [EXTENSIONS.md](../../../EXTENSIONS.md).
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

- Prefix contribution ids with your extension id (`com.example.histogram-pro.waveform`).
- Arbitrary Tailwind classes have no CSS in runtime bundles. Use `api.ui`, `api.components` or theme CSS variables with inline styles. See [Theming tokens](../api/components.md#theming-tokens).
- Keep bundles small. React, the [component kit](../api/components.md) and [app state](../api/stores.md) come from the API.
- To replace a stock panel, register your own and tell users to disable the built-in in the Extensions panel.

## Languages

Safelight's interface is in English only for now, and the API has no translation support or locale setting. An extension that wants to offer other languages picks its own strings, for example from `navigator.language`, and keeps them in its own code. The manifest's `name` and `description` and the README on your store page are shown as written.

## Working with a coding agent

Coding agents can write Safelight extensions, and nothing here requires one. If you use one, give it [Your first extension](first-extension.md), the [recipe](recipes.md) closest to your idea, and the generated types file, [`extension-types/safelight.d.ts`](../../../extension-types/safelight.d.ts), which the [extension template](https://github.com/anthonyreimche/Extension-Template) already includes. Tell it the two rules agents most often miss: the bundle must not import anything at runtime, and a stage must leave the image unchanged at its defaults. Then test the result in the dev folder yourself, because you're the one publishing it.
