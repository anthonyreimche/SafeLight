# UI Components & Theming

← [API Reference](README.md)

Two kits keep extension UI matching the app. Render them with `api.react` (`React.createElement(api.components.Slider, props)`), never a bundled React.

- **`api.components`**: the app's own `Panel`, `Slider`, `Histogram`, `CurveEditor`, `Rating`, `Thumbnail` and `PhotoListRow`.
- **`api.ui`**: themed form and layout primitives, plus `tokens`. Use these over hand-rolled controls.

## `Panel`

A collapsible, titled section. Inside a dock panel with the same title, the header is dropped, so one component works standalone and docked.

```typescript
interface PanelProps {
  title: string;          // header; also keys the saved open state
  defaultOpen?: boolean;  // default true
  children: ReactNode;
}
```

## `Slider`

The labelled numeric control every Develop adjustment uses. Drag to scrub, **Shift** for fine control, double-click to reset, or type a value.

```typescript
interface SliderProps {
  label: string;           // "" for none (then set ariaLabel)
  ariaLabel?: string;
  value: number;
  onChange: (value: number) => void; // live, once per frame at most
  onCommit?: () => void;   // drag end, blur, key-up
  min?: number;            // default -100
  max?: number;            // default 100
  step?: number;           // default 1; sets the decimal places
  defaultValue?: number;   // double-click reset target (default 0)
  icon?: string;           // slider icon id, e.g. "core.exposure"
  hideValue?: boolean;     // hide the numeric field
  compact?: boolean;       // narrow label and value columns
  trackBackground?: string; // CSS gradient track, with a marker
  onModifierPreview?: (active: boolean) => void; // Alt/Ctrl mid-drag
}
```

Notes:

- Update live state in `onChange` (cheap enough to bind straight to a store setter). Snapshot undo history in `onCommit`.
- A typed value may pass `min`/`max` (the field turns red). Dragging and arrow keys clamp.

## `Histogram`

A live RGB/luma histogram with mode buttons and clipping toggles. With `onAdjust`, its five tonal zones (`blacks`, `shadows`, `exposure`, `highlights`, `whites`) become draggable.

```typescript
interface HistogramProps {
  data: HistogramData | null;  // null renders empty
  onAdjust?: (zone: HistogramZone, deltaPx: number,
              phase: "start" | "move" | "end") => void;
  onReset?: (zone: HistogramZone) => void; // double-click a zone
  showClipping?: ClippingMask; // 0-7 bitfield (default 0)
  onToggleClipping?: () => void;  // shows the "Clip" button
  onSetClipping?: (mode: ClippingMask) => void; // clip badges toggle
}
```

`showClipping` bits: `1` shadow clipping, `2` highlight clipping, `4` gamut warning (version 3 photos only). `deltaPx` is the offset from the drag start.

## `CurveEditor`

A controlled tone-curve editor, as in the Tone Curve panel.

```typescript
interface CurveEditorProps {
  curves: ToneCurves;      // { rgb, red, green, blue }, points in 0..1
  onChange: (channel: ToneCurveChannel, points: CurvePoint[]) => void;
  onCommit: () => void;    // drag end: snapshot history here
  compact?: boolean;       // smaller plot
  showPointValues?: boolean; // In/Out boxes (0-255) for the selection
}
```

## `Rating`

A 0 to 5 star control. Clicking the current value resets it to 0.

```typescript
interface RatingProps {
  value: number;
  onChange?: (rating: number) => void; // omit for read-only
  size?: "sm" | "md";      // default "sm"
}
```

## `Thumbnail`

The Library grid cell. It shows the stored import preview, never an edited render. Callbacks take the photo id first and the cell is memoised, so pass one stable function to every cell.

