# UI Components & Theming

← [API Reference](README.md)

Two kits keep extension UI matching the app exactly. Both are built with the app's own React instance; render them through `api.react` (`React.createElement(api.components.Slider, props)`), never import React yourself.

- **`api.components`** — the app's own composite components: `Panel`, `Slider`, `Histogram`, `CurveEditor`, `Rating`, `Thumbnail`, `PhotoListRow`.
- **`api.ui`** — themed form and layout primitives: `Button`, `Select`, `TextInput`, `NumberInput`, `TextArea`, `Toggle`, `SegmentedControl`, `Field`, `Section`, `Card`, `Badge`, `ProgressBar`, `Stack`, `Row`, plus `tokens`. Prefer these over hand-rolled inline-styled controls.

- [`Panel`](#panel)
- [`Slider`](#slider)
- [`Histogram`](#histogram)
- [`CurveEditor`](#curveeditor)
- [`Rating`](#rating)
- [`Thumbnail`](#thumbnail)
- [`PhotoListRow`](#photolistrow)
- [Photo surfaces: menu and shortcuts](#photo-surfaces-menu-and-shortcuts)
- [`api.ui` primitives](#apiui-primitives)
- [Theming tokens](#theming-tokens)
- [Styling hooks](#styling-hooks)
- [Building custom controls](#building-custom-controls)

## `Panel`

A collapsible, titled section. The open/closed state persists in `localStorage` keyed by `title`. When rendered *inside* a dock panel whose tab already shows the same title, the collapsible header is dropped and the children render directly — so the same component works both standalone and docked.

| Prop | Type | Default | Notes |
|---|---|---|---|
| `title` | `string` | — | Section header; also the persistence key. |
| `defaultOpen` | `boolean` | `true` | Initial state when nothing is persisted. |
| `children` | `ReactNode` | — | Panel body. |

## `Slider`

The standard labelled numeric control used by every Develop adjustment. Drag the track horizontally to scrub; hold **Shift** for fine control (0.2× sensitivity); **double-click** the track to reset to `defaultValue`; type directly into the numeric field. Store updates during a drag are coalesced to one per animation frame, so binding `onChange` straight to a store setter is cheap.

| Prop | Type | Default | Notes |
|---|---|---|---|
| `label` | `string` | — | Label text. Pass `""` to omit the label entirely. |
| `value` | `number` | — | Controlled value. |
| `onChange` | `(value: number) => void` | — | Fires continuously while dragging/typing (rAF-coalesced). Update live state here. |
| `onCommit` | `() => void` | — | Fires once at drag end, field blur, or key-up. **Snapshot to undo history here**, not in `onChange`. |
| `min` | `number` | `-100` | Track minimum. |
| `max` | `number` | `100` | Track maximum. |
| `step` | `number` | `1` | Snap increment; decimal precision is inferred from `step`. |
| `defaultValue` | `number` | `0` | Double-click-to-reset target. |
| `icon` | `string` | — | A `SliderIconContribution` id (e.g. `"core.exposure"`). Renders a 12×12 SVG before the label; nothing if the id is unregistered. |
| `hideValue` | `boolean` | `false` | Hide the editable numeric field. |
| `compact` | `boolean` | `false` | Narrow label + value column, for tight layouts (e.g. color-wheel triplets). |
| `onModifierPreview` | `(active: boolean) => void` | — | Fires `true`/`false` as **Alt** or **Ctrl** is held/released during a drag (Lightroom-style "show me the effect" previews). Toggling the modifier mid-drag re-fires. |

A typed value may exceed `min`/`max` (the field turns red); dragging and arrow keys still clamp to the track range.

## `Histogram`

A live RGB/luma histogram canvas with built-in mode buttons (Lum / RGB / R / G / B, persisted) and optional clipping toggles. Passing `onAdjust` turns it into an **interactive** control: the five tonal zones (`blacks`, `shadows`, `exposure`, `highlights`, `whites`) become draggable, the cursor becomes `ew-resize`, and double-click resets a zone. Incoming data animates (lerps) toward its target rather than jumping.

| Prop | Type | Default | Notes |
|---|---|---|---|
| `data` | `HistogramData \| null` | — | Bins to draw (`r`/`g`/`b`/`luma`, plus optional `extended` clip data). `null` renders empty. |
| `onAdjust` | `(zone, deltaPx, phase) => void` | — | Present ⇒ interactive. `zone: HistogramZone`, `deltaPx: number` (pointer delta from drag start), `phase: "start" \| "move" \| "end"`. |
| `onReset` | `(zone: HistogramZone) => void` | — | Double-click on a zone. |
| `showClipping` | `0 \| 1 \| 2 \| 3` | `0` | Bitfield: `1` = shadow clip overlay, `2` = highlight clip overlay. |
| `onToggleClipping` | `() => void` | — | Renders the "Clip" button when provided. |
| `onSetClipping` | `(mode: 0\|1\|2\|3) => void` | — | Lets clicking the clip-percentage badges toggle each side. |

## `CurveEditor`

A controlled tone-curve editor (the RGB + per-channel point curve used by the Tone Curve panel and per-mask Curve sub-panels). State lives with the caller; the editor only emits changes.

| Prop | Type | Default | Notes |
|---|---|---|---|
| `curves` | `ToneCurves` | — | `{ rgb, red, green, blue }`, each a `CurvePoint[]` of `{x, y}` in 0..1. |
| `onChange` | `(channel: ToneCurveChannel, points: CurvePoint[]) => void` | — | Fires while dragging a point. `channel` is `"rgb" \| "red" \| "green" \| "blue"`. |
| `onCommit` | `() => void` | — | Fires at drag end — snapshot history here. |
| `compact` | `boolean` | `false` | Smaller plot for embedding inside another panel. |

## `Rating`

A 0–5 star control. Clicking the current value resets it to 0. Omit `onChange` for a read-only display.

| Prop | Type | Default | Notes |
|---|---|---|---|
| `value` | `number` | — | 0–5. |
| `onChange` | `(rating: number) => void` | — | Omit to render read-only (stars are disabled). |
| `size` | `"sm" \| "md"` | `"sm"` | Star size. |

## `Thumbnail`

The Library grid cell: cached preview, selection/active border, color-label dot, flag and rating badges, hover filename + inline rating. All callbacks receive the `photo.id` first so a parent can pass one stable function to every cell (the component is `memo`-ized on its props). It shows the import-time compressed preview only — never a per-edit re-render or decode.

| Prop | Type | Notes |
|---|---|---|
| `photo` | `CatalogPhoto` | The record to render. |
| `selected` | `boolean` | Part of a multi-selection (accent ring). |
| `active` | `boolean` | The photo open in Develop/Loupe (brightest ring). |
| `size` | `number` | Cell size in px (square). |
| `onClick` | `(id, e: React.MouseEvent) => void` | — |
| `onDoubleClick` | `(id) => void` | Optional. |
| `onContextMenu` | `(id, e) => void` | Optional. |
| `onRatingChange` | `(id, rating) => void` | Optional — enables the inline star control. |
| `onDragStart` | `(id, e: React.DragEvent) => void` | Optional — makes the cell draggable. |

## `PhotoListRow`

The Library list-view row — the same cell in row form: preview, color-label edge, filename, keyword and flag badges, rating, dimensions and camera. `memo`-ized on its props with the same id-first callbacks as `Thumbnail`.

| Prop | Type | Notes |
|---|---|---|
| `photo` | `CatalogPhoto` | The record to render. |
| `selected` | `boolean` | Part of a multi-selection. |
| `active` | `boolean` | The photo open in Develop/Loupe. |
| `compact` | `boolean` | Optional — drop the dimension and camera columns, for a narrow container (a filmstrip rail). |
| `onClick` | `(id, e: React.MouseEvent) => void` | — |
| `onDoubleClick` | `(id) => void` | — |
| `onContextMenu` | `(id, e) => void` | Optional. |
| `onDragStart` | `(id, e: React.DragEvent) => void` | Optional — makes the row draggable. |

Rows are 53px tall in the Library grid's list view; match that if you want your surface to line up with it.

## Photo surfaces: menu and shortcuts

A surface that lists photos (a filmstrip, an alternative browser) should not reimplement the grid's behavior — three APIs hand you core's own, so extension-contributed menu items and the user's rebound keys are included for free.

```typescript
// The photos the Library grid shows, in its order: folder, filters, sort and
// extension grid filters applied. `without` leaves out named grid filters, for
// a surface that registers a filter and must not narrow itself by it.
const photos = api.catalog.useVisiblePhotos({ without: ["my-ext.in-view"] });

// The Library right-click menu + its dialogs (rename, copy settings).
const { onContextMenu, overlays } = api.catalog.usePhotoActions();
// …wire onContextMenu to each cell, render {overlays} in the surface.

// Ratings, flags, labels, rotate, remove/delete, rename, reveal, select-all,
// prev/next — live while your component is mounted.
api.catalog.useCullingShortcuts({ sizeSteps: false });
```

`onContextMenu` targets the whole selection when the clicked photo is part of one, else selects just it (the grid's rule). The menu carries the built-in actions plus every [`registerGridMenuItem`](contributions.md) contribution.

`useCullingShortcuts` installs one shared, ref-counted listener, so several surfaces on screen at once still act once per press. Pass `sizeSteps: false` when your cells are sized by their container — `-`/`=` then stay with the Library grid. Develop's own bindings keep priority where they overlap: `Delete` belongs to a selected mask component while you're painting one, and prev/next and rotate move to this handler while any surface is mounted so they never fire twice.

`api.catalog.requestThumbnail(photoId)` queues a photo's grid preview through core's on-demand loader, the same call a `Thumbnail` cell makes as it scrolls into view; the preview lands on the record's `thumbnailUrl`. A surface that draws previews itself (a canvas, a map pin) has no cell to trigger the load, so it calls this for each photo it is about to draw whose record has no `thumbnailUrl` yet, as the cell does. For a photo that already has one, the call still reads the preview from disk, and the result is discarded.

## `api.ui` primitives

Runtime-loaded extensions can't use Tailwind (only core is scanned), so these controls are authored in core and rendered inside your extension's subtree. They pick up the active theme and match the Preferences controls exactly. Controlled inputs take a `value` and an `onChange` that receives the new value directly (not an event).

| Component | Props | Notes |
|---|---|---|
| `Button` | `variant?: "primary" \| "secondary" \| "ghost" \| "danger"`, `size?: "sm" \| "md"`, `active?`, `full?`, plus any `<button>` attribute | Defaults: `secondary`, `md`, `type="button"`. `active` renders the selected state (accent fill) whatever the variant; `full` stretches to the container width. |
| `Select` | `value`, `onChange(value)`, `options?: { value, label }[]` or `groups?` (headed sections), `placeholder?`, `disabled?`, `ariaLabel?`, `title?`, `className?` | The app's one dropdown, full-width by default. |
| `TextInput` | `value`, `onChange(value)`, plus any `<input>` attribute | Spellcheck off. |
| `NumberInput` | `value: number`, `onChange(n)`, `width?` (CSS, default `"56px"`), plus any `<input>` attribute | Ignores empty and non-finite entries. For anything a user scrubs, prefer `api.components.Slider`. |
| `TextArea` | `value`, `onChange(value)`, `mono?`, `rows?` (default 4) | `mono` switches to the monospace font, for code or SVG markup. |
| `Toggle` | `checked`, `onChange(checked)`, `label?`, `ariaLabel?` | The app switch (`.sl-switch`), with an optional inline label before it. |
| `SegmentedControl` | `value`, `onChange(value)`, `options: { value, label, title? }[]`, `size?` | A row of mutually exclusive buttons (`.sl-segmented`). |
| `Field` | `label?`, `hint?`, `children` | Stacked label, control and hint, as in Preferences. |
| `Section` | `title`, `right?`, `children` | An uppercase header (with an optional right-aligned control) over its children. |
| `Card` | `children`, `className?` | A bordered, raised container. |
| `Badge` | `children`, `color?` | A small pill; neutral unless `color` sets an explicit background. |
| `ProgressBar` | `value` (0..1) | A thin accent bar. |
| `Stack` / `Row` | `gap?` (px, default 8), `style?`; `Row` also takes `align?`, `justify?`, `wrap?` | Vertical / horizontal flex with a pixel gap. |

`api.ui.tokens` holds the canonical theme variable strings (`tokens.surface2` is `"var(--color-surface-2)"`, `tokens.textMuted`, `tokens.accent`, `tokens.fontMono`, `tokens.fontCode`, …) for the occasional inline style. Use them instead of typing `var(--color-…)` by hand, so a typo can't point at a variable that doesn't exist.

```js
const React = api.react;
const { Button, Field, Select, Stack } = api.ui;

function ExportOptions() {
  const [size, setSize] = React.useState("2048");
  return React.createElement(Stack, { gap: 8 },
    React.createElement(Field, { label: "Long edge", hint: "Pixels on the longer side." },
      React.createElement(Select, {
        value: size,
        onChange: setSize,
        options: [{ value: "2048", label: "2048 px" }, { value: "4096", label: "4096 px" }],
      })),
    React.createElement(Button, { variant: "primary", full: true, onClick: run }, "Export"));
}
```

## Theming tokens

Runtime-loaded bundles are **not scanned by Tailwind**, so arbitrary Tailwind utility classes won't have CSS generated. Build custom UI by reusing `api.components` and `api.ui`, or with inline styles that reference the theme CSS variables below (`api.ui.tokens` has them as ready-made strings) (which *are* always present and re-applied live when the user switches theme). Native form controls (`<input type="range/checkbox/radio">`, `<select>`, `<progress>`) inherit `accent-color: var(--color-slider-fill)` globally, so they already match the theme without extra styling.

Every theme (and an extension's [`ThemeContribution.vars`](contributions.md#themecontribution)) sets this complete surface. Use them as `var(--token)` in inline styles.

| Token | Role |
|---|---|
| `--color-surface-0` | Recessed base / app background |
| `--color-surface-1` … `--color-surface-4` | Ascending raised surfaces (panels, controls, hover) |
| `--color-border` | Standard borders |
| `--color-border-subtle` | Hairline dividers (panel separators) |
| `--color-text-primary` | Primary text |
| `--color-text-secondary` | Labels, secondary text |
| `--color-text-muted` | Disabled / de-emphasized text |
| `--color-accent` | Active control / selection fill |
| `--color-accent-hover` | Accent hover state |
| `--color-slider-fill` | Slider track fill; also the global `accent-color` |
| `--color-rating` | Star rating gold |
| `--color-flag-pick` / `--color-flag-reject` | Pick / reject flag colors |
| `--color-label-red` / `-yellow` / `-green` / `-blue` / `-purple` | The five color labels |
| `--font-mono` | Interface font stack (Afacad by default; the name is historical) |
| `--font-code` | Monospace stack for code, logs and markup |

A `ThemeContribution` need only set the first 13 (`surface-0`–`slider-fill`); rating/flag/label tokens fall back to the app defaults if omitted. The defaults mirror the shipped **Safelight Neutral** theme (an achromatic bright mid-grey); see `src/extensions/builtin.tsx` for the stock Neutral / Dark / Light values to use as a starting point.

## Styling hooks

Themes recolour; **stylesheets** reshape. An extension that registers a [`StylesheetContribution`](contributions.md#stylesheetcontribution) can change the shape, size and focus behaviour of the core input controls through these selectors. They are the contract — core keeps them stable — whereas the Tailwind utility classes next to them are implementation detail and may change without notice. Extension sheets cascade after core CSS and beat utility classes without `!important` (see the contribution notes); inline styles still win.

| Selector | What it is |
|---|---|
| `button`, `[role="button"]` | Every button — Safelight's buttons are plain styled `<button>` elements with no shared class, so use the element selector. Exclude `.sl-switch` (a switch is a button too) and `.sl-select` when you only mean push buttons. |
| `.sl-segmented` | The container of `api.ui.SegmentedControl` (its options are `button`s inside). |
| `.sl-select` | The dropdown trigger of the app `Select`. |
| `.sl-switch`, `.sl-switch-track`, `.sl-switch-knob` | The toggle switch (`role="switch"` button), its pill track and its knob. `aria-checked="true"` marks the on state. |
| `.sl-slider-wrap` | The Develop `Slider`'s track area (position: relative; 16 px tall). |
| `.sl-slider-label`, `.sl-slider-value` | Its label and the editable numeric field (`:focus` for the typing state). |
| `.sl-slider-track`, `.sl-slider-fill` | The track bar and the filled portion up to the value. |
| `.sl-slider-thumb` | A knob positioned at the value (`left: <pct>%`, centred by transform). **Hidden by default** — set `display: block` plus a size and shape to show one. |
| `.sl-slider-marker` | The value marker on gradient (HSL) tracks, which have no fill. Always visible. |
| `.sl-slider` | Native `<input type="range">` sliders (Preferences, extension settings fields); style `::-webkit-slider-thumb` / `::-moz-range-thumb` for the knob. |
| `input[type="checkbox"]`, `input[type="text"]`, `input[inputmode="decimal"]`, `input[type="number"]`, `textarea` | Native fields — attribute selectors, no extra class. |

```css
/* a round 12 px knob on every Develop slider */
.sl-slider-thumb { display: block; width: 12px; height: 12px; border-radius: 50%;
  background: var(--color-text-primary); box-shadow: 0 1px 2px rgba(0, 0, 0, .4); }
/* square corners on push buttons only */
button:not(.sl-switch):not(.sl-select) { border-radius: 0; }
```

The shipped **Input Styling** extension is built entirely on these hooks and is the reference for a full preset.

## Building custom controls

Reach for [`api.ui`](#apiui-primitives) first: buttons, selects, toggles, text and number inputs are all there, already themed. For anything numeric, prefer `api.components.Slider` over a raw `<input type="range">` — it brings drag-scrub, fine control, reset, and history-commit semantics for free.

For a control neither kit covers, lay it out with inline styles, color it from the tokens above, and let native `accent-color` theme your checkboxes, radios and range inputs automatically:

```js
const { tokens } = api.ui;

React.createElement("button", {
  type: "button",
  onClick,
  style: {
    padding: "4px 8px",
    fontSize: 11,
    borderRadius: 4,
    color: active ? tokens.textPrimary : tokens.textSecondary,
    background: active ? tokens.accent : "transparent",
    border: `1px solid ${tokens.border}`,
  },
}, "Swatch");
```
