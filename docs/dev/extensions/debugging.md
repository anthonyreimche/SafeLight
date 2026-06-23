# Developing & Debugging

← [Building Extensions](README.md)

Safelight ships an in-app **Developer Tools** extension that is **disabled by default** (it's a built-in under Extensions ▸ Installed). Enabling it installs console/error capture and unlocks the live-loading workflow below; disabling it tears all of that down so a normal user's console stays untouched. Enable it once, then reach for it whenever you build an extension.

## Enable it

Extensions panel (**Ctrl+Shift+X**) ▸ **Installed** ▸ toggle **Developer Tools** on. Open the panel from **View ▸ Developer Tools** or **Ctrl+Alt+I**. It docks like any panel and can be popped out into its own OS window (the ⧉ button).

The panel has five tabs:

- **Console** — captured `console.*` output with level filters, text search, and an inline **REPL** (evaluate JS against the running app; `window.safelight` is the extension API, handy for poking at stores). Note: the Electron shell ships a strict CSP without `unsafe-eval`, so the REPL's `eval` is refused there — use the **Native** tab to open Chrome DevTools instead.
- **Issues** — warnings and errors only, with a count badge.
- **System** — app/runtime versions, platform, cross-origin-isolation status (affects RAW decode), WebGL vendor/renderer/limits, JS heap, and (desktop) GPU feature status.
- **Storage** — a `localStorage` browser/editor (Safelight keys are `sl_*`).
- **Native** (desktop only) — open/dock/toggle the real Chrome DevTools, reload (soft/hard), and per-process CPU/memory metrics.

## Live-load from a folder (the iterate loop)

Reinstalling from GitHub on every change is slow. Instead, point Safelight at a **local folder of built extensions** and it loads them live — **desktop app only** (it reads bundle bytes over the native filesystem bridge).

1. **Extensions ▸ Dev** (or **Preferences ▸ Developer Tools**) ▸ **Choose folder…**
2. Each immediate subfolder of that folder is treated as one extension — the *same* `safelight.json` + built-bundle layout an installed extension uses:
   ```
   my-dev-folder/
   ├─ theme-slate/        →  safelight.json + index.js
   └─ my-extension/       →  safelight.json + dist/index.js
   ```
3. Edit and rebuild your extension, then hit **↻ Reload** on its row (or **Rescan** for the whole folder). The old instance is deactivated and its contributions swept before the new one activates — no app restart.

The Dev tab shows each discovered extension's load status; a failed load shows the error inline. The configured path lives in the Developer Tools extension's own settings, so disabling that extension unloads every dev extension and forgets the path.

## Common load errors

- **`safelight.json is missing 'id' or 'main'`** — both are required; check the manifest path and JSON validity.
- **`bundle has no activate(api) export`** — your bundle must `export function activate(api)`. Usually means React wasn't left external (so the bundle threw on import) or the entry file is wrong.
- **Blank/unstyled UI** — Tailwind utility classes aren't compiled for runtime bundles. Use theme CSS variables + inline styles, or `api.components`. See [UI Components → Theming tokens](../api/components.md#theming-tokens).
- **Hooks crash (`Invalid hook call`)** — you bundled your own React. Mark `react`/`react-dom`/`react/jsx-runtime` external and use `api.react`.
