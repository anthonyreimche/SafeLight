// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// One extension stage whose GLSL doesn't build must not take every frame with
// it: the renderer finds it, draws without it and says which it was. And the
// program cache holds only so many programs, whatever a stage that re-registers
// itself with new GLSL keeps asking for.

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { ProcessingStageContribution } from "@/extensions/types";
import { BUILTIN_RESOLVED } from "./builtin-pipeline";
import { ProgramCache } from "./program-cache";
import type { QuarantinedStage, WebGLRenderer } from "./renderer";
import { V2_VARIANT } from "./shaders";
import { buildStageInjection } from "./stage-injection";
import {
  LINEAR_PROBE_PIPELINE,
  type Frame,
  floatImage,
  glHarness,
  identityParams,
  markerStage,
  pixelAt,
  takingStages,
  trackGlObjects,
  withRenderer,
  worstDifference,
} from "./webgl.test-support";

const GREY = 0.2;

const stage = (id: string, glsl: string): ProcessingStageContribution => ({
  id,
  name: id,
  phase: "scene-linear",
  glsl,
  uniforms: [],
});

const DOUBLE_RED = stage("acme.red", "lin.r *= 2.0;");
const HALVE_BLUE = stage("acme.blue", "lin.b *= 0.5;");
const BROKEN = stage("acme.broken", "lin = lin *;");

function capture(renderer: WebGLRenderer): Frame {
  const frame = renderer.captureFloatFrame();
  if (!frame) throw new Error("captureFloatFrame returned null");
  return frame;
}

let logged: MockInstance<typeof console.error>;
beforeEach(() => {
  logged = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  logged.mockRestore();
});

