// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Some shaders take the graphics driver down instead of failing to compile:
// Saturation Curve 1.0.0's per-pixel spline lost the context on Direct3D 11,
// and the graphics process with it. With no compile log there was nothing to
// quarantine the stage by, the window a crash reloads built it again, and after
// three crashes Chromium blocked WebGL and Safelight fell back to software.
//
// The renderers say which extension stages each build has in hand (StageBuildEvent).
// The ones that never built on this machine are written down before the driver
// starts, so a lost context, or a window that died mid-build, pins the crash on
// them. A stage whose shaders build can still draw so long that the driver
// resets, so the first draws of a stage at a cost it hasn't finished at here
// (drawCost: the size drawn and how many draws) are written down the same way.
// Every renderer leaves a blamed stage out, and the window names it, until the
// stage is registered changed or its extension is turned off and on.

import type { ProcessingStageContribution } from "@/extensions/types";
import type { NativeCrashRecord } from "@/extensions/api/native-bridge";
import type { StageBuildOutcome } from "./webgl/program-cache";
import type { StageBuildEvent } from "./webgl/renderer";
import { stageKey } from "./webgl/stage-injection";

export { stageKey };

/** The log a stage the guard blames is reported with. */
export const GPU_CRASH_LOG = "the graphics driver stopped while building or running its shader";

const STORAGE_KEY = "sl_gpu_stage_guard_v1";
// Every version of every stage that built is kept, so old ones are let go.
const MAX_CONFIRMED = 1000;
// The costs kept for each stage that drew.
const MAX_DRAWN_COSTS = 8;

interface Pending {
  keys: string[];
  since: number;
}

interface Journal {
  /** Stages that have built on this machine, by "{id}:{signature}". */
  confirmed: string[];
  /** Stages a lost context or a crash was pinned on. */
  crashed: string[];
  /** Stages a build or a draw has in hand that never finished here, and when
   *  the first of them began. */
  pending: Pending | null;
  /** The costs each stage's draws have finished at on this machine, newest last. */
  drawn: Record<string, string[]>;
}

const EMPTY: Journal = { confirmed: [], crashed: [], pending: null, drawn: {} };

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((k): k is string => typeof k === "string") : [];
}

// A journal written before draws were watched has no costs.
function drawnCosts(v: unknown): Record<string, string[]> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
  const drawn: Record<string, string[]> = {};
  for (const [key, costs] of Object.entries(v)) {
    const kept = strings(costs);
    if (kept.length > 0) drawn[key] = kept;
  }
  return drawn;
}

function read(): Journal {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (typeof raw !== "object" || raw === null) return EMPTY;
    const r = raw as Record<string, unknown>;
    const p = r.pending as Record<string, unknown> | null | undefined;
    const pending =
      p && typeof p === "object" && typeof p.since === "number" && strings(p.keys).length > 0
        ? { keys: strings(p.keys), since: p.since }
        : null;
    return { confirmed: strings(r.confirmed), crashed: strings(r.crashed), pending, drawn: drawnCosts(r.drawn) };
  } catch {
    return EMPTY;
  }
}

let journal = read();
let confirmed = new Set(journal.confirmed);
let crashed = new Set(journal.crashed);
let drawn = new Map(Object.entries(journal.drawn));
// Bumped whenever the crashed set changes, for withoutCrashed's memo.
let generation = 0;
const listeners = new Set<() => void>();

function write(): void {
  journal = {
    confirmed: [...confirmed],
    crashed: [...crashed],
    pending: journal.pending,
    drawn: Object.fromEntries(drawn),
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(journal));
  } catch {
    // Storage full or off: the guard still holds for this window.
  }
}

function crashedChanged(): void {
  generation++;
  for (const listener of listeners) listener();
}

// A build or draw the last window had in hand when it died is blamed before
// anything here builds again; settleLeftoverBuild forgives it once the crash log
// shows no graphics crash after it began.
let leftover: Pending | null = journal.pending;
if (leftover) {
  for (const key of leftover.keys) crashed.add(key);
  journal = { ...journal, pending: null };
  write();
}

const idOf = (key: string): string => key.slice(0, key.lastIndexOf(":"));

function hold(fresh: readonly string[]): void {
  if (fresh.length === 0) return;
  const held = journal.pending;
  journal = {
    ...journal,
    pending: { keys: [...new Set([...(held?.keys ?? []), ...fresh])], since: held?.since ?? Date.now() },
  };
  write();
}

// Whether any of `keys` left the pending list.
function letGo(keys: readonly string[]): boolean {
  const held = journal.pending;
  if (!held) return false;
  const ended = new Set(keys);
  const rest = held.keys.filter((k) => !ended.has(k));
  if (rest.length === held.keys.length) return false;
  journal = { ...journal, pending: rest.length > 0 ? { ...held, keys: rest } : null };
  return true;
}

export function noteBuildStarted(keys: readonly string[]): void {
  hold(keys.filter((k) => !confirmed.has(k) && !crashed.has(k)));
}

