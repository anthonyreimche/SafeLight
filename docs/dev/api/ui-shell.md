# UI Shell: Modules, Panels & Slots

← [API Reference](README.md)

Where extension UI mounts in the app shell. For what goes inside, see [UI Components](components.md).

| Mechanism | Call | Where it shows |
|---|---|---|
| Module | `registerModule` | A tab beside Library and Develop |
| Panel | `registerPanel` | A dock rail in any module, or floating |
| Per-mask panel | `registerPanel` with `mask` | The Masking panel's **+ Adjust** menu |
| Header accessory | `registerPanelHeaderAccessory` | Every panel's dock header |
| Slot | `registerSlot` | A fixed region of core chrome |
| Top-bar button | `registerTopBarButton` | An icon in the main window's top bar |
| Window | `registerWindow` | A pop-up over the app, like the Extensions window |
| Layout | `registerLayout` | The Layout menu |

## Modules

A module is a top-level view beside **Library** and **Develop**, for an extension that needs a whole workspace rather than a panel. It gets a tab, a pop-out window and its own dock layout.

```typescript
interface ModuleContribution {
  id: string;                 // e.g. "map"
  label: string;              // tab label and pop-out window title
  component: ComponentType;   // the main view; must fill its container
  order?: number;             // tab position after the built-ins (default 100)
  defaultLayout?: ModuleLayoutDef; // panels placed on first visit
  statusBar?: ComponentType;  // footer content
}
```

Switch modules with `api.navigation.goTo(id)` from any window. Read the active one with `api.stores.useUIStore(s => s.activeModule)`; panels are not told which module they are in.

Notes:

- The id uses lower-case letters, digits, `.`, `_` and `-`, starting with a letter or digit. `"library"` and `"develop"` are refused.
- `component` unmounts on every tab switch. Keep state that must survive one in a store or settings.
- `defaultLayout` may name core panels (`"core.folders"`, `"core.filters"`, `"core.info"`). Without it, panels whose `defaultDock.module` is your id are placed.
- There is no automatic shortcut. Register one with `registerKeybinding` that calls `goTo(id)`.
- Pop-out windows carry `?detached=<module id>`. Gate "only in Develop" logic on both `activeModule` **and** that param.

## Panels (`registerPanel`)

A React component that lives in a dock rail. Users can dock, tab, float and collapse it like any built-in panel.

```typescript
interface PanelContribution {
  id: string;                 // globally unique, e.g. "my-ext.waveform"
  title: string;
  component: ComponentType;
  slot?: "develop-right" | "develop-left" | "none"; // deprecated: ignored, panels live in the dock
  order?: number;             // sort order (default 100)
  defaultDock?: {             // first placement; the View menu reopens it here
    module: ModuleId;         // "library", "develop" or a registered module
    direction: "left" | "right" | "bottom";
    order?: number;
    width?: number;           // side-rail width
    height?: number;          // bottom-rail height
  };
  fill?: boolean;             // stretch to the rail's remaining height
  allowBottomDock?: boolean;  // allow the bottom rail
  replaces?: readonly string[]; // old panel ids this one takes over
  onReset?: () => void;       // adds "Reset to defaults" to the header
  owns?: readonly (keyof DevelopParams)[]; // what the preview-off eye hides
  ownsBag?: readonly string[];  // the bag keys it hides (3.2.6)
  headerAccessory?: ComponentType; // a control left of the title
  mask?: MaskPanelContribution;    // per-mask variant, see below
}
```

Read where the panel is docked with `api.dock.usePanelPlacement().side` (`"left" | "right" | "bottom" | "float"`).

Open or close a panel with `api.dock.togglePanel(id)`. A panel with a `defaultDock` for the current module opens there; any other floats. Pass a placement, `togglePanel(id, { direction: "bottom", height: 240 })`, to open a panel without one in a rail instead, in whichever module is showing: a console a shortcut opens, say. It joins the side's first rail, or a new rail of that width or height (clamped to the rail limits), and a side the person hid is shown again. A panel open on a hidden side is shown rather than closed. The bottom rail still needs `allowBottomDock`; without it the panel floats. Needs Safelight 3.2.5; older builds ignore the placement.

Notes:

