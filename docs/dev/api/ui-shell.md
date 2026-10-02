# UI Shell: Modules, Panels & Slots

← [API Reference](README.md)

Where extension UI mounts in the app shell. For the components you put *inside* these mounts, see [UI Components](components.md).

## Modules

Safelight ships two **modules** — **Library** (browsing/culling) and **Develop** (editing) — and an extension can register more (`registerModule`). A registered module gets a tab in the strip beside Library and Develop, its own pop-out window, its own dock layout, and its id becomes valid for `api.navigation.goTo`.

```typescript
interface ModuleContribution {
  id: string;                 // tab key, ?detached= key, dock-layout key, goTo() value; e.g. "map"
  label: string;              // tab label; also names the pop-out window
  component: ComponentType;   // the main view, rendered inside the shell's main dock area;
                              // it must fill its container
  order?: number;             // tab position after the built-ins (default 100)
  defaultLayout?: ModuleLayoutDef; // rails (and floating panels) seeded on first visit;
                              // may name core panels ("core.folders", "core.filters", "core.info")
  statusBar?: ComponentType;  // footer content
}
```

A module id is lower-case letters, digits, `.`, `_` and `-`, starting with a letter or digit: it travels in the pop-out window's URL. `registerModule` refuses any other id with a console warning, as it refuses the built-in ids `"library"` and `"develop"`.

A `defaultLayout` seeds only the panels that are registered, so a core panel the user has disabled is left out rather than shown as a placeholder. Without `defaultLayout`, the module's first-visit rails come from panels whose `defaultDock.module` is its id, as for the built-ins. A layout preset without an entry for the module resolves to these same defaults. A module's shortcut is its own: register one with `registerKeybinding` whose handler calls `navigation.goTo(id)`.

The `component` is mounted only while the module is active in that window: every tab switch unmounts it, so keep anything that must survive a switch in a store or in settings rather than in component state. If the component or the status bar throws while rendering, the error is shown in its place and the top bar, tabs and Extensions button keep working, so the user can still switch modules or disable the extension.

Extensions can also extend any module through these mount mechanisms:

| Mechanism | Contribution | What it gives you | Where it lives |
|---|---|---|---|
| **Panel** | `registerPanel` | A dockable, tabbable, floatable window with your own React component | A dock rail in any module (placed via `defaultDock`) |
| **Slot** | `registerSlot` | A component injected into a fixed region of core chrome | Named `SlotName` regions (toolbars, sub-bars, the canvas overlay) |
| **Stack panel** | `registerPanel` with `slot` | A small panel hosted inside a composite stack | `"develop-right"` / `"develop-left"` |
| **Per-mask panel** | `registerPanel` with `mask` | A compact variant of your panel, one instance per mask | The Masking panel's **+ Adjust** menu |
| **Header accessory** | `registerPanelHeaderAccessory` | One control rendered on every panel's dock header | Left of each panel title |

Switch the active module imperatively with `api.navigation.goTo(id)` (`ModuleId` = `"library" | "develop"` or a registered id), and read it from `api.stores.useUIStore(s => s.activeModule)`. A panel's component is mounted whenever the panel is visible in its module; it is *not* told which module it is in — read `useUIStore` if you need to vary behavior.

`goTo` works from any window. In the main window it switches to the module, focuses the module's own window instead if it is popped out, and ignores (with a console warning) an id that is neither built-in nor registered. A popped-out window shows only its own module, so there `goTo` of that module does nothing, and any other id is carried out by the main window by those same rules, with the main window brought forward.

> **Detached-window gotcha:** popped-out windows carry a `?detached=<module id>` URL param and report through `useUIStore`'s `detached` set. Gate any "only in the develop module" logic on both `activeModule` **and** the detached param, or it will misbehave in a popped-out window. A registered module's pop-out window shows a "waiting" placeholder until its extension has loaded there.

## Panels (`registerPanel`)

A panel is a React component placed via `defaultDock`; once placed it is dockable, tabbable, and floatable like any built-in.

```typescript
interface PanelContribution {
  id: string;                 // globally unique, e.g. "my-ext.waveform"
  title: string;
  component: ComponentType;   // a React component built with api.react
  slot?: "develop-right" | "develop-left" | "none"; // composite stack slot (default "none")
  order?: number;             // sort within slot (default 100)
  fill?: boolean;             // stretch to the remaining rail space; body sizes
                              // to 100% and scrolls itself
  allowBottomDock?: boolean;  // opt in to bottom rails (see below)
  defaultDock?: {             // initial placement when the user has no saved layout,
                              // and where View-menu / shortcut toggles reopen the panel
    module: ModuleId;          // "library" | "develop" | a registered module id
    direction: "left" | "right" | "bottom"; // "bottom" = full-width horizontal strip
    order?: number;
    width?: number;           // side-rail column width
    height?: number;          // bottom-rail strip height
  };
  onReset?: () => void;       // adds "Reset to defaults" to the dock header; one undoable action
  headerAccessory?: ComponentType; // a control left of this panel's title (e.g. a bypass eye)
  mask?: {                    // makes the panel addable per mask (see Per-mask panels)
    component: ComponentType;
    order?: number;           // among a mask's sub-panels (default 100)
    owns: readonly string[];  // the mask values this sub-panel edits
  };
}
```

A `headerAccessory` must handle its own clicks. The header ignores pointerdowns on buttons, so clicking one won't start a panel drag.

Side rails render panels top-to-bottom at natural height; a **bottom** rail renders its panels side-by-side, each filling the strip's height, with the rail resized from its top edge. Collapsing folds a bottom rail downward — once every panel in it is collapsed the rail drops to its headers and gives the band back to the main view, restoring its height when one is expanded again.

