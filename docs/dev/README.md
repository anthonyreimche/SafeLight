# Developer Docs

For extension authors and core contributors.

## Building extensions

The fastest way to extend Safelight — no fork required. Ship a panel, tool, theme, or display transform as a GitHub repo and users install it from the in-app store.

- [Building Extensions](extensions/README.md) — orchestrator model, repo anatomy, manifest, and the build
- [Contribution Types](extensions/contribution-types.md) — what you can register, with examples
- [Debugging](extensions/debugging.md) — the in-app Developer Tools and live-load loop
- [Publishing](extensions/publishing.md) — store listing, thumbnail, README, metadata

## API reference

The complete `SafelightAPI` surface, split by topic.

- [API Overview](api/README.md) — the `SafelightAPI` object and imperative controls
- [UI Shell](api/ui-shell.md) — modules, panels, slots, layouts
- [UI Components](api/components.md) — the component kit (Slider, Panel, …), theming tokens, building buttons
- [Contribution Types](api/contributions.md) — signatures for every `register*` call
- [State Stores & Tools](api/stores.md) — `api.stores`, the brush/mask/retouch model, `api.develop`
- [Core Data Types](api/types.md) — `CatalogPhoto`, `DevelopParams`
- [Subsystems](api/subsystems.md) — storage, rendering, RAW, presets, export, broadcast, keybindings, Electron bridge

## Working on the core

- [Architecture](architecture.md) — the blind-orchestrator model, render path, RAW pipeline, Electron shell
- [Contributing](contributing.md) — setup, code style, where things live, workflow

New to the project? Read [Architecture](architecture.md) first — the "everything is an extension" model shapes everything else.
