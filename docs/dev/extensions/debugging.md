# Developing & Debugging

← [Building Extensions](README.md)

Safelight ships an in-app **Developer Tools** extension, **disabled by default** (a built-in under Extensions ▸ Installed). Enabling it adds console and error capture and the live-loading workflow below. Disabling it removes all of that, so a normal user's console stays untouched.

## Enable it

Extensions panel (**Ctrl+Shift+X**) ▸ **Installed** ▸ toggle **Developer Tools** on. Open the panel from **View ▸ Developer Tools** or **Ctrl+Alt+I**. It docks like any panel and can be popped out into its own window (the ⧉ button).

The panel has seven tabs:

- **Console**: captured `console.*` output with level filters, search and an inline **REPL** (`window.safelight` is the extension API). The desktop app's content-security policy refuses `eval`, so there the REPL doesn't run: use the **Native** tab to open Chrome DevTools instead.
- **Issues**: warnings and errors only, with a count badge.
- **System**: app and runtime versions, platform, cross-origin isolation (affects RAW decode), WebGL vendor and limits, JS heap, and (desktop) GPU feature status.
- **Storage**: a `localStorage` browser and editor (Safelight keys are `sl_*`).
- **Variables**: every shared variable (`api.variables`) with its writers, subscribers, value and recent history, and an editor for its value.
- **Pipeline**: the develop program the open photo renders with. It lists Safelight's blocks in order, each stage between them (owner, phase, priority, space, whether it reads the current image, its copies inside masks), the conversions between spaces, and every point where the colour is clipped to [0, 1]. The v1/v2/v3 picker shows what another process version runs. With no photo open, or in a popped-out window, it shows default settings. Its "found in GLSL" lines come from a text scan of your inline GLSL and helpers, so they can miss clamps or report false ones.
- **Native** (desktop only): open, dock or toggle Chrome DevTools, soft or hard reload, and per-process CPU and memory.

## Live-load from a folder (the iterate loop)

Reinstalling from GitHub on every change is slow. Instead, point Safelight at a **local folder of built extensions** and it loads them live. **Desktop app only**, since it reads bundles over the native filesystem bridge.

1. **Extensions ▸ Dev** (or **Preferences ▸ Developer Tools**) ▸ **Choose folder…**
2. Each immediate subfolder is one extension, in the same `safelight.json` + built-bundle layout an installed extension uses:
   ```
   my-dev-folder/
   ├─ theme-slate/        →  safelight.json + index.js
   └─ my-extension/       →  safelight.json + dist/index.js
   ```
3. Rebuild your extension, then hit **↻ Reload** on its row (or **Rescan** for the whole folder). The old instance is deactivated and swept before the new one activates. No app restart.

The Dev tab shows each extension's load status, with any error inline. The folder path is stored in Developer Tools' own settings, so disabling Developer Tools unloads every dev extension and forgets the path.

Network access works as for an installed extension: `permissions.network` origins are read when Safelight starts, so choosing a folder or adding a declaration needs one restart. Until then those requests fail (a failed fetch, blank map tiles). The Dev tab lists the origins waiting on a restart.

## Common load errors

- **`safelight.json is missing 'id' or 'main'`**: both are required, and `id` must be text. Check the manifest path and that the JSON is valid.
- **`<id>: extension ids under 'core' are reserved for Safelight`**: pick your own id, such as `com.example.name` (see [Manifest](README.md#manifest)). Installing such an extension from GitHub fails too, with only `Invalid safelight.json`.
- **`bundle has no activate(api) export`**: your bundle must `export function activate(api)`. Usually React wasn't left external (so the bundle threw on import) or `main` points at the wrong file.
- **Blank or unstyled UI**: Tailwind classes aren't compiled for runtime bundles. Use theme CSS variables with inline styles, or `api.components`. See [Theming tokens](../api/components.md#theming-tokens).
- **`Invalid hook call`**: you bundled your own React. Mark `react`, `react-dom` and `react/jsx-runtime` external and use `api.react`.
