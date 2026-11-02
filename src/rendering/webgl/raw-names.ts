// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { ProcessingStageContribution } from "@/extensions/types";
import { writesRawNames } from "./builtin-stage";
import { extractHelperNames } from "./shader-compiler";
import { V1_VARIANT, V2_VARIANT, V3_VARIANT, buildFragmentShader } from "./shaders";

// A stage that writes raw names (builtin-stage.ts) shares one namespace with
// the develop program and with every other such stage, so a second declaration
// of a name would fail the whole program. Registration refuses it instead.

const UNIFORM_DECL = /\buniform\s+(?:(?:highp|mediump|lowp)\s+)?\w+\s+([A-Za-z_]\w*)/g;

/** The uniforms and helpers a stage brings into the namespace. */
function declaredNames(s: Pick<ProcessingStageContribution, "uniforms" | "helpers">): string[] {
  return [...s.uniforms.map((u) => u.key), ...extractHelperNames(s.helpers ?? "")];
}

let programNames: ReadonlySet<string> | undefined;

/** The names the develop program declares without any stage, on any version. */
function developProgramNames(): ReadonlySet<string> {
  if (programNames) return programNames;
  const names = new Set<string>();
  for (const variant of [V1_VARIANT, V2_VARIANT, V3_VARIANT]) {
    const src = buildFragmentShader(null, undefined, variant);
    for (const m of src.matchAll(UNIFORM_DECL)) names.add(m[1]);
    for (const name of extractHelperNames(src)) names.add(name);
  }
  names.delete("main");
  programNames = names;
  return names;
}

/** Why stage `c` from `extensionId` can't take its raw names, or null. Only a
 *  stage that writes raw names is checked; `stages` are the registered ones,
 *  and the stage's own earlier registration doesn't count. */
export function rawNameClash(
  c: ProcessingStageContribution,
  extensionId: string,
  stages: Readonly<Record<string, ProcessingStageContribution & { extensionId: string }>>,
): string | null {
  if (!writesRawNames({ id: c.id, extensionId })) return null;
  const others = Object.values(stages).filter((s) => s.id !== c.id && writesRawNames(s));
  for (const name of declaredNames(c)) {
    if (developProgramNames().has(name)) {
      return `stage "${c.id}": "${name}" is already a name in the develop program`;
    }
    const other = others.find((s) => declaredNames(s).includes(name));
    if (other) return `stage "${c.id}": "${name}" is already a name in stage "${other.id}"`;
  }
  return null;
}
