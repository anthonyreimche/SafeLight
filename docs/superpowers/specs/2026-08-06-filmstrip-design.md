# Filmstrip extension — design

2026-08-06 · branch `100-extension-film-strip`

## Goal

An industry-competitive filmstrip for the Develop module — the strip of photo
thumbnails Lightroom, Capture One, darktable et al. dock under the canvas — as
an installable extension, supporting both horizontal (bottom) and vertical
(left/right rail) docking.

## What exists / what's missing

- The dock (`src/extensions/dock.tsx`) supports **left/right rails only**; a
  true reflowing bottom strip is impossible today (a `develop-canvas-overlay`
  would float over and occlude the image).
- Panels in side rails render at natural height (the rail scrolls); a strip
  needs to **fill** the rail and scroll internally.
- Extensions have no API for the grid's visible photo order
  (`visiblePhotos(...)` + grid filters + custom sorts) and no way to know which
  side their panel is docked on.
- Everything else needed already exists: `api.components.Thumbnail` (lazy
  thumbnail loading, badges), `useCatalogStore` selection actions
  (`select`/`toggleSelect`/`selectRange`/`setRating`), core ←/→ photo
  navigation, `api.dock.togglePanel`, keybindings.

## Approaches considered

1. **Canvas-overlay strip** (extension-only, no core changes) — floats over the
   photo, occludes it, unmounts when no photo is open. Rejected: not
   industry-competitive.
2. **Vertical rail panel only** — works today but no horizontal mode. Rejected:
   the classic filmstrip is horizontal.
3. **Bottom dock rail in core + extension panel** — chosen. The dock gains a
   first-class bottom rail (any panel can use it), and the filmstrip is a
   normal dockable/floatable/draggable panel. Smallest API surface that makes
   the feature real, and the new capabilities are general-purpose.

## Core changes (Safelight)

### Dock: bottom rails (`dock.tsx`, `types.ts`)

- `RailState.side` / `LayoutRail.side` / `PanelDockDefault.direction` gain
  `"bottom"`. Bottom rails size by a new `height` field (`width` for side
  rails); clamped 56–320 px, default 112.
- Bottom rails are **opt-in**: `PanelContribution.allowBottomDock` (implied by a
  bottom `defaultDock`) gates every bottom drop target, so panels laid out as
  vertical columns behave exactly as before and can't be squeezed into a strip.
  Saved layouts carrying one are pruned on load; unregistered ids are left
  alone (their extension may still be loading).
- `DockHost` becomes a column: `[left rails | main | right rails]` row, then
  bottom rails spanning full width (Lightroom-style), above the status bar.
- Bottom rails render panels side-by-side, each a full-height column
  (header + body that fills); resize handle on the rail's top edge.
- `hitTest`/`DropTarget`: indicator geometry unified to one `line: {x,y,w,h}`
  box; bottom drop zones — container bottom edge (new outermost bottom rail),
  inside a bottom rail (insertion by horizontal midpoint), strip just inside
  main's bottom edge (new innermost bottom rail).
- `toggleDockPanel` open-path improvement: a closed panel with a `defaultDock`
  matching the current module re-docks there (append to existing rail on that
  side, else create one) instead of always floating. View ▸ Filmstrip / F6
  therefore lands the strip at the bottom on first use.

### Fill panels

`PanelContribution.fill?: boolean` — in a side rail, a non-collapsed fill
panel stretches to the remaining rail height (rail stops scrolling; body gets
`flex-1 min-h-0 overflow-hidden` and manages its own scrolling). Bottom-rail
panels always fill. Floating panels keep the existing `max-h-[70vh]` body.

### Placement hook

`api.dock.usePanelPlacement(): { side: "left" | "right" | "bottom" | "float" }`
— React context provided by Rail/BottomRail/FloatingPanel so a panel can adapt
its layout to where it's docked. Defaults to `"float"` outside a dock.

### Visible photos hook

`api.catalog.useVisiblePhotos(): CatalogPhoto[]` — reactive hook returning the
exact filtered+sorted list the Library grid shows (folder, filter, sort,
extension grid filters, extension sorts, subfolder pref). Implemented in
`photo-navigation.ts` next to `visibleList()`; `LibraryGrid` refactors onto it
so there is one derivation.

