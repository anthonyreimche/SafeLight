// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The brush tips extensions register (api.develop.registerBrushTip), held in the
// window. The set is also the one this thread's bakes stamp with (webgl/brush-tips.ts),
// which export and the window's own renderers read, and the render worker is posted
// it whole whenever it changes and once more when a bridge is wired.

import { useSyncExternalStore } from "react";
import {
  MAX_BRUSH_TIP_EDGE,
  type BrushTipContribution,
  type BrushTipSettings,
} from "@/extensions/api/contributions";
import { setActiveBrushTips } from "./webgl/brush-tips";

/** What the registry tells the shared render bridge. */
interface TipSink {
  setBrushTips(tips: Record<string, BrushTipContribution>): void;
  render(wantHistogram?: boolean): void;
}

const tips = new Map<string, { owner: string; tip: BrushTipContribution }>();
let sink: TipSink | null = null;
let posting = false;
let listed: readonly BrushTipContribution[] = [];
const readers = new Set<() => void>();

/** Why `tip` can't be stamped, or null. A shape of the wrong size reads out of
 *  bounds in the bake. */
function problem(tip: BrushTipContribution | null): string | null {
  if (typeof tip !== "object" || tip === null) return "needs to be an object";
  if (typeof tip.id !== "string" || tip.id.length === 0) return "needs an id";
  if (typeof tip.alpha !== "object" || tip.alpha === null) return "needs an alpha shape";
  const { width, height, data } = tip.alpha;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0)
    return `needs a whole, positive width and height, not ${width}×${height}`;
  if (width > MAX_BRUSH_TIP_EDGE || height > MAX_BRUSH_TIP_EDGE)
    return `is ${width}×${height}, over the ${MAX_BRUSH_TIP_EDGE} px one edge may take`;
  if (!(data instanceof Uint8Array)) return "needs its alpha data in a Uint8Array";
  if (data.length !== width * height) return `holds ${data.length} values where ${width}×${height} takes ${width * height}`;
  return null;
}

const MAX_GROUP_LENGTH = 64;

function clampTo(value: unknown, lo: number, hi: number): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(hi, Math.max(lo, value)) : undefined;
}

/** The settings of `brush` that are numbers (or the flag a boolean), each
 *  clamped into its range; the rest left out. */
function brushSettings(brush: BrushTipSettings): BrushTipSettings {
  const count = clampTo(brush.count, 1, 16);
  const angle = typeof brush.angle === "number" && Number.isFinite(brush.angle) ? brush.angle % (2 * Math.PI) : undefined;
  const kept: BrushTipSettings = {
    spacing: clampTo(brush.spacing, 0.01, 10),
    scatter: clampTo(brush.scatter, 0, 10),
    count: count === undefined ? undefined : Math.round(count),
    sizeJitter: clampTo(brush.sizeJitter, 0, 1),
    angleJitter: clampTo(brush.angleJitter, 0, 1),
    flowJitter: clampTo(brush.flowJitter, 0, 1),
    angle,
    followStroke: typeof brush.followStroke === "boolean" ? brush.followStroke : undefined,
  };
  return Object.fromEntries(Object.entries(kept).filter(([, v]) => v !== undefined));
}

/** `tip` with only the group and brush settings a picker can use. */
function tidied(tip: BrushTipContribution): BrushTipContribution {
  const { group, brush, ...shape } = tip;
  const named = typeof group === "string" && group.length > 0 ? group.slice(0, MAX_GROUP_LENGTH) : undefined;
  return {
    ...shape,
    ...(named ? { group: named } : {}),
    ...(typeof brush === "object" && brush !== null ? { brush: brushSettings(brush) } : {}),
  };
}

function snapshot(): Record<string, BrushTipContribution> {
  return Object.fromEntries([...tips].map(([id, held]) => [id, held.tip]));
}

// Registrations come in runs (an extension's tips at its start), so the worker is
// posted once for the run, ahead of the redraw that shows them.
function changed(): void {
  setActiveBrushTips(snapshot());
  listed = [...tips.values()].map((entry) => entry.tip);
  for (const read of readers) read();
  if (!sink || posting) return;
  posting = true;
  queueMicrotask(() => {
    posting = false;
    sink?.setBrushTips(snapshot());
    sink?.render(false);
  });
}

/** Hold `tip` for `extensionId`. A tip the bake can't stamp is refused with a
 *  warning, as is an id another extension holds; an extension may replace its own. */
export function registerBrushTip(extensionId: string, tip: BrushTipContribution): void {
  const bad = problem(tip);
  if (bad) {
    console.warn(`[extensions] ${extensionId}: brush tip "${String(tip?.id)}" ${bad}; registerBrushTip ignored`);
    return;
  }
  const held = tips.get(tip.id);
  if (held && held.owner !== extensionId) {
    console.warn(
      `[extensions] ${extensionId}: brush tip "${tip.id}" is registered by ${held.owner}; registerBrushTip ignored`,
    );
    return;
  }
  tips.set(tip.id, { owner: extensionId, tip: tidied(tip) });
  changed();
}

/** Drop tip `id`, which `extensionId` registered; another extension's is kept,
 *  with a warning. Strokes that name it stamp the disc from then on. */
export function unregisterBrushTip(extensionId: string, id: string): void {
  const entry = tips.get(id);
  if (!entry) return;
  if (entry.owner !== extensionId) {
    console.warn(
      `[extensions] ${extensionId}: brush tip "${id}" is registered by ${entry.owner}; unregisterBrushTip ignored`,
    );
    return;
  }
  tips.delete(id);
  changed();
}

/** Every registered tip, whoever registered it, in the order they came. The
 *  same array until the set changes. */
export function brushTips(): readonly BrushTipContribution[] {
  return listed;
}

function readTips(read: () => void): () => void {
  readers.add(read);
  return () => readers.delete(read);
}

/** React hook: brushTips(), re-rendering when the set changes. */
export function useBrushTips(): readonly BrushTipContribution[] {
  return useSyncExternalStore(readTips, brushTips);
}

/** Drop every tip `extensionId` registered, as when it stops. */
export function dropBrushTips(extensionId: string): void {
  let dropped = false;
  for (const [id, held] of tips) {
    if (held.owner !== extensionId) continue;
    tips.delete(id);
    dropped = true;
  }
  if (dropped) changed();
}

/** Make `bridge` the one the tips are posted to, and hand it those held now. Call
 *  after its init. */
export function wireBrushTips(bridge: TipSink): void {
  sink = bridge;
  if (tips.size > 0) bridge.setBrushTips(snapshot());
}

/** Stop posting to the bridge, before it is disposed. */
export function unwireBrushTips(): void {
  sink = null;
}
