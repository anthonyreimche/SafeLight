// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The extension stages the render worker's renderers quarantined: their GLSL
// wouldn't build into the develop program, so frames are drawn without them.
// Kept here for the Extensions window and Develop to name; a stage registered
// again with anything changed is built again, so its failure stops standing.

import { useMemo } from "react";
import { create } from "zustand";
import { getExtensionName } from "@/extensions/param-registry";
import { useRegistry, type RegisteredProcessingStage } from "@/extensions/registry";
import type { QuarantinedStage } from "../webgl/renderer";
import { stageSignature } from "../webgl/stage-injection";

type Stages = Readonly<Record<string, RegisteredProcessingStage>>;

/** The latest quarantine of each stage, by stage id. */
export const useStageFailures = create<Record<string, QuarantinedStage>>(() => ({}));

export function recordStageFailure(stage: QuarantinedStage): void {
  useStageFailures.setState({ [stage.stageId]: stage });
}

/** Forget every failure: a new renderer, or one handed a stage set that lost a
 *  stage, tries each stage again and reports those that still fail. */
export function forgetStageFailures(): void {
  useStageFailures.setState({}, true);
}

/** The failures of `extensionId`'s stages that still stand: each stage is
 *  registered as it was when it failed. */
export function stageFailuresOf(
  extensionId: string,
  failures: Readonly<Record<string, QuarantinedStage>>,
  stages: Stages,
): QuarantinedStage[] {
  return Object.values(failures).filter((f) => {
    const stage = stages[f.stageId];
    return stage?.extensionId === extensionId && stageSignature(stage) === f.signature;
  });
}

export function useStageFailuresOf(extensionId: string): QuarantinedStage[] {
  const failures = useStageFailures();
  const stages = useRegistry((s) => s.processingStages);
  return useMemo(() => stageFailuresOf(extensionId, failures, stages), [extensionId, failures, stages]);
}

/** The first line of a failure's log that says what went wrong, without the
 *  "Shader compile failed:" the renderer puts ahead of the driver's log. */
export function firstLogLine(log: string): string {
  const line = log.split("\n").find((l) => l.trim() !== "") ?? "";
  return line.replace(/^(Shader compile|Program link) failed:\s*/, "").trim();
}

/** What the window says of a quarantined stage: the extension it came from first. */
export function stageFailureText(stage: QuarantinedStage, stages: Stages): string {
  const owner = stages[stage.stageId];
  const name = owner ? getExtensionName(owner.extensionId) : stage.stageId;
  return `${name}: stage "${stage.stageId}" failed to compile and is off until it changes (${firstLogLine(stage.log)})`;
}
