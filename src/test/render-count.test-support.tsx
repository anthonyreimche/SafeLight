// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Counts the commits that touch a subtree, for specs that pin how narrowly a
// component subscribes to its stores. Mount, reset, then drive the store: any
// count above zero is a re-render the change caused. Each store write under
// test needs its own act(), or React batches them into a single commit.

import { Profiler, type ProfilerOnRenderCallback, type ReactNode } from "react";

const counts = new Map<string, number>();

const record: ProfilerOnRenderCallback = (id) => {
  counts.set(id, (counts.get(id) ?? 0) + 1);
};

export function CountRenders({ id, children }: { id: string; children: ReactNode }) {
  return (
    <Profiler id={id} onRender={record}>
      {children}
    </Profiler>
  );
}

/** Commits per CountRenders id since the last reset; an id absent here has not
 *  re-rendered. */
export function renderCounts(): Record<string, number> {
  return Object.fromEntries(counts);
}

export function resetRenderCounts(): void {
  counts.clear();
}