/** A build with no log stays in hand: the context it lost may not have said so yet. */
export function noteBuildEnded(keys: readonly string[], outcome: StageBuildOutcome): void {
  if (outcome === "suspect") return;
  let changed = letGo(keys);
  if (outcome === "built") {
    for (const key of keys) {
      if (confirmed.has(key)) continue;
      confirmed.add(key);
      changed = true;
    }
    if (confirmed.size > MAX_CONFIRMED) confirmed = new Set([...confirmed].slice(-MAX_CONFIRMED));
  }
  if (changed) write();
}

/** Draws of `keys` at `cost` begin: those that have never finished at it here
 *  are held until they do. Being built here before spares none of them. */
export function noteDrawStarted(keys: readonly string[], cost: string): void {
  hold(keys.filter((k) => !crashed.has(k) && !drawn.get(k)?.includes(cost)));
}

/** `finished`: the draws were done; false when they stopped short without the
 *  context being lost, which confirms nothing. */
export function noteDrawEnded(keys: readonly string[], cost: string, finished: boolean): void {
  let changed = letGo(keys);
  if (finished) {
    for (const key of keys) {
      const costs = drawn.get(key) ?? [];
      if (costs.includes(cost)) continue;
      drawn.delete(key);
      drawn.set(key, [...costs, cost].slice(-MAX_DRAWN_COSTS));
      changed = true;
    }
    if (drawn.size > MAX_CONFIRMED) drawn = new Map([...drawn].slice(-MAX_CONFIRMED));
  }
  if (changed) write();
}

/** The draws of `stages` that have finished here, as "key|cost", for a renderer
 *  to take as confirmed and not wait on again (WebGLRendererOpts.confirmedDraws). */
export function confirmedDrawsOf(stages: Iterable<ProcessingStageContribution>): string[] {
  const entries: string[] = [];
  for (const s of stages) {
    const key = stageKey(s);
    for (const cost of drawn.get(key) ?? []) entries.push(`${key}|${cost}`);
  }
  return entries;
}

export function noteStageBuild(event: StageBuildEvent): void {
  switch (event.phase) {
    case "start":
      noteBuildStarted(event.stages);
      break;
    case "end":
      noteBuildEnded(event.stages, event.outcome);
      break;
    case "drawStart":
      noteDrawStarted(event.stages, event.cost);
      break;
    case "drawEnd":
      noteDrawEnded(event.stages, event.cost, event.drawn);
      break;
  }
}

/** A renderer's context was lost: the stages a build or draw had in hand that
 *  never finished here take the blame. The keys newly blamed. */
export function blameLostContext(): string[] {
  const held = journal.pending;
  if (!held) return [];
  const blamed = held.keys.filter((k) => !crashed.has(k));
  for (const key of blamed) crashed.add(key);
  journal = { ...journal, pending: null };
  write();
  if (blamed.length > 0) crashedChanged();
  return blamed;
}

/** Forgives the build the last window died in unless the graphics process
 *  crashed after it began: the window was closed or reloaded mid-build. A crash
 *  log that can't be read keeps the blame. The keys forgiven. */
export async function settleLeftoverBuild(
  crashes: () => Promise<readonly NativeCrashRecord[] | undefined>,
): Promise<string[]> {
  const held = leftover;
  leftover = null;
  if (!held) return [];
  let log: readonly NativeCrashRecord[] | undefined;
  try {
    log = await crashes();
  } catch {
    log = undefined;
  }
  if (!log || log.some((c) => c.process === "GPU" && c.time >= held.since)) return [];
  const forgiven = held.keys.filter((k) => crashed.has(k));
  if (forgiven.length === 0) return [];
  for (const key of forgiven) crashed.delete(key);
  write();
  crashedChanged();
  return forgiven;
}

export const isCrashed = (stage: ProcessingStageContribution): boolean =>
  crashed.size > 0 && crashed.has(stageKey(stage));

/** Turning an extension off and on tries its stages again. */
export function forgetCrashesOf(stageIds: readonly string[]): void {
  const ids = new Set(stageIds);
  const forgotten = [...crashed].filter((k) => ids.has(idOf(k)));
  if (forgotten.length === 0) return;
  for (const key of forgotten) crashed.delete(key);
  write();
  crashedChanged();
}

export function subscribeCrashes(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const filtered = new WeakMap<object, { generation: number; kept: ProcessingStageContribution[] | null }>();

/** `stages` without the blamed ones: the same object while none of them is, and
 *  the same filtered array until the blame changes, as a renderer rebuilds its
 *  stage injection whenever its source is a new object. */
export function withoutCrashed<T extends ProcessingStageContribution>(stages: T[]): T[];
export function withoutCrashed<T extends ProcessingStageContribution>(stages: Record<string, T>): Record<string, T> | T[];
export function withoutCrashed<T extends ProcessingStageContribution>(
  stages: T[] | Record<string, T>,
): T[] | Record<string, T> {
  if (crashed.size === 0) return stages;
  const held = filtered.get(stages);
  if (held?.generation === generation) return (held.kept as T[] | null) ?? stages;
  const all: T[] = Array.isArray(stages) ? stages : Object.values(stages);
  const blamedIds = new Set([...crashed].map(idOf));
  const kept = all.filter((s) => !blamedIds.has(s.id) || !crashed.has(stageKey(s)));
  const result = kept.length === all.length ? null : kept;
  filtered.set(stages, { generation, kept: result });
  return result ?? stages;
}
