// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A display transform's pre-pass (PipelineContribution.prepass) on the real
// renderer: its passes read the image as edited up to the transform, bind the
// transform's params, and hand their result to pipelineToDisplay as
// slTransformPass at the pixel; it runs only while the photo renders with that
// transform, and not while its dormantWhen holds.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CURRENT_PROCESS_VERSION } from "@/catalog/types";
import { resolvePipelineFor } from "@/extensions/pipelines";
import { registerPipeline, unregisterExtension } from "@/extensions/registry";
import type { PipelineContribution, ProcessingStageContribution, StageSpace } from "@/extensions/types";
import type { WebGLRenderer } from "./renderer";
import {
  builtinStages,
  floatImage,
  glHarness,
  identityParams,
  pixelAt,
  rendererBuildError,
  toHalf,
  withRenderer,
} from "./webgl.test-support";

const EXT = "test-transform-prepass";
const AS_DRAWN: StageSpace = { encoding: "perceptual", primaries: "rec709" };
const W = 8;
const H = 4;
// Every pixel its own colour, so a result read at the wrong place shows.
const source = (x: number, y: number): [number, number, number] => [0.05 + x * 0.05, 0.1 + y * 0.1, 0.3];
const IMAGE = floatImage(W, H, source);

// The passes rotate the channels and scale by `k`; the transform draws their
// result while `use` is on and they run (k isn't 0), its own input otherwise.
const ROTATE: PipelineContribution = {
  id: "test.prepass",
  name: "Pre-pass",
  glsl: "vec3 pipelineToDisplay(vec3 lin) { return use && k != 0.0 ? slTransformPass : lin; }",
  skipBaseCurve: true,
  skipToneShoulder: true,
  params: [
    { key: "use", glslType: "bool", default: true },
    { key: "k", glslType: "float", default: 1 },
  ],
  prepass: {
    passes: [{ glsl: "c = vec3(c.g, c.b, c.r) * k;", uniforms: [{ key: "k", glslType: "float", default: 1 }] }],
    dormantWhen: { k: 0 },
  },
};

// A box blur over the row: each result reads its neighbours.
const BLUR: PipelineContribution = {
  id: "test.prepass-blur",
  name: "Pre-pass blur",
  glsl: "vec3 pipelineToDisplay(vec3 lin) { return slTransformPass; }",
  skipBaseCurve: true,
  skipToneShoulder: true,
  prepass: {
    passes: [
      {
        glsl: `vec3 s = vec3(0.0);
  for (int i = -1; i <= 1; i++) s += texelFetch(uPrevPass, clamp(ivec2(gl_FragCoord.xy) + ivec2(i, 0), ivec2(0), textureSize(uPrevPass, 0) - 1), 0).rgb;
  c = s / 3.0;`,
      },
    ],
  },
};

const PLAIN: PipelineContribution = {
  id: "test.plain",
  name: "Plain",
  glsl: "vec3 pipelineToDisplay(vec3 lin) { return lin; }",
  skipBaseCurve: true,
  skipToneShoulder: true,
};

// A scene-linear stage ahead of the transform: the passes must see its edit.
const DOUBLE: ProcessingStageContribution = {
  id: "test.double",
  name: "Double",
  phase: "scene-linear",
  glsl: "lin *= gain;",
  uniforms: [{ key: "gain", glslType: "float", default: 1 }],
};

// Its own GLSL doesn't build (an undeclared name); its pre-pass does.
const BROKEN_GLSL: PipelineContribution = {
  ...ROTATE,
  id: "test.prepass-broken-glsl",
  glsl: "vec3 pipelineToDisplay(vec3 lin) { return slTransformPass * notDeclared; }",
  params: undefined,
  prepass: { passes: [{ glsl: "c = c * 2.0;" }] },
};

// Its pass doesn't build; its own GLSL does.
const BROKEN_PASS: PipelineContribution = {
  ...PLAIN,
  id: "test.prepass-broken-pass",
  glsl: "vec3 pipelineToDisplay(vec3 lin) { return slTransformPass; }",
  prepass: { passes: [{ glsl: "c = notDeclaredEither;" }] },
};

beforeAll(() => {
  for (const c of [ROTATE, BLUR, PLAIN, BROKEN_GLSL, BROKEN_PASS]) registerPipeline(EXT, c);
});
afterAll(() => unregisterExtension(EXT));

const half = (v: number) => toHalf(v);

function frame(
  r: WebGLRenderer,
  id: string,
  bag: Record<string, unknown> = {},
): (x: number, y: number) => [number, number, number] {
  r.setActivePipeline(resolvePipelineFor(id));
  r.setParams(identityParams({ processVersion: CURRENT_PROCESS_VERSION, displayTransform: id }));
  r.setContributedParams(bag);
  const f = r.readFloatFrame("pre-output", Infinity, AS_DRAWN);
  if (!f) throw new Error("readFloatFrame returned null");
  return (x, y) => {
    const p = pixelAt(f, x, y);
    return [p[0], p[1], p[2]];
  };
}

function expectNear(got: readonly number[], want: readonly number[], what: string): void {
  got.forEach((v, i) => expect(Math.abs(v - want[i]), `${what} ch ${i}: ${v} vs ${want[i]}`).toBeLessThan(2e-3));
}