- Panels dock left or right unless they set `allowBottomDock` (implied by `direction: "bottom"`). Bottom-rail panels sit side by side at full strip height.
- A `fill` panel's body must size to 100% and scroll itself.
- `onReset` should be one undoable action.
- `replaces` is for a panel that moved, e.g. into another extension. Saved layouts naming an old id show this panel there once nothing else uses that id. Older builds ignore it, so no `minAppVersion` is needed.
- A `headerAccessory` handles its own clicks. Clicks on a button in the header don't start a drag.
- `owns` names the develop params your panel's effect is made of. While its preview-off eye is held, Develop draws the photo with them at their defaults, and the stored edit stays as it is. List every key the eye should hide, including another tool's that means nothing without yours: Transform lists the crop, since the crop is drawn in the transformed frame. A panel with `owns` gets the eye even without a stage of its own, and holding it leaves your extension's stage params alone; a panel without `owns` or `ownsBag` previews off by dropping all of them. Keys that aren't develop params are left out at registration, with a warning. Older builds ignore it.
- `ownsBag` (3.2.6) names the param-bag keys your panel's effect lives in, for an extension whose stages serve several panels: one panel per installed filter, say. Give an exact key (`"my-ext.f.abc"`) or a prefix ending in `.` (`"my-ext.f.abc."`) for every key under it. While the eye is held, Develop draws without those keys, from the photo's bag and from your `api.develop.setViewValues` alike, and leaves your other stage params as they are. A panel with both `owns` and `ownsBag` previews both off, and one with `ownsBag` gets the eye. An empty `ownsBag` says the panel has no effect of its own (a store or a list beside your stages): it gets no eye. Entries that aren't strings are left out at registration, with a warning. Older builds ignore it and drop all of your stage params.

`api.unregisterPanel(id)` (3.2.6) removes a panel you registered, such as a filter's panel when the filter is uninstalled. The panel goes the way a disabled extension's does: saved layouts keep its id, so registering it again puts it back where it was, and meanwhile the dock shows the panel's spot as disabled or not installed, if it was open. Close it first with `api.dock.togglePanel(id)` if it shouldn't show there. A held preview-off eye on it lets go. Another extension's id is refused with a warning.

To replace a stock panel, register your own and ask users to disable the built-in one in the Extensions dialogue.

### Per-mask panels (`PanelContribution.mask`)

With `mask`, users can add your panel to a mask from the Masking panel's **+ Adjust** menu. Each mask gets its own instance of `mask.component`, editing that mask's values. The stock Basic, White Balance, HSL, Tone Curve and Detail panels work this way.

```typescript
interface MaskPanelContribution {
  component: ComponentType;
  order?: number;             // among a mask's sub-panels (default 100)
  owns: readonly string[];    // the mask values this sub-panel edits
}
```

The component reads and writes through a scope, never the global develop params:

```typescript
interface ParamScope {        // api.develop.useParamScope()
  maskId: string | null;      // null: the photo's own paramBag
  getParam(key: string): unknown;  // falls back to the default
  getParams(): Readonly<Record<string, unknown>>; // stored values only
  setParams(patch: Record<string, unknown>): void; // undefined clears
  commit(label: string): void;     // end the gesture as one undo step
}

interface MaskParamScope extends ParamScope { // api.develop.useMaskScope()
  maskId: string;
  adj: MaskAdjustments;       // core local adjustments, -100..100
  setAdj(patch: Partial<MaskAdjustments>): void;
  hsl: HSLAdjustments | undefined;  // while the HSL sub-panel is added
  setHsl(value: HSLAdjustments): void;
  toneCurve: ToneCurves | undefined; // while Tone Curve is added
  setToneCurve(value: ToneCurves): void;
  setParam(key: string, value: unknown): void;
}
```

Notes:

