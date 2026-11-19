// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What registerPipeline accepts from a display transform's glsl, params,
// helpers and derive hook. A transform's keys become GLSL identifiers and bag
// keys, and derive's results bind straight to uniforms, so both are checked
// before anything reaches a shader.

import { transformPrepassStage } from "@/rendering/webgl/transform-prepass";
import { checkStageContract } from "./stage-validation";
import type {
  GlslType,
  PipelineContribution,
  TransformDerive,
  TransformPrepass,
  UniformDeclaration,
  UniformValue,
} from "./types";

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;

const COMPONENTS: Partial<Record<GlslType, number>> = {
  vec2: 2, vec3: 3, vec4: 4, ivec2: 2, ivec3: 3, ivec4: 4, mat3: 9, mat4: 16,
};

/** True when `value` can bind to a uniform of `type`: a finite number for
 *  float and int, a boolean for bool, and an array of exactly that many
 *  finite numbers for the vector and matrix types. Never for a sampler. */
export function isUniformValue(value: unknown, type: GlslType): value is UniformValue {
  if (type === "float" || type === "int") return typeof value === "number" && Number.isFinite(value);
  if (type === "bool") return typeof value === "boolean";
  const n = COMPONENTS[type];
  return (
    n !== undefined &&
    Array.isArray(value) &&
    value.length === n &&
    value.every((v) => typeof v === "number" && Number.isFinite(v))
  );
}

const PARAM_TYPES: readonly GlslType[] = ["float", "int", "bool"];
const DERIVED_TYPES: readonly GlslType[] = [
  "float", "int", "bool", "vec2", "vec3", "vec4", "ivec2", "ivec3", "ivec4", "mat3",
];

// `list` comes from extension code, so every field is checked as unknown.
function declarationsError(list: unknown, at: string, types: readonly GlslType[]): string | null {
  if (!Array.isArray(list)) return `${at} must be an array`;
  const seen = new Set<string>();
  for (const [i, u] of (list as unknown[]).entries()) {
    if (typeof u !== "object" || u === null) return `${at}[${i}] must be an object`;
    const { key, glslType, default: value } = u as Partial<UniformDeclaration>;
    if (typeof key !== "string" || !IDENTIFIER.test(key) || key.includes("__")) {
      return `${at}[${i}].key must be a GLSL identifier without "__", got ${JSON.stringify(key)}`;
    }
    if (glslType === undefined || !types.includes(glslType)) {
      return `${at} "${key}": glslType must be one of ${types.join(", ")}`;
    }
    if (!isUniformValue(value, glslType)) return `${at} "${key}": default doesn't fit ${glslType}`;
    if (seen.has(key)) return `${at} declares "${key}" twice`;
    seen.add(key);
  }
  return null;
}

/** Why registerPipeline refuses `c`, or null when it can register. */
export function pipelineContractError(c: PipelineContribution): string | null {
  const at = `transform "${c.id}"`;
  const tuned = c.params !== undefined || c.helpers !== undefined || c.derive !== undefined;
  const glsl: unknown = c.glsl;
  if (glsl !== undefined && glsl !== null && typeof glsl !== "string") return `${at}: glsl must be a string`;
  if (tuned && !glsl) return `${at}: params, helpers and derive need glsl`;
  if (c.helpers !== undefined && typeof c.helpers !== "string") return `${at}: helpers must be a string`;
  if (c.params !== undefined) {
    const error = declarationsError(c.params, `${at}: params`, PARAM_TYPES);
    if (error) return error;
  }
  if (c.derive !== undefined) {
    const derive: unknown = c.derive;
    if (typeof derive !== "object" || derive === null) return `${at}: derive must be { uniforms, fn }`;
    const { uniforms, fn } = derive as Partial<TransformDerive>;
    if (typeof fn !== "function") return `${at}: derive.fn must be a function`;
    const error = declarationsError(uniforms, `${at}: derive.uniforms`, DERIVED_TYPES);
    if (error) return error;
  }
  if (c.prepass !== undefined) return prepassError(c, c.prepass, at, Boolean(glsl));
  return null;
}

// The names the pre-pass's result sampler takes under the transform's namespace.
const RESULT_NAMES = new Set(["stageResult", "stageResultLayer"]);

function prepassError(c: PipelineContribution, given: TransformPrepass, at: string, hasGlsl: boolean): string | null {
  // Extensions are plain JavaScript, so the shape is checked before it is trusted.
  const prepass: unknown = given;
  if (typeof prepass !== "object" || prepass === null) return `${at}: prepass must be { passes, dormantWhen? }`;
  if (!hasGlsl) return `${at}: prepass needs glsl to read its result`;
  const passes: unknown = (prepass as Record<string, unknown>).passes;
  if (!Array.isArray(passes) || passes.length === 0) return `${at}: prepass.passes must list at least one pass`;
  const keys = [...(c.params ?? []), ...(c.derive?.uniforms ?? [])].map((u) => u.key);
  const taken = keys.find((k) => RESULT_NAMES.has(k));
  if (taken) return `${at}: "${taken}" names the pre-pass's result, so a transform with one can't use it as a key`;
  // The renderer runs the passes as a stage of their own, so they answer to a stage's contract.
  const check = checkStageContract(transformPrepassStage(c.id, given));
  return check.error ? `${at}: prepass: ${check.error.replace(/^stage "[^"]*": /, "")}` : null;
}
