// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A photo's history as pure functions over its stored EditState: the look it
// opens on, appending a step, and moving the cursor. Shared by stored-edit.ts
// and `slu`, so both write the same history.

import type { EditSnapshot, EditState } from "./types";
import { freshParams, normalizeParams } from "./types";
import { historyCursor } from "./history-cursor";
import { normalizeParamBag } from "@/extensions/param-registry";
import type { StoredLook } from "./stored-edit-look";

export interface StepTarget { photoId: string; asShot: number }

/** The snapshots up to the stored cursor, or none for a photo never edited. The
 *  stored cursor may be unusable; this is the one Develop opens on. */
function openStack(state: EditState | undefined): EditSnapshot[] {
  if (!state || state.stack.length === 0) return [];
  return state.stack.slice(0, historyCursor(state.currentIndex, state.stack.length) + 1);
}

/** The look the photo opens on: the cursor's step, or freshParams(asShot) for a never-edited photo. */
export function currentLook(state: EditState | undefined, asShot: number): StoredLook {
  const top = openStack(state).at(-1);
  if (!top) return { params: freshParams(asShot), paramBag: {} };
  return { params: normalizeParams(top.params), paramBag: normalizeParamBag(top.paramBag) };
}

/** stored-edit's appendedEdit, pure: cut at the cursor, seed "Original" for a never-edited photo, append, move the cursor. */
export function appendStep(
  state: EditState | undefined,
  target: StepTarget,
  label: string,
  look: StoredLook,
  now: number,
  source?: string,
): EditState {
  const kept = openStack(state);
  const stack: EditSnapshot[] =
    kept.length > 0
      ? kept
      : [{ timestamp: now, label: "Original", params: freshParams(target.asShot), paramBag: {} }];
  const step: EditSnapshot = { timestamp: now, label, params: look.params, paramBag: look.paramBag };
  if (source !== undefined) step.source = source;
  const newStack = [...stack, step];
  return { photoId: target.photoId, stack: newStack, currentIndex: newStack.length - 1 };
}

/** Undo/redo by `by` steps (negative = undo), clamped; the same state object when nothing moves. */
export function moveCursor(state: EditState, by: number): EditState {
  if (state.stack.length === 0 || !Number.isInteger(by)) return state;
  const from = historyCursor(state.currentIndex, state.stack.length);
  const to = Math.min(Math.max(from + by, 0), state.stack.length - 1);
  return to === state.currentIndex ? state : { ...state, currentIndex: to };
}

export function historyRows(state: EditState | undefined): { index: number; label: string; timestamp: number; current: boolean }[] {
  if (!state) return [];
  const cursor = historyCursor(state.currentIndex, state.stack.length);
  return state.stack.map((s, index) => ({ index, label: s.label, timestamp: s.timestamp, current: index === cursor }));
}
