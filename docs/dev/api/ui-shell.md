# UI Shell: Modules, Panels & Slots

← [API Reference](README.md)

Where extension UI mounts in the app shell. For the components you put *inside* these mounts, see [UI Components](components.md).

## Modules

Safelight has a fixed two-**module** shell — **Library** (browsing/culling) and **Develop** (editing). Extensions do *not* create new top-level modules; instead they extend the existing two through three mount mechanisms:

| Mechanism | Contribution | What it gives you | Where it lives |
|---|---|---|---|
| **Panel** | `registerPanel` | A dockable, tabbable, floatable window with your own React component | A dock rail in Library or Develop (placed via `defaultDock`) |
| **Slot** | `registerSlot` | A component injected into a fixed region of core chrome | Named `SlotName` regions (toolbars, sub-bars, the canvas overlay) |
| **Stack panel** | `registerPanel` with `slot` | A small panel hosted inside a composite stack | `"develop-right"` / `"develop-left"` |

Switch the active module imperatively with `api.navigation.goTo("library" | "develop")`, and read it from `api.stores.useUIStore(s => s.activeModule)`. A panel's component is mounted whenever the panel is visible in its module; it is *not* told which module it is in — read `useUIStore` if you need to vary behavior.

> **Detached-window gotcha:** popped-out windows carry a `?detached=` URL param and report through `useUIStore`'s `detached` set. Gate any "only in the develop module" logic on both `activeModule` **and** the detached param, or it will misbehave in a popped-out window.

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
    module: "library" | "develop";
    direction: "left" | "right" | "bottom"; // "bottom" = full-width horizontal strip
    order?: number;
    width?: number;           // side-rail column width
    height?: number;          // bottom-rail strip height
  };
  onReset?: () => void;       // adds "Reset to defaults" to the dock header; one undoable action
}
```

Side rails render panels top-to-bottom at natural height; a **bottom** rail renders its panels side-by-side, each filling the strip's height, with the rail resized from its top edge. Collapsing folds a bottom rail downward — once every panel in it is collapsed the rail drops to its headers and gives the band back to the main view, restoring its height when one is expanded again.

Bottom rails are **opt-in**. A panel is a vertical column unless it sets `allowBottomDock` (declaring `defaultDock.direction: "bottom"` implies it), and the dock offers a bottom drop target only for those — dragging any other panel over the strip floats it instead. This keeps a histogram or a curve editor out of a 112px band it was never laid out for. A saved layout carrying such a panel in a bottom rail is pruned on load; reopening it from the View menu re-docks it at its own default.

A component that must adapt to its rail (e.g. a filmstrip that flips horizontal when docked at the bottom) reads its placement with the hook:

```typescript
const { side } = api.dock.usePanelPlacement(); // "left" | "right" | "bottom" | "float"
```

To *replace* a stock panel, register your own and tell users to disable the built-in (e.g. "Histogram") in the Extensions panel.

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

## Layouts (`registerLayout`)

A named dock arrangement selectable from the Layout menu.

```typescript
interface LayoutContribution {
  id: string; name: string; description?: string;
  modules?: Partial<Record<"library" | "develop", {
    rails: { side: "left" | "right" | "bottom"; width?: number; height?: number; panels: string[] }[];
    floating?: Record<string, { x: number; y: number; width: number }>;
  }>>;
}
```

A layout with no `modules` resolves to the registry's `defaultDock` placements — that is what the built-in **Classic** layout does, so extension panels join it automatically.
