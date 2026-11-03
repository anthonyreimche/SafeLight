// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The histogram's read-backs on a context whose float targets never complete,
// though the renderer was told they render: a driver can list the extension
// and still refuse RGBA16F, and a histogram read from an incomplete target is
// all black, which sends Auto Tone and Auto WB wild.

import { describe, expect, it } from "vitest";
import { Readback } from "./readback";
import { buildProgram, freshContext, releaseProgram } from "./webgl.test-support";

// Two triangles over the target, with no vertex buffer to bind.
const VERTEX = `#version 300 es
void main() {
  vec2 corners[6] = vec2[](vec2(-1, -1), vec2(1, -1), vec2(-1, 1), vec2(-1, 1), vec2(1, -1), vec2(1, 1));
  gl_Position = vec4(corners[gl_VertexID], 0.0, 1.0);
}`;

// A ramp across and up the 128 px target, so the bins spread.
const RAMP = `#version 300 es
precision highp float;
out vec4 o;
void main() { o = vec4(gl_FragCoord.x / 128.0, gl_FragCoord.y / 128.0, 0.25, 1.0); }`;

const noPasses = (): WebGLProgram => {
  throw new Error("the histogram builds no pass programs");
};

describe("the histogram where float targets don't complete", () => {
  it("is the 8-bit histogram, not every pixel in bin 0", () => {
    const context = freshContext({ noFloat: true });
    const { gl } = context;
    const build = buildProgram(gl, VERTEX, RAMP);
    const told = new Readback(gl, true, noPasses);
    const eightBit = new Readback(gl, false, noPasses);
    try {
      if (!build.program) throw new Error(build.error ?? "no program");
      gl.useProgram(build.program);
      const got = told.histogram(true, null);
      const want = eightBit.histogram(true, null);
      expect(want.r.filter((n) => n > 0).length, "the ramp's red bins").toBeGreaterThan(100);
      expect(got).toEqual(want);
      expect(got.extended).toBeUndefined();
    } finally {
      told.dispose();
      eightBit.dispose();
      releaseProgram(gl, build);
      context.release();
    }
  });
});
