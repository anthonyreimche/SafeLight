// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A stage that belongs to a display transform draws only in the frames of
// photos that render with it. One renderer draws many photos (the thumbnails',
// an export batch's), each with its own transform, so a photo that renders
// with another draws without it there too (SafeLight #278).

import { describe, expect, it, vi } from "vitest";
import type { ProcessingStageContribution } from "@/extensions/types";
import type { ResolvedPipeline } from "./resolved-pipeline";
import type { WebGLRenderer, WebGLRendererOpts } from "./renderer";
import { LINEAR_PROBE_PIPELINE, floatImage, glHarness, identityParams, pixelAt, withRenderer } from "./webgl.test-support";

const MATCH_TRANSFORM: ResolvedPipeline = { ...LINEAR_PROBE_PIPELINE, id: "acme.match-transform" };

const MATCH: ProcessingStageContribution = {
  id: "acme.match",
  name: "Match",
  phase: "effects",
  space: { encoding: "perceptual" },
  glsl: "c = vec3(1.0, 0.0, 0.0);",
  uniforms: [],
  transform: MATCH_TRANSFORM.id,
};

const GREY = floatImage(8, 8, () => [0.18, 0.18, 0.18]);

function drawnRed(renderer: WebGLRenderer): boolean {
  renderer.render();
  const { canvas, gl } = glHarness();
  const pixels = new Uint8Array(canvas.width * canvas.height * 4);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  let r = 0;
  let g = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    r += pixels[i];
    g += pixels[i + 1];
  }
  const n = pixels.length / 4;
  return r / n > 250 && g / n < 5;
}

function withMatch<T>(opts: Partial<WebGLRendererOpts>, fn: (renderer: WebGLRenderer) => T): T {
  return withRenderer({ stages: [MATCH], pipeline: MATCH_TRANSFORM, ...opts }, (renderer) => {
    renderer.setParams(identityParams());
    renderer.uploadSource("grey:0", GREY);
    return fn(renderer);
  });
}

describe("a stage that belongs to a display transform", () => {
  it("draws in a frame drawn with its transform", () => {
    withMatch({}, (renderer) => expect(drawnRed(renderer)).toBe(true));
  });

  it("is left out of a frame drawn with another transform", () => {
    withMatch({}, (renderer) => {
      renderer.setActivePipeline(LINEAR_PROBE_PIPELINE);
      expect(drawnRed(renderer)).toBe(false);
    });
  });

  it("follows each photo's transform on a renderer that draws many photos", () => {
    withMatch({ skipDormantStages: true, wakeTogether: true }, (renderer) => {
      renderer.wakeAllStages();
      const drawn = [MATCH_TRANSFORM, LINEAR_PROBE_PIPELINE, MATCH_TRANSFORM, LINEAR_PROBE_PIPELINE].map((p) => {
        renderer.setActivePipeline(p);
        return drawnRed(renderer);
      });
      expect(drawn).toEqual([true, false, true, false]);
    });
  });
});

// Two stages that build alone and fail together: the later one is left out of
// that transform's frames, and runs in the frames of a transform its partner
// doesn't belong to.
describe("a stage left out with a transform's stage", () => {
  it("runs again in the frames of another transform", () => {
    const GREY = 0.2;
    const doubleRed: ProcessingStageContribution = { ...MATCH, id: "acme.red", phase: "scene-linear", space: undefined, glsl: "lin.r *= 2.0;" };
    const halveBlue: ProcessingStageContribution = { id: "acme.blue", name: "Blue", phase: "scene-linear", glsl: "lin.b *= 0.5;", uniforms: [] };
    const { gl } = glHarness();
    const original = { shaderSource: gl.shaderSource, getShaderParameter: gl.getShaderParameter };
    const together = new WeakSet<WebGLShader>();
    gl.shaderSource = (shader: WebGLShader, src: string) => {
      if (src.includes("lin.r *= 2.0") && src.includes("lin.b *= 0.5")) together.add(shader);
      original.shaderSource.call(gl, shader, src);
    };
    gl.getShaderParameter = (shader: WebGLShader, pname: number) =>
      pname === gl.COMPILE_STATUS && together.has(shader) ? false : original.getShaderParameter.call(gl, shader, pname);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const reported: string[] = [];
      withRenderer(
        { stages: [doubleRed, halveBlue], pipeline: MATCH_TRANSFORM, onStageQuarantined: (q) => reported.push(q.stageId) },
        (renderer) => {
          renderer.setImage(floatImage(16, 16, () => [GREY, GREY, GREY]));
          renderer.setParams(identityParams());
          const blue = (p: ResolvedPipeline) => {
            renderer.setActivePipeline(p);
            return Math.round((pixelAt(renderer.captureFloatFrame()!, 8, 8)[2] / GREY) * 100) / 100;
          };
          // A grid of photos with either transform, drawn in turn by one renderer.
          expect([MATCH_TRANSFORM, LINEAR_PROBE_PIPELINE, MATCH_TRANSFORM, LINEAR_PROBE_PIPELINE].map(blue)).toEqual([1, 0.5, 1, 0.5]);
          expect(reported).toEqual(["acme.blue"]);
        },
      );
    } finally {
      Object.assign(gl, original);
      logged.mockRestore();
    }
  });
});
