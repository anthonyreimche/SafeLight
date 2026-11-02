// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Panel replacement: a panel can take the place of old panel ids (one that
// moved to another extension, say) wherever a layout still names them.

import type { RegisteredPanel } from "../registry";
import type { FloatState, RailState } from "./store";

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
