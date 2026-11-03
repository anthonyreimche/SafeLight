// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What the dock does to its own layout: the public toggles (View menu, Tab,
// extensions) and the mutations drags and resizes apply. Edits go through
// commit(), which turns an active preset into Custom and queues the save.

import { useRegistry } from "../registry";
import {
  DEFAULT_BOTTOM,
  openList,
  scheduleSave,
  useDockStore,
  type DockState,
  type RailState,
} from "./store";
import { markLayoutCustom, saveCollapsedToLayout } from "./layouts";

export function commit(partial: Partial<DockState>) {
  const s = useDockStore.getState();
  const rails = partial.rails ?? s.rails;
  const floating = partial.floating ?? s.floating;
  useDockStore.setState({ ...partial, open: openList(rails, floating) });
  markLayoutCustom(); // any user edit to a preset turns it into "Custom"
  scheduleSave();
}

/** Layout with `id` removed everywhere; empty rails dropped. */
export function without(id: string) {
  const s = useDockStore.getState();
  const rails = s.rails
    .map((r) => ({ ...r, panels: r.panels.filter((p) => p !== id) }))
    .filter((r) => r.panels.length > 0);
  const floating = { ...s.floating };
  delete floating[id];
  return { rails, floating, zOrder: s.zOrder.filter((p) => p !== id) };
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
  // (The View menu opens panels centred instead: toggleDockPanelFloating.)
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
 *  floats the panel centred over the workspace — never into a rail, where it
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

export function toggleCollapsed(id: string) {
  const s = useDockStore.getState();
  const collapsed = { ...s.collapsed, [id]: !s.collapsed[id] };
  if (!saveCollapsedToLayout(collapsed)) commit({ collapsed });
}

export function bringToFront(id: string) {
  const s = useDockStore.getState();
  if (!(id in s.floating)) return;
  if (s.zOrder[s.zOrder.length - 1] === id) return;
  commit({ zOrder: [...s.zOrder.filter((p) => p !== id), id] });
}

export function setRailWidth(railId: string, width: number) {
  const s = useDockStore.getState();
  commit({
    rails: s.rails.map((r) => (r.id === railId ? { ...r, width } : r)),
  });
}

export function setRailHeight(railId: string, height: number) {
  const s = useDockStore.getState();
  commit({
    rails: s.rails.map((r) => (r.id === railId ? { ...r, height } : r)),
  });
}

export function setFloatWidth(id: string, width: number) {
  const s = useDockStore.getState();
  const f = s.floating[id];
  if (!f) return;
  commit({ floating: { ...s.floating, [id]: { ...f, width } } });
}

export function dropToRail(id: string, railId: string, index: number) {
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

export function dropToNewRail(id: string, side: RailState["side"], index: number) {
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

export function dropToFloat(id: string, x: number, y: number, width: number) {
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