- `owns` takes `MaskAdjustments` keys (`"exposure"`), `"hsl"`, `"toneCurve"` or qualified extension keys (`"my-ext.stage.amount"`). They are seeded on add, cleared on remove and reset by the mask's Reset.
- List every key the component writes. A mask runs a stage's copy while it holds any of that stage's keys, so a missing key keeps it running after removal.
- `useParamScope` gives the mask's scope in a mask and the photo's elsewhere, so one component can be both `component` and `mask.component`. `useMaskScope` throws outside a mask.
- Extension params work in a mask only if their stage is [maskable](contributions.md#processingstagecontribution--gpu-stage) and the photo is at process version 2 or later.
- Keep whole-photo tools (an Auto button, an on-image control) out of `mask.component`, or check `maskId`. They act on the global stage.
- Scope reads see the live store, so a drag handler can start each step from the last write instead of the render's snapshot.

## Panel header accessories (`registerPanelHeaderAccessory`)

One control drawn on every panel's dock header, left of the title, such as a preview-off eye.

```typescript
interface PanelHeaderAccessoryContribution {
  id: string;                 // globally unique, e.g. "my-ext.eye"
  component: ComponentType<PanelHeaderContext>;
  order?: number;             // default 100
}

interface PanelHeaderContext { // props, once per panel
  panelId: string;
  title: string;
  module?: ModuleId;          // the panel's default module, if known
  extensionId: string;        // "host" / "core.*" for built-ins
  previewable: boolean;       // the panel has an image effect
}
```

Return `null` to skip a panel, and handle your own pointer events. `previewable` is false for Histogram, Edit, Presets and other panels with no image effect.

## Slots (`registerSlot`)

Named mount points in core chrome, for a small component in a fixed place.

```typescript
interface SlotContribution {
  id: string;                 // globally unique, e.g. "my-ext.search-bar"
  slot: SlotName;
  component: ComponentType;
  order?: number;             // default 100
}
```

| Slot | Location |
|---|---|
| `library-toolbar` | The Library toolbar |
| `library-subbar` | A full-width bar below it, shown only when used |
| `develop-toolbar` | The Develop status bar, left of the zoom controls |
| `develop-canvas-overlay` | A click-through layer over the Develop canvas, under a held canvas tool's overlay (see [`api.develop`](stores.md#apidevelop)) |
| `develop-detail` | The Detail panel's Noise Reduction area. **Replaces** the built-in sliders |

`api.unregisterSlot(id)` removes a slot contribution, e.g. a denoiser's `develop-detail` controls when it is off, so the built-in sliders return.

`components.Slot` draws a slot's components wherever your own UI puts it. Its `fallback` (3.2.0) shows while the slot is empty: the Detail extension draws the built-in noise sliders as the `develop-detail` fallback.

## Top-bar buttons (`registerTopBarButton`)

An icon button in the main window's top bar, beside the built-in icons: the G'MIC extension's store opens from one. Needs Safelight 3.2.6.

```typescript
interface TopBarButtonContribution {
  id: string;                 // globally unique, e.g. "my-ext.store"
  label: string;              // tooltip and accessible name
  svg: string;                // inline <svg …> markup
  onClick(): void;
  order?: number;             // lower = further left (default 100)
}
```

The button looks and behaves like the built-in ones: same size, hover colour and tooltip. The icon is your svg's shapes filled with the bar's icon colour, so it follows the theme; colours in the markup are ignored. Draw it on a square `viewBox`; it is shown at 15 px. The markup is drawn as an image, never put into the page, and anything but inline `<svg` markup (a URL, say) is refused with a warning.

`api.unregisterTopBarButton(id)` removes one you registered; another extension's id is refused with a warning. Re-registering an id replaces it, and disabling your extension removes its buttons. A throw from `onClick` is logged and the bar carries on. Pop-out windows don't show them.

## Windows (`registerWindow`)

A window is a pop-up over the app, drawn like the Extensions window: a dimmed backdrop, a titlebar you drag it by, and a close button. Esc or a click outside closes it. Use one for a page of its own that the user opens and puts away, such as a store; a panel suits something that stays beside the photo. The G'MIC extension's filter store opens in one, from its top-bar button. Needs Safelight 3.2.6.

```typescript
interface WindowContribution {
  id: string;                 // globally unique, e.g. "my-ext.store"
  title: string;              // the titlebar's text
  component: ComponentType;   // the window's content
  maximizable?: boolean;      // offer Maximize/Restore, as the Extensions window does
}

api.registerWindow({ id: "my-ext.store", title: "Filter store", component: Store, maximizable: true });
api.registerTopBarButton({ id: "my-ext.store", label: "Filter store", svg, onClick: () => api.windows.toggle("my-ext.store") });
```

Registering a window doesn't show it. Open it with `api.windows`:

| Call | What it does |
|---|---|
| `open(id)` | Opens the window, closing any other extension's window that is open |
| `close(id)` | Closes it |
| `toggle(id)` | Opens it if closed, closes it if open |
| `isOpen(id)` | Whether it is open now (not reactive) |
| `useOpen(id)` | React hook: whether it is open, re-rendering when that changes |

One extension window is open at a time. These calls take your own windows only: another extension's id, or one nobody registered, is refused with a warning.

Your component fills the window below the titlebar, at 960 × 640, or the app below its top bar when maximized, and manages its own padding and scrolling. Make its root a flex column (`flex min-h-0 flex-1 flex-col`) and give the part that scrolls `min-h-0 flex-1 overflow-y-auto`; content that simply runs long scrolls as a whole. A throw while it renders shows a crash notice inside the window instead of taking the app down.

With `maximizable`, a Maximize button sits beside the close button and a titlebar double-click toggles it. Each window remembers whether it was maximized until Safelight restarts.

Re-registering an id replaces the window, and an open one shows the new content. `api.unregisterWindow(id)` removes one you registered and closes it if open; another extension's id is refused with a warning. Disabling your extension removes its windows the same way. A window opens in the app window that asked for it: a pop-out module window shows its own.

## Layouts (`registerLayout`)

A named dock arrangement in the Layout menu.

```typescript
interface LayoutContribution {
  id: string;
  name: string;
  description?: string;       // menu tooltip
  modules?: Partial<Record<string, ModuleLayoutDef>>; // by module id
}

interface ModuleLayoutDef {
  rails: { side: "left" | "right" | "bottom"; width?: number;
           height?: number; panels: string[] }[];
  floating?: Record<string, { x: number; y: number; width: number }>;
  collapsed?: string[];       // panels that start collapsed
}
```

A module missing from `modules` uses its `defaultLayout`, else each panel's `defaultDock`. The built-in **Classic** layout has no `modules`, so extension panels join it.
