// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The values contributed bindings take from the param bag, and binding them by
// their declared GLSL type: the develop program's stage and transform uniforms
// and the prepass passes' alike.

import type { GlslType } from "@/extensions/types";
import { imageSpaceMatrix, isImageSpaceMatrix } from "../geometry";
import { mat3ColumnMajor } from "../transform";
import type { ContributedBinding } from "./stage-injection";

/** How many numbers one element of each type takes. */
const COMPONENTS: Partial<Record<GlslType, number>> = {
  float: 1, int: 1, bool: 1, vec2: 2, vec3: 3, vec4: 4, ivec2: 2, ivec3: 3, ivec4: 4, mat3: 9, mat4: 16,
};

/** Whether a bag value fits a binding that takes a list of numbers: an array
 *  uniform's every element, or a matrix. Any other binding takes what it gets. */
function fitsBinding(value: unknown, b: Pick<ContributedBinding, "glslType" | "length">): boolean {
  const listed = b.length !== undefined || b.glslType === "mat3" || b.glslType === "mat4";
  if (!listed) return true;
  const count = (COMPONENTS[b.glslType] ?? 0) * (b.length ?? 1);
  return (
    Array.isArray(value) &&
    value.length === count &&
    value.every((v) => typeof v === "number" && Number.isFinite(v))
  );
}

/** The value a binding takes from the bag: the bag's, when it fits, else the
 *  declared default. */
export const boundValue = (bag: Record<string, unknown>, b: ContributedBinding): unknown => {
  const held = bag[b.qualifiedKey];
  return held !== undefined && fitsBinding(held, b) ? held : b.default;
};

/** An image-space matrix's column-major numbers for an image of `aspect`;
 *  the declared default (a plain matrix) without a value it can finish. */
export const imageSpaceValue = (bag: Record<string, unknown>, b: ContributedBinding, aspect: number): number[] => {
  const held = bag[b.qualifiedKey];
  return isImageSpaceMatrix(held)
    ? Array.from(mat3ColumnMajor(imageSpaceMatrix(held, aspect)))
    : (b.default as number[]);
};

/** Bind an array uniform from its flattened numbers. */
function bindUniformArray(gl: WebGL2RenderingContext, loc: WebGLUniformLocation, type: GlslType, v: number[]): void {
  switch (type) {
    case "float": gl.uniform1fv(loc, v); break;
    case "vec2": gl.uniform2fv(loc, v); break;
    case "vec3": gl.uniform3fv(loc, v); break;
    case "vec4": gl.uniform4fv(loc, v); break;
    case "int": gl.uniform1iv(loc, v.map((x) => x | 0)); break;
    case "bool": gl.uniform1iv(loc, v.map((x) => (x ? 1 : 0))); break;
    case "ivec2": gl.uniform2iv(loc, v.map((x) => x | 0)); break;
    case "ivec3": gl.uniform3iv(loc, v.map((x) => x | 0)); break;
    case "ivec4": gl.uniform4iv(loc, v.map((x) => x | 0)); break;
    default: break;
  }
}

/** Bind one value to a uniform by its declared GLSL type, an array uniform by
 *  its length. sampler2D is skipped: samplers are bound by the prepass and
 *  stage-texture code. Pass a value that fits (boundValue). */
export function bindUniformByType(
  gl: WebGL2RenderingContext,
  loc: WebGLUniformLocation,
  type: GlslType,
  value: unknown,
  length?: number,
): void {
  if (length !== undefined) {
    bindUniformArray(gl, loc, type, value as number[]);
    return;
  }
  switch (type) {
    case "float": gl.uniform1f(loc, value as number); break;
    case "int": gl.uniform1i(loc, (value as number) | 0); break;
    case "bool": gl.uniform1i(loc, value ? 1 : 0); break;
    case "vec2": { const v = value as number[]; gl.uniform2f(loc, v[0], v[1]); break; }
    case "vec3": { const v = value as number[]; gl.uniform3f(loc, v[0], v[1], v[2]); break; }
    case "vec4": { const v = value as number[]; gl.uniform4f(loc, v[0], v[1], v[2], v[3]); break; }
    case "ivec2": { const v = value as number[]; gl.uniform2i(loc, v[0] | 0, v[1] | 0); break; }
    case "ivec3": { const v = value as number[]; gl.uniform3i(loc, v[0] | 0, v[1] | 0, v[2] | 0); break; }
    case "ivec4": { const v = value as number[]; gl.uniform4i(loc, v[0] | 0, v[1] | 0, v[2] | 0, v[3] | 0); break; }
    case "mat3": gl.uniformMatrix3fv(loc, false, value as number[]); break;
    case "mat4": gl.uniformMatrix4fv(loc, false, value as number[]); break;
    default: break;
  }
}