```typescript
interface ThumbnailProps {
  photo: CatalogPhoto;
  selected: boolean;       // part of a multi-selection
  active: boolean;         // open in Develop
  size: number;            // square cell size, px
  onClick: (id: string, e: React.MouseEvent) => void;
  onDoubleClick?: (id: string) => void;
  onContextMenu?: (id: string, e: React.MouseEvent) => void;
  onRatingChange?: (id: string, rating: number) => void; // inline stars
  onDragStart?: (id: string, e: React.DragEvent) => void;
}
```

## `PhotoListRow`

The Library list-view row (53 px tall there), with the same callbacks as `Thumbnail`. `onDoubleClick` is required; `compact` drops the dimension and camera columns.

```typescript
interface PhotoListRowProps {
  photo: CatalogPhoto; selected: boolean; active: boolean; compact?: boolean;
  onClick: (id: string, e: React.MouseEvent) => void;
  onDoubleClick: (id: string) => void;
  onContextMenu?: (id: string, e: React.MouseEvent) => void;
  onDragStart?: (id: string, e: React.DragEvent) => void;
}
```

## Photo surfaces: menu and shortcuts

A surface that lists photos (a filmstrip, a map) should reuse the grid's behaviour, which includes extension menu items and the user's rebound keys.

```typescript
const photos = api.catalog.useVisiblePhotos({ without: ["my-ext.in-view"] });
const { onContextMenu, overlays } = api.catalog.usePhotoActions(); // render {overlays}
api.catalog.useCullingShortcuts({ sizeSteps: false }); // while mounted
api.catalog.requestThumbnail(photoId);  // fills photo.thumbnailUrl
```

Notes:

- `useVisiblePhotos` returns the grid's photos in grid order. `without` leaves out your own grid filter.
- `onContextMenu` acts on the selection when the clicked photo is in it, else on that photo alone.
- `useCullingShortcuts` acts once per press however many surfaces are mounted. Pass `sizeSteps: false` when cells size to their container, so `-`/`=` stay with the grid.
- Call `requestThumbnail` only for photos you draw yourself that have no `thumbnailUrl` yet. A call for a photo that has one still reads from disk.

## `api.ui` primitives

Themed controls that match Preferences. Controlled inputs take `value` and an `onChange` that receives the value, not an event.

| Component | Props | Notes |
|---|---|---|
| `Button` | `variant?` (`primary`, `secondary`, `ghost`, `danger`), `size?` (`sm`, `md`), `active?`, `full?`, `<button>` attrs | Defaults `secondary`, `md`, `type="button"`. `full` fills the width. |
| `Select` | `value`, `onChange`, `options?` (`{ value, label }[]`) or `groups?`, `placeholder?`, `disabled?`, `ariaLabel?`, `title?`, `className?` | The app's one dropdown. Full width. |
| `TextInput` | `value`, `onChange`, `<input>` attrs | Spellcheck off. |
| `NumberInput` | `value: number`, `onChange`, `width?` (default `"56px"`), `<input>` attrs | Ignores empty and non-finite input. |
| `TextArea` | `value`, `onChange`, `mono?`, `rows?` (default 4) | `mono` uses the code font. |
| `Toggle` | `checked`, `onChange`, `label?`, `ariaLabel?` | The app switch. |
| `SegmentedControl` | `value`, `onChange`, `options` (`{ value, label, title? }[]`), `size?` | Mutually exclusive buttons. |
| `Field` | `label?`, `hint?`, `children` | Label, control and hint, stacked. |
| `Section` | `title`, `right?`, `children` | Uppercase header over its children. |
| `Card` | `children`, `className?` | Bordered, raised container. |
| `Badge` | `children`, `color?` | Small pill; `color` sets its background. |
| `ProgressBar` | `value` (0..1) | Thin accent bar. |
| `Stack` / `Row` | `gap?` (px, default 8), `style?`; `Row`: `align?`, `justify?`, `wrap?` | Vertical / horizontal flex. |

```js
const { Button, Field, Select, Stack } = api.ui;
const h = api.react.createElement;

h(Stack, { gap: 8 },
  h(Field, { label: "Long edge" },
    h(Select, { value: size, onChange: setSize,
      options: [{ value: "2048", label: "2048 px" }, { value: "4096", label: "4096 px" }] })),
  h(Button, { variant: "primary", full: true, onClick: run }, "Export"));
```

