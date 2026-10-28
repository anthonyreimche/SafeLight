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
import { ErrorBoundary } from "@/ui/components/ErrorBoundary";
import { create } from "zustand";
import {
  useRegistry,
  usePanelHeaderAccessories,
  moduleEntry,
  moduleTabs,
} from "./registry";
import { panelIsPreviewable } from "@/modules/develop/panel-bypass";
import { frameLocalPoint } from "@/ui/frame-point";
import { getSettings } from "@/state/settings-store";
import type { AppModule } from "@/catalog/types";
import type { ModuleLayoutDef, PanelPlacement } from "./types";
import type { RegisteredPanel } from "./registry";
import { detachedModule } from "@/state/detach";
import {
  applyLayoutExtensions,
  captureLayoutExtensions,
  enablementPending,
  layoutExtensionsMatch,
} from "./loader";

function PanelErrorBoundary({ id, children }: { id: string; children: ReactNode }) {
  return (
    <ErrorBoundary what={`Panel "${id}"`} className="p-3 text-[11px] text-red-400">
      {children}
    </ErrorBoundary>
  );
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

export interface RailState {
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
export interface FloatState {
  x: number;
  y: number;
  width: number;
  /** Pinned to the workspace center — x/y become offsets from it — until the
   *  user drags the window somewhere concrete. */
  centered?: boolean;
}

interface DockState {
  module: AppModule | null;
  rails: RailState[];
  floating: Record<string, FloatState>;
  /** Floating z-order, back→front. */
  zOrder: string[];
  collapsed: Record<string, boolean>;
  /** Off-screen without leaving the layout; a module switch shows them all. */
  hidden: Record<DockSide, boolean>;
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

type DockSide = RailState["side"] | "floating";

const ALL_SHOWN: Record<DockSide, boolean> = {
  left: false,
  right: false,
  bottom: false,
  floating: false,
};

export const useDockStore = create<DockState>(() => ({
  module: null,
  rails: [],
  floating: {},
  zOrder: [],
  collapsed: {},
  hidden: ALL_SHOWN,
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

/** Run a queued save now, while the dock still holds the state it was queued
 *  for. Left to its timer, a layout switch would write the incoming layout under
 *  the Custom key, and a module switch would drop the outgoing module's edit. */
function flushPendingSave() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  saveLayout(useDockStore.getState());
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

/** The arrangement a module starts from when nothing saved or preset covers it:
 *  its defaultLayout, else the panels whose defaultDock names it. Only
 *  registered panels are seeded (a defaultLayout may name a core panel the user
 *  has disabled), and a rail left empty is dropped. */
function seedDefaults(module: AppModule): {
  rails: RailState[];
  floating: Record<string, FloatState>;
  collapsed: Record<string, boolean>;
} {
  const registered = useRegistry.getState().panels;
  const isRegistered = (id: string) => Object.hasOwn(registered, id);
  const def = moduleEntry(useRegistry.getState().modules, module)?.defaultLayout;
  if (def)
    return {
      rails: railsFromDef(module, def)
        .map((r) => ({ ...r, panels: r.panels.filter(isRegistered) }))
        .filter((r) => r.panels.length > 0),
      floating: Object.fromEntries(
        Object.entries(def.floating ?? {}).filter(([id]) => isRegistered(id)),
      ),
      collapsed: collapsedFlags(def.collapsed),
    };
  const panels = Object.values(registered)
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
  return { rails, floating: {}, collapsed: {} };
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

/** The edited module is saved as usual; every other module is stored as the
 *  layout showed it, so Custom carries on from the layout rather than from an
 *  arrangement left over from before it was picked. */
function markLayoutCustom() {
  if (useLayoutStore.getState().activeId === CUSTOM_LAYOUT) return;
  const current = useDockStore.getState().module;
  for (const m of layoutModules()) {
    if (m !== current) saveLayout({ module: m, ...resolveModuleState(m) });
  }
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
  modules: Partial<Record<string, ModuleLayoutDef>>;
  /** Whether picking this layout switches extensions to its ticks. Off for new
   *  layouts and for those saved before layouts had the choice. */
  switchesExtensions?: boolean;
  /** The layout's ticks: on or off by extension id. Kept while switching is
   *  off; an extension with no tick is left as it is. */
  extensions?: Record<string, boolean>;
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

// Counts applyDockLayout calls, so a layout still switching its extensions
// doesn't replace one picked after it.
let layoutRequests = 0;

/** Switch the active layout and rebuild the current module's dock. A saved
 *  layout that switches extensions switches them first, so the panels they
 *  bring are registered by the time the module's arrangement is resolved.
 *  Resolves once the layout is showing; with nothing to switch and no change
 *  still under way, that happens before this returns. */
export function applyDockLayout(id: string): Promise<void> {
  const request = ++layoutRequests;
  const layout = moduleEntry(useUserLayouts.getState().layouts, id);
  const states = layout?.switchesExtensions ? layout.extensions : undefined;
  if (!states || (!enablementPending() && layoutExtensionsMatch(states))) {
    showLayout(id);
    return Promise.resolve();
  }
  return applyLayoutExtensions(states).then(() => {
    if (request === layoutRequests) showLayout(id);
  });
}

function showLayout(id: string): void {
  flushPendingSave();
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
    flushPendingSave();
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

/** A layout's collapsed list as dock flags. Extensions are plain JS at runtime,
 *  so the list may not be the array the type promises. */
function collapsedFlags(ids: unknown): Record<string, boolean> {
  if (!Array.isArray(ids)) return {};
  return Object.fromEntries(
    ids.filter((id): id is string => typeof id === "string").map((id) => [id, true]),
  );
}

/** Drop panels that don't lay out horizontally from bottom rails, and any rail
 *  left empty. A saved layout can carry them from a build where bottom docking
 *  was open to everything; the panels aren't lost — reopening one from the View
 *  menu brings it back as a floating window. */
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

// ── Panel replacement: a panel can take the place of old panel ids (one that
// moved to another extension, say) wherever a layout still names them.

export interface DockPlacement {
  rails: RailState[];
  floating: Record<string, FloatState>;
  zOrder: string[];
  collapsed: Record<string, boolean>;
}

const warnedReplacements = new Set<string>();

/** Old panel id → the registered panel that takes its place. An old id a
 *  registered panel still uses keeps that panel; when two panels claim the same
 *  old id, the first registered keeps it. */
export function panelReplacements(registered: Record<string, RegisteredPanel>): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of Object.values(registered)) {
    // Extensions are plain JS at runtime, so `replaces` may not be the array the type promises.
    const olds: readonly unknown[] = Array.isArray(p.replaces) ? p.replaces : [];
    for (const old of olds) {
      if (typeof old !== "string" || old === p.id || Object.hasOwn(registered, old)) continue;
      const holder = out.get(old);
      if (holder === undefined) {
        out.set(old, p.id);
        continue;
      }
      const key = `${old}\n${p.id}`;
      if (holder !== p.id && !warnedReplacements.has(key)) {
        warnedReplacements.add(key);
        console.warn(`[dock] panel "${p.id}" also replaces "${old}"; "${holder}" keeps it.`);
      }
    }
  }
  return out;
}

/** `placement` with each replaced id renamed to its replacement, or dropped
 *  where the replacement is already placed, so it keeps the spot it had. The
 *  same object comes back when nothing names a replaced id. */
export function replacePanelIds(placement: DockPlacement, replacements: ReadonlyMap<string, string>): DockPlacement {
  if (replacements.size === 0) return placement;
  const named = (id: string) => replacements.has(id);
  const ids = [...placement.rails.flatMap((r) => r.panels), ...Object.keys(placement.floating)];
  if (!ids.some(named) && !Object.keys(placement.collapsed).some(named)) return placement;

  const placed = new Set(ids.filter((id) => !named(id)));
  const renamed = new Set<string>();
  const rename = (id: string): string | null => {
    const to = replacements.get(id);
    if (to === undefined) return id;
    if (placed.has(to)) return null;
    placed.add(to);
    renamed.add(id);
    return to;
  };

  const rails = placement.rails
    .map((r) => ({ ...r, panels: r.panels.flatMap((id) => rename(id) ?? []) }))
    .filter((r) => r.panels.length > 0);
  const floating: Record<string, FloatState> = {};
  for (const [id, f] of Object.entries(placement.floating)) {
    const to = rename(id);
    if (to !== null) floating[to] = f;
  }
  // A dropped old id must not pull the panel it lost to forward in the stacking.
  const zOrder = [
    ...new Set(
      placement.zOrder
        .filter((id) => !named(id) || renamed.has(id))
        .map((id) => replacements.get(id) ?? id),
    ),
  ].filter((id) => Object.hasOwn(floating, id));
  // Renamed flags go in second so one beats a stale flag already on the new id.
  const collapsed: Record<string, boolean> = {};
  for (const [id, v] of Object.entries(placement.collapsed)) {
    if (!named(id)) collapsed[id] = v;
  }
  for (const [id, v] of Object.entries(placement.collapsed)) {
    if (renamed.has(id)) collapsed[replacements.get(id)!] = v;
  }
  return { rails, floating, zOrder, collapsed };
}

/** Resolve dock state for `module` under the active layout, without applying
 *  it or writing anything. `rewritesSaved` says the saved layout it read named
 *  a replaced panel, so the caller that loads it should store the swap. */
function resolveModuleState(module: AppModule): DockPlacement & { rewritesSaved: boolean } {
  const activeId = useLayoutStore.getState().activeId;
  let rails: RailState[] | null = null;
  let floating: Record<string, FloatState> = {};
  let zOrder: string[] | null = null;
  let collapsed: Record<string, boolean> = {};
  let fromSaved = false;

  if (activeId === CUSTOM_LAYOUT) {
    let saved: Partial<DockState> | null = null;
    try {
      const raw = localStorage.getItem(layoutKey(module));
      if (raw) saved = JSON.parse(raw);
    } catch {}
    if (Array.isArray(saved?.rails)) {
      rails = saved!.rails!;
      fromSaved = true;
    }
    floating = saved?.floating ?? {};
    zOrder = saved?.zOrder ?? null;
    collapsed = saved?.collapsed ?? {};
  } else {
    // A user layout wins over a registered preset if the id ever collides.
    const def =
      moduleEntry(useUserLayouts.getState().layouts[activeId]?.modules, module) ??
      moduleEntry(useRegistry.getState().layouts[activeId]?.modules, module);
    if (def) {
      rails = railsFromDef(module, def);
      floating = def.floating ?? {};
      collapsed = collapsedFlags(def.collapsed);
    }
  }
  if (!rails) {
    const seed = seedDefaults(module);
    rails = seed.rails;
    floating = seed.floating;
    collapsed = seed.collapsed;
  }
  const resolved: DockPlacement = { rails, floating, zOrder: zOrder ?? Object.keys(floating), collapsed };
  const placement = replacePanelIds(resolved, panelReplacements(useRegistry.getState().panels));
  return {
    ...placement,
    rails: pruneBottomRails(placement.rails),
    rewritesSaved: fromSaved && placement !== resolved,
  };
}

/** Build dock state for `module` from the active layout. */
function loadModuleLayout(module: AppModule) {
  const { rails, floating, zOrder, collapsed, rewritesSaved } = resolveModuleState(module);
  // A saved layout that named a replaced panel is stored with the new id at
  // once, so storage settles on it.
  if (rewritesSaved) saveLayout({ module, rails, floating, zOrder, collapsed });
  useDockStore.setState({
    module,
    rails,
    floating,
    zOrder,
    collapsed,
    hidden: ALL_SHOWN,
    open: openList(rails, floating),
    drag: null,
    target: null,
  });
}

// Installed extensions register after the dock has loaded its layout, so a
// replacing panel usually arrives late: swap its old ids in the live dock too.
// No commit(): that would turn a preset into "Custom"; a preset resolves the
// swap again whenever it is loaded.
useRegistry.subscribe((s, prev) => {
  if (s.panels === prev.panels) return;
  const dock = useDockStore.getState();
  if (!dock.module) return;
  const next = replacePanelIds(dock, panelReplacements(s.panels));
  if (next === dock) return;
  const rails = pruneBottomRails(next.rails);
  useDockStore.setState({
    rails,
    floating: next.floating,
    zOrder: next.zOrder,
    collapsed: next.collapsed,
    open: openList(rails, next.floating),
  });
  if (useLayoutStore.getState().activeId === CUSTOM_LAYOUT) scheduleSave();
});

// ── User-layout capture + CRUD ──────────────────────────────────────────────

/** Every module a layout can describe: the built-ins plus registered ones. */
const layoutModules = (): AppModule[] => moduleTabs().map((m) => m.id);

/** Convert live dock state into the serializable ModuleLayoutDef. */
function moduleDefFromState(
  rails: RailState[],
  floating: Record<string, FloatState>,
  collapsed: Record<string, boolean>,
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
  const folded = openList(rails, floating).filter((id) => collapsed[id]);
  if (folded.length) def.collapsed = folded;
  return def;
}

/** Snapshot the current arrangement of every module. The active module is read
 *  live from the dock; the others are resolved from the active layout. */
function captureCurrentLayout(): Partial<Record<string, ModuleLayoutDef>> {
  const s = useDockStore.getState();
  const out: Partial<Record<string, ModuleLayoutDef>> = {};
  for (const m of layoutModules()) {
    const { rails, floating, collapsed } = s.module === m ? s : resolveModuleState(m);
    out[m] = moduleDefFromState(rails, floating, collapsed);
  }
  return out;
}

/** Save the current arrangement as a new named layout and switch to it. */
export function addUserLayout(name?: string): string {
  flushPendingSave();
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

/** Overwrite an existing user layout with the current arrangement. Entries for
 *  modules not registered right now (their extension is off) are kept, and so
 *  are its extension ticks: when it switches extensions and they differ from
 *  what is on, they switch, as picking the layout would. */
export function updateUserLayout(id: string): void {
  const existing = useUserLayouts.getState().layouts[id];
  if (!existing) return;
  flushPendingSave();
  persistUserLayouts({
    ...useUserLayouts.getState().layouts,
    [id]: {
      ...existing,
      modules: { ...existing.modules, ...captureCurrentLayout() },
    },
  });
  const ticks = existing.switchesExtensions ? existing.extensions : undefined;
  if (ticks && (enablementPending() || !layoutExtensionsMatch(ticks))) {
    void applyDockLayout(id);
    return;
  }
  // The dock now matches the saved layout again, so re-select it (editing a
  // preset/layout flips the active id to Custom).
  setActiveLayout(id);
}

/** Turn extension switching on or off for a user layout. Turning it on ticks
 *  every extension a layout can switch, without switching any: the layout
 *  showing takes what is running, another keeps the ticks it has and takes the
 *  rest from what is on now. Turning it off keeps the ticks. */
export function setLayoutSwitchesExtensions(id: string, on: boolean): void {
  const layouts = useUserLayouts.getState().layouts;
  const existing = moduleEntry(layouts, id);
  if (!existing || !!existing.switchesExtensions === on) return;
  const now = captureLayoutExtensions();
  const showing = useLayoutStore.getState().activeId === id;
  persistUserLayouts({
    ...layouts,
    [id]: {
      ...existing,
      switchesExtensions: on,
      ...(on && {
        extensions: showing
          ? { ...existing.extensions, ...now }
          : { ...now, ...existing.extensions },
      }),
    },
  });
}

/** Tick or untick extensions in a user layout. When it is the layout showing
 *  and it switches extensions, they switch now; resolves once they have. */
export function setLayoutExtensions(
  id: string,
  ticks: Record<string, boolean>,
): Promise<void> {
  const layouts = useUserLayouts.getState().layouts;
  const existing = moduleEntry(layouts, id);
  if (!existing) return Promise.resolve();
  persistUserLayouts({
    ...layouts,
    [id]: { ...existing, extensions: { ...existing.extensions, ...ticks } },
  });
  const live =
    existing.switchesExtensions && useLayoutStore.getState().activeId === id;
  return live ? applyLayoutExtensions(ticks) : Promise.resolve();
}

/** Record `id` on or off in the layout showing, if that layout switches
 *  extensions, so picking it again keeps what was just chosen elsewhere. */
export function recordActiveLayoutExtension(id: string, enabled: boolean): void {
  const layouts = useUserLayouts.getState().layouts;
  const active = moduleEntry(layouts, useLayoutStore.getState().activeId);
  if (!active?.switchesExtensions || moduleEntry(active.extensions, id) === enabled)
    return;
  persistUserLayouts({
    ...layouts,
    [active.id]: { ...active, extensions: { ...active.extensions, [id]: enabled } },
  });
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
  // Flush any pending save for the outgoing module before replacing state. For
  // the same module the edit is dropped with the reload, and the timer with it:
  // it must not write the reloaded layout, which may be a temporary swap.
  if (useDockStore.getState().module !== module) flushPendingSave();
  else if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
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
  // floating, so extension togglePanel calls land panels where they belong.
  // (The View menu opens panels centered instead: toggleDockPanelFloating.)
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

/** View-menu toggle. Closing matches toggleDockPanel, but opening always
 *  floats the panel centered over the workspace — never into a rail, where it
 *  could land scrolled out of sight. Consecutive opens stagger so each new
 *  window leaves the previous one visible. */
export function toggleDockPanelFloating(id: string): void {
  const s = useDockStore.getState();
  if (s.open.includes(id)) {
    commit(without(id));
    return;
  }
  const n = Object.values(s.floating).filter((f) => f.centered).length;
  commit({
    floating: {
      ...s.floating,
      [id]: { x: n * 24, y: n * 24, width: 320, centered: true },
    },
    zOrder: [...s.zOrder, id],
  });
}

/** Hides every panel while any side is showing, else shows them all. */
export function toggleDockVisibility(): void {
  useDockStore.setState((s) => {
    const hide = Object.values(s.hidden).some((h) => !h);
    return { hidden: { left: hide, right: hide, bottom: hide, floating: hide } };
  });
}

export function toggleDockSide(side: RailState["side"]): void {
  useDockStore.setState((s) => ({ hidden: { ...s.hidden, [side]: !s.hidden[side] } }));
}

// ---------------------------------------------------------------------------
// Layout mutations
// ---------------------------------------------------------------------------

function toggleCollapsed(id: string) {
  const s = useDockStore.getState();
  const collapsed = { ...s.collapsed, [id]: !s.collapsed[id] };
  if (!saveCollapsedToLayout(collapsed)) commit({ collapsed });
}

/** With the setting on, a collapse while a user layout is picked is written
 *  into that layout, which stays picked. A registered preset can't be written,
 *  so returns false and the edit turns it into Custom as usual. */
function saveCollapsedToLayout(collapsed: Record<string, boolean>): boolean {
  if (!getSettings().autoSaveCollapsedPanels) return false;
  const s = useDockStore.getState();
  const layouts = useUserLayouts.getState().layouts;
  const layout = moduleEntry(layouts, useLayoutStore.getState().activeId);
  if (!layout || !s.module) return false;
  const base =
    moduleEntry(layout.modules, s.module) ?? moduleDefFromState(s.rails, s.floating, {});
  const folded = openList(s.rails, s.floating).filter((id) => collapsed[id]);
  const def: ModuleLayoutDef = { ...base, collapsed: folded };
  if (!folded.length) delete def.collapsed;
  useDockStore.setState({ collapsed });
  persistUserLayouts({
    ...layouts,
    [layout.id]: { ...layout, modules: { ...layout.modules, [s.module]: def } },
  });
  return true;
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
  // Centered windows track the workspace center by CSS, so they stay centered
  // whatever the panel's natural height; the height cap keeps a tall panel's
  // header reachable (the body scrolls) instead of centering it off both edges.
  const placement = pos.centered
    ? {
        left: `calc(50% + ${pos.x}px)`,
        top: `calc(50% + ${pos.y}px)`,
        transform: "translate(-50%, -50%)",
        maxHeight: "calc(100% - 16px)",
      }
    : { left: pos.x, top: pos.y };
  return (
    <div
      onPointerDown={() => bringToFront(id)}
      className="absolute flex flex-col overflow-hidden rounded border border-border bg-surface-1 shadow-2xl"
      style={{ ...placement, width: pos.width, zIndex: 30 + Math.max(z, 0) }}
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

  const shown = (side: DockSide) => ready && !hidden[side];
  const left = shown("left") ? rails.filter((r) => r.side === "left") : [];
  const right = shown("right") ? rails.filter((r) => r.side === "right") : [];
  const bottom = shown("bottom") ? rails.filter((r) => r.side === "bottom") : [];

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
        {shown("floating") && floatIds.map((id) => <FloatingPanel key={id} id={id} />)}
        <DragOverlay />
      </div>
    </ContainerCtx.Provider>
  );
}
