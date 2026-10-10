// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What a stage that declares `space` receives on the GPU. A probe squeezes
// [-1, 3] into [0, 1] so values beyond white or below black survive the output
// clamp, and `recover` undoes the squeeze.

import { describe, expect, it } from "vitest";
import {
  CURRENT_PROCESS_VERSION,
  DEFAULT_GRAIN,
  DEFAULT_VIGNETTE,
  LEGACY_PROCESS_VERSION,
  type DevelopParams,
} from "@/catalog/types";
import { BUILTIN_RESOLVED, type ResolvedPipeline } from "@/extensions/pipelines";
import type { ProcessingStageContribution, StageSpace } from "@/extensions/types";
import { fromStageSpace, toStageSpace, type Vec3 } from "../stage-space";
import type { WebGLRenderer } from "./renderer";
import { PASS_VERTEX_SHADER, buildStageInjection } from "./stage-injection";
import {
  LINEAR_PROBE_PIPELINE,
  buildProgram,
  builtinStage,
  floatImage,
  glHarness,
  identityParams,
  pixelAt,
  releaseProgram,
  rendererBuildError,
  withRenderer,
  type FloatImage,
  type Frame,
} from "./webgl.test-support";

const V1 = { processVersion: LEGACY_PROCESS_VERSION };
const V2 = { processVersion: CURRENT_PROCESS_VERSION };

const DOUBLING_PIPELINE: ResolvedPipeline = {
  id: "test.double",
  glsl: "vec3 pipelineToDisplay(vec3 lin) { return lin * 2.0; }",
  skipBaseCurve: true,
  skipToneShoulder: true,
  sig: "test.double",
};

const recover = (v: number) => (v - 0.25) * 4;

function probe(over: Partial<ProcessingStageContribution> = {}): ProcessingStageContribution {
  return {
    id: "test.probe",
    name: "Probe",
    phase: "effects",
    space: { encoding: "perceptual" },
    glsl: "c = c * 0.25 + 0.25;",
    uniforms: [],
    ...over,
  };
}

function capture(renderer: WebGLRenderer): Frame {
  const frame = renderer.captureFloatFrame();
  if (!frame) throw new Error("captureFloatFrame returned null");
  return frame;
}

function render(
  stages: ProcessingStageContribution[],
  pipeline: ResolvedPipeline,
  source: FloatImage,
  params: DevelopParams,
  bag: Parameters<WebGLRenderer["setContributedParams"]>[0] = {},
): Frame {
  return withRenderer({ stages, pipeline }, (renderer) => {
    renderer.setImage(source);
    renderer.setParams(params);
    renderer.setContributedParams(bag);
    return capture(renderer);
  });
}

const flat = (r: number, g = r, b = r) => floatImage(16, 16, () => [r, g, b]);

const scale = (v: Vec3, k: Vec3): Vec3 => [v[0] * k[0], v[1] * k[1], v[2] * k[2]];

