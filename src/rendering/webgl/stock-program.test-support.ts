// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { ProgramExit, ShaderVariant } from "./shaders";
import { buildFragmentShader } from "./shaders";
import { buildStageInjection } from "./stage-injection";
import { essentialStages, type EssentialLine } from "./essential-stages.fixtures";

/** The develop program as the shipped app builds it for `variant`: the
 *  Essentials' line for that version. */
export function shippedProgram(variant: ShaderVariant, pipeline: string | null = null): string {
  const stages = essentialStages(variant.version as EssentialLine);
  return buildFragmentShader(pipeline, buildStageInjection(stages, variant).injection, variant);
}

/** Core's own develop program, without the Essentials. For tests that read
 *  the program's text; it loads no extension code, so the node project can
 *  run it. */
export function stockProgram(variant: ShaderVariant, pipeline: string | null = null, exit?: ProgramExit): string {
  return buildFragmentShader(pipeline, buildStageInjection([], variant).injection, variant, exit);
}
