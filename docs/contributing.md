# Contributing

Thanks for your interest in contributing to Safelight! There are two main ways to contribute: improving the core app, and building extensions.

## Development Setup

1. Fork and clone the repository
2. `npm install`
3. `npm run dev` — browser dev server (Chromium-based browser recommended), or
   `npm run electron:dev` — desktop window
4. `npm run build` — type-check and production build; `npm run build:electron` — Windows installer

Node.js 18+ required. There is no test suite yet; changes are verified by building and exercising the app.

## Code Style

- TypeScript everywhere; keep types in `src/catalog/types.ts` (core data) or alongside the feature
- Follow existing patterns — Zustand stores for state, panels as small focused components, comments explaining *why* at the top of each file
- Keep functions small; prefer pure helpers (see `src/rendering/` and `src/raw/`) that are easy to reason about

## Where Things Live

- `src/catalog/` — photo records, EXIF, edit params, storage interface
- `src/project/` — project folders and `.safelight/` persistence
- `src/raw/` — RAW decoding (libraw-wasm adapter, TIFF/CFA, cache)
- `src/modules/` — library, develop (and its panels), export
- `src/extensions/` — registry, host API, loader, docking, themes, built-ins
- `src/rendering/` — WebGL renderer, shaders, image math
- `src/state/` — Zustand stores, broadcast, keybindings
- `electron/` — desktop shell

See [Architecture](architecture.md) for the full picture.

## Building Extensions Instead

If your feature is a new panel, theme, or tool, consider shipping it as an extension rather than a core change — no fork required, and users can install it straight from your GitHub repo. See [Extensions](extensions.md) and the [API reference](api-documentation.md). Tag the repo with the `safelight-extension` topic so it appears in the in-app browser.

## Workflow

1. Branch from `main`: `feature/<name>` or `fix/<description>`
2. Implement, keeping commits focused
3. Verify: `npm run build` passes; test in the browser and (for anything touching files, RAW, or GPU paths) the Electron build; test keyboard shortcuts and multi-window sync if relevant
4. Open a pull request describing what and why, with screenshots for UI changes and references to related issues

Commit message style: `feat: …`, `fix: …`, `docs: …`, `refactor: …`.

## Areas Where Help Is Wanted

- Red eye correction
- Image compare view
- B&W and HDR image support
- HDR / focus stacking and photo merge
- Batch editing
- AI masking via ONNX.js (Select Subject, Sky)
- Lightroom catalog import (sql.js)
- Mobile-responsive viewing
- Camera profiles / base tuning (the Tuning panel is currently a stub)
- Extension marketplace, templates, and scaffolding
- macOS / Linux desktop builds
- Tests

## Questions

Open a GitHub issue for questions or to discuss an idea before building it.
