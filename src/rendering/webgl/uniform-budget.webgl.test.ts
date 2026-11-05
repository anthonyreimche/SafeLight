// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The shipped develop program's uniforms against MAX_FRAGMENT_UNIFORM_VECTORS.
// A driver with fewer vectors than the program fills can't link it, and the
// stock program failing to link leaves Develop blank. 1024 is what desktop
// drivers commonly give; the recorded count makes growth show up in review.

import { describe, expect, it } from "vitest";
import { CURRENT_PROCESS_VERSION } from "@/catalog/types";
import { withProcessVersion } from "./program-cache";
import { VERTEX_SHADER, shaderVariantFor } from "./shaders";
import { shippedProgram } from "./stock-program.test-support";
import { buildProgram, glHarness, releaseProgram } from "./webgl.test-support";

/** Vector rows the shipped program's active uniforms fill, as last measured.
 *  Raise it deliberately when the program grows. */
const RECORDED_ROWS = 661;
const COMMON_DRIVER_VECTORS = 1024;

/** The vec4 rows one element of a uniform of `type` takes: a matrix one per
 *  column, everything else (scalars, vectors, samplers) one. */
function rowsPerElement(gl: WebGL2RenderingContext, type: number): number {
  switch (type) {
    case gl.FLOAT_MAT2:
    case gl.FLOAT_MAT2x3:
    case gl.FLOAT_MAT2x4:
      return 2;
    case gl.FLOAT_MAT3:
    case gl.FLOAT_MAT3x2:
    case gl.FLOAT_MAT3x4:
      return 3;
    case gl.FLOAT_MAT4:
    case gl.FLOAT_MAT4x2:
    case gl.FLOAT_MAT4x3:
      return 4;
    default:
      return 1;
  }
}

function activeUniformRows(gl: WebGL2RenderingContext, program: WebGLProgram): number {
  const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as number;
  let rows = 0;
  for (let i = 0; i < count; i++) {
    const info = gl.getActiveUniform(program, i);
    if (info) rows += info.size * rowsPerElement(gl, info.type);
  }
  return rows;
}

describe("the shipped develop program's uniform budget", () => {
  // Every Essential, Heal and Masks among them. The mask uniforms are arrays
  // of MAX_MASKS whatever the photo holds, so this is the most masks there are.
  it(`fits in ${COMMON_DRIVER_VECTORS} fragment uniform vectors`, () => {
    const { gl } = glHarness();
    const fragment = withProcessVersion(shippedProgram(shaderVariantFor(CURRENT_PROCESS_VERSION)), CURRENT_PROCESS_VERSION);
    const build = buildProgram(gl, VERTEX_SHADER, fragment);
    expect(build.error).toBeNull();
    const rows = activeUniformRows(gl, build.program!);
    releaseProgram(gl, build);
    expect(RECORDED_ROWS).toBeLessThan(COMMON_DRIVER_VECTORS);
    expect(rows).toBeLessThanOrEqual(RECORDED_ROWS);
  });
});
