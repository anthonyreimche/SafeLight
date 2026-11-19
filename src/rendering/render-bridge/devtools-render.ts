// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// api.devtools.render: what Developer Tools reads of the live render.

import { useSyncExternalStore } from "react";
import type { DevtoolsObservable, DevtoolsRender, StageFailureInfo } from "@/extensions/api/devtools";
import { useRegistry } from "@/extensions/registry";
import { GPU_CRASH_LOG } from "../gpu-crash-guard";
import { peekRenderBridge } from "../render-bridge";
import { hasLiveView, useLiveStatus } from "./live-status";
import { standingStageFailures, useStageFailures } from "./stage-failures";

type Failures = Readonly<Record<string, StageFailureInfo>>;

function observable<T>(get: () => T, subscribe: (listener: () => void) => () => void): DevtoolsObservable<T> {
  return { get, subscribe, use: () => useSyncExternalStore(subscribe, get, get) };
}

const live = observable(
  () => useLiveStatus.getState().live,
  (listener) => useLiveStatus.subscribe(listener),
);

// The quarantine and the registry change with no bearing on what is listed, so
// the list is rebuilt only for new ones, and kept when it comes out the same.
let memo: { quarantine: object; stages: object; failures: Failures } | null = null;

function sameFailures(a: Failures, b: Failures): boolean {
  const ids = Object.keys(a);
  return ids.length === Object.keys(b).length && ids.every((id) => b[id]?.log === a[id].log && b[id].crashed === a[id].crashed);
}

function standingFailures(): Failures {
  const quarantine = useStageFailures.getState();
  const stages = useRegistry.getState().processingStages;
  if (memo && memo.quarantine === quarantine && memo.stages === stages) return memo.failures;
  const next: Failures = Object.fromEntries(
    Object.entries(standingStageFailures(quarantine, stages)).map(([id, f]) => [
      id,
      { log: f.log, crashed: f.log === GPU_CRASH_LOG },
    ]),
  );
  memo = { quarantine, stages, failures: memo && sameFailures(memo.failures, next) ? memo.failures : next };
  return memo.failures;
}

const stageFailures = observable(standingFailures, (listener) => {
  const stops = [useStageFailures.subscribe(listener), useRegistry.subscribe(listener)];
  return () => stops.forEach((stop) => stop());
});

export const devtoolsRender: DevtoolsRender = {
  live,
  stageFailures,
  liveValues(stageId) {
    const bridge = peekRenderBridge();
    if (!bridge || !hasLiveView()) return null;
    return bridge.liveStageValues(stageId);
  },
};