describe("an extension stage whose GLSL doesn't build", () => {
  function drawing(
    stages: ProcessingStageContribution[],
    fn: (renderer: WebGLRenderer, reported: QuarantinedStage[]) => void,
  ): void {
    const reported: QuarantinedStage[] = [];
    withRenderer(
      { stages, pipeline: LINEAR_PROBE_PIPELINE, onStageQuarantined: (q) => reported.push(q) },
      (renderer) => {
        renderer.setImage(floatImage(16, 16, () => [GREY, GREY, GREY]));
        renderer.setParams(identityParams());
        fn(renderer, reported);
      },
    );
  }

  it("is left out of the frame, which draws the stages that build, and is reported by id", () => {
    drawing([DOUBLE_RED, BROKEN, HALVE_BLUE], (renderer, reported) => {
      const [r, g, b] = pixelAt(capture(renderer), 8, 8);
      expect(r).toBeCloseTo(GREY * 2, 2);
      expect(g).toBeCloseTo(GREY, 2);
      expect(b).toBeCloseTo(GREY / 2, 2);
      expect(reported.map((q) => q.stageId)).toEqual(["acme.broken"]);
      expect(reported[0].log).toMatch(/error/i);
    });
  });

  it("is not built or reported again on the frames after", () => {
    const tally = trackGlObjects(glHarness().gl);
    try {
      drawing([DOUBLE_RED, BROKEN], (renderer, reported) => {
        capture(renderer);
        const compiled = tally.created.shader;
        capture(renderer);
        renderer.setParams(identityParams({ exposure: 0.5 }));
        capture(renderer);
        expect(tally.created.shader).toBe(compiled);
        expect(reported).toHaveLength(1);
      });
    } finally {
      tally.restore();
    }
  });

  it("is built again once it is registered with other GLSL", () => {
    drawing([DOUBLE_RED, BROKEN], (renderer, reported) => {
      capture(renderer);
      renderer.setStages([DOUBLE_RED, { ...BROKEN, glsl: "lin.g *= 3.0;" }]);
      const [r, g] = pixelAt(capture(renderer), 8, 8);
      expect(r).toBeCloseTo(GREY * 2, 2);
      expect(g).toBeCloseTo(GREY * 3, 2);
      expect(reported).toHaveLength(1);
    });
  });

  // A context lost partway fails every build after, so none of those is a fact
  // about a stage: nothing is quarantined, and nothing failed is remembered.
  describe("on a context lost while the stage is looked for", () => {
    /** From the `after`th program link on, the context reads as lost and every
     *  shader as failing to compile, as a lost context's do. */
    function losingContext(after: number): { restore(): void } {
      const { gl } = glHarness();
      const original = {
        linkProgram: gl.linkProgram,
        getShaderParameter: gl.getShaderParameter,
        isContextLost: gl.isContextLost,
      };
      let links = 0;
      let lost = after === 0;
      gl.linkProgram = (program: WebGLProgram) => {
        original.linkProgram.call(gl, program);
        if (++links >= after) lost = true;
      };
      gl.getShaderParameter = (shader: WebGLShader, pname: number) =>
        lost && pname === gl.COMPILE_STATUS ? false : original.getShaderParameter.call(gl, shader, pname);
      gl.isContextLost = () => lost || original.isContextLost.call(gl);
      return {
        restore() {
          Object.assign(gl, original);
        },
      };
    }

    it.each([
      ["from the start", 0],
      ["after the stock build", 1],
    ])("quarantines nothing %s, and builds the stage set again once it is back", (_, after) => {
      drawing([DOUBLE_RED, BROKEN], (renderer, reported) => {
        const losing = losingContext(after);
        try {
          expect(() => capture(renderer)).toThrow();
          expect(reported).toEqual([]);
        } finally {
          losing.restore();
        }
        expect(pixelAt(capture(renderer), 8, 8)[0]).toBeCloseTo(GREY * 2, 2);
        expect(reported.map((q) => q.stageId)).toEqual(["acme.broken"]);
      });
    });
  });

  // Two stages that build alone and fail together, as a set past the GPU's limits
  // does: the later one is quarantined, and tried again once the set is smaller.
  it("is tried again when the stage set loses a stage", () => {
    const { gl } = glHarness();
    const original = { shaderSource: gl.shaderSource, getShaderParameter: gl.getShaderParameter };
    const together = new WeakSet<WebGLShader>();
    gl.shaderSource = (shader: WebGLShader, src: string) => {
      if (src.includes("lin.r *= 2.0") && src.includes("lin.b *= 0.5")) together.add(shader);
      original.shaderSource.call(gl, shader, src);
    };
    gl.getShaderParameter = (shader: WebGLShader, pname: number) =>
      pname === gl.COMPILE_STATUS && together.has(shader) ? false : original.getShaderParameter.call(gl, shader, pname);
    try {
      drawing([DOUBLE_RED, HALVE_BLUE], (renderer, reported) => {
        const [r, , b] = pixelAt(capture(renderer), 8, 8);
        expect(r).toBeCloseTo(GREY * 2, 2);
        expect(b).toBeCloseTo(GREY, 2);
        expect(reported.map((q) => q.stageId)).toEqual(["acme.blue"]);

        renderer.setStages([HALVE_BLUE]);
        expect(pixelAt(capture(renderer), 8, 8)[2]).toBeCloseTo(GREY / 2, 2);
      });
    } finally {
      Object.assign(gl, original);
    }
  });

  // Version 1 has no shared result array, so a sampler per stage on top of the
  // develop shader's own can pass what a GPU allows one shader: every stage
  // builds alone, and the set doesn't. Those past the limit are left out, once.
  it("draws a version 1 photo whose stages pass the sampler limit without those past it", () => {
    const limit = 12;
    const { gl } = glHarness();
    const original = { shaderSource: gl.shaderSource, getShaderParameter: gl.getShaderParameter };
    const over = new WeakSet<WebGLShader>();
    gl.shaderSource = (shader: WebGLShader, src: string) => {
      if ((src.match(/\buniform\s+(?:\w+\s+)?sampler/g) ?? []).length > limit) over.add(shader);
      original.shaderSource.call(gl, shader, src);
    };
    gl.getShaderParameter = (shader: WebGLShader, pname: number) =>
      pname === gl.COMPILE_STATUS && over.has(shader) ? false : original.getShaderParameter.call(gl, shader, pname);
    const step = 0.02;
    const stages = Array.from({ length: 10 }, (_, i) => markerStage(i, step));
    try {
      drawing(stages, (renderer, reported) => {
        const idle = pixelAt(capture(renderer), 8, 8)[1];
        renderer.setContributedParams(takingStages(stages));
        const lit = pixelAt(capture(renderer), 8, 8)[1];
        const kept = stages.length - reported.length;
        expect(reported.length).toBeGreaterThan(0);
        expect(reported.map((q) => q.stageId)).toEqual(stages.slice(kept).map((s) => s.id));
        expect(Math.round((lit - idle) / step)).toBe(kept);
        const failed = reported.length;
        renderer.setParams(identityParams({ exposure: 0.5 }));
        capture(renderer);
        expect(reported).toHaveLength(failed);
      });
    } finally {
      Object.assign(gl, original);
    }
  });

  it("still fails the frame when the program can't be built without any extension stage", () => {
    const { gl } = glHarness();
    const getShaderParameter = gl.getShaderParameter;
    gl.getShaderParameter = (shader: WebGLShader, pname: number) =>
      pname === gl.COMPILE_STATUS ? false : getShaderParameter.call(gl, shader, pname);
    try {
      drawing([DOUBLE_RED, BROKEN], (renderer, reported) => {
        expect(() => capture(renderer)).toThrow(/compile failed/);
        expect(reported).toEqual([]);
      });
    } finally {
      gl.getShaderParameter = getShaderParameter;
    }
  });
});

