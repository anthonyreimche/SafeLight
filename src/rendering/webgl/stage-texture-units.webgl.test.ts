// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Every lut, dynamic and paint texture in a program needs a unit of its own.
// Only four were bound, from 12 up: a fifth was left on unit 0, the photo
// itself. A thumbnail or an export draws with every stage while the live view
// draws with those its photo woke, so the stage past the fourth read the photo
// as its table in the Library and in the file but not in Develop (SafeLight
// #278).
//
// Each stage brightens the frame by STEP only when its own table holds its
// mark, so the frame says how many stages read their own table.

import { describe, expect, it } from "vitest";
import type { ProcessingStageContribution, StageTextureData } from "@/extensions/types";
import type { WebGLRenderer } from "./renderer";
import { LINEAR_PROBE_PIPELINE, floatImage, glHarness, identityParams, pixelAt, withRenderer } from "./webgl.test-support";

const STEP = 0.05;
const BASE = 0.1;
const SOURCE = floatImage(8, 8, () => [BASE, BASE, BASE]);

const markOf = (i: number) => (i + 1) * 20;

function tableStage(i: number): ProcessingStageContribution {
  return {
    id: `table-${i}.test`,
    name: `Table ${i}`,
    phase: "scene-linear",
    priority: 10 + i,
    glsl: `if (abs(texelFetch(tbl, ivec2(0), 0).r * 255.0 - ${markOf(i)}.0) < 0.5) lin += vec3(${STEP});`,
    uniforms: [],
    textures: [{ key: "tbl", kind: "lut", format: "rgba8" }],
  };
}

function tableOf(i: number): StageTextureData {
  return { data: new Uint8Array([markOf(i), 0, 0, 255]), width: 1, height: 1, format: "rgba8", version: 1 };
}

/** A driver reporting `units` combined texture units, from the next renderer on. */
function combinedUnits(units: number): { restore(): void } {
  const { gl } = glHarness();
  const original = gl.getParameter;
  gl.getParameter = (pname: number) =>
    pname === gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS ? units : Reflect.apply(original, gl, [pname]);
  return {
    restore() {
      gl.getParameter = original;
    },
  };
}

function stepsTaken(n: number): number {
  const stages = Array.from({ length: n }, (_, i) => tableStage(i));
  return withRenderer({ stages, pipeline: LINEAR_PROBE_PIPELINE }, (renderer: WebGLRenderer) => {
    renderer.setImage(SOURCE);
    renderer.setParams(identityParams());
    renderer.setStageTextures(Object.fromEntries(stages.map((s, i) => [`${s.id}.tbl`, tableOf(i)])));
    const level = pixelAt(renderer.captureFloatFrame()!, 4, 4)[1];
    return Math.round((level - BASE) / STEP);
  });
}

describe("stage texture units", () => {
  it("binds each of four tables to its own stage", () => {
    expect(stepsTaken(4)).toBe(4);
  });

  it("binds a fifth and sixth table too", () => {
    expect(stepsTaken(6)).toBe(6);
  });

  // Unreachable while the program compiles on a real context; a table past the
  // context's units must fail the frame, never be drawn from another unit.
  it("fails the frame rather than bind a table past the context's units", () => {
    const driver = combinedUnits(16);
    try {
      expect(() => stepsTaken(6)).toThrow(/units/);
    } finally {
      driver.restore();
    }
  });
});