describe("a stage that declares a space", () => {
  it("compiles for every space, before and after the transform", () => {
    for (const phase of ["noise-reduction", "scene-linear", "effects"] as const)
      for (const encoding of ["linear", "perceptual"] as const)
        for (const primaries of ["rec709", "rec2020"] as const) {
          const glsl = phase === "effects" ? "c = c;" : "lin = lin;";
          const stage = probe({ phase, space: { encoding, primaries }, glsl });
          const label = `${phase} ${encoding} ${primaries}`;
          expect(rendererBuildError({ stages: [stage] }), label).toBeNull();
        }
  });

  it("compiles its pass programs for every space", () => {
    const { gl } = glHarness();
    for (const encoding of ["linear", "perceptual"] as const)
      for (const primaries of ["rec709", "rec2020"] as const) {
        const stage = probe({
          space: { encoding, primaries },
          passes: [{ glsl: "c = readPrev(vUv);" }],
        });
        const [pass] = buildStageInjection([stage]).prepass[0].passes;
        const build = buildProgram(gl, PASS_VERTEX_SHADER, pass.fragmentSource);
        expect(build.error, `${encoding} ${primaries}`).toBeNull();
        releaseProgram(gl, build);
      }
  });

  it("gets values above white after the transform on version 2", () => {
    const px = pixelAt(render([probe()], DOUBLING_PIPELINE, flat(0.8), identityParams(V2)), 8, 8);
    expect(recover(px[0])).toBeCloseTo(1.6, 1);
  });

  it("keeps version 1 photos on the old clamped values", () => {
    const px = pixelAt(render([probe()], DOUBLING_PIPELINE, flat(0.8), identityParams(V1)), 8, 8);
    expect(recover(px[0])).toBeCloseTo(1.0, 1);
  });

  it("sees clipped values once a tool that needs [0, 1] is in use", () => {
    const params = identityParams({ ...V2, contrast: 40 });
    const px = pixelAt(render([probe()], DOUBLING_PIPELINE, flat(0.8), params), 8, 8);
    expect(recover(px[0])).toBeLessThan(1.01);
  });

  it("keeps a stage that declared nothing on clipped values, even on version 2", () => {
    const legacy = probe({ space: undefined });
    const px = pixelAt(render([legacy], DOUBLING_PIPELINE, flat(0.8), identityParams(V2)), 8, 8);
    expect(recover(px[0])).toBeCloseTo(1.0, 1);
  });

  // Version 1 never clipped what sharpening pushes past white ahead of the
  // effects stages, so its legacy stages must keep seeing that overshoot. One
  // renderer draws photos of both versions, so each needs its own injection.
  it("clips for a legacy stage on version 2 photos only, in one renderer", () => {
    const edge = floatImage(32, 32, (x) => (x < 16 ? [0.1, 0.1, 0.1] : [0.6, 0.6, 0.6]));
    const sharpened = (over: Partial<DevelopParams>) =>
      identityParams({ sharpening: 100, sharpenDetail: 100, ...over });
    withRenderer({ stages: [probe({ space: undefined })], pipeline: DOUBLING_PIPELINE }, (r) => {
      r.setImage(edge);
      const at = (params: DevelopParams) => {
        r.setParams(params);
        return recover(pixelAt(capture(r), 16, 16)[0]);
      };
      const v1 = at(sharpened(V1));
      expect(v1).toBeGreaterThan(1.01);
      expect(at(sharpened(V2))).toBeCloseTo(1.0, 2);
      expect(at(sharpened(V1))).toBe(v1);
    });
  });

  it("keeps colour outside sRGB signed through the built-in transform on version 2", () => {
    const source = flat(0.3, -0.02, 0.3);
    const v2 = pixelAt(render([probe()], BUILTIN_RESOLVED, source, identityParams(V2)), 8, 8);
    const v1 = pixelAt(render([probe()], BUILTIN_RESOLVED, source, identityParams(V1)), 8, 8);
    expect(recover(v2[1])).toBeLessThan(-0.01);
    expect(recover(v1[1])).toBeGreaterThan(-0.005);
  });

  // Both probes below scale what they receive, and the expectation runs the
  // frame drawn without them through the TS mirrors: LINEAR_PROBE_PIPELINE
  // isn't an exact identity, so the source itself can't stand in for it.
  it("converts a linear display stage both ways", () => {
    const space: StageSpace = { encoding: "linear" };
    const linear = probe({ space, glsl: "c = c * 0.5;" });
    const params = identityParams(V2);
    const before = pixelAt(render([], LINEAR_PROBE_PIPELINE, flat(0.3), params), 8, 8);
    const after = pixelAt(render([linear], LINEAR_PROBE_PIPELINE, flat(0.3), params), 8, 8);
    const inSpace = toStageSpace(before, space, "display");
    const expected = fromStageSpace(scale(inSpace, [0.5, 0.5, 0.5]), space, "display");
    for (let i = 0; i < 3; i++) expect(after[i]).toBeCloseTo(expected[i], 3);
  });

  // A scale per channel doesn't commute with the primaries matrix, so the
  // result tells a stage handed Rec.2020 values from one handed Rec.709.
  it("converts a Rec.2020 scene stage both ways", () => {
    const wide: StageSpace = { encoding: "linear", primaries: "rec2020" };
    const glsl = "lin *= vec3(1.0, 0.5, 0.25);";
    const stage = probe({ phase: "scene-linear", space: wide, glsl });
    const source = flat(0.4, 0.2, 0.1);
    const params = identityParams(V2);
    const before = pixelAt(render([], LINEAR_PROBE_PIPELINE, source, params), 8, 8);
    const after = pixelAt(render([stage], LINEAR_PROBE_PIPELINE, source, params), 8, 8);
    const inSpace = toStageSpace(before, wide, "scene");
    const expected = fromStageSpace(scale(inSpace, [1, 0.5, 0.25]), wide, "scene");
    for (let i = 0; i < 3; i++) expect(after[i]).toBeCloseTo(expected[i], 3);
  });

  it("feeds its passes the source in its own space", () => {
    const wide = probe({
      phase: "scene-linear",
      space: { encoding: "linear", primaries: "rec2020" },
      glsl: "lin = mix(lin, stageResult, take);",
      uniforms: [{ key: "take", glslType: "float", default: 0 }],
      passes: [{ glsl: "c = c;" }],
    });
    const px = pixelAt(
      render([wide], LINEAR_PROBE_PIPELINE, flat(0.5, 0.2, 0.1), identityParams(V2), {
        "test.probe.take": 1,
      }),
      8,
      8,
    );
    expect(px[0]).toBeCloseTo(0.5, 2);
    expect(px[1]).toBeCloseTo(0.2, 2);
    expect(px[2]).toBeCloseTo(0.1, 2);
  });
});

// The core Vignette and Grain clamped their output to [0, 1]. They still do on
// version 1. On version 2 they hand on what they make, so a stage that declares a
// space after them sees values over white. 0.55 doubles to 1.1 at the display
// stage on version 2 (1.0 on version 1). The probe takes 0.5 off: a pixel left at
// 1.1 reads 0.6, one the effect lifts further reads higher, and a clipped one 0.5.
describe("the core Vignette and Grain, ahead of a stage that declares a space", () => {
  const SOURCE = flat(0.55);
  const takeHalf = probe({ phase: "output-encode", glsl: "c = c - 0.5;" });
  const TOOLS: [string, string, Partial<DevelopParams>][] = [
    ["Vignette", "core.vignette", { vignette: { ...DEFAULT_VIGNETTE, amount: 20 } }],
    ["Grain", "core.grain", { grain: { ...DEFAULT_GRAIN, amount: 100 } }],
  ];

  // Grain lifts some pixels and lowers others, so no single pixel is the one to
  // ask about; the frame's brightest red channel is.
  function brightest(id: string, over: Partial<DevelopParams>): number {
    const stages = [builtinStage(id), takeHalf];
    const frame = render(stages, DOUBLING_PIPELINE, SOURCE, identityParams(over));
    let top = -Infinity;
    for (let i = 0; i < frame.data.length; i += 4) top = Math.max(top, frame.data[i]);
    return top;
  }

  for (const [tool, id, params] of TOOLS) {
    it(`keeps what ${tool} makes past white on version 2`, () => {
      expect(brightest(id, { ...V2, ...params })).toBeGreaterThan(0.6);
    });

    it(`still clips ${tool} at white on version 1`, () => {
      expect(brightest(id, { ...V1, ...params })).toBeCloseTo(0.5, 3);
    });
  }
});
