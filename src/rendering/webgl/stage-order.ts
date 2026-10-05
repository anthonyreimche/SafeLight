// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { PROCESSING_PHASE_ORDER, type ProcessingStageContribution } from "@/extensions/types";

// Pipeline order, shared by the injection (stage-injection.ts) and the test-only
// compiler (shader-compiler.ts) so the two cannot disagree. A leaf module on
// purpose: stage-injection.ts already imports shader-compiler.ts, so the sort
// can live in neither.

const phaseIndex = new Map(PROCESSING_PHASE_ORDER.map((p, i) => [p, i]));

// A phase the order doesn't list sorts after every listed one.
const UNLISTED_PHASE_INDEX = 99;

// The cycles already reported, each by its members' ids in sorted order. The
// renderer orders the same stages for each process version, in each renderer it
// runs, and again whenever the stage set changes: one cycle would be logged each
// time. The render worker and the main window each keep their own list.
const reportedCycles = new Set<string>();

function byPhaseThenPriority(
  a: ProcessingStageContribution,
  b: ProcessingStageContribution,
): number {
  const phases =
    (phaseIndex.get(a.phase) ?? UNLISTED_PHASE_INDEX) -
    (phaseIndex.get(b.phase) ?? UNLISTED_PHASE_INDEX);
  if (phases !== 0) return phases;
  return (a.priority ?? 100) - (b.priority ?? 100);
}

/** For each stage, the positions of the stages it waits for: those it names in
 *  `after` that sit in its own phase. */
function blockersOf(ordered: readonly ProcessingStageContribution[]): number[][] {
  const positions = ordered.map((_, at) => at);
  return ordered.map((stage, at) => {
    // Extensions are plain JavaScript: an `after` that isn't a list names nothing.
    const named: readonly unknown[] = Array.isArray(stage.after) ? stage.after : [];
    return positions.filter(
      (i) => i !== at && ordered[i].phase === stage.phase && named.includes(ordered[i].id),
    );
  });
}

/** The groups of stages that wait on each other, directly or through others (the
 *  strongly connected components with more than one stage). Each is a list of
 *  positions, lowest first, and the groups are listed by their lowest position. */
function cyclesIn(blockers: readonly number[][]): number[][] {
  const found = blockers.map(() => -1);
  const low = blockers.map(() => -1);
  const open: number[] = [];
  const cycles: number[][] = [];
  let count = 0;

  const visit = (at: number): void => {
    found[at] = count;
    low[at] = count;
    count++;
    open.push(at);
    for (const next of blockers[at]) {
      if (found[next] < 0) {
        visit(next);
        low[at] = Math.min(low[at], low[next]);
      } else if (open.includes(next)) {
        low[at] = Math.min(low[at], found[next]);
      }
    }
    if (low[at] !== found[at]) return;
    // `at` roots a group: it and everything opened after it.
    const group = open.splice(open.lastIndexOf(at));
    if (group.length > 1) cycles.push(group.sort((a, b) => a - b));
  };

  blockers.forEach((_, at) => {
    if (found[at] < 0) visit(at);
  });
  return cycles.sort((a, b) => a[0] - b[0]);
}

/** Pipeline order: by phase, then priority (default 100), then the order given.
 *
 *  `after` is a soft dependency inside a phase: a stage runs after every stage it
 *  names that is in the same phase, even against priority. An id that isn't in
 *  the list, or sits in another phase, names nothing (a phase boundary always
 *  wins). Stages that wait on each other in a cycle lose the entries between
 *  them and nothing else: a member that also names a stage outside the cycle
 *  still waits for it. Each distinct cycle is warned about once, naming its
 *  stages.
 *
 *  The sort is topological and always places the first stage, in the order
 *  above, whose dependencies are placed. A stage without `after` therefore never
 *  moves for another stage's, and a set with none comes out as it always has. */
export function sortStages(
  stages: readonly ProcessingStageContribution[],
): ProcessingStageContribution[] {
  const ordered = stages.slice().sort(byPhaseThenPriority);
  const blockers = blockersOf(ordered);
  if (blockers.every((b) => b.length === 0)) return ordered;

  for (const cycle of cyclesIn(blockers)) {
    const ids = cycle.map((at) => ordered[at].id);
    const key = JSON.stringify([...ids].sort());
    if (!reportedCycles.has(key)) {
      reportedCycles.add(key);
      console.warn(
        `[render] stages ${ids.map((id) => `"${id}"`).join(", ")} wait on each other ` +
          `through "after"; only the entries between them are ignored.`,
      );
    }
    // Only the entries inside the cycle go: a member still waits for a stage outside it.
    for (const at of cycle) blockers[at] = blockers[at].filter((i) => !cycle.includes(i));
  }

  const waiting = ordered.map((_, at) => at);
  const placed = new Set<number>();
  const result: ProcessingStageContribution[] = [];
  while (waiting.length > 0) {
    // The cycles are gone, so some waiting stage always has every dependency placed.
    const ready = waiting.findIndex((i) => blockers[i].every((b) => placed.has(b)));
    const [at] = waiting.splice(ready, 1);
    placed.add(at);
    result.push(ordered[at]);
  }
  return result;
}
