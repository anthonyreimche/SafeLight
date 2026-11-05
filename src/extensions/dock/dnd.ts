// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Pointer handling for the dock: where a dragged panel header would land, the
// drag itself, and resize handles.

import type { PointerEvent as ReactPointerEvent } from "react";
import { useRegistry } from "../registry";
import { frameLocalPoint } from "@/ui/frame-point";
import { getSettings } from "@/state/settings-store";
import {
  DRAG_THRESHOLD,
  EDGE,
  MAX_FLOAT,
  MIN_FLOAT,
  allowsBottom,
  useDockStore,
  type DropTarget,
} from "./store";
import {
  bringToFront,
  dropToFloat,
  dropToNewRail,
  dropToRail,
  toggleCollapsed,
} from "./actions";

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
export function startHeaderDrag(
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

export function startResize(
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
