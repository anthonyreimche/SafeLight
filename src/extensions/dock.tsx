// Custom Lightroom-style dock. Side rails are single scrollable columns where
// every docked panel renders at its natural height (height follows content and
// width — panels never get their own scrollbar; the rail scrolls). Dragging a
// panel header re-docks it at any position in any rail, drops it on an edge
// strip to create a new rail, or anywhere else to float it as a window.
// Layouts persist per module; Tab hides everything and restores it unchanged.

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { create } from "zustand";
import { useRegistry } from "./registry";
import type { AppModule } from "@/catalog/types";
import type { ModuleLayoutDef } from "./types";
import { detachedModule } from "@/state/detach";

// v4: dockview replaced by the custom rail dock; old grid layouts don't apply.
const layoutKey = (module: AppModule) =>
  `sl_dock_layout_v4:${module}${detachedModule() ? ":detached" : ""}`;

const EDGE = 24; // px-wide drop strips that create a new rail
const MIN_RAIL = 200;
const MAX_RAIL = 440;
const MIN_FLOAT = 220;
const MAX_FLOAT = 480;
const DRAG_THRESHOLD = 5;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface RailState {
  id: string;
  side: "left" | "right";
  width: number;
  /** Panel ids top→bottom. Left rails order outermost→innermost in the rails
   *  array; right rails innermost→outermost (i.e. render order). */
  panels: string[];
}
interface FloatState {
  x: number;
  y: number;
  width: number;
}

interface DockState {
  module: AppModule | null;
  rails: RailState[];
  floating: Record<string, FloatState>;
  /** Floating z-order, back→front. */
  zOrder: string[];
  collapsed: Record<string, boolean>;
  hidden: boolean;
  /** Every panel open in the dock (rails + floating) — drives View-menu checks. */
  open: string[];
  /** Live drag, rendered as a ghost chip + drop indicator. */
  drag: { id: string; x: number; y: number } | null;
  target: DropTarget | null;
}

type DropTarget =
  | { kind: "rail"; railId: string; index: number; line: { x: number; y: number; w: number } }
  | { kind: "newRail"; side: "left" | "right"; index: number; x: number; top: number; height: number }
  | { kind: "float" };

export const useDockStore = create<DockState>(() => ({
  module: null,
  rails: [],
  floating: {},
  zOrder: [],
  collapsed: {},
  hidden: false,
  open: [],
  drag: null,
  target: null,
}));

const openList = (rails: RailState[], floating: Record<string, FloatState>) => [
  ...rails.flatMap((r) => r.panels),
  ...Object.keys(floating),
];

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const s = useDockStore.getState();
    if (!s.module) return;
    try {
      localStorage.setItem(
        layoutKey(s.module),
        JSON.stringify({
          rails: s.rails,
          floating: s.floating,
          zOrder: s.zOrder,
          collapsed: s.collapsed,
        }),
      );
    } catch {}
  }, 300);
}

function commit(partial: Partial<DockState>) {
  const s = useDockStore.getState();
  const rails = partial.rails ?? s.rails;
  const floating = partial.floating ?? s.floating;
  useDockStore.setState({ ...partial, open: openList(rails, floating) });
  markLayoutCustom(); // any user edit to a preset turns it into "Custom"
  scheduleSave();
}

/** Layout with `id` removed everywhere; empty rails dropped. */
function without(id: string) {
  const s = useDockStore.getState();
  const rails = s.rails
    .map((r) => ({ ...r, panels: r.panels.filter((p) => p !== id) }))
    .filter((r) => r.panels.length > 0);
  const floating = { ...s.floating };
  delete floating[id];
  return { rails, floating, zOrder: s.zOrder.filter((p) => p !== id) };
}

function seedDefaults(module: AppModule): RailState[] {
  const panels = Object.values(useRegistry.getState().panels)
    .filter((p) => p.defaultDock?.module === module)
    .sort(
      (a, b) => (a.defaultDock?.order ?? 100) - (b.defaultDock?.order ?? 100),
    );
  const rails: RailState[] = [];
  for (const side of ["left", "right"] as const) {
    const group = panels.filter((p) => p.defaultDock!.direction === side);
    if (group.length)
      rails.push({
        id: `${side}-default`,
        side,
        width: group[0].defaultDock!.width ?? 280,
        panels: group.map((p) => p.id),
      });
  }
  return rails;
}

