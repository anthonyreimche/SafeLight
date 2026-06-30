# Contributing

Thanks for your interest in contributing to Safelight! There are two main ways to contribute: improving the core app, and building extensions.

## Licensing of contributions

Safelight is free software under the [GNU GPL v3](../../LICENSING.md). Contributions use the standard **inbound = outbound** model: when you submit code or documentation, you license it under the same **GPL v3** that covers the project, and **you keep the copyright to your work**. There is no separate contributor agreement to sign.

By opening a pull request you confirm you have the right to contribute the work and to license it under the GPL v3 (i.e. it's your own work, or you have permission to submit it). Extensions you publish in **your own** repository are your work under your own license.

## Development Setup

1. Fork and clone the repository
2. `npm install`
3. `npm run dev` — browser dev server (Chromium-based browser recommended), or
   `npm run electron:dev` — desktop window
4. `npm run build` — type-check and production build; `npm run build:electron` — Windows installer. Distribution packages (Windows + Linux deb/rpm/pacman/AppImage/Flatpak) are built with the one-click scripts in `build-scripts/` (see [Installation](../user/installation.md))

Node.js 20.19+ or 22.12+ required (Vite 8 minimum; Node 22 LTS recommended). There is no test suite yet; changes are verified by building and exercising the app.

## Code Style

- TypeScript everywhere; keep types in `src/catalog/types.ts` (core data) or alongside the feature
- Follow existing patterns — Zustand stores for state, panels as small focused components, comments explaining *why* at the top of each file
- Keep functions small; prefer pure helpers (see `src/rendering/` and `src/raw/`) that are easy to reason about

## Where Things Live

- `src/catalog/` — photo records, EXIF, develop params, storage interface, limits
- `src/project/` — project folders and `.safelight/` persistence
- `src/raw/` — RAW decoding (libraw-wasm adapter, TIFF/CFA, cache)
- `src/lens-profiles/` — Lensfun-derived lens correction database + resolver
- `src/modules/` — library, develop (and its panels), export, loupe
- `src/extensions/` — registry, host API, loader, docking, themes, pipelines, built-ins
- `src/rendering/` — render worker + bridge, WebGL renderer, shaders, image math
- `src/state/` — Zustand stores, broadcast, keybindings
- `electron/` — desktop shell and plugin host

Two things to keep in mind: rendering runs in a **Web Worker on an `OffscreenCanvas`**, so render-path code must not touch the DOM; and the core is a **blind orchestrator** — built-in panels and tools are pre-installed extensions registered through the same `SafelightAPI` external plugins use, so prefer adding a contribution over wiring something directly into the shell. See [Architecture](architecture.md) for the full picture.

## Building Extensions Instead

If your feature is a new panel, theme, or tool, consider shipping it as an extension rather than a core change — no fork required, and users can install it straight from your GitHub repo. See [Building Extensions](extensions/README.md) and the [API reference](api/README.md). Tag the repo with the `safelight-extension` topic so it appears in the in-app browser.

While developing, enable the built-in **Developer Tools** extension (disabled by default) and point it at a local folder of your built extensions to load them live with reload-on-rebuild — no GitHub reinstall per change. See [Developing & debugging](extensions/debugging.md) for the full loop, the in-app console/REPL, and common load errors.

## Workflow

1. Branch from `main`: `feature/<name>` or `fix/<description>`
2. Implement, keeping commits focused
3. Verify: `npm run build` passes; test in the browser and (for anything touching files, RAW, or GPU paths) the Electron build; test keyboard shortcuts and multi-window sync if relevant
4. Open a pull request describing what and why, with screenshots for UI changes and references to related issues

Commit message style: `feat: …`, `fix: …`, `docs: …`, `refactor: …`.

## Where to Start

Safelight is solo-maintained, so help is genuinely welcome. The highest-leverage places to jump in:

- **Build an extension.** Almost all new functionality belongs in an extension rather than the core — panels, tools, themes, display transforms, export targets, metadata sidecars, and process-heavy features all ship this way. See [Building Extensions](extensions/README.md), and tag your repo with the `safelight-extension` topic so it shows up in the in-app store.
- **Pick up an issue.** The live list of wanted work is the [issue tracker](../../issues) — auto-labelled and sorted by priority onto the project board. Planned extensions are the open issues labelled [`extension`](../../issues?q=is%3Aissue+is%3Aopen+label%3Aextension). That list is the source of truth, so nothing here goes stale.
- **Propose an extension.** Open an issue titled `Extension: <name>` — triage auto-labels it `extension` and adds it to the board. See the [Roadmap](../../ROADMAP.md) for how planned work is tracked.
- **Tests and tooling.** There's no automated test suite yet, and extension templates, scaffolding, and CI would all help future contributors.

## Questions

Open a GitHub issue for questions or to discuss an idea before building it.
