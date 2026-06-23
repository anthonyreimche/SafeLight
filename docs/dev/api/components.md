# UI Components & Theming

← [API Reference](README.md)

`api.components` is the stock component kit — pre-themed React components so extension UI matches the app exactly. They are built with the app's own React instance; render them through `api.react` (`React.createElement(api.components.Slider, props)`), never import React yourself. Six components are exposed: `Panel`, `Slider`, `Histogram`, `CurveEditor`, `Rating`, `Thumbnail`.

> There is **no `Button` component** in the kit — buttons in Safelight are plain styled `<button>` elements. See [Building custom controls](#building-custom-controls-buttons-checkboxes-selects).

- [`Panel`](#panel)
- [`Slider`](#slider)
- [`Histogram`](#histogram)
- [`CurveEditor`](#curveeditor)
- [`Rating`](#rating)
- [`Thumbnail`](#thumbnail)
- [Theming tokens](#theming-tokens)
- [Building custom controls](#building-custom-controls-buttons-checkboxes-selects)

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

## Theming tokens

Runtime-loaded bundles are **not scanned by Tailwind**, so arbitrary Tailwind utility classes won't have CSS generated. Build custom UI by reusing `api.components`, or with inline styles that reference the theme CSS variables below (which *are* always present and re-applied live when the user switches theme). Native form controls (`<input type="range/checkbox/radio">`, `<select>`, `<progress>`) inherit `accent-color: var(--color-slider-fill)` globally, so they already match the theme without extra styling.

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
| `--font-mono` | App font stack |

A `ThemeContribution` need only set the first 13 (`surface-0`–`slider-fill`); rating/flag/label tokens fall back to the app defaults if omitted. The defaults mirror the shipped **Safelight Neutral** theme (an achromatic bright mid-grey); see `src/extensions/builtin.tsx` for the stock Neutral / Dark / Light values to use as a starting point.

## Building custom controls (buttons, checkboxes, selects)

There is no `Button` in `api.components` — Safelight's own buttons are styled `<button>` elements. The house style is a small, uppercase, low-chrome button that lights up on hover and uses the accent fill when active:

```js
// idiomatic Safelight button, built off api.react
React.createElement("button", {
  onClick,
  style: {
    padding: "4px 8px",
    fontSize: 11,
    borderRadius: 4,
    color: active ? "var(--color-text-primary)" : "var(--color-text-secondary)",
    background: active ? "var(--color-accent)" : "transparent",
    border: "1px solid var(--color-border)",
  },
  onMouseEnter: (e) => (e.currentTarget.style.background = "var(--color-accent-hover)"),
  onMouseLeave: (e) => (e.currentTarget.style.background = active ? "var(--color-accent)" : "transparent"),
}, "Reset");
```

The same approach applies to any custom control: lay it out with inline styles, color it from the tokens above, and let native `accent-color` theme your checkboxes/radios/range inputs automatically. For anything numeric, prefer `api.components.Slider` over a raw `<input type="range">` — it brings drag-scrub, fine control, reset, and history-commit semantics for free.