// ---------------------------------------------------------------------------
// Layout presets (the Layout menu). The active choice is a global preference:
// "custom" = the user's own saved per-module arrangement (historic behavior);
// any other id = a registered LayoutContribution applied on top of the
// registry defaults. Editing the dock while a preset is active flips back to
// Custom, with the edited state becoming the new custom layout.
// ---------------------------------------------------------------------------

export const CUSTOM_LAYOUT = "custom";
const LAYOUT_PREF_KEY = "sl_layout_pref";

export const useLayoutStore = create<{ activeId: string }>(() => ({
  activeId: (() => {
    try {
      return localStorage.getItem(LAYOUT_PREF_KEY) ?? CUSTOM_LAYOUT;
    } catch {
      return CUSTOM_LAYOUT;
    }
  })(),
}));

function setActiveLayout(id: string) {
  useLayoutStore.setState({ activeId: id });
  try {
    localStorage.setItem(LAYOUT_PREF_KEY, id);
  } catch {}
}

function markLayoutCustom() {
  if (useLayoutStore.getState().activeId !== CUSTOM_LAYOUT)
    setActiveLayout(CUSTOM_LAYOUT);
}

/** Switch the active layout and rebuild the current module's dock. */
export function applyDockLayout(id: string): void {
  setActiveLayout(id);
  const m = useDockStore.getState().module;
  if (m) loadModuleLayout(m);
}

/** Keep the layout choice in sync across windows (like themes). */
export function initDockLayouts(): void {
  window.addEventListener("storage", (e) => {
    if (e.key !== LAYOUT_PREF_KEY || !e.newValue) return;
    if (e.newValue === useLayoutStore.getState().activeId) return;
    useLayoutStore.setState({ activeId: e.newValue });
    const m = useDockStore.getState().module;
    if (m) loadModuleLayout(m);
  });
}

function railsFromDef(module: AppModule, def: ModuleLayoutDef): RailState[] {
  return def.rails.map((r, i) => ({
    id: `${module}-${r.side}-${i}`,
    side: r.side,
    width: r.width ?? 280,
    panels: [...r.panels],
  }));
}

/** Build dock state for `module` from the active layout. */
function loadModuleLayout(module: AppModule) {
  const activeId = useLayoutStore.getState().activeId;
  let rails: RailState[] | null = null;
  let floating: Record<string, FloatState> = {};
  let zOrder: string[] | null = null;
  let collapsed: Record<string, boolean> = {};

  if (activeId === CUSTOM_LAYOUT) {
    let saved: Partial<DockState> | null = null;
    try {
      const raw = localStorage.getItem(layoutKey(module));
      if (raw) saved = JSON.parse(raw);
    } catch {}
    if (Array.isArray(saved?.rails)) rails = saved!.rails!;
    floating = saved?.floating ?? {};
    zOrder = saved?.zOrder ?? null;
    collapsed = saved?.collapsed ?? {};
  } else {
    const def = useRegistry.getState().layouts[activeId]?.modules?.[module];
    if (def) {
      rails = railsFromDef(module, def);
      floating = def.floating ?? {};
    }
  }
  rails ??= seedDefaults(module);
  useDockStore.setState({
    module,
    rails,
    floating,
    zOrder: zOrder ?? Object.keys(floating),
    collapsed,
    hidden: false,
    open: openList(rails, floating),
    drag: null,
    target: null,
  });
}

function initModule(module: AppModule) {
  // Flush any pending save for the outgoing module before replacing state.
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    const prev = useDockStore.getState();
    if (prev.module && prev.module !== module) {
      try {
        localStorage.setItem(
          layoutKey(prev.module),
          JSON.stringify({
            rails: prev.rails,
            floating: prev.floating,
            zOrder: prev.zOrder,
            collapsed: prev.collapsed,
          }),
        );
      } catch {}
    }
  }
  loadModuleLayout(module);
}

// ---------------------------------------------------------------------------
// Public dock API (View menu, Tab toggle, extensions)
// ---------------------------------------------------------------------------

export function toggleDockPanel(id: string): void {
  const s = useDockStore.getState();
  if (s.open.includes(id)) {
    commit(without(id));
    return;
  }
  const n = Object.keys(s.floating).length;
  commit({
    floating: {
      ...s.floating,
      [id]: { x: 60 + n * 24, y: 60 + n * 24, width: 320 },
    },
    zOrder: [...s.zOrder, id],
  });
}

export function toggleDockVisibility(): void {
  useDockStore.setState((s) => ({ hidden: !s.hidden }));
}

