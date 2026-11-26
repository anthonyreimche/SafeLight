# UI Components & Theming

← [API Reference](README.md)

Two kits keep extension UI matching the app. Render them with `api.react` (`React.createElement(api.components.Slider, props)`), never a bundled React.

- **`api.components`**: the app's own `Panel`, `Slider`, `Histogram`, `CurveEditor`, `Rating`, `Thumbnail` and `PhotoListRow`.
- **`api.ui`**: themed form and layout primitives, `tokens`, and the app's dialogues. Use these over hand-rolled controls.

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
  onAuto?: () => void;     // 3.2.5: Shift+double-click sets this value automatically
}
```

Notes:

- Update live state in `onChange` (cheap enough to bind straight to a store setter). Snapshot undo history in `onCommit`.
- With `onAuto`, Shift+double-click on the track calls it instead of resetting, and the track's tooltip names the gesture. A plain double-click still resets. Set the value and make the undo step yourself; the slider commits nothing for it. Older builds reset on any double-click.
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

## `PickerIcon`

The eyedropper icon core's pickers show (3.2.0). It draws in the current text colour; `size` is in pixels (default 11).

## `AutoButton`

The small Auto button of the develop panels (3.2.0): `onClick`, `disabled` and a `title` for its tooltip. Pair it with `api.develop.autoAdjust`.

## `ThumbnailBadge`

The small marker core draws on thumbnails, such as the edited pencil and the file type (3.2.6): `children` is its text or glyph, `title` its tooltip and the name a screen reader gives it. Use it in a [`ThumbnailBadgeContribution`](contributions.md#thumbnailbadgecontribution).

## `MaskScope`

Binds its children to one mask (3.2.0): `<MaskScope maskId={id}>`. A mask sub-panel's component (`PanelContribution.mask`) drawn inside reads and writes that mask through `useMaskScope` and `useParamScope`. A masking panel draws each of a mask's sub-panels inside one; `api.develop.useMaskPanels` lists them.

## `Thumbnail`

The Library grid cell. It shows the stored import preview, never an edited render. Callbacks take the photo id first and the cell is memoized, so pass one stable function to every cell.

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
- Call `requestThumbnail` only for photos you draw yourself that have no `thumbnailUrl` yet. A call for a photo that has one still reads from disk. Core releases the `thumbnailUrl` of photos far from view in a big project, so a surface that scrolls should ask again when a photo it draws has none.
- To read previews of many photos at once without loading them, use `api.catalog.readPreview(photoId)` (see [Stores: `api.catalog`](stores.md#apicatalog)).

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
| `ProgressBar` | `value?` (0..1), `indeterminate?`, `delayMs?`, `label?` | Thin accent bar. `indeterminate` slides a segment along it for a wait of unknown length. `delayMs` keeps it hidden until that long has passed. |
| `LoadingDots` | `label?` | Status text with an ellipsis whose dots step in turn, such as `Loading...`. The dots are hidden from screen readers. Under Reduce motion it shows a still `…`. |
| `Skeleton` | `style?`, `className?` | A breathing block standing in for content still loading. Give it the size of what will arrive, so nothing jumps when it does. |
| `useDelayedFlag(active, ms = 300)` | — | A hook: true once `active` has stayed true for `ms`, and false the moment it ends. Gate a wait indicator on it, so a quick load never flashes one. |
| `Stack` / `Row` | `gap?` (px, default 8), `style?`; `Row`: `align?`, `justify?`, `wrap?` | Vertical / horizontal flex. |
| `ColourField` | `label`, `hue`, `saturation?`, `lightness?`, `onChange`, `onCommit?`, `toRgb?`, `fromRgb?`, `pick?`, `title?` | A colour: see [Colour field](#colour-field). Needs Safelight 3.2.8. |

```js
const { Button, Field, Select, Stack } = api.ui;
const h = api.react.createElement;

h(Stack, { gap: 8 },
  h(Field, { label: "Long edge" },
    h(Select, { value: size, onChange: setSize,
      options: [{ value: "2048", label: "2048 px" }, { value: "4096", label: "4096 px" }] })),
  h(Button, { variant: "primary", full: true, onClick: run }, "Export"));
```

### Colour field

`ColourField` is the one control for choosing a colour. A swatch as wide as the row shows the colour, with an eyedropper beside it. Clicking the swatch opens a picker under it: a hue-by-saturation area (a hue bar when the field has no `saturation`), a lightness bar when it has `lightness`, and a hex field. Escape or another click on the swatch closes it. Keep your Hue and Saturation sliders under it for fine control if you have them.

- `hue` is in degrees (0 to 360), `saturation` and `lightness` in percent. `onChange` gets only the channels the field has, live during a drag; `onCommit` follows once the drag ends, and after a key, a hex or a pick.
- `toRgb(hue, saturation, lightness)` returns the display sRGB colour (0 to 1) your model makes of those values, and `fromRgb(rgb)` reads a typed or picked colour back as `{ hue, saturation, lightness }`. Both default to HSL. A channel the field lacks is passed to `toRgb` as 100 (saturation) or 50 (lightness).
- The eyedropper holds the canvas's pick-drag tool, so it gives way to a canvas tool and lets go on Escape. With the default `pick: true` it takes the colour the view shows where the photo is clicked. Pass `pick: { paramBag }` to sample a capture with that bag merged over the photo's instead, and over each mask's copy of a stage it names, which leaves your own effect out of the sample (set your stage's opacity or amount to its off value there). `pick: false` hides it.

```js
const { ColourField } = api.ui;
h(ColourField, {
  label: "Tint",
  hue: p.hue,
  saturation: p.saturation,
  pick: { paramBag: { "my-ext.tint.amount": 0 } },
  onChange: (c) => scope.setParams({ "my-ext.tint.hue": c.hue, "my-ext.tint.saturation": c.saturation }),
  onCommit: () => scope.commit("Tint"),
});
```

## `api.ui` dialogues

Ask or tell the person something in the app's own dialogue card (3.2.0). Never call `window.confirm` or `window.alert`: in Electron a native dialogue can leave the window unaware it has focus again, and every key stops reaching the app until it is refocused or restarted.

```ts
confirmDialog(options: {
  title: string;
  message: string;
  confirmLabel?: string;            // default "OK"
  cancelLabel?: string;             // default "Cancel"
  variant?: "default" | "danger";
}): Promise<boolean>;