## Theming tokens

Extension bundles get no Tailwind CSS. Style custom UI inline with these CSS variables, or the matching `api.ui.tokens` strings (`tokens.surface2` is `"var(--color-surface-2)"`). They update live when the theme changes. Native range, checkbox and radio inputs, `<select>` and `<progress>` are already themed through `accent-color`.

| CSS variable | `tokens` key | Role |
|---|---|---|
| `--color-surface-0` | `surface0` | App background |
| `--color-surface-1` … `-4` | `surface1` … `surface4` | Raised surfaces, ascending |
| `--color-border` | `border` | Borders |
| `--color-border-subtle` | `borderSubtle` | Hairline dividers |
| `--color-text-primary` | `textPrimary` | Primary text |
| `--color-text-secondary` | `textSecondary` | Labels |
| `--color-text-muted` | `textMuted` | Disabled text |
| `--color-accent` | `accent` | Active control, selection |
| `--color-accent-hover` | `accentHover` | Accent hover |
| `--color-slider-fill` | `sliderFill` | Slider fill, global `accent-color` |
| `--color-rating` | `rating` | Star rating |
| `--color-flag-pick` / `-reject` | | Flag colours |
| `--color-label-red` / `-yellow` / `-green` / `-blue` / `-purple` | | Colour labels |
| `--font-mono` | `fontMono` | Interface font (despite the name) |
| `--font-code` | `fontCode` | Monospace font |

A [`ThemeContribution`](contributions.md#themecontribution) must set the first 13 (`surface-0` to `slider-fill`). The rest fall back to the **Safelight Neutral** values.

## Styling hooks

Themes recolour, stylesheets reshape. A [`StylesheetContribution`](contributions.md#stylesheetcontribution) can target these stable selectors (Tailwind classes beside them may change any release). Extension sheets beat utility classes without `!important`; inline styles still win.

| Selector | What it is |
|---|---|
| `button`, `[role="button"]` | Every button. Exclude `.sl-switch` and `.sl-select` for push buttons only. |
| `.sl-segmented` | `SegmentedControl` container (options are `button`s) |
| `.sl-select` | `Select` trigger |
| `.sl-switch`, `.sl-switch-track`, `.sl-switch-knob` | Toggle switch; `aria-checked="true"` when on |
| `.sl-slider-wrap` | Develop `Slider` track area (relative, 16 px) |
| `.sl-slider-label`, `.sl-slider-value` | Its label and numeric field |
| `.sl-slider-track`, `.sl-slider-fill` | Track bar and filled part |
| `.sl-slider-thumb` | Knob at `left: <pct>%`. **Hidden by default**: set `display: block`, size and shape |
| `.sl-slider-marker` | Value marker on gradient (HSL) tracks |
| `.sl-slider` | Native `<input type="range">` (style its `::-webkit-slider-thumb` / `::-moz-range-thumb`) |
| `input[type="checkbox"]`, `input[type="text"]`, `input[inputmode="decimal"]`, `input[type="number"]`, `textarea` | Native fields |

```css
.sl-slider-thumb { display: block; width: 12px; height: 12px; border-radius: 50%;
  background: var(--color-text-primary); }
button:not(.sl-switch):not(.sl-select) { border-radius: 0; }
```

[Custom Input Styling](https://github.com/anthonyreimche/Custom-Input-Styling) is built entirely on these hooks.

## Building custom controls

Use `api.ui` first, and `Slider` for anything numeric (it brings scrubbing, reset and history commits). Otherwise use inline styles coloured from `api.ui.tokens`:

```js
const { tokens } = api.ui;
const style = { color: tokens.textPrimary, background: active ? tokens.accent : "transparent",
  border: "1px solid " + tokens.border, borderRadius: 4, padding: "4px 8px" };
```
