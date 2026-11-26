// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Layout presets (the Layout menu) and the user's own saved layouts. The active
// choice is a global preference: "custom" = the user's own saved per-module
// arrangement (historic behaviour); any other id = a registered
// LayoutContribution applied on top of the registry defaults. Editing the dock
// while a preset is active flips back to Custom, with the edited state becoming
// the new custom layout.

import { create } from "zustand";
import { useRegistry, moduleEntry, moduleTabs } from "../registry";
import { getSettings } from "@/state/settings-store";
import { isPlainObject } from "@/project/fs";
import type { AppModule } from "@/catalog/types";
import type { ModuleLayoutDef, SavedLayout, SavedLayoutInput } from "../types";
import type { LayoutState } from "../api/stores";
import {
  applyLayoutExtensions,
  captureLayoutExtensions,
  enablementPending,
  layoutExtensionsMatch,
  onLayoutExtensionToggled,
} from "../loader";
import {
  ALL_SHOWN,
  DEFAULT_BOTTOM,
  allowsBottom,
  allowsModule,
  cancelPendingSave,
  flushPendingSave,
  layoutKey,
  openList,
  saveLayout,
  scheduleSave,
  useDockStore,
  type FloatState,
  type RailState,
} from "./store";
import {
  panelReplacements,
  replacePanelIds,
  type DockPlacement,
} from "./replacements";

export const CUSTOM_LAYOUT = "custom";
const LAYOUT_PREF_KEY = "sl_layout_pref";
const EDITED_FROM_KEY = "sl_layout_edited_from";

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export const useLayoutStore = create<LayoutState>(() => {
  const activeId = readStored(LAYOUT_PREF_KEY) ?? CUSTOM_LAYOUT;
  const editedFrom = activeId === CUSTOM_LAYOUT ? readStored(EDITED_FROM_KEY) : null;
  return editedFrom ? { activeId, editedFrom } : { activeId };
});

function setActiveLayout(id: string, editedFrom?: string) {
  useLayoutStore.setState({ activeId: id, editedFrom });
  try {
    if (editedFrom) localStorage.setItem(EDITED_FROM_KEY, editedFrom);
    else localStorage.removeItem(EDITED_FROM_KEY);
    localStorage.setItem(LAYOUT_PREF_KEY, id);
  } catch {}
}

/** The edited module is saved as usual; every other module is stored as the
 *  layout showed it, so Custom carries on from the layout rather than from an
 *  arrangement left over from before it was picked. */