Bottom rails are **opt-in**. A panel is a vertical column unless it sets `allowBottomDock` (declaring `defaultDock.direction: "bottom"` implies it), and the dock offers a bottom drop target only for those — dragging any other panel over the strip floats it instead. This keeps a histogram or a curve editor out of a 112px band it was never laid out for. A saved layout carrying such a panel in a bottom rail is pruned on load; reopening it from the View menu floats it centered over the workspace (a `dock.togglePanel` call still re-docks it at its own default).

A component that must adapt to its rail (e.g. a filmstrip that flips horizontal when docked at the bottom) reads its placement with the hook:

```typescript
const { side } = api.dock.usePanelPlacement(); // "left" | "right" | "bottom" | "float"
```

To *replace* a stock panel, register your own and tell users to disable the built-in (e.g. "Histogram") in the Extensions panel.

### Per-mask panels (`PanelContribution.mask`)

A panel that declares `mask` shows up in the Masking panel's **+ Adjust** menu, and each mask that adds it renders its own instance of `mask.component` in the mask's Adjust tab. The built-in Basic, White Balance, HSL, Tone Curve and Detail panels work this way.

`owns` lists the mask values the sub-panel edits: `MaskAdjustments` keys (`"exposure"`, `"clarity"`, …), the structured blocks `"hsl"` and `"toneCurve"`, or qualified extension keys (`"my-ext.stage.amount"`). They are seeded with defaults when the sub-panel is added to a mask, cleared when it is removed, and restored to defaults by the mask's Reset action.

The component reads and writes the mask it belongs to through `api.develop.useMaskScope()`, never the global develop params:

```typescript
interface MaskParamScope {
  maskId: string;
  adj: MaskAdjustments;                          // core local adjustments, -100..100, 0 = none
  setAdj(patch: Partial<MaskAdjustments>): void;
  hsl: HSLAdjustments | undefined;               // present only while the HSL sub-panel is added
  setHsl(value: HSLAdjustments): void;
  toneCurve: ToneCurves | undefined;             // present only while the Tone Curve sub-panel is added
  setToneCurve(value: ToneCurves): void;
  getParam(key: string): unknown;                // extension params; falls back to the registered default
  setParam(key: string, value: unknown): void;
  commit(label: string): void;                   // end the gesture as one undo step
}
```

`useMaskScope` throws outside a mask sub-panel, so only call it from `mask.component`. Core adjustments (`adj`, `hsl`, `toneCurve`) are applied by the GPU's local-adjustment path. Extension params set with `setParam` are saved per mask (in `Mask.bag`), but extension stages still apply globally: per-mask stage application is planned, not built.

## Panel header accessories (`registerPanelHeaderAccessory`)

One control rendered on **every** panel's dock header, left of the title and beside that panel's own `headerAccessory`. It lets an extension add a uniform per-panel affordance (a preview-off eye, a pin) without core knowing about it.

```typescript
interface PanelHeaderAccessoryContribution {
  id: string;                                  // globally unique, e.g. "my-ext.eye"
  component: ComponentType<PanelHeaderContext>;
  order?: number;                              // among header accessories (default 100)
}

interface PanelHeaderContext {
  panelId: string;
  title: string;
  module?: ModuleId;     // the dock module the panel defaults into, if known
  extensionId: string;   // who registered the panel ("host" / "core.*" for built-ins)
  previewable: boolean;  // the renderer can preview this panel's effect off
}
```

The component receives each panel's identity as props and returns `null` to render nothing for that panel. `previewable` is true when the panel governs core adjustments or its extension owns a GPU stage, and false for panels with no image effect (Histogram, Edit, Presets), so a preview eye can hide itself there. Handle your own pointer events, as for `headerAccessory`.

## Slots (`registerSlot`)

Named mount points in core chrome — render a component into a fixed region without owning a whole panel.

```typescript
interface SlotContribution {
  id: string;
  slot: "library-toolbar" | "library-subbar" | "develop-toolbar"
      | "develop-canvas-overlay" | "develop-detail";
  component: ComponentType;
  order?: number;             // sort within the slot (default 100)
}
```

| Slot | Location |
|---|---|
| `library-toolbar` | The Library toolbar |
| `library-subbar` | A full-width bar directly below the Library toolbar (rendered only when something contributes to it) |
| `develop-toolbar` | The Develop status bar, left of the zoom controls |
| `develop-canvas-overlay` | A click-through layer over the Develop canvas — pair with [`api.develop`](stores.md#apidevelop) to build before/after overlays and canvas tools |
| `develop-detail` | Inside the Detail panel's Noise Reduction area; **replaces** the built-in NR sliders when contributed (e.g. an alternative denoiser) |

`api.unregisterSlot(id)` removes one slot contribution, so a slot can come and go with feature state. A denoiser, for example, drops its `develop-detail` controls when its method is set to "off", and the Detail panel falls back to the built-in sliders.

## Layouts (`registerLayout`)

A named dock arrangement selectable from the Layout menu.

```typescript
interface LayoutContribution {
  id: string; name: string; description?: string;
  modules?: Partial<Record<string, {   // keyed by module id
    rails: { side: "left" | "right" | "bottom"; width?: number; height?: number; panels: string[] }[];
    floating?: Record<string, { x: number; y: number; width: number }>;
  }>>;
}
```

A layout with no `modules` resolves to the registry's `defaultDock` placements — that is what the built-in **Classic** layout does, so extension panels join it automatically. A registered module a layout has no entry for resolves to its `defaultLayout`, if it has one.
