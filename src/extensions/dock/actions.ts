// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What the dock does to its own layout: the public toggles (View menu, Tab,
// extensions) and the mutations drags and resizes apply. Edits go through
// commit(), which turns an active preset into Custom and queues the save.

import type { DockPanelPlacement } from "../api/contributions";
import { useRegistry } from "../registry";
import {
  allowsBottom,
  DEFAULT_BOTTOM,
  MAX_BOTTOM,
  MAX_RAIL,
  MIN_BOTTOM,
  MIN_RAIL,
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

/** `at` places a panel that has no default dock in the current module (an
 *  extension's console that any module may open). */
export function toggleDockPanel(id: string, at?: DockPanelPlacement): void {
  const s = useDockStore.getState();
  if (s.open.includes(id)) {
    // Open on a side the person hid: the toggle means "show it".
    const side = id in s.floating ? "floating" : s.rails.find((r) => r.panels.includes(id))?.side;
    if (at && side && s.hidden[side]) {
      useDockStore.setState({ hidden: { ...s.hidden, [side]: false } });
      return;
    }
    commit(without(id));
    return;
  }
  // A closed panel with a default dock in the current module reopens there —
  // appended to the first rail on its side, or in a fresh rail — instead of
  // floating, so extension togglePanel calls land panels where they belong.
  // (The View menu opens panels centred instead: toggleDockPanelFloating.)
  const registered = useRegistry.getState().panels[id];
  const def = registered?.defaultDock;
  const place =
    def && def.module === s.module ? def : placementFor(at, allowsBottom(registered));
  if (place) {
    const rail = s.rails.find((r) => r.side === place.direction);
    if (rail) dropToRail(id, rail.id, rail.panels.length);
    else dropToNewRail(id, place.direction, 0, place);
    if (useDockStore.getState().hidden[place.direction]) {
      useDockStore.setState((st) => ({ hidden: { ...st.hidden, [place.direction]: false } }));
    }
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

/** An extension's placement, checked and its size clamped into the rail's
 *  limits; null for one that isn't usable (bad input, or the bottom rail for a
 *  panel that doesn't lay out across it). */
function placementFor(at: DockPanelPlacement | undefined, bottomOk: boolean): DockPanelPlacement | null {
  if (!at || typeof at !== "object") return null;
  const { direction } = at;
  if (direction !== "left" && direction !== "right" && direction !== "bottom") return null;
  if (direction === "bottom" && !bottomOk) return null;
  const clamp = (v: unknown, lo: number, hi: number, fallback: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : fallback;
  return {
    direction,
    width: clamp(at.width, MIN_RAIL, MAX_RAIL, 280),
    height: clamp(at.height, MIN_BOTTOM, MAX_BOTTOM, DEFAULT_BOTTOM),
  };
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

export function dropToNewRail(
  id: string,
  side: RailState["side"],
  index: number,
  size?: { width?: number; height?: number },
) {
  const s = useDockStore.getState();
  const rails = s.rails
    .map((r) => ({ ...r, panels: r.panels.filter((p) => p !== id) }))
    .filter((r) => r.panels.length > 0);
  const floating = { ...s.floating };
  delete floating[id];
  const def = size ?? useRegistry.getState().panels[id]?.defaultDock;
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
