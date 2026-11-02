// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The dock's live state and its debounced persistence. Everything else in the
// dock builds on this file and nothing here imports the rest of the dock.

import { create } from "zustand";
import { detachedModule } from "@/state/detach";
import type { AppModule } from "@/catalog/types";
import type { RegisteredPanel } from "../registry";

// v4: dockview replaced by the custom rail dock; old grid layouts don't apply.
export const layoutKey = (module: AppModule) =>
  `sl_dock_layout_v4:${module}${detachedModule() ? ":detached" : ""}`;

export const EDGE = 24; // px-wide drop strips that create a new rail
export const MIN_RAIL = 200;
export const MAX_RAIL = 440;
export const MIN_BOTTOM = 56;
export const MAX_BOTTOM = 320;
export const DEFAULT_BOTTOM = 112;
export const MIN_FLOAT = 220;
export const MAX_FLOAT = 480;
export const DRAG_THRESHOLD = 5;

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

export interface DockState {
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
export interface DropLine {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type DropTarget =
  | { kind: "rail"; railId: string; index: number; line: DropLine }
  | { kind: "newRail"; side: RailState["side"]; index: number; line: DropLine }
  | { kind: "float" };

export type DockSide = RailState["side"] | "floating";

export const ALL_SHOWN: Record<DockSide, boolean> = {
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

export const openList = (rails: RailState[], floating: Record<string, FloatState>) => [
  ...rails.flatMap((r) => r.panels),
  ...Object.keys(floating),
];

export function saveLayout(
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
export function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveLayout(useDockStore.getState()), 300);
}

/** Run a queued save now, while the dock still holds the state it was queued
 *  for. Left to its timer, a layout switch would write the incoming layout under
 *  the Custom key, and a module switch would drop the outgoing module's edit. */
export function flushPendingSave() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  saveLayout(useDockStore.getState());
}

/** Drop a queued save without writing it. */
export function cancelPendingSave() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
}

/** Bottom rails are horizontal strips, so only panels that lay out that way
 *  belong in one — a vertical column squeezed into a 112px band reads as
 *  broken. Panels opt in with `allowBottomDock` (or by defaulting there). An
 *  unregistered id gets the benefit of the doubt: its extension may still be
 *  loading, and dropping it would evict a filmstrip from its own rail. */
export function allowsBottom(panel: RegisteredPanel | undefined): boolean {
  if (!panel) return true;
  return (
    panel.allowBottomDock === true || panel.defaultDock?.direction === "bottom"
  );
}
