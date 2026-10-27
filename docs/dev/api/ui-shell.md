# UI Shell: Modules, Panels & Slots

← [API Reference](README.md)

Where extension UI mounts in the app shell. For what goes inside, see [UI Components](components.md).

| Mechanism | Call | Where it shows |
|---|---|---|
| Module | `registerModule` | A tab beside Library and Develop |
| Panel | `registerPanel` | A dock rail in any module, or floating |
| Stack panel | `registerPanel` with `slot` | The `develop-right` / `develop-left` stack |
| Per-mask panel | `registerPanel` with `mask` | The Masking panel's **+ Adjust** menu |
| Header accessory | `registerPanelHeaderAccessory` | Every panel's dock header |
| Slot | `registerSlot` | A fixed region of core chrome |
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
  slot?: "develop-right" | "develop-left" | "none"; // default "none"
  order?: number;             // sort within slot (default 100)
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
  headerAccessory?: ComponentType; // a control left of the title
  mask?: MaskPanelContribution;    // per-mask variant, see below
}
```

Read where the panel is docked with `api.dock.usePanelPlacement().side` (`"left" | "right" | "bottom" | "float"`).

Notes:

- Panels dock left or right unless they set `allowBottomDock` (implied by `direction: "bottom"`). Bottom-rail panels sit side by side at full strip height.
- A `fill` panel's body must size to 100% and scroll itself.
- `onReset` should be one undoable action.
- `replaces` is for a panel that moved, e.g. into another extension. Saved layouts naming an old id show this panel there once nothing else uses that id. Older builds ignore it, so no `minAppVersion` is needed.
- A `headerAccessory` handles its own clicks. Clicks on a button in the header don't start a drag.

To replace a stock panel, register your own and ask users to disable the built-in one in the Extensions dialog.

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
| `develop-canvas-overlay` | A click-through layer over the Develop canvas (see [`api.develop`](stores.md#apidevelop)) |
| `develop-detail` | The Detail panel's Noise Reduction area. **Replaces** the built-in sliders |

`api.unregisterSlot(id)` removes a slot contribution, e.g. a denoiser's `develop-detail` controls when it is off, so the built-in sliders return.

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