describe("a display transform's pre-pass", () => {
  it("compiles beside the built-in stages", () => {
    expect(rendererBuildError({ stages: builtinStages(), pipeline: resolvePipelineFor(ROTATE.id) })).toBeNull();
  });

  it("hands pipelineToDisplay the passes' result at each pixel", () => {
    withRenderer({ stages: [], pipeline: resolvePipelineFor(ROTATE.id) }, (r) => {
      r.setImage(IMAGE);
      const at = frame(r, ROTATE.id);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const [s0, s1, s2] = source(x, y).map(half);
          expectNear(at(x, y), [s1, s2, s0], `pixel ${x},${y}`);
        }
      }
    });
  });

  it("binds the transform's params in its passes", () => {
    withRenderer({ stages: [], pipeline: resolvePipelineFor(ROTATE.id) }, (r) => {
      r.setImage(IMAGE);
      const at = frame(r, ROTATE.id, { [`${ROTATE.id}.k`]: 3 });
      const [s0, s1, s2] = source(2, 1).map(half);
      expectNear(at(2, 1), [3 * s1, 3 * s2, 3 * s0], "k = 3");
    });
  });

  it("reads the image as edited up to the transform", () => {
    withRenderer({ stages: [DOUBLE], pipeline: resolvePipelineFor(ROTATE.id) }, (r) => {
      r.setImage(IMAGE);
      const at = frame(r, ROTATE.id, { [`${DOUBLE.id}.gain`]: 2 });
      const [s0, s1, s2] = source(5, 2).map(half);
      expectNear(at(5, 2), [2 * s1, 2 * s2, 2 * s0], "after a stage doubling the image");
    });
  });

  it("reads its neighbours, at the source's resolution", () => {
    withRenderer({ stages: [], pipeline: resolvePipelineFor(BLUR.id) }, (r) => {
      r.setImage(IMAGE);
      const at = frame(r, BLUR.id);
      const want = [0, 1, 2].map((c) => [3, 4, 5].reduce((s, x) => s + half(source(x, 1)[c]), 0) / 3);
      expectNear(at(4, 1), want, "the mean of three");
    });
  });

  it("leaves its stage out of the live view while its dormantWhen holds", () => {
    withRenderer({ stages: [], pipeline: resolvePipelineFor(ROTATE.id), skipDormantStages: true }, (r) => {
      r.setImage(IMAGE);
      const lin = source(3, 2).map(half);
      expectNear(frame(r, ROTATE.id, { [`${ROTATE.id}.k`]: 0 })(3, 2), lin, "dormant: the transform's input");
      expect(r.dormantStages).toEqual([ROTATE.id]);
      const [s0, s1, s2] = lin;
      expectNear(frame(r, ROTATE.id, { [`${ROTATE.id}.k`]: 1 })(3, 2), [s1, s2, s0], "awake");
      expect(r.awakeStages).toEqual([ROTATE.id]);
    });
  });

  it("goes with its transform when the photo switches to another", () => {
    withRenderer({ stages: [], pipeline: resolvePipelineFor(ROTATE.id) }, (r) => {
      r.setImage(IMAGE);
      const [s0, s1, s2] = source(1, 3).map(half);
      expectNear(frame(r, ROTATE.id)(1, 3), [s1, s2, s0], "with the pre-pass");
      expectNear(frame(r, PLAIN.id)(1, 3), [s0, s1, s2], "another transform");
      expectNear(frame(r, ROTATE.id)(1, 3), [s1, s2, s0], "back again");
    });
  });

  // A pick that isn't registered renders with the built-in.
  const BUILT_IN = "test.not-registered";

  it("falls back to the built-in when its own GLSL doesn't build, blaming no stage", () => {
    const reported: string[] = [];
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      withRenderer(
        { stages: [], pipeline: resolvePipelineFor(BROKEN_GLSL.id), onStageQuarantined: (q) => reported.push(q.stageId) },
        (r) => {
          r.setImage(IMAGE);
          const builtIn = frame(r, BUILT_IN)(2, 2);
          expectNear(frame(r, BROKEN_GLSL.id)(2, 2), builtIn, "the built-in");
        },
      );
    } finally {
      error.mockRestore();
    }
    expect(reported).toEqual([]);
  });

  it("draws with the built-in while its pre-pass doesn't build, blaming no stage", () => {
    const reported: string[] = [];
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      withRenderer(
        { stages: [], pipeline: resolvePipelineFor(BROKEN_PASS.id), onStageQuarantined: (q) => reported.push(q.stageId) },
        (r) => {
          r.setImage(IMAGE);
          const builtIn = frame(r, BUILT_IN)(6, 1);
          frame(r, BROKEN_PASS.id);
          expectNear(frame(r, BROKEN_PASS.id)(6, 1), builtIn, "the built-in");
        },
      );
    } finally {
      error.mockRestore();
    }
    expect(reported).toEqual([]);
  });

  // Only the pre-pass's own pass program, which left the set with it, is built again.
  it("keeps its develop program while the photo switches to another transform and back", () => {
    withRenderer({ stages: [], pipeline: resolvePipelineFor(ROTATE.id) }, (r) => {
      r.setImage(IMAGE);
      frame(r, ROTATE.id);
      frame(r, PLAIN.id);
      const links = vi.spyOn(glHarness().gl, "linkProgram");
      try {
        frame(r, ROTATE.id);
        frame(r, PLAIN.id);
        expect(links).toHaveBeenCalledTimes(ROTATE.prepass?.passes.length ?? 0);
      } finally {
        links.mockRestore();
      }
    });
  });
});