alertDialog(options: {
  title: string;
  message: string;
  confirmLabel?: string;            // default "OK"
}): Promise<void>;
```

- `confirmDialog` resolves `true` on confirm. Cancel, Esc and a click outside the card all resolve `false`.
- `alertDialog` resolves however the card is closed.
- `variant: "danger"` paints the confirm button red and opens with Cancel focused. Keep it for actions that destroy data.
- A blank line in `message` starts a new paragraph; a single line break stays a line break.
- Dialogues queue: a second one waits until the first is answered. While one is open the app's own shortcuts stand down.
- A start of your extension that no longer counts (it timed out, or a newer copy took over) can't open one: the call throws, like a `register` call would.

### `onEscape`

```ts
api.ui.onEscape(handler: () => void): () => void;
```

Takes the Escape key while something of yours is open that Escape should close: an edit mode whose handles sit over the photo, a popover of your own. Needs Safelight 3.2.4.

- The newest taker gets the key, so a dialogue or menu opened after yours closes first, and yours closes before an on-image tool (`setCanvasTool`) is let go. One press closes one thing.
- It returns the function that gives the key back. Call it as soon as there is nothing left to close, from a React effect's cleanup: while you hold the key, Escape reaches nothing below you.
- A slider's value field keeps Escape for its own revert.
- An on-image tool held with `setCanvasTool` already gets Escape through its `onEscape`; use this for everything else.

```tsx
React.useEffect(() => (editing ? api.ui.onEscape(() => setEditing(false)) : undefined), [editing]);
```

### `notify`

```ts
api.ui.notify(notice: string | { message: string; tone?: "info" | "success" | "warning" | "error"; progress?: number | null }): {
  update(next: Partial<typeof notice>): void;
  close(): void;
};
```

Tells the person something without stopping them: a bar in the app's bottom stack, like core's own notices, under your extension's name and with a × to dismiss. Needs Safelight 3.2.8.

- `info` (the default) and `success` go by themselves after a few seconds. `warning` and `error` stay until dismissed.
- A notice with `progress` (0..1) shows a bar and stays while the run is under way. `update` it as the run goes, then update it to `progress: null` with the result.
- The message is selectable, so an error can be copied into a report.
- Core takes your notices down when your extension stops.
- Use it for the outcome of work the person started and may not be watching (a merge, a batch). Ask a question with `confirmDialog` instead.

```js
const run = api.ui.notify({ message: "Aligning 5 frames…", progress: 0 });
run.update({ progress: 0.5 });
run.update({ message: "Merged 5 frames.", tone: "success", progress: null });
```

```js
const ok = await api.ui.confirmDialog({
  title: "Clear the cache",
  message: "This deletes every rendered preview. They are made again as you browse.",
  confirmLabel: "Clear",
  variant: "danger",
});
if (ok) clearCache();
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
| `--color-on-accent` | | Text and icons on accent and slider-fill backgrounds (white by default) |
| `--color-rating` | `rating` | Star rating |
| `--color-flag-pick` / `-reject` | | Flag colours |
| `--color-label-red` / `-yellow` / `-green` / `-blue` / `-purple` | | Colour labels |
| `--font-mono` | `fontMono` | Interface font (despite the name) |
| `--font-code` | `fontCode` | Monospace font |

A variable a [`ThemeContribution`](contributions.md#themecontribution) leaves out keeps the **Safelight Neutral** value. Set at least the first 13 (`surface-0` to `slider-fill`), or the theme's own colours end up mixed with Neutral's surfaces and text.

## Styling hooks

Themes recolour, stylesheets reshape. A [`StylesheetContribution`](contributions.md#stylesheetcontribution) can target these stable selectors (Tailwind classes beside them may change any release). Extension sheets beat utility classes without `!important`; inline styles still win.

| Selector | What it is |
|---|---|
| `button`, `[role="button"]` | Every button. Exclude `.sl-switch` and `.sl-select` for push buttons only. |
| `.sl-colour-field` | `ColourField` container; `.sl-colour-swatch`, `.sl-colour-pick`, `.sl-colour-picker`, `.sl-colour-area`, `.sl-colour-bar`, `.sl-colour-marker` and `.sl-colour-hex` are its parts |
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
| `.sl-floating-panel` | A dock panel floated over the workspace (3.2.2) |
| `.sl-thumbnail-badge` | A `ThumbnailBadge` on a grid or Filmstrip thumbnail, core's edited pencil and file type, and extensions' badges (3.2.6) |

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