// ---------------------------------------------------------------------------
// Layout mutations
// ---------------------------------------------------------------------------

function toggleCollapsed(id: string) {
  const s = useDockStore.getState();
  commit({ collapsed: { ...s.collapsed, [id]: !s.collapsed[id] } });
}

function bringToFront(id: string) {
  const s = useDockStore.getState();
  if (!(id in s.floating)) return;
  commit({ zOrder: [...s.zOrder.filter((p) => p !== id), id] });
}

function setRailWidth(railId: string, width: number) {
  const s = useDockStore.getState();
  commit({
    rails: s.rails.map((r) => (r.id === railId ? { ...r, width } : r)),
  });
}

function setFloatWidth(id: string, width: number) {
  const s = useDockStore.getState();
  const f = s.floating[id];
  if (!f) return;
  commit({ floating: { ...s.floating, [id]: { ...f, width } } });
}

function dropToRail(id: string, railId: string, index: number) {
  const s = useDockStore.getState();
  let rails = s.rails.map((r) => ({
    ...r,
    panels: r.panels.filter((p) => p !== id),
  }));
  const floating = { ...s.floating };
  delete floating[id];
  rails = rails
    .map((r) =>
      r.id === railId
        ? {
            ...r,
            panels: [...r.panels.slice(0, index), id, ...r.panels.slice(index)],
          }
        : r,
    )
    .filter((r) => r.panels.length > 0);
  commit({ rails, floating, zOrder: s.zOrder.filter((p) => p !== id) });
}

function dropToNewRail(id: string, side: "left" | "right", index: number) {
  const s = useDockStore.getState();
  const rails = s.rails
    .map((r) => ({ ...r, panels: r.panels.filter((p) => p !== id) }))
    .filter((r) => r.panels.length > 0);
  const floating = { ...s.floating };
  delete floating[id];
  const rail: RailState = {
    id: `rail-${Date.now().toString(36)}`,
    side,
    width: useRegistry.getState().panels[id]?.defaultDock?.width ?? 280,
    panels: [id],
  };
  const same = rails.filter((r) => r.side === side);
  const other = rails.filter((r) => r.side !== side);
  same.splice(Math.min(index, same.length), 0, rail);
  commit({
    rails: side === "left" ? [...same, ...other] : [...other, ...same],
    floating,
    zOrder: s.zOrder.filter((p) => p !== id),
  });
}

function dropToFloat(id: string, x: number, y: number, width: number) {
  const s = useDockStore.getState();
  const rails = s.rails
    .map((r) => ({ ...r, panels: r.panels.filter((p) => p !== id) }))
    .filter((r) => r.panels.length > 0);
  commit({
    rails,
    floating: { ...s.floating, [id]: { x, y, width } },
    zOrder: [...s.zOrder.filter((p) => p !== id), id],
  });
}

// ---------------------------------------------------------------------------
// Drag handling
// ---------------------------------------------------------------------------

function hitTest(container: HTMLElement, x: number, y: number, dragId: string): DropTarget {
  const c = container.getBoundingClientRect();
  const s = useDockStore.getState();
  const leftCount = s.rails.filter((r) => r.side === "left").length;
  const rightCount = s.rails.filter((r) => r.side === "right").length;
  const strip = { top: c.top, height: c.height };

  // Outermost edges of the whole dock area → new outermost rail.
  if (x < c.left + EDGE)
    return { kind: "newRail", side: "left", index: 0, x: c.left + 2, ...strip };
  if (x > c.right - EDGE)
    return { kind: "newRail", side: "right", index: rightCount, x: c.right - 4, ...strip };

  // Inside an existing rail → insertion point between panels.
  for (const el of Array.from(container.querySelectorAll<HTMLElement>("[data-rail]"))) {
    const r = el.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
    const railId = el.dataset.rail!;
    const items = Array.from(
      el.querySelectorAll<HTMLElement>("[data-dock-panel]"),
    ).filter((p) => p.dataset.dockPanel !== dragId);
    let index = items.length;
    let lineY = items.length
      ? items[items.length - 1].getBoundingClientRect().bottom
      : r.top + 2;
    for (let i = 0; i < items.length; i++) {
      const pr = items[i].getBoundingClientRect();
      if (y < pr.top + pr.height / 2) {
        index = i;
        lineY = pr.top;
        break;
      }
    }
    return { kind: "rail", railId, index, line: { x: r.left, y: lineY, w: r.width } };
  }

  // Strips just inside the main view's edges → new innermost rail.
  const main = container.querySelector<HTMLElement>("[data-dock-main]");
  if (main) {
    const m = main.getBoundingClientRect();
    if (x >= m.left && x < m.left + EDGE)
      return { kind: "newRail", side: "left", index: leftCount, x: m.left, ...strip };
    if (x <= m.right && x > m.right - EDGE)
      return { kind: "newRail", side: "right", index: 0, x: m.right - 2, ...strip };
  }
  return { kind: "float" };
}

