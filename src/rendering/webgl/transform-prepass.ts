// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A display transform's pre-pass (PipelineContribution.prepass) runs as a
// stage of its own, which the renderer adds to its stage set while it draws
// with that transform: last in the tone-map group and reading the current
// image, so its passes see `lin` as it enters the transform. Its inline hands
// the passes' result to pipelineToDisplay through a global the resolved
// pipeline declares ahead of the transform's GLSL.

import type { ProcessingStageContribution, TransformPrepass } from "@/extensions/types";
import { BUILTIN_RESOLVED } from "./builtin-pipeline";
import type { ResolvedPipeline } from "./resolved-pipeline";

export const TRANSFORM_PASS_GLOBAL = "slTransformPass";
export const TRANSFORM_PASS_DECLARATION = `vec3 ${TRANSFORM_PASS_GLOBAL} = vec3(0.0);`;

/** The built-in transform for a stage set that holds a pre-pass: what a
 *  pre-pass transform whose own GLSL fails to build falls back to. The
 *  pre-pass's inline still writes the global, so this declares it. */
export const PREPASS_BUILTIN: ResolvedPipeline = {
  ...BUILTIN_RESOLVED,
  uniformDecls: TRANSFORM_PASS_DECLARATION,
  sig: `${BUILTIN_RESOLVED.sig}\n${TRANSFORM_PASS_DECLARATION}`,
};

const prepassStages = new WeakSet<ProcessingStageContribution>();

/** The stage that runs `prepass` for the transform `id`. Its uniforms bind the
 *  bag under the transform's id, where the transform's params are. */
export function transformPrepassStage(id: string, prepass: TransformPrepass): ProcessingStageContribution {
  const stage: ProcessingStageContribution = {
    id,
    name: `${id} pre-pass`,
    phase: "tone-map",
    // After every other stage of the group, so its input is the transform's.
    priority: Number.MAX_SAFE_INTEGER,
    reads: "current",
    passes: prepass.passes,
    uniforms: [],
    glsl: `${TRANSFORM_PASS_GLOBAL} = stageResult;`,
    ...(prepass.dormantWhen ? { dormantWhen: prepass.dormantWhen } : {}),
  };
  prepassStages.add(stage);
  return stage;
}

/** A transform's pre-pass runs on every frame its transform draws, bar while
 *  its dormantWhen holds; an extension's stage runs only once its params do
 *  something (PrepassRunner.active). */
export const isTransformPrepass = (s: ProcessingStageContribution): boolean => prepassStages.has(s);

// One stage per pipeline signature, so the renderer's stage set keeps its
// identity, and its memos, while the photo keeps its transform.
const bySig = new Map<string, ProcessingStageContribution>();
const MAX_REMEMBERED = 16;

/** The stage `pipeline`'s pre-pass runs as, or null for a pipeline without one. */
export function prepassStageOf(pipeline: ResolvedPipeline): ProcessingStageContribution | null {
  if (!pipeline.prepass) return null;
  let stage = bySig.get(pipeline.sig);
  if (!stage) {
    if (bySig.size >= MAX_REMEMBERED) bySig.clear();
    stage = transformPrepassStage(pipeline.id, pipeline.prepass);
    bySig.set(pipeline.sig, stage);
  }
  return stage;
}
