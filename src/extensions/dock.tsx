// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Custom Lightroom-style dock. Side rails are single scrollable columns where
// every docked panel renders at its natural height (height follows content and
// width — panels never get their own scrollbar; the rail scrolls), except that
// one `fill` panel per rail may stretch to the remaining height and scroll
// itself. Bottom rails are full-width horizontal strips under the main view
// whose panels sit side-by-side and always fill the rail height. Dragging a
// panel header re-docks it at any position in any rail, drops it on an edge
// strip to create a new rail, or anywhere else to float it as a window.
// Layouts persist per module; Tab hides everything and restores it unchanged.

import {
  Component,
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { ContextMenu } from "@/ui/components/ContextMenu";
import { create } from "zustand";
import { useRegistry, usePanelHeaderAccessories } from "./registry";
import { panelIsPreviewable } from "@/modules/develop/panel-bypass";
import { frameLocalPoint } from "@/ui/frame-point";
import { getSettings } from "@/state/settings-store";
import type { AppModule } from "@/catalog/types";
import type { ModuleLayoutDef, PanelPlacement } from "./types";
import type { RegisteredPanel } from "./registry";
import { detachedModule } from "@/state/detach";

class PanelErrorBoundary extends Component<
  { id: string; children: ReactNode },
  { error: unknown }
> {
  constructor(props: { id: string; children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  render() {
    if (this.state.error) {
      const msg =
        this.state.error instanceof Error
          ? this.state.error.message
          : String(this.state.error);
      return (
        <div className="p-3 text-[11px] text-red-400">
          Panel "{this.props.id}" crashed: {msg}
        </div>
      );
    }
    return this.props.children;
  }
}

// v4: dockview replaced by the custom rail dock; old grid layouts don't apply.
const layoutKey = (module: AppModule) =>
  `sl_dock_layout_v4:${module}${detachedModule() ? ":detached" : ""}`;

const EDGE = 24; // px-wide drop strips that create a new rail
const MIN_RAIL = 200;
const MAX_RAIL = 440;
const MIN_BOTTOM = 56;
const MAX_BOTTOM = 320;
const DEFAULT_BOTTOM = 112;
const MIN_FLOAT = 220;
const MAX_FLOAT = 480;
const DRAG_THRESHOLD = 5;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface RailState {
  id: string;
  side: "left" | "right" | "bottom";
  /** Side rails: column width. Bottom rails size by `height` instead. */
  width: number;
  /** Bottom rails: strip height. */
  height?: number;
  /** Panel ids top→bottom (side rails) or left→right (bottom rails). Left
   *  rails order outermost→innermost in the rails array; right rails
   *  innermost→outermost (i.e. render order); bottom rails top→bottom. */
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

/** Drop indicator box in visual px (client coords). */
interface DropLine {
  x: number;
  y: number;
  w: number;
  h: number;
}

type DropTarget =
  | { kind: "rail"; railId: string; index: number; line: DropLine }
  | { kind: "newRail"; side: RailState["side"]; index: number; line: DropLine }
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

function saveLayout(
  s: Pick<DockState, "module" | "rails" | "floating" | "zOrder" | "collapsed">,
) {
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
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveLayout(useDockStore.getState()), 300);
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

/** Bottom rails are horizontal strips, so only panels that lay out that way
 *  belong in one — a vertical column squeezed into a 112px band reads as
 *  broken. Panels opt in with `allowBottomDock` (or by defaulting there). An
 *  unregistered id gets the benefit of the doubt: its extension may still be
 *  loading, and dropping it would evict a filmstrip from its own rail. */
function allowsBottom(panel: RegisteredPanel | undefined): boolean {
  if (!panel) return true;
  return (
    panel.allowBottomDock === true || panel.defaultDock?.direction === "bottom"
  );
}

function seedDefaults(module: AppModule): RailState[] {
  const panels = Object.values(useRegistry.getState().panels)
    .filter((p) => p.defaultDock?.module === module)
    .sort(
      (a, b) => (a.defaultDock?.order ?? 100) - (b.defaultDock?.order ?? 100),
    );
  const rails: RailState[] = [];
  for (const side of ["left", "right", "bottom"] as const) {
    const group = panels.filter((p) => p.defaultDock!.direction === side);
    if (group.length)
      rails.push({
        id: `${side}-default`,
        side,
        width: group[0].defaultDock!.width ?? 280,
        ...(side === "bottom"
          ? { height: group[0].defaultDock!.height ?? DEFAULT_BOTTOM }
          : {}),
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

// ── User layouts: named arrangements the user saves from their current dock.
// Stored locally (not through the extension registry) but listed and applied
// alongside the registered presets — they share the active-id space and the
// same ModuleLayoutDef shape. Captured across both modules so switching modules
// keeps the saved arrangement.

export interface UserLayout {
  id: string;
  name: string;
  modules: Partial<Record<AppModule, ModuleLayoutDef>>;
}

const USER_LAYOUTS_KEY = "sl_user_layouts";

function loadUserLayouts(): Record<string, UserLayout> {
  try {
    const raw = localStorage.getItem(USER_LAYOUTS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export const useUserLayouts = create<{ layouts: Record<string, UserLayout> }>(
  () => ({ layouts: loadUserLayouts() }),
);

function persistUserLayouts(layouts: Record<string, UserLayout>) {
  useUserLayouts.setState({ layouts });
  try {
    localStorage.setItem(USER_LAYOUTS_KEY, JSON.stringify(layouts));
  } catch {}
}

/** A unique "Layout N" name not already taken. */
function defaultLayoutName(layouts: Record<string, UserLayout>): string {
  const names = new Set(Object.values(layouts).map((l) => l.name));
  for (let i = 1; ; i++) {
    const name = `Layout ${i}`;
    if (!names.has(name)) return name;
  }
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
    if (e.key === USER_LAYOUTS_KEY) {
      useUserLayouts.setState({ layouts: loadUserLayouts() });
      return;
    }
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
    ...(r.side === "bottom" ? { height: r.height ?? DEFAULT_BOTTOM } : {}),
    panels: [...r.panels],
  }));
}

/** Drop panels that don't lay out horizontally from bottom rails, and any rail
 *  left empty. A saved layout can carry them from a build where bottom docking
 *  was open to everything; the panels aren't lost — reopening one from the View
 *  menu re-docks it at its own default. */
function pruneBottomRails(rails: RailState[]): RailState[] {
  const registered = useRegistry.getState().panels;
  return rails
    .map((r) =>
      r.side === "bottom"
        ? { ...r, panels: r.panels.filter((id) => allowsBottom(registered[id])) }
        : r,
    )
    .filter((r) => r.panels.length > 0);
}

/** Resolve dock state for `module` under the active layout, without applying it. */
function resolveModuleState(module: AppModule): {
  rails: RailState[];
  floating: Record<string, FloatState>;
  zOrder: string[];
  collapsed: Record<string, boolean>;
} {
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
    // A user layout wins over a registered preset if the id ever collides.
    const def =
      useUserLayouts.getState().layouts[activeId]?.modules?.[module] ??
      useRegistry.getState().layouts[activeId]?.modules?.[module];
    if (def) {
      rails = railsFromDef(module, def);
      floating = def.floating ?? {};
    }
  }
  rails = pruneBottomRails(rails ?? seedDefaults(module));
  return { rails, floating, zOrder: zOrder ?? Object.keys(floating), collapsed };
}

/** Build dock state for `module` from the active layout. */
function loadModuleLayout(module: AppModule) {
  const { rails, floating, zOrder, collapsed } = resolveModuleState(module);
  useDockStore.setState({
    module,
    rails,
    floating,
    zOrder,
    collapsed,
    hidden: false,
    open: openList(rails, floating),
    drag: null,
    target: null,
  });
}

// ── User-layout capture + CRUD ──────────────────────────────────────────────

const LAYOUT_MODULES: AppModule[] = ["library", "develop"];

/** Convert live rail/floating state into the serializable ModuleLayoutDef. */
function moduleDefFromState(
  rails: RailState[],
  floating: Record<string, FloatState>,
): ModuleLayoutDef {
  const def: ModuleLayoutDef = {
    rails: rails.map((r) => ({
      side: r.side,
      width: r.width,
      ...(r.height != null ? { height: r.height } : {}),
      panels: [...r.panels],
    })),
  };
  if (Object.keys(floating).length) def.floating = { ...floating };
  return def;
}

/** Snapshot the current arrangement of every module. The active module is read
 *  live from the dock; the others are resolved from the active layout. */
function captureCurrentLayout(): Partial<Record<AppModule, ModuleLayoutDef>> {
  const s = useDockStore.getState();
  const out: Partial<Record<AppModule, ModuleLayoutDef>> = {};
  for (const m of LAYOUT_MODULES) {
    const { rails, floating } = s.module === m ? s : resolveModuleState(m);
    out[m] = moduleDefFromState(rails, floating);
  }
  return out;
}

/** Save the current arrangement as a new named layout and switch to it. */
export function addUserLayout(name?: string): string {
  const layouts = useUserLayouts.getState().layouts;
  const id = `user.${Date.now().toString(36)}`;
  persistUserLayouts({
    ...layouts,
    [id]: {
      id,
      name: name?.trim() || defaultLayoutName(layouts),
      modules: captureCurrentLayout(),
    },
  });
  setActiveLayout(id);
  return id;
}

/** Overwrite an existing user layout with the current arrangement. */
export function updateUserLayout(id: string): void {
  const existing = useUserLayouts.getState().layouts[id];
  if (!existing) return;
  persistUserLayouts({
    ...useUserLayouts.getState().layouts,
    [id]: { ...existing, modules: captureCurrentLayout() },
  });
  // The dock now matches the saved layout again, so re-select it (editing a
  // preset/layout flips the active id to Custom).
  setActiveLayout(id);
}

export function renameUserLayout(id: string, name: string): void {
  const existing = useUserLayouts.getState().layouts[id];
  if (!existing || !name.trim()) return;
  persistUserLayouts({
    ...useUserLayouts.getState().layouts,
    [id]: { ...existing, name: name.trim() },
  });
}

export function deleteUserLayout(id: string): void {
  const next = { ...useUserLayouts.getState().layouts };
  if (!(id in next)) return;
  delete next[id];
  persistUserLayouts(next);
  if (useLayoutStore.getState().activeId === id) applyDockLayout(CUSTOM_LAYOUT);
}

function initModule(module: AppModule) {
  // Flush any pending save for the outgoing module before replacing state.
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    const prev = useDockStore.getState();
    if (prev.module && prev.module !== module) saveLayout(prev);
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
  // A closed panel with a default dock in the current module reopens there —
  // appended to the first rail on its side, or in a fresh rail — instead of
  // floating, so View-menu/shortcut toggles land panels where they belong.
  const def = useRegistry.getState().panels[id]?.defaultDock;
  if (def && def.module === s.module) {
    const rail = s.rails.find((r) => r.side === def.direction);
    if (rail) dropToRail(id, rail.id, rail.panels.length);
    else dropToNewRail(id, def.direction, 0);
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
  if (s.zOrder[s.zOrder.length - 1] === id) return;
  commit({ zOrder: [...s.zOrder.filter((p) => p !== id), id] });
}

function setRailWidth(railId: string, width: number) {
  const s = useDockStore.getState();
  commit({
    rails: s.rails.map((r) => (r.id === railId ? { ...r, width } : r)),
  });
}

function setRailHeight(railId: string, height: number) {
  const s = useDockStore.getState();
  commit({
    rails: s.rails.map((r) => (r.id === railId ? { ...r, height } : r)),
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

function dropToNewRail(id: string, side: RailState["side"], index: number) {
  const s = useDockStore.getState();
  const rails = s.rails
    .map((r) => ({ ...r, panels: r.panels.filter((p) => p !== id) }))
    .filter((r) => r.panels.length > 0);
  const floating = { ...s.floating };
  delete floating[id];
  const def = useRegistry.getState().panels[id]?.defaultDock;
  const rail: RailState = {
    id: `rail-${Date.now().toString(36)}`,
    side,
    width: def?.width ?? 280,
    ...(side === "bottom" ? { height: def?.height ?? DEFAULT_BOTTOM } : {}),
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
  const bottomCount = s.rails.filter((r) => r.side === "bottom").length;
  const vStrip = { y: c.top, w: 4, h: c.height };
  // A panel that can't lay out horizontally is never offered a bottom target;
  // dragging it over the strip floats it instead.
  const canBottom = allowsBottom(useRegistry.getState().panels[dragId]);

  // Outermost edges of the whole dock area → new outermost rail.
  if (x < c.left + EDGE)
    return { kind: "newRail", side: "left", index: 0, line: { x: c.left + 2, ...vStrip } };
  if (x > c.right - EDGE)
    return { kind: "newRail", side: "right", index: rightCount, line: { x: c.right - 6, ...vStrip } };
  if (canBottom && y > c.bottom - EDGE)
    return {
      kind: "newRail",
      side: "bottom",
      index: bottomCount,
      line: { x: c.left, y: c.bottom - 6, w: c.width, h: 4 },
    };

  // Inside an existing rail → insertion point between panels (stacked in side
  // rails, side-by-side in bottom rails).
  for (const el of Array.from(container.querySelectorAll<HTMLElement>("[data-rail]"))) {
    const r = el.getBoundingClientRect();
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue;
    const railId = el.dataset.rail!;
    const horizontal = s.rails.find((rr) => rr.id === railId)?.side === "bottom";
    if (horizontal && !canBottom) continue;
    const items = Array.from(
      el.querySelectorAll<HTMLElement>("[data-dock-panel]"),
    ).filter((p) => p.dataset.dockPanel !== dragId);
    let index = items.length;
    const last = items.length ? items[items.length - 1].getBoundingClientRect() : null;
    let at = horizontal ? (last?.right ?? r.left + 2) : (last?.bottom ?? r.top + 2);
    for (let i = 0; i < items.length; i++) {
      const pr = items[i].getBoundingClientRect();
      const before = horizontal
        ? x < pr.left + pr.width / 2
        : y < pr.top + pr.height / 2;
      if (before) {
        index = i;
        at = horizontal ? pr.left : pr.top;
        break;
      }
    }
    return {
      kind: "rail",
      railId,
      index,
      line: horizontal
        ? { x: at, y: r.top, w: 2, h: r.height }
        : { x: r.left, y: at, w: r.width, h: 2 },
    };
  }

  // Strips just inside the main view's edges → new innermost rail.
  const main = container.querySelector<HTMLElement>("[data-dock-main]");
  if (main) {
    const m = main.getBoundingClientRect();
    if (x >= m.left && x < m.left + EDGE)
      return { kind: "newRail", side: "left", index: leftCount, line: { x: m.left, ...vStrip } };
    if (x <= m.right && x > m.right - EDGE)
      return { kind: "newRail", side: "right", index: 0, line: { x: m.right - 2, ...vStrip } };
    if (canBottom && y <= m.bottom && y > m.bottom - EDGE)
      return {
        kind: "newRail",
        side: "bottom",
        index: 0,
        line: { x: m.left, y: m.bottom - 2, w: m.width, h: 4 },
      };
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
  // Header rect and the pointer grab offset are visual px under the <body>
  // UI-scale zoom; the float width/position they seed are layout px (CSS
  // width/left/top), so map both back through the zoom (see frame-point.ts).
  const z = getSettings().uiScale || 1;
  const hr = header.getBoundingClientRect();
  const width = hr.width / z;
  const ox = (startX - hr.left) / z;
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
      const p = frameLocalPoint(c, ev.clientX, ev.clientY);
      const w = Math.min(Math.max(width, MIN_FLOAT), MAX_FLOAT);
      const x = Math.min(Math.max(p.x - ox, 0), c.width / z - w);
      const y = Math.min(Math.max(p.y - 12, 0), c.height / z - 40);
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
  apply: (size: number) => void,
  axis: "x" | "y" = "x",
) {
  if (e.button !== 0) return;
  e.preventDefault();
  const startPos = axis === "x" ? e.clientX : e.clientY;
  // Pointer delta is visual px under the <body> UI-scale zoom; the size it
  // drives is layout px, so map it back through the zoom to track 1:1.
  const z = getSettings().uiScale || 1;
  const move = (ev: PointerEvent) => {
    const pos = axis === "x" ? ev.clientX : ev.clientY;
    const w = start + (sign * (pos - startPos)) / z;
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

const PLACEMENTS: Record<PanelPlacement["side"], PanelPlacement> = {
  left: { side: "left" },
  right: { side: "right" },
  bottom: { side: "bottom" },
  float: { side: "float" },
};
const PlacementCtx = createContext<PanelPlacement>(PLACEMENTS.float);

/** Where the hosting dock panel currently sits — lets a panel adapt its layout
 *  to its rail (e.g. a strip renders horizontal in a bottom rail). "float"
 *  covers floating windows and any render outside the dock. */
export function useDockPlacement(): PanelPlacement {
  return useContext(PlacementCtx);
}

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
  const onReset = useRegistry((s) => s.panels[id]?.onReset);
  const Accessory = useRegistry((s) => s.panels[id]?.headerAccessory);
  // Controls an extension contributes to EVERY panel header (e.g. a preview-off
  // eye). Each gets the panel's identity so one component can decorate all.
  const headerAccessories = usePanelHeaderAccessories();
  const module = useRegistry((s) => s.panels[id]?.defaultDock?.module);
  const extensionId = useRegistry((s) => s.panels[id]?.extensionId ?? "");
  const previewable = useRegistry((s) => panelIsPreviewable(id, s));
  const collapsed = useDockStore((s) => !!s.collapsed[id]);
  // The marker points the way the body will go: a column folds up to the right,
  // a bottom strip folds down out of the canvas's way.
  const { side } = useDockPlacement();
  const marker = side === "bottom" ? (collapsed ? "▴" : "▾") : collapsed ? "▸" : "▾";
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  return (
    <div
      onPointerDown={(e) => startHeaderDrag(id, e, containerRef?.current ?? null)}
      onContextMenu={
        onReset
          ? (e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY });
            }
          : undefined
      }
      className="flex h-7 shrink-0 cursor-grab select-none items-center gap-1.5 border-b border-border-subtle bg-surface-2 px-2"
    >
      <span className="w-2 text-[9px] text-text-muted" aria-hidden="true">
        {marker}
      </span>
      {Accessory && (
        <span className="flex items-center leading-none">
          <Accessory />
        </span>
      )}
      {headerAccessories.map(({ id: accId, component: A }) => (
        <span key={accId} className="flex items-center leading-none">
          <A
            panelId={id}
            title={title}
            module={module}
            extensionId={extensionId}
            previewable={previewable}
          />
        </span>
      ))}
      <span className="flex-1 truncate text-[11px] uppercase tracking-wider text-text-secondary">
        {title}
      </span>
      <button
        type="button"
        title="Close panel"
        aria-label={`Close ${title} panel`}
        onClick={() => commit(without(id))}
        className="rounded px-1 text-[12px] leading-none text-text-muted hover:text-text-primary"
      >
        ×
      </button>
      {menu && onReset && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[{ label: "Reset to defaults", onClick: onReset }]}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

/** `stretch` panels fill the remaining rail space and let the body scroll
 *  itself (fill panels in side rails; every panel in a bottom rail). */
function DockedPanel({ id, stretch = false }: { id: string; stretch?: boolean }) {
  const collapsed = useDockStore((s) => !!s.collapsed[id]);
  const body = (
    <PanelErrorBoundary id={id}>
      <PanelBody id={id} />
    </PanelErrorBoundary>
  );
  return (
    <div
      data-dock-panel={id}
      className={`border-b border-border ${
        stretch ? "flex min-h-0 min-w-0 flex-1 flex-col" : "shrink-0"
      }`}
    >
      <PanelHeader id={id} />
      {!collapsed &&
        (stretch ? <div className="min-h-0 flex-1 overflow-hidden">{body}</div> : body)}
    </div>
  );
}

function Rail({ rail }: { rail: RailState }) {
  // At most one fill panel per rail stretches to the leftover height; while one
  // is present (and expanded) the rail stops scrolling and the panel scrolls.
  const fillId = useRegistry(
    (s) => rail.panels.find((id) => s.panels[id]?.fill) ?? null,
  );
  const fillExpanded = useDockStore((s) => !!fillId && !s.collapsed[fillId]);
  return (
    <PlacementCtx.Provider value={PLACEMENTS[rail.side]}>
      <div
        data-rail={rail.id}
        className={`relative h-full shrink-0 bg-surface-1 ${
          rail.side === "left" ? "border-r" : "border-l"
        } border-border`}
        style={{ width: rail.width }}
      >
        <div
          className={
            fillExpanded
              ? "flex h-full flex-col overflow-hidden"
              : "h-full overflow-y-auto overflow-x-hidden"
          }
        >
          {rail.panels.map((id) => (
            <DockedPanel key={id} id={id} stretch={fillExpanded && id === fillId} />
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
    </PlacementCtx.Provider>
  );
}

function BottomRail({ rail }: { rail: RailState }) {
  // Collapsing a bottom panel folds the strip downward: with every panel in the
  // rail collapsed it drops its fixed height and sizes to the headers alone, so
  // the canvas takes back the band instead of looking at an empty strip. (One
  // collapsed panel beside an expanded one just narrows to its own header.)
  const allCollapsed = useDockStore((s) => rail.panels.every((id) => s.collapsed[id]));
  return (
    <PlacementCtx.Provider value={PLACEMENTS.bottom}>
      <div
        data-rail={rail.id}
        className="relative w-full shrink-0 border-t border-border bg-surface-1"
        style={allCollapsed ? undefined : { height: rail.height ?? DEFAULT_BOTTOM }}
      >
        <div
          className={`flex overflow-hidden [&>*:not(:last-child)]:border-r ${
            allCollapsed ? "" : "h-full"
          }`}
        >
          {rail.panels.map((id) => (
            <DockedPanel key={id} id={id} stretch />
          ))}
        </div>
        {/* Nothing to resize while it's folded away; the stored height comes
            back when a panel is expanded again. */}
        {!allCollapsed && (
          <div
            onPointerDown={(e) =>
              startResize(e, rail.height ?? DEFAULT_BOTTOM, MIN_BOTTOM, MAX_BOTTOM, -1,
                (h) => setRailHeight(rail.id, h), "y")
            }
            className="absolute -top-0.5 left-0 z-10 h-1 w-full cursor-row-resize hover:bg-accent/40"
          />
        )}
      </div>
    </PlacementCtx.Provider>
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
          <PanelErrorBoundary id={id}>
            <PanelBody id={id} />
          </PanelErrorBoundary>
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
  // These coords are visual px (client coords / getBoundingClientRect from
  // hitTest); the fixed elements are <body>-zoom descendants whose CSS left/top
  // are layout px, so map back through the zoom (see frame-point.ts).
  const z = getSettings().uiScale || 1;
  return (
    <>
      {target && target.kind !== "float" && (
        <div
          className={`pointer-events-none fixed z-50 ${
            target.kind === "rail" ? "bg-accent" : "bg-accent/70"
          }`}
          style={{
            left: target.line.x / z,
            top: target.line.y / z,
            width: target.line.w / z,
            height: target.line.h / z,
          }}
        />
      )}
      <div
        className="pointer-events-none fixed z-50 rounded border border-accent bg-surface-2 px-3 py-1 text-[11px] uppercase tracking-wider text-text-primary opacity-90 shadow-xl"
        style={{ left: drag.x / z + 10, top: drag.y / z + 10 }}
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
  const bottom = show ? rails.filter((r) => r.side === "bottom") : [];

  return (
    <ContainerCtx.Provider value={containerRef}>
      <div ref={containerRef} className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {left.map((r) => (
            <Rail key={r.id} rail={r} />
          ))}
          <div data-dock-main className="flex h-full min-w-0 flex-1 flex-col">
            {children}
          </div>
          {right.map((r) => (
            <Rail key={r.id} rail={r} />
          ))}
        </div>
        {bottom.map((r) => (
          <BottomRail key={r.id} rail={r} />
        ))}
        {show && floatIds.map((id) => <FloatingPanel key={id} id={id} />)}
        <DragOverlay />
      </div>
    </ContainerCtx.Provider>
  );
}
