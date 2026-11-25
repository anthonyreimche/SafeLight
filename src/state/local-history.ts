// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Local history (#281): the steps one extension made, read out of the photo's
// one history by the `source` each step was committed with. A local undo, redo
// or jump is itself a step of the global history, made in that extension's
// name and marked `local`, that takes back or brings forward only the values
// the extension's steps changed: every other tool's later edits stay.

import type { DevelopParams, EditSnapshot, Mask } from "@/catalog/types";
import { withoutComputedParams } from "@/extensions/param-registry";
import type { LocalHistory, LocalStep } from "./local-history-types";

export type { LocalHistory, LocalStep };

/** An extension picked in the History panel's place of the latest edited
 *  one, for one photo (history-choice.ts drops it). */
export interface HistoryPin {
  photoId: string;
  source: string;
}

export interface Look {
  params: DevelopParams;
  paramBag: Record<string, unknown>;
}

/** The extension that made `step`, or undefined for core's own steps and those
 *  saved before 3.2.8. */
export function stepSource(step: EditSnapshot): string | undefined {
  return typeof step.source === "string" && step.source ? step.source : undefined;
}

/** Where a local move went: a step's index in the history, null for before
 *  the first step, or undefined when `step` is no local move. */
function localTarget(step: EditSnapshot): number | null | undefined {
  const local: unknown = step.local;
  if (typeof local !== "object" || local === null || !("to" in local)) return undefined;
  const to = local.to;
  return to === null || typeof to === "number" ? to : undefined;
}

export function localHistory(history: readonly EditSnapshot[], historyIndex: number, source: string): LocalHistory {
  let steps: LocalStep[] = [];
  let cursor = -1;
  for (let index = 1; index <= historyIndex && index < history.length; index++) {
    const step = history[index];
    if (stepSource(step) !== source) continue;
    const to = localTarget(step);
    if (to === undefined) {
      steps = steps.slice(0, cursor + 1);
      steps.push({ index, label: step.label, timestamp: step.timestamp });
      cursor = steps.length - 1;
    } else {
      cursor = to === null ? -1 : steps.findIndex((s) => s.index === to);
    }
  }
  return { source, steps, cursor };
}

/** Every extension with a step the photo shows, the most recently edited first. */
export function historySources(history: readonly EditSnapshot[], historyIndex: number): string[] {
  const seen = new Set<string>();
  for (let index = Math.min(historyIndex, history.length - 1); index > 0; index--) {
    const source = stepSource(history[index]);
    if (source) seen.add(source);
  }
  return [...seen];
}

/** The extension the local history shows: the one picked for this photo, or
 *  the one behind the latest step the photo shows. */
export function chosenSource(
  history: readonly EditSnapshot[],
  historyIndex: number,
  photoId: string | null,
  pin: HistoryPin | null,
): string | null {
  if (pin && pin.photoId === photoId) return pin.source;
  for (let index = Math.min(historyIndex, history.length - 1); index > 0; index--) {
    const source = stepSource(history[index]);
    if (source) return source;
  }
  return null;
}

interface Touched {
  params: Set<keyof DevelopParams>;
  bag: Set<string>;
  masks: Set<string>;
}

/** Everything the extension's steps changed: settings, extension values (never
 *  the computed ones) and masks by id. The process version is no adjustment. */
function touchedBy(history: readonly EditSnapshot[], local: LocalHistory): Touched {
  const touched: Touched = { params: new Set(), bag: new Set(), masks: new Set() };
  for (const { index } of local.steps) {
    const before = history[index - 1];
    const after = history[index];
    for (const key of unionKeys(before.params, after.params) as (keyof DevelopParams)[]) {
      if (key === "processVersion" || sameValue(before.params[key], after.params[key])) continue;
      if (key === "masks") for (const id of changedMasks(before.params.masks, after.params.masks)) touched.masks.add(id);
      else touched.params.add(key);
    }
    const bagBefore = withoutComputedParams(before.paramBag ?? {});
    const bagAfter = withoutComputedParams(after.paramBag ?? {});
    for (const key of unionKeys(bagBefore, bagAfter)) {
      if (!sameValue(bagBefore[key], bagAfter[key])) touched.bag.add(key);
    }
  }
  return touched;
}

/** `live` with the extension's own values as they stood after its step at
 *  `position`, or before its first step at -1. */
export function localLook(history: readonly EditSnapshot[], local: LocalHistory, position: number, live: Look): Look {
  const first = local.steps[0];
  const at = local.steps[position];
  if (!first || position < -1 || position >= local.steps.length) return live;
  const reference = at ? history[at.index] : history[first.index - 1];
  const touched = touchedBy(history, local);

  const params = { ...live.params };
  const values = params as unknown as Record<string, unknown>;
  const from = reference.params as unknown as Record<string, unknown>;
  for (const key of touched.params) values[key] = structuredClone(from[key]);
  if (touched.masks.size > 0) params.masks = maskedBack(live.params.masks, reference.params.masks ?? [], touched.masks);

  const paramBag = { ...live.paramBag };
  const bag = reference.paramBag ?? {};
  for (const key of touched.bag) {
    if (key in bag) paramBag[key] = structuredClone(bag[key]);
    else delete paramBag[key];
  }
  return { params, paramBag };
}

/** The new step's name: one step back or forward after the step undone or
 *  redone, a longer move after the step it lands on. */
export function localMoveLabel(local: LocalHistory, position: number): string {
  const landing = position < 0 ? "Original" : local.steps[position]?.label;
  if (position === local.cursor - 1) return `Undo ${local.steps[local.cursor].label}`;
  if (position === local.cursor + 1) return `Redo ${landing}`;
  return position < local.cursor ? `Undo to ${landing}` : `Redo to ${landing}`;
}

function maskedBack(live: readonly Mask[], reference: readonly Mask[], ids: ReadonlySet<string>): Mask[] {
  const wanted = new Map(reference.filter((m) => ids.has(m.id)).map((m) => [m.id, m]));
  const masks = live.flatMap((m) => {
    if (!ids.has(m.id)) return [m];
    const back = wanted.get(m.id);
    wanted.delete(m.id);
    return back ? [structuredClone(back)] : [];
  });
  for (const back of wanted.values()) {
    const at = reference.findIndex((m) => m.id === back.id);
    masks.splice(Math.min(at, masks.length), 0, structuredClone(back));
  }
  return masks;
}

function changedMasks(before: readonly Mask[] = [], after: readonly Mask[] = []): string[] {
  const was = new Map(before.map((m) => [m.id, m]));
  const ids = new Set<string>();
  for (const mask of after) if (!sameValue(was.get(mask.id), mask)) ids.add(mask.id);
  const now = new Set(after.map((m) => m.id));
  for (const mask of before) if (!now.has(mask.id)) ids.add(mask.id);
  return [...ids];
}

function unionKeys(a: object, b: object): string[] {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])];
}

/** Equal as stored values: numbers by value (NaN as itself), arrays item by
 *  item, objects key by key, a key holding undefined as one left out. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b || (Number.isNaN(a) && Number.isNaN(b))) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const left = Object.entries(a).filter(([, v]) => v !== undefined);
  const right = new Map(Object.entries(b).filter(([, v]) => v !== undefined));
  return left.length === right.size && left.every(([key, value]) => right.has(key) && sameValue(value, right.get(key)));
}
