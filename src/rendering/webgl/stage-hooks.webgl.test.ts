// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Two stage-framework hooks on the real renderer: inter-stage variables carry
// a producer's value per pixel to a later stage in the same draw, and a pass
// can take its draw count from the bag each frame.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ProcessingStageContribution } from "@/extensions/types";
import type { WebGLRenderer } from "./renderer";
import { LINEAR_PROBE_PIPELINE, floatImage, identityParams, pixelAt, withRenderer } from "./webgl.test-support";

const BASE = 0.1;
const SOURCE = floatImage(8, 8, (x) => [BASE, 0.05 + x / 32, BASE]);

function draw<T>(stages: ProcessingStageContribution[], fn: (r: WebGLRenderer) => T): T {
  return withRenderer({ stages, pipeline: LINEAR_PROBE_PIPELINE }, (renderer) => {
    renderer.setImage(SOURCE);
    renderer.setParams(identityParams());
    return fn(renderer);
  });
}

const red = (r: WebGLRenderer, x: number): number => pixelAt(r.captureFloatFrame()!, x, 4)[0];

describe("inter-stage variables", () => {
  afterEach(() => vi.restoreAllMocks());

  const producer: ProcessingStageContribution = {
    id: "isv-maker.test",
    name: "Maker",
    phase: "scene-linear",
    glsl: "float made = lin.g;",
    uniforms: [],
    produces: [{ name: "hookMade", glslType: "float", producer: "made" }],
  };
  const consumer: ProcessingStageContribution = {
    id: "isv-reader.test",
    name: "Reader",
    phase: "output-encode",
    priority: 100000,
    glsl: "c = vec3(isv_hookMade);",
    uniforms: [],
    consumes: ["hookMade"],
  };

  it("hands a scene-linear value per pixel to an output-encode stage", () => {
    draw([producer, consumer], (r) => {
      for (const x of [0, 3, 7]) expect(red(r, x)).toBeCloseTo(0.05 + x / 32, 3);
    });
  });

  it("reads zero in a consumer ordered ahead of its producer", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const early: ProcessingStageContribution = {
      id: "isv-early.test",
      name: "Early",
      phase: "scene-linear",
      priority: 5,
      glsl: "lin = vec3(isv_hookLate);",
      uniforms: [],
      consumes: ["hookLate"],
    };
    const late: ProcessingStageContribution = {
      id: "isv-late.test",
      name: "Late",
      phase: "scene-linear",
      priority: 50,
      glsl: "",
      uniforms: [],
      produces: [{ name: "hookLate", glslType: "float", producer: "0.5" }],
    };
    draw([early, late], (r) => expect(red(r, 3)).toBe(0));
  });

  it("renders without a consumer whose producer is missing", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const bare = draw([], (r) => red(r, 3));
    draw([consumer], (r) => expect(red(r, 3)).toBe(bare));
  });
});

describe("bag-driven pass draw counts", () => {
  const STEP = 1 / 64;
  const counted = (over: Partial<ProcessingStageContribution> = {}): ProcessingStageContribution => ({
    id: "count-hook.test",
    name: "Counted",
    phase: "scene-linear",
    glsl: "if (draws > 0.5) lin = stageResult;",
    uniforms: [
      { key: "draws", glslType: "float", default: 0 },
      { key: "take", glslType: "float", default: 0 },
    ],
    passes: [{ glsl: `c += vec3(${STEP});`, iterations: { key: "draws", max: 8 } }],
    ...over,
  });
  const key = (k: string) => `count-hook.test.${k}`;

  // The probe pipeline reads the plain source a little under BASE, so steps are
  // counted from the same pixel with no stage in the program.
  let plain = BASE;
  beforeAll(() => {
    plain = draw([], (r) => red(r, 3));
  });

  /** The steps the frame shows over the plain source, and the pass and split draws it took. */
  function frame(r: WebGLRenderer, bag: Record<string, unknown>) {
    const before = r.renderDrawCounts;
    r.setContributedParams(bag);
    const value = red(r, 3);
    const after = r.renderDrawCounts;
    return {
      steps: Math.round((value - plain) / STEP),
      draws: after.pass - before.pass,
      splits: after.split - before.split,
    };
  }

  it("draws the count the bag holds", () => {
    draw([counted()], (r) => expect(frame(r, { [key("draws")]: 3 })).toMatchObject({ steps: 3, draws: 3 }));
  });

  it("draws again when the count changes, and not while it holds", () => {
    draw([counted()], (r) => {
      expect(frame(r, { [key("draws")]: 3 }).draws).toBe(3);
      expect(frame(r, { [key("draws")]: 3 }).draws).toBe(0);
      expect(frame(r, { [key("draws")]: 5 })).toMatchObject({ steps: 5, draws: 5 });
    });
  });

  it("rounds a fractional count and clamps it to max", () => {
    draw([counted()], (r) => {
      expect(frame(r, { [key("draws")]: 2.6 })).toMatchObject({ steps: 3, draws: 3 });
      expect(frame(r, { [key("draws")]: 20 })).toMatchObject({ steps: 8, draws: 8 });
    });
  });

  it("uses the uniform's default while the bag has no count", () => {
    const stage = counted({
      uniforms: [
        { key: "draws", glslType: "float", default: 2 },
        { key: "take", glslType: "float", default: 0 },
      ],
    });
    draw([stage], (r) => expect(frame(r, { [key("take")]: 1 })).toMatchObject({ steps: 2, draws: 2 }));
  });

  it("runs nothing, not even the split, while the count is 0", () => {
    draw([counted({ reads: "current" })], (r) => {
      expect(frame(r, { [key("take")]: 1, [key("draws")]: 0 })).toEqual({ steps: 0, draws: 0, splits: 0 });
    });
  });

  it("draws the split with the passes once the count is positive", () => {
    draw([counted({ reads: "current" })], (r) => {
      expect(frame(r, { [key("take")]: 1, [key("draws")]: 2 })).toEqual({ steps: 2, draws: 2, splits: 1 });
    });
  });
});