/** Header pointerdown: a plain click toggles collapse; moving past the
 *  threshold starts a drag that re-docks or floats the panel on release. */
function startHeaderDrag(
  id: string,
  e: ReactPointerEvent,
  container: HTMLElement | null,
) {
  if (e.button !== 0 || !container) return;
  if ((e.target as HTMLElement).closest("button")) return;
  e.preventDefault();
  bringToFront(id);
  const startX = e.clientX;
  const startY = e.clientY;
  const header = e.currentTarget as HTMLElement;
  const width = header.getBoundingClientRect().width;
  const ox = startX - header.getBoundingClientRect().left;
  let active = false;

  const move = (ev: PointerEvent) => {
    if (!active && Math.hypot(ev.clientX - startX, ev.clientY - startY) < DRAG_THRESHOLD)
      return;
    active = true;
    useDockStore.setState({
      drag: { id, x: ev.clientX, y: ev.clientY },
      target: hitTest(container, ev.clientX, ev.clientY, id),
    });
  };
  const up = (ev: PointerEvent) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    if (!active) {
      toggleCollapsed(id);
      return;
    }
    const t = hitTest(container, ev.clientX, ev.clientY, id);
    useDockStore.setState({ drag: null, target: null });
    if (t.kind === "rail") dropToRail(id, t.railId, t.index);
    else if (t.kind === "newRail") dropToNewRail(id, t.side, t.index);
    else {
      const c = container.getBoundingClientRect();
      const w = Math.min(Math.max(width, MIN_FLOAT), MAX_FLOAT);
      const x = Math.min(Math.max(ev.clientX - ox - c.left, 0), c.width - w);
      const y = Math.min(Math.max(ev.clientY - 12 - c.top, 0), c.height - 40);
      dropToFloat(id, x, y, w);
    }
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

function startResize(
  e: ReactPointerEvent,
  start: number,
  min: number,
  max: number,
  sign: 1 | -1,
  apply: (w: number) => void,
) {
  if (e.button !== 0) return;
  e.preventDefault();
  const startX = e.clientX;
  const move = (ev: PointerEvent) => {
    const w = start + sign * (ev.clientX - startX);
    apply(Math.min(Math.max(w, min), max));
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/** The hosting dock panel's title. A Panel whose own title matches renders
 *  without its collapsible header — the dock header already names it. */
export const DockPanelTitleCtx = createContext<string | null>(null);

const ContainerCtx = createContext<RefObject<HTMLDivElement | null> | null>(null);

function PanelBody({ id }: { id: string }) {
  const reg = useRegistry((s) => s.panels[id]);
  if (!reg)
    return (
      <div className="p-3 text-[11px] text-text-muted">
        Panel “{id}” is disabled or not installed.
      </div>
    );
  const C = reg.component;
  return (
    <DockPanelTitleCtx.Provider value={reg.title}>
      <C />
    </DockPanelTitleCtx.Provider>
  );
}

function PanelHeader({ id }: { id: string }) {
  const containerRef = useContext(ContainerCtx);
  const title = useRegistry((s) => s.panels[id]?.title ?? id);
  const collapsed = useDockStore((s) => !!s.collapsed[id]);
  return (
    <div
      onPointerDown={(e) => startHeaderDrag(id, e, containerRef?.current ?? null)}
      className="flex h-7 shrink-0 cursor-grab select-none items-center gap-1.5 border-b border-border-subtle bg-surface-2 px-2"
    >
      <span className="w-2 text-[9px] text-text-muted">
        {collapsed ? "▸" : "▾"}
      </span>
      <span className="flex-1 truncate text-[11px] uppercase tracking-wider text-text-secondary">
        {title}
      </span>
      <button
        title="Close panel"
        onClick={() => commit(without(id))}
        className="rounded px-1 text-[12px] leading-none text-text-muted hover:text-text-primary"
      >
        ×
      </button>
    </div>
  );
}

function DockedPanel({ id }: { id: string }) {
  const collapsed = useDockStore((s) => !!s.collapsed[id]);
  return (
    <div data-dock-panel={id} className="shrink-0 border-b border-border">
      <PanelHeader id={id} />
      {!collapsed && <PanelBody id={id} />}
    </div>
  );
}

function Rail({ rail }: { rail: RailState }) {
  return (
    <div
      data-rail={rail.id}
      className={`relative h-full shrink-0 bg-surface-1 ${
        rail.side === "left" ? "border-r" : "border-l"
      } border-border`}
      style={{ width: rail.width }}
    >
      <div className="h-full overflow-y-auto overflow-x-hidden">
        {rail.panels.map((id) => (
          <DockedPanel key={id} id={id} />
        ))}
      </div>
      <div
        onPointerDown={(e) =>
          startResize(e, rail.width, MIN_RAIL, MAX_RAIL,
            rail.side === "left" ? 1 : -1,
            (w) => setRailWidth(rail.id, w))
        }
        className={`absolute top-0 z-10 h-full w-1 cursor-col-resize hover:bg-accent/40 ${
          rail.side === "left" ? "-right-0.5" : "-left-0.5"
        }`}
      />
    </div>
  );
}

function FloatingPanel({ id }: { id: string }) {
  const pos = useDockStore((s) => s.floating[id]);
  const z = useDockStore((s) => s.zOrder.indexOf(id));
  const collapsed = useDockStore((s) => !!s.collapsed[id]);
  if (!pos) return null;
  return (
    <div
      onPointerDown={() => bringToFront(id)}
      className="absolute flex flex-col overflow-hidden rounded border border-border bg-surface-1 shadow-2xl"
      style={{ left: pos.x, top: pos.y, width: pos.width, zIndex: 30 + Math.max(z, 0) }}
    >
      <PanelHeader id={id} />
      {!collapsed && (
        <div className="max-h-[70vh] overflow-y-auto">
          <PanelBody id={id} />
        </div>
      )}
      <div
        onPointerDown={(e) =>
          startResize(e, pos.width, MIN_FLOAT, MAX_FLOAT, 1, (w) =>
            setFloatWidth(id, w))
        }
        className="absolute right-0 top-0 h-full w-1 cursor-col-resize hover:bg-accent/40"
      />
    </div>
  );
}

function DragOverlay() {
  const drag = useDockStore((s) => s.drag);
  const target = useDockStore((s) => s.target);
  const title = useRegistry((s) => (drag ? (s.panels[drag.id]?.title ?? drag.id) : ""));
  if (!drag) return null;
  return (
    <>
      {target?.kind === "rail" && (
        <div
          className="pointer-events-none fixed z-50 h-0.5 bg-accent"
          style={{ left: target.line.x, top: target.line.y - 1, width: target.line.w }}
        />
      )}
      {target?.kind === "newRail" && (
        <div
          className="pointer-events-none fixed z-50 w-1 bg-accent/70"
          style={{ left: target.x, top: target.top, height: target.height }}
        />
      )}
      <div
        className="pointer-events-none fixed z-50 rounded border border-accent bg-surface-2 px-3 py-1 text-[11px] uppercase tracking-wider text-text-primary opacity-90 shadow-xl"
        style={{ left: drag.x + 10, top: drag.y + 10 }}
      >
        {title}
      </div>
    </>
  );
}

export function DockHost({
  module,
  children,
}: {
  module: AppModule;
  children: ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const ready = useDockStore((s) => s.module === module);
  const hidden = useDockStore((s) => s.hidden);
  const rails = useDockStore((s) => s.rails);
  const floatIds = useDockStore((s) => s.zOrder);

  useEffect(() => {
    initModule(module);
  }, [module]);

  const show = ready && !hidden;
  const left = show ? rails.filter((r) => r.side === "left") : [];
  const right = show ? rails.filter((r) => r.side === "right") : [];

  return (
    <ContainerCtx.Provider value={containerRef}>
      <div ref={containerRef} className="relative flex min-h-0 flex-1 overflow-hidden">
        {left.map((r) => (
          <Rail key={r.id} rail={r} />
        ))}
        <div data-dock-main className="flex h-full min-w-0 flex-1 flex-col">
          {children}
        </div>
        {right.map((r) => (
          <Rail key={r.id} rail={r} />
        ))}
        {show && floatIds.map((id) => <FloatingPanel key={id} id={id} />)}
        <DragOverlay />
      </div>
    </ContainerCtx.Provider>
  );
}
