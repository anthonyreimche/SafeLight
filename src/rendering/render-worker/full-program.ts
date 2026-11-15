// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The develop program with every stage in, built ahead. The live view leaves
// dormant stages out, so that program is otherwise first built by a frame that
// needs it (another photo's grid preview, an export, an extension's frame), which
// after an install or update holds the worker for seconds. Chromium keeps every
// program it links, by its text, for any context and for later launches, so once
// the stages, the display transform or the open photo's version have changed and
// the worker has then heard nothing for FULL_PROGRAM_QUIET_MS, the live renderer
// builds it in the background. One build at a time: a change while one is in
// progress waits for it.

import { CURRENT_PROCESS_VERSION } from "@/catalog/types";
import type { WorkerContext, WorkerState } from "./context";

export const FULL_PROGRAM_QUIET_MS = 3000;

/** What the full program was last built for: a change to any of them calls for another. */
export interface FullProgramFor {
  renderer: NonNullable<WorkerState["renderer"]>;
  stages: WorkerState["latestStages"];
  pipeline: WorkerState["latestPipeline"];
  version: number;
}

const versionOf = (state: WorkerState): number => state.lastParams?.processVersion ?? CURRENT_PROCESS_VERSION;

function wanted(state: WorkerState): FullProgramFor | null {
  const { renderer } = state;
  if (!renderer) return null;
  return { renderer, stages: state.latestStages, pipeline: state.latestPipeline, version: versionOf(state) };
}

function isBuilt(state: WorkerState, want: FullProgramFor): boolean {
  const last = state.fullProgramFor;
  return (
    last !== null &&
    last.renderer === want.renderer &&
    last.stages === want.stages &&
    last.pipeline === want.pipeline &&
    last.version === want.version
  );
}

/** After each message: (re)starts the wait while the full program is out of date,
 *  so any message puts its build off. */
export function afterMessage(ctx: WorkerContext): void {
  const { state } = ctx;
  if (state.fullProgramTimer !== null) clearTimeout(state.fullProgramTimer);
  state.fullProgramTimer = null;
  if (state.fullProgramBuilding) return;
  const want = wanted(state);
  if (!want || isBuilt(state, want)) return;
  state.fullProgramTimer = setTimeout(() => {
    state.fullProgramTimer = null;
    build(ctx);
  }, FULL_PROGRAM_QUIET_MS);
}

function build(ctx: WorkerContext): void {
  const { state } = ctx;
  const want = wanted(state);
  if (!want || isBuilt(state, want)) return;
  state.fullProgramFor = want;
  state.fullProgramBuilding = true;
  void want.renderer.prepareFullProgramAsync(want.version).then(() => {
    state.fullProgramBuilding = false;
    afterMessage(ctx);
  });
}