export function markLayoutCustom() {
  const from = useLayoutStore.getState().activeId;
  if (from === CUSTOM_LAYOUT) return;
  const current = useDockStore.getState().module;
  for (const m of layoutModules()) {
    if (m !== current) saveLayout({ module: m, ...resolveModuleState(m) });
  }
  setActiveLayout(CUSTOM_LAYOUT, from);
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
  const defRails = def ? layoutRails(module, def.rails) : null;
  if (def && defRails)
    return {
      rails: defRails
        .map((r) => ({ ...r, panels: r.panels.filter(isRegistered) }))
        .filter((r) => r.panels.length > 0),
      floating: Object.fromEntries(
        Object.entries(recordOr<FloatState>(def.floating)).filter(([id]) => isRegistered(id)),
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

const isRailSide = (v: unknown): v is RailState["side"] =>
  v === "left" || v === "right" || v === "bottom";

const finiteOr = (v: unknown, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;

function recordOr<T>(v: unknown): Record<string, T> {
  return isPlainObject(v) ? (v as Record<string, T>) : {};
}

/** A layout's rails as dock rails, or null when there are none to use: the
 *  list isn't one, or every rail in it is malformed. Layouts come from
 *  extensions (plain JS at runtime) and from storage any extension can write,
 *  so a rail without a known side or a panels list is dropped rather than left
 *  to throw on every launch. Saved rails keep their ids; a preset's are
 *  numbered by position. */
function layoutRails(module: AppModule, list: unknown, keepIds = false): RailState[] | null {
  if (!Array.isArray(list)) return null;
  const rails = list.flatMap((r: unknown, i): RailState[] => {
    if (!isPlainObject(r) || !isRailSide(r.side) || !Array.isArray(r.panels)) return [];
    const side = r.side;
    return [
      {
        id: keepIds && typeof r.id === "string" ? r.id : `${module}-${side}-${i}`,
        side,
        width: finiteOr(r.width, 280),
        ...(side === "bottom" ? { height: finiteOr(r.height, DEFAULT_BOTTOM) } : {}),
        panels: r.panels.filter((id): id is string => typeof id === "string"),
      },
    ];
  });
  return rails.length > 0 || list.length === 0 ? rails : null;
}

/** A layout's collapsed list as dock flags. Extensions are plain JS at runtime,
 *  so the list may not be the array the type promises. */
function collapsedFlags(ids: unknown): Record<string, boolean> {
  if (!Array.isArray(ids)) return {};
  return Object.fromEntries(
    ids.filter((id): id is string => typeof id === "string").map((id) => [id, true]),
  );
}

/** Drop the panels `module` doesn't allow (their `modules` list leaves it out),
 *  and from bottom rails the panels that don't lay out horizontally, then any
 *  rail left empty. A saved layout can carry them from a build where docking
 *  was open to everything; the panels aren't lost — reopening one from the View
 *  menu brings it back as a floating window, in a module it allows. */
function prunePlacement(module: AppModule, placement: DockPlacement): DockPlacement {
  const registered = useRegistry.getState().panels;
  const allowed = (id: string) => allowsModule(registered[id], module);
  const rails = placement.rails
    .map((r) => {
      const panels = r.panels.filter(
        (id) => allowed(id) && (r.side !== "bottom" || allowsBottom(registered[id])),
      );
      return panels.length === r.panels.length ? r : { ...r, panels };
    })
    .filter((r) => r.panels.length > 0);
  const floatIds = Object.keys(placement.floating);
  const keptFloats = floatIds.filter(allowed);
  const unchanged =
    keptFloats.length === floatIds.length &&
    rails.length === placement.rails.length &&
    rails.every((r, i) => r === placement.rails[i]);
  if (unchanged) return placement;
  return {
    ...placement,
    rails,
    floating: Object.fromEntries(keptFloats.map((id) => [id, placement.floating[id]])),
    zOrder: placement.zOrder.filter(allowed),
  };
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
    let saved: unknown = null;
    try {
      const raw = localStorage.getItem(layoutKey(module));
      if (raw) saved = JSON.parse(raw);
    } catch {}
    const s = recordOr<unknown>(saved);
    rails = layoutRails(module, s.rails, true);
    fromSaved = rails !== null;
    floating = recordOr(s.floating);
    zOrder =
      Array.isArray(s.zOrder) && s.zOrder.every((id) => typeof id === "string") ? s.zOrder : null;
    collapsed = recordOr(s.collapsed);
  } else {
    // A user layout wins over a registered preset if the id ever collides.
    const def =
      moduleEntry(useUserLayouts.getState().layouts[activeId]?.modules, module) ??
      moduleEntry(useRegistry.getState().layouts[activeId]?.modules, module);
    const defRails = def ? layoutRails(module, def.rails) : null;
    if (def && defRails) {
      rails = defRails;
      floating = recordOr(def.floating);
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
    ...prunePlacement(module, placement),
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

export function initModule(module: AppModule) {
  // Flush any pending save for the outgoing module before replacing state. For
  // the same module the edit is dropped with the reload, and the timer with it:
  // it must not write the reloaded layout, which may be a temporary swap.
  if (useDockStore.getState().module !== module) flushPendingSave();
  else cancelPendingSave();
  loadModuleLayout(module);
}

// Installed extensions register after the dock has loaded its layout, so a
// replacing panel usually arrives late: swap its old ids in the live dock too,
// and take out a late panel the module doesn't allow. No commit(): that would
// turn a preset into "Custom"; a preset resolves both again whenever it loads.
useRegistry.subscribe((s, prev) => {
  if (s.panels === prev.panels) return;
  const dock = useDockStore.getState();
  if (!dock.module) return;
  const next = prunePlacement(dock.module, replacePanelIds(dock, panelReplacements(s.panels)));
  if (next === dock) return;
  useDockStore.setState({
    rails: next.rails,
    floating: next.floating,
    zOrder: next.zOrder,
    collapsed: next.collapsed,
    open: openList(next.rails, next.floating),
  });
  if (useLayoutStore.getState().activeId === CUSTOM_LAYOUT) scheduleSave();
});

// ── User layouts: named arrangements the user saves from their current dock.
// Stored locally (not through the extension registry) but listed and applied
// alongside the registered presets — they share the active-id space and the
// same ModuleLayoutDef shape. Captured across both modules so switching modules
// keeps the saved arrangement.

/** `switchesExtensions` is off for new layouts and for those saved before
 *  layouts had the choice. While it is off the ticks in `extensions` are kept;
 *  an extension with no tick is left as it is. */
export type UserLayout = SavedLayout;

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

/** A fresh id: several layouts saved in the same millisecond (an import) each
 *  get their own. */
function newUserLayoutId(layouts: Record<string, UserLayout>): string {
  const base = `user.${Date.now().toString(36)}`;
  let id = base;
  for (let i = 2; Object.hasOwn(layouts, id); i++) id = `${base}-${i}`;
  return id;
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
    if (e.key === EDITED_FROM_KEY) {
      useLayoutStore.setState({ editedFrom: e.newValue ?? undefined });
      return;
    }
    if (e.key !== LAYOUT_PREF_KEY || !e.newValue) return;
    if (e.newValue === useLayoutStore.getState().activeId) return;
    flushPendingSave();
    useLayoutStore.setState({
      activeId: e.newValue,
      editedFrom: e.newValue === CUSTOM_LAYOUT ? readStored(EDITED_FROM_KEY) ?? undefined : undefined,
    });
    const m = useDockStore.getState().module;
    if (m) loadModuleLayout(m);
  });
}

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
  const id = newUserLayoutId(layouts);
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

onLayoutExtensionToggled(recordActiveLayoutExtension);

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

/** With the setting on, a collapse while a user layout is picked is written
 *  into that layout, which stays picked. A registered preset can't be written,
 *  so returns false and the edit turns it into Custom as usual. */
export function saveCollapsedToLayout(collapsed: Record<string, boolean>): boolean {
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

// ── Layout managers (api.layouts) ───────────────────────────────────────────
// What an extension that manages layouts works with. Each acts on the calling
// window's own module: a popped-out module keeps its own arrangement, so
// another window's module can't be read or shown from here.

/** A module's arrangement as a layout holds it: the current module's as the
 *  dock shows it, another's as this window would load it. Null before the dock
 *  has a module, and for a module that isn't registered. */
export function captureModuleLayout(module?: AppModule): ModuleLayoutDef | null {
  const s = useDockStore.getState();
  if (module === undefined || module === s.module) {
    return s.module ? moduleDefFromState(s.rails, s.floating, s.collapsed) : null;
  }
  if (!layoutModules().includes(module)) return null;
  const { rails, floating, collapsed } = resolveModuleState(module);
  return moduleDefFromState(rails, floating, collapsed);
}

/** `def` as the dock would show it in `module`: replaced panels swapped and
 *  the panels it can't hold pruned, as loading it does. Null when it isn't a layout. */
function resolvedDef(module: AppModule, def: ModuleLayoutDef): ModuleLayoutDef | null {
  const rails = layoutRails(module, recordOr<unknown>(def).rails);
  if (!rails) return null;
  const floating = recordOr<FloatState>(def.floating);
  const placement = replacePanelIds(
    { rails, floating, zOrder: Object.keys(floating), collapsed: collapsedFlags(def.collapsed) },
    panelReplacements(useRegistry.getState().panels),
  );
  const pruned = prunePlacement(module, placement);
  return moduleDefFromState(pruned.rails, pruned.floating, pruned.collapsed);
}

const near = (a: number | undefined, b: number | undefined) =>
  a === b || (a !== undefined && b !== undefined && Math.abs(a - b) <= 1);

function sameArrangement(a: ModuleLayoutDef, b: ModuleLayoutDef): boolean {
  const railsMatch =
    a.rails.length === b.rails.length &&
    a.rails.every((r, i) => {
      const o = b.rails[i];
      return (
        r.side === o.side &&
        (r.side === "bottom" ? near(r.height, o.height) : near(r.width, o.width)) &&
        r.panels.length === o.panels.length &&
        r.panels.every((p, j) => p === o.panels[j])
      );
    });
  const fa = a.floating ?? {};
  const fb = b.floating ?? {};
  const floatsMatch =
    Object.keys(fa).length === Object.keys(fb).length &&
    Object.entries(fa).every(([id, f]) => {
      const o = fb[id];
      return !!o && near(f.x, o.x) && near(f.y, o.y) && near(f.width, o.width);
    });
  const ca = [...(a.collapsed ?? [])].sort();
  const cb = [...(b.collapsed ?? [])].sort();
  return railsMatch && floatsMatch && ca.length === cb.length && ca.every((id, i) => id === cb[i]);
}

/** Whether the current module's dock shows `def`, a pixel either way. */
export function moduleShowsLayout(def: ModuleLayoutDef): boolean {
  const module = useDockStore.getState().module;
  const live = captureModuleLayout();
  const wanted = module ? resolvedDef(module, def) : null;
  return !!live && !!wanted && sameArrangement(live, wanted);
}

/** Show `def` in the current module. Under a saved layout it becomes that
 *  layout's arrangement for the module, and the layout stays picked; under
 *  Custom or a registered preset it is shown as Custom's, as an edit would be.
 *  An edit still waiting to be saved is dropped, and a layout still switching
 *  its extensions no longer replaces it. */
export function showModuleLayout(def: ModuleLayoutDef): void {
  const module = useDockStore.getState().module;
  const clean = module ? resolvedDef(module, def) : null;
  if (!module || !clean) return;
  layoutRequests++;
  cancelPendingSave();
  const layouts = useUserLayouts.getState().layouts;
  const saved = moduleEntry(layouts, useLayoutStore.getState().activeId);
  if (saved) {
    persistUserLayouts({
      ...layouts,
      [saved.id]: { ...saved, modules: { ...saved.modules, [module]: clean } },
    });
  } else {
    markLayoutCustom();
    const rails = layoutRails(module, clean.rails)!;
    const floating = clean.floating ?? {};
    saveLayout({ module, rails, floating, zOrder: Object.keys(floating), collapsed: collapsedFlags(clean.collapsed) });
  }
  loadModuleLayout(module);
}

/** Create a saved layout, or replace the name and arrangements of one, keeping
 *  its extension ticks. Arrangements that aren't layouts are left out. Returns
 *  its id. A saved layout that is showing shows its new arrangement. */
export function saveUserLayout(input: SavedLayoutInput): string {
  const layouts = useUserLayouts.getState().layouts;
  const existing = input.id === undefined ? undefined : moduleEntry(layouts, input.id);
  if (input.id !== undefined && !existing) throw new Error(`There is no saved layout "${input.id}"`);
  const modules: Partial<Record<string, ModuleLayoutDef>> = {};
  for (const [m, def] of Object.entries(recordOr<unknown>(input.modules))) {
    const clean = isPlainObject(def) ? resolvedDef(m, def as unknown as ModuleLayoutDef) : null;
    if (clean) modules[m] = clean;
  }
  const name =
    (typeof input.name === "string" && input.name.trim()) || existing?.name || defaultLayoutName(layouts);
  const id = existing?.id ?? newUserLayoutId(layouts);
  persistUserLayouts({
    ...layouts,
    [id]: existing ? { ...existing, name, modules } : { id, name, modules },
  });
  const m = useDockStore.getState().module;
  if (existing && m && useLayoutStore.getState().activeId === id) {
    cancelPendingSave();
    loadModuleLayout(m);
  }
  return id;
}