Docs updated: `docs/dev/api/ui-shell.md` (bottom direction, fill, placement
hook), catalog/stores doc (useVisiblePhotos).

## Extension (`D:\Repositories\Safelight Project\Filmstrip`)

Standalone MIT repo, built with rolldown (React external, `api.react` at
runtime), `dist/index.js` committed — same conventions as Advanced EXIF Tools.

- `safelight.json`: id `com.safelight.filmstrip`, main `dist/index.js`,
  categories `["Develop"]`, `minAppVersion` = the core release carrying these
  APIs.
- `activate(api)`:
  - `registerPanel({ id: "com.safelight.filmstrip.panel", title: "Filmstrip",
    fill: true, defaultDock: { module: "develop", direction: "bottom",
    height: 112 } })`
  - `registerKeybinding` — F6 toggles the panel (Lightroom's shortcut),
    category General.
- Panel component:
  - Orientation from `usePanelPlacement()`: bottom → horizontal strip; side
    rail → vertical; floating → vertical with a fixed 420 px height.
  - Photos from `useVisiblePhotos()`; active/selected from `useCatalogStore`.
  - **Virtualized**: windowed absolute-position cells inside one scroll
    container (pure helpers in `strip-math.ts`, node-tested). Cell size =
    rail cross-axis minus padding/scrollbar, so resizing the rail resizes the
    thumbnails — exactly how Lightroom behaves.
  - Cells are `api.components.Thumbnail` (lazy loading, selection rings,
    rating/flag/label badges, virtual-copy names for free).
  - Click = select, Ctrl-click = toggle, Shift-click = range (visible order),
    double-click = open in Develop; hover rating editable via the built-in
    badge. Core ←/→ already steps photos; the strip auto-scrolls the active
    photo into view.
  - Vertical mouse wheel scrolls a horizontal strip.
  - Empty state: muted "No photos".
  - Styling: inline styles + `api.ui.tokens` only (runtime bundles get no
    Tailwind).

## Error handling & testing

- Panel crashes are contained by the dock's `PanelErrorBoundary`.
- Old app versions reading a saved layout with a bottom rail simply don't
  render it (panels stay in `open`); no migration needed.
- Core verified by `tsc` + existing vitest unit/dom suites (visible-photos has
  a suite; dock drag paths are pointer-driven and stay manually verified).
  Extension: strip-math windowing functions node-tested; bundle built and
  smoke-checked. Final in-app verification (Electron loads `dist/`) is done by
  Anthony per the usual flow.

## Follow-up: culling parity + list view (v1.1.0)

Added after the first pass, so the strip is a culling surface rather than only
a navigator:

- **`src/modules/library/photo-actions.tsx`** — the grid's right-click menu and
  its dialogs (rename, copy settings) extracted into `usePhotoActions()`.
  `LibraryGrid` consumes it, and it's exposed as `api.catalog.usePhotoActions`,
  so the strip's menu carries the built-ins *and* every `registerGridMenuItem`
  contribution. F2's `sl-rename-photo` event is answered by the most recently
  mounted surface, so two surfaces never raise two dialogs.
- **`useCullingShortcuts(options?)`** — now one shared, ref-counted window
  listener instead of one per mount (the grid and a floated strip can coexist),
  exposed as `api.catalog.useCullingShortcuts`. `sizeSteps: false` leaves `-`/`=`
  to the grid. Develop's global handler defers prev/next and rotate while any
  surface is mounted (`cullingShortcutsMounted()`), and Delete stays with a
  selected mask component.
- **`PhotoListRow`** — `LibraryListRow` gains `compact` (drops the dimension and
  camera columns for narrow rails) and is exposed via `api.components`.
- Extension: a **List view** setting registered via `registerSettings` (custom
  section component, since the field is layout-dependent — it renders only while
  the strip is docked vertically; a bottom rail has no room for rows). The panel
  publishes its placement to a small module store because Preferences renders
  outside the dock and can't read the placement context. The value persists
  through `api.settings` and is read with `useSyncExternalStore`.

## Out of scope (deliberate)

- Drag-reorder, per-strip filtering/sort UI, edited-preview thumbnails (plain
  compressed previews by design), auto-open on install.
