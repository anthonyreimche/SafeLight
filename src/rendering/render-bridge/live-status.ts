// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What the live develop view last drew: the frame's overflowed stages and
// timing, the program the worker said it holds, and the last render error. The
// bridge that serves the Develop view writes it; DevelopCanvas's overflow notice
// and Developer Tools read it.

import { create } from "zustand";
import type { LiveRenderStatus, ProcessVersion } from "@/extensions/api/devtools";

/** What the live view is drawing, which the bridge's messages don't say. */
export interface LiveViewSource {
  photoId(): string | null;
  processVersion(): ProcessVersion;
}

interface ProgramStatus {
  programStages: readonly string[];
  dormant: readonly string[];
}

// A frame that changes nothing but its time is written no more often than this.
const TIMING_WRITE_MS = 1_000;

export const useLiveStatus = create<{ live: LiveRenderStatus | null }>(() => ({ live: null }));

let view: LiveViewSource | null = null;
let program: ProgramStatus = { programStages: [], dormant: [] };
let lastWriteAt = -Infinity;

const sameIds = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((id, i) => id === b[i]);

function sameApartFromTiming(a: LiveRenderStatus, b: LiveRenderStatus): boolean {
  return (
    a.photoId === b.photoId &&
    a.processVersion === b.processVersion &&
    sameIds(a.programStages, b.programStages) &&
    sameIds(a.dormant, b.dormant) &&
    sameIds(a.overflowed, b.overflowed) &&
    a.lastError?.at === b.lastError?.at &&
    a.lastError?.message === b.lastError?.message
  );
}

const keepIfSame = (held: readonly string[] | undefined, next: readonly string[]): readonly string[] =>
  held && sameIds(held, next) ? held : next;

function write(given: LiveRenderStatus): void {
  const { live } = useLiveStatus.getState();
  const now = Date.now();
  if (live && sameApartFromTiming(live, given) && now - lastWriteAt < TIMING_WRITE_MS) return;
  lastWriteAt = now;
  // A list that came out the same stays the one readers hold, so they don't redraw for it.
  const next: LiveRenderStatus = {
    ...given,
    programStages: keepIfSame(live?.programStages, given.programStages),
    dormant: keepIfSame(live?.dormant, given.dormant),
    overflowed: keepIfSame(live?.overflowed, given.overflowed),
  };
  useLiveStatus.setState({ live: next });
}

/** The Develop view says what it is drawing; null when it goes. Nothing is
 *  written while there is none. */
export function setLiveViewSource(source: LiveViewSource | null): void {
  view = source;
}

/** Whether a Develop view is drawing in this window now. */
export function hasLiveView(): boolean {
  return view !== null;
}

function fresh(view: LiveViewSource): LiveRenderStatus {
  return {
    at: Date.now(),
    photoId: view.photoId(),
    processVersion: view.processVersion(),
    ...program,
    overflowed: [],
    frameMs: null,
    lastError: null,
  };
}

/** A live frame was drawn: `overflowed` is the stages it was drawn without and
 *  `frameMs` how long the render took, or null when that isn't known. */
export function noteLiveFrame({ overflowed, frameMs }: { overflowed: readonly string[]; frameMs: number | null }): void {
  if (!view) return;
  write({ ...fresh(view), overflowed, frameMs });
}

/** The worker's program changed: the stages it holds and those it was built without. */
export function noteProgramStatus(status: ProgramStatus): void {
  program = status;
  if (!view) return;
  const { live } = useLiveStatus.getState();
  if (live) write({ ...live, ...status });
}

/** A render failed; it stands until a later frame succeeds. */
export function noteRenderError(message: string): void {
  if (!view) return;
  const { live } = useLiveStatus.getState();
  write({ ...(live ?? fresh(view)), lastError: { at: Date.now(), message } });
}

/** The view moved to another photo, whose frames have not drawn yet: the last
 *  one's overflowed stages no longer apply. */
export function clearLiveOverflowed(): void {
  const { live } = useLiveStatus.getState();
  if (live && live.overflowed.length > 0) write({ ...live, overflowed: [] });
}

/** Forget everything: the renderer was disposed, so what it drew no longer stands. */
export function resetLiveStatus(): void {
  program = { programStages: [], dormant: [] };
  lastWriteAt = -Infinity;
  useLiveStatus.setState({ live: null });
}