// A stage whose pass doesn't build has no result for its inline glsl to read:
// read anyway, the raw source stands in for it (a glow at Amount 0.5 lifts the
// frame by half). The stage is left out of the frame instead, and reported.
describe("an extension stage whose pass doesn't build", () => {
  const GLOW: ProcessingStageContribution = {
    ...stage("acme.glow", "lin += stageResult * amount;"),
    uniforms: [{ key: "amount", glslType: "float", default: 0 }],
    passes: [{ glsl: "c = c *;" }],
  };
  const BAG = { "acme.glow.amount": 0.5 };

  function frames(stages: ProcessingStageContribution[], processVersion: number, bag: Record<string, unknown>) {
    const reported: QuarantinedStage[] = [];
    const shots = withRenderer(
      { stages, pipeline: LINEAR_PROBE_PIPELINE, onStageQuarantined: (q) => reported.push(q) },
      (renderer) => {
        renderer.setImage(floatImage(16, 16, (x, y) => [0.1 + x / 64, 0.1 + y / 64, GREY]));
        renderer.setParams(identityParams({ processVersion }));
        renderer.setContributedParams(bag);
        const first = capture(renderer);
        renderer.setParams(identityParams({ processVersion, exposure: 0.5 }));
        capture(renderer);
        return { first, later: capture(renderer) };
      },
    );
    return { ...shots, reported };
  }

  it.each([1, 2])("draws a version %i frame as if the stage weren't there, and reports it once", (version) => {
    const failing = frames([DOUBLE_RED, GLOW], version, BAG);
    const without = frames([DOUBLE_RED], version, {});
    expect(worstDifference(failing.first, without.first)).toBe(0);
    expect(worstDifference(failing.later, without.later)).toBe(0);
    expect(failing.reported.map((q) => q.stageId)).toEqual(["acme.glow"]);
    expect(failing.reported[0].log).toMatch(/compile failed/);
  });
});

describe("the program cache", () => {
  const injection = (s: ProcessingStageContribution) => buildStageInjection([s], V2_VARIANT);
  const build = (cache: ProgramCache, s: ProcessingStageContribution) =>
    cache.entryFor(BUILTIN_RESOLVED, injection(s), V2_VARIANT, new Set([s.id]));
  const variant = (n: number) => stage("acme.film", `lin *= ${n}.0;`);

  it("deletes the least recently used program beyond its cap", () => {
    const { gl } = glHarness();
    const cache = new ProgramCache(gl, 2);
    try {
      const one = build(cache, variant(1));
      const two = build(cache, variant(2));
      expect(build(cache, variant(1))).toBe(one);
      const three = build(cache, variant(3));
      expect(gl.isProgram(two.program)).toBe(false);
      expect(gl.isProgram(one.program)).toBe(true);
      expect(gl.isProgram(three.program)).toBe(true);
    } finally {
      cache.dispose();
    }
  });

  it("never deletes the program in use", () => {
    const { gl } = glHarness();
    const cache = new ProgramCache(gl, 1);
    try {
      const current = build(cache, variant(1));
      cache.setCurrent(current);
      const next = build(cache, variant(2));
      expect(gl.isProgram(current.program)).toBe(true);
      expect(gl.isProgram(next.program)).toBe(true);
      cache.setCurrent(next);
      build(cache, variant(3));
      expect(gl.isProgram(current.program)).toBe(false);
      expect(gl.isProgram(next.program)).toBe(true);
    } finally {
      cache.dispose();
    }
  });

  it("warns once of a stage built under many signatures within a minute", () => {
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cache = new ProgramCache(glHarness().gl, 2);
    try {
      for (let n = 1; n <= 10; n++) build(cache, variant(n));
      expect(warned).toHaveBeenCalledTimes(1);
      expect(String(warned.mock.calls[0][0])).toContain("acme.film");
    } finally {
      cache.dispose();
      warned.mockRestore();
    }
  });
});
