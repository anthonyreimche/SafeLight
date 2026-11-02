// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { ProcessingStageContribution } from "@/extensions/types";
import { normalizeGlsl } from "./v1-identity.fixtures";
import { V2_IDENTITY_CONFIGS, V2_IDENTITY_PIPELINES } from "./v2-identity.fixtures";
import { withEssentialLine, type EssentialLine } from "./essential-stages.fixtures";
import { V1_VARIANT, V2_VARIANT, V3_VARIANT, buildFragmentShader, type ShaderVariant } from "./shaders";
import { buildStageInjection } from "./stage-injection";

/** A program's code tokens (normalizeGlsl) with its top-level declarations in a
 *  fixed order: each uniform, constant, global, directive and function is one
 *  item, and the items are sorted, main() among them. The order of top-level
 *  declarations doesn't change what a program computes (the compiler refuses
 *  a name used before it is declared), so a tool's uniforms and helpers can
 *  move between the template and a stage without changing the program this
 *  stands for. Everything inside an item, main()'s body included, keeps its
 *  order. */
export function canonicalGlsl(src: string): string {
  const items: string[] = [];
  let item: string[] = [];
  let depth = 0;
  for (const line of normalizeGlsl(src).split("\n")) {
    item.push(line);
    for (const ch of line) {
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
    }
    if (depth === 0 && (line.startsWith("#") || line.endsWith(";") || line.endsWith("}"))) {
      items.push(item.join("\n"));
      item = [];
    }
  }
  if (item.length > 0) items.push(item.join("\n"));
  return items.sort().join("\n");
}

export const PROGRAM_VARIANTS: Record<string, ShaderVariant> = {
  v1: V1_VARIANT,
  v2: V2_VARIANT,
  v3: V3_VARIANT,
};

/** The Essentials' release line written for each version. */
const PROGRAM_LINES: Record<string, EssentialLine> = { v1: 1, v2: 2, v3: 3 };

/** Every frozen program, keyed `version/config/pipeline`, in canonical form,
 *  with the Essentials at the line of each version. `stagesFor` replaces a
 *  config's stages. */
export function programSnapshot(
  stagesFor: (config: string, stages: ProcessingStageContribution[]) => ProcessingStageContribution[] = (
    _,
    stages,
  ) => stages,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [version, variant] of Object.entries(PROGRAM_VARIANTS)) {
    for (const [name, config] of Object.entries(V2_IDENTITY_CONFIGS)) {
      const stages = withEssentialLine(stagesFor(name, config.stages()), PROGRAM_LINES[version]);
      const { injection } = buildStageInjection(stages, variant, config.samplerBudget);
      for (const [pipeline, glsl] of Object.entries(V2_IDENTITY_PIPELINES)) {
        out[`${version}/${name}/${pipeline}`] = canonicalGlsl(buildFragmentShader(glsl, injection, variant));
      }
    }
  }
  return out;
}
