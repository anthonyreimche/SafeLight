// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A stage whose shaders build can still draw so long that the driver resets.
// The first draws of a stage at a cost the renderer hasn't drawn it at are said
// before they are issued and once a one-pixel read of what they drew returns,
// so the window can pin a lost context on them (gpu-crash-guard.ts). Every
// later frame at that cost says nothing and reads nothing.

import { afterEach, describe, expect, it } from "vitest";
import type { ProcessingStageContribution } from "@/extensions/types";
import { drawCost } from "./prepass-runner";
import type { StageBuildEvent, WebGLRenderer } from "./renderer";
import { stageKey } from "./stage-injection";
import {
  LINEAR_PROBE_PIPELINE,
  floatImage,
  freshContext,
  glHarness,
  identityParams,
  withRenderer,
} from "./webgl.test-support";

const ID = "acme.passed";
const PASSED: ProcessingStageContribution = {
  id: ID,
  name: "Passed",
  phase: "decode",
  uniforms: [{ key: "n", glslType: "float", default: 1 }],
  passes: [
    {
      glsl: "c = c * 0.5 + vec3(g);",
      iterations: { key: "n", max: 64 },
      uniforms: [{ key: "g", glslType: "float", default: 0.5 }],
    },
  ],
  glsl: "lin = stageResult;",
};
const DOUBLE_RED: ProcessingStageContribution = {
  id: "acme.red",
  name: "Red",
  phase: "scene-linear",
  glsl: "lin.r *= 2.0;",
  uniforms: [],
};

const SMALL = floatImage(8, 8, (x, y) => [x / 8, y / 8, 0.3]);
const LARGE = floatImage(64, 64, (x, y) => [x / 64, y / 64, 0.3]);

type Draw = Extract<StageBuildEvent, { phase: "drawStart" | "drawEnd" }>;
const draws = (events: StageBuildEvent[]): Draw[] =>
  events.filter((e): e is Draw => e.phase === "drawStart" || e.phase === "drawEnd");

interface Frames {
  events: StageBuildEvent[];
  reads: () => number;
  frame: (bag: Record<string, unknown>, image?: typeof SMALL) => { events: Draw[]; reads: number };
}

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});

/** Counts the readPixels calls of `gl` until the test ends. */
function countReads(gl: WebGL2RenderingContext): () => number {
  const readPixels = gl.readPixels;
  let reads = 0;
  gl.readPixels = function (this: WebGL2RenderingContext, ...args: unknown[]) {
    reads++;
    return (readPixels as (...a: unknown[]) => void).apply(this, args);
  } as typeof gl.readPixels;
  restores.push(() => {
    gl.readPixels = readPixels;
  });
  return () => reads;
}

function onRenderer<T>(
  stages: ProcessingStageContribution[],
  fn: (f: Frames, r: WebGLRenderer) => T,
  confirmedDraws?: readonly string[],
): T {
  const events: StageBuildEvent[] = [];
  const reads = countReads(glHarness().gl);
  return withRenderer({ stages, pipeline: LINEAR_PROBE_PIPELINE, onStageBuild: (e) => events.push(e), confirmedDraws }, (r) => {
    let image: typeof SMALL | null = null;
    const frame = (bag: Record<string, unknown>, next = SMALL) => {
      if (image !== next) r.setImage(next);
      image = next;
      r.setContributedParams(bag);
      r.setParams(identityParams());
      const seen = events.length;
      const read = reads();
      r.render();
      return { events: draws(events.slice(seen)), reads: reads() - read };
    };
    return fn({ events, reads, frame }, r);
  });
}

const key = stageKey(PASSED);
const passCost = (image: typeof SMALL, n: number) => drawCost(image.width, image.height, n);

/** The draw events and readPixels calls of the frames `fn` renders, in order. */
function sequence(stages: ProcessingStageContribution[], fn: (r: WebGLRenderer) => void): string[] {
  const { gl } = glHarness();
  const seen: string[] = [];
  const readPixels = gl.readPixels;
  gl.readPixels = function (this: WebGL2RenderingContext, ...args: unknown[]) {
    seen.push("read");
    return (readPixels as (...a: unknown[]) => void).apply(this, args);
  } as typeof gl.readPixels;
  restores.push(() => {
    gl.readPixels = readPixels;
  });
  const onStageBuild = (e: StageBuildEvent) => {
    if (e.phase === "drawStart" || e.phase === "drawEnd") seen.push(e.phase);
  };
  withRenderer({ stages, pipeline: LINEAR_PROBE_PIPELINE, onStageBuild }, (r) => {
    r.setImage(SMALL);
    r.setParams(identityParams());
    fn(r);
  });
  return seen;
}

describe("a prepass stage's first draws at a cost", () => {
  it("are said before and after, with one read between", () => {
    onRenderer([PASSED], ({ frame }) => {
      const first = frame({ [`${ID}.n`]: 4 });
      const cost = passCost(SMALL, 4);
      expect(first.events.slice(0, 2)).toEqual([
        { phase: "drawStart", stages: [key], cost },
        { phase: "drawEnd", stages: [key], cost, drawn: true },
      ]);
      // For the pass and the develop program each: a read that waits out the
      // work before them, and the read of what they drew.
      expect(first.reads).toBe(4);
    });
  });

  it("wait out the work queued before them, so the window holds only their draws", () => {
    const seen = sequence([PASSED], (r) => {
      r.setContributedParams({ [`${ID}.n`]: 4 });
      r.render();
      r.setContributedParams({ [`${ID}.n`]: 4, [`${ID}.g`]: 0.25 });
      r.render();
    });
    expect(seen).toEqual(["read", "drawStart", "read", "drawEnd", "read", "drawStart", "read", "drawEnd"]);
  });

  it("say nothing and read nothing once drawn at that cost", () => {
    onRenderer([PASSED], ({ frame }) => {
      frame({ [`${ID}.n`]: 4, [`${ID}.g`]: 0.25 });
      const again = frame({ [`${ID}.n`]: 4, [`${ID}.g`]: 0.125 });
      expect(again).toEqual({ events: [], reads: 0 });
    });
  });

  it("are said again at a larger size or more draws", () => {
    onRenderer([PASSED], ({ frame }) => {
      frame({ [`${ID}.n`]: 2 });
      const more = frame({ [`${ID}.n`]: 16 });
      expect(more.events.map((e) => [e.phase, e.cost])).toEqual([
        ["drawStart", passCost(SMALL, 16)],
        ["drawEnd", passCost(SMALL, 16)],
      ]);
      const larger = frame({ [`${ID}.n`]: 16 }, LARGE);
      expect(larger.events.filter((e) => e.stages.length === 1 && e.cost === passCost(LARGE, 16))).toHaveLength(2);
      expect(passCost(LARGE, 16)).not.toBe(passCost(SMALL, 16));
    });
  });

  it("say nothing and read nothing at a cost the renderer was told finished before", () => {
    const told = [`${key}|${passCost(SMALL, 4)}`];
    const second = (confirmed?: readonly string[]) =>
      onRenderer(
        [PASSED],
        ({ frame }) => {
          // A frame with the stage idle draws the develop program once.
          frame({ [`${ID}.n`]: 0 });
          return { at: frame({ [`${ID}.n`]: 4 }), larger: frame({ [`${ID}.n`]: 16 }) };
        },
        confirmed,
      );
    expect(second().at.reads).toBe(2);
    const seeded = second(told);
    expect(seeded.at).toEqual({ events: [], reads: 0 });
    expect(seeded.larger.events.map((e) => e.phase)).toEqual(["drawStart", "drawEnd"]);
    expect(seeded.larger.reads).toBe(2);
  });

  it("aren't said to have ended when the context is lost before the read returns", () => {
    const fresh = freshContext();
    const lose = fresh.gl.getExtension("WEBGL_lose_context");
    const events: StageBuildEvent[] = [];
    const readPixels = fresh.gl.readPixels;
    fresh.gl.readPixels = function (this: WebGL2RenderingContext, ...args: unknown[]) {
      if (events.some((e) => e.phase === "drawStart")) lose?.loseContext();
      return (readPixels as (...a: unknown[]) => void).apply(this, args);
    } as typeof fresh.gl.readPixels;
    try {
      withRenderer(
        { stages: [PASSED], pipeline: LINEAR_PROBE_PIPELINE, onStageBuild: (e) => events.push(e) },
        (r) => {
          r.setImage(SMALL);
          r.setContributedParams({ [`${ID}.n`]: 4 });
          r.setParams(identityParams());
          r.render();
        },
        fresh.canvas,
      );
    } finally {
      fresh.gl.readPixels = readPixels;
    }
    expect(fresh.gl.isContextLost()).toBe(true);
    expect(draws(events)).toEqual([{ phase: "drawStart", stages: [key], cost: passCost(SMALL, 4) }]);
  });
});

describe("the develop program's first draw at a size", () => {
  it("is said with the extension stages in it, once", () => {
    onRenderer([DOUBLE_RED, PASSED], ({ frame }) => {
      const developCost = drawCost(SMALL.width, SMALL.height);
      const first = frame({ [`${ID}.n`]: 4, [`${ID}.g`]: 0.25 });
      const develop = first.events.filter((e) => e.cost === developCost);
      expect(develop).toEqual([
        { phase: "drawStart", stages: [stageKey(DOUBLE_RED), key], cost: developCost },
        { phase: "drawEnd", stages: [stageKey(DOUBLE_RED), key], cost: developCost, drawn: true },
      ]);
      expect(frame({ [`${ID}.n`]: 4, [`${ID}.g`]: 0.125 }).events).toEqual([]);
    });
  });

  it("says nothing and reads nothing when every stage in it was told finished at that size", () => {
    const developCost = drawCost(SMALL.width, SMALL.height);
    const told = [`${stageKey(DOUBLE_RED)}|${developCost}`, `${key}|${developCost}`];
    const first = (confirmed?: readonly string[]) =>
      onRenderer([DOUBLE_RED, PASSED], ({ frame }) => frame({ [`${ID}.n`]: 0 }), confirmed);
    expect(first().reads).toBe(2);
    expect(first(told)).toEqual({ events: [], reads: 0 });
    expect(first(told.slice(0, 1)).reads).toBe(2);
  });

  it("leaves nothing pending when it throws", () => {
    const { gl } = glHarness();
    const drawArrays = gl.drawArrays;
    restores.push(() => {
      gl.drawArrays = drawArrays;
    });
    onRenderer([DOUBLE_RED], ({ events }, r) => {
      r.setImage(SMALL);
      r.setParams(identityParams());
      gl.drawArrays = function (this: WebGL2RenderingContext, ...args: unknown[]) {
        if (gl.getParameter(gl.FRAMEBUFFER_BINDING) === null) throw new Error("driver fault");
        return (drawArrays as (...a: unknown[]) => void).apply(this, args);
      } as typeof gl.drawArrays;
      expect(() => r.render()).toThrow("driver fault");
      gl.drawArrays = drawArrays;
      const developCost = drawCost(SMALL.width, SMALL.height);
      expect(draws(events)).toEqual([
        { phase: "drawStart", stages: [stageKey(DOUBLE_RED)], cost: developCost },
        { phase: "drawEnd", stages: [stageKey(DOUBLE_RED)], cost: developCost, drawn: false },
      ]);
      r.render();
      expect(draws(events).slice(2).map((e) => e.phase)).toEqual(["drawStart", "drawEnd"]);
    });
  });

  it("confirms nothing into a target it can't read, and leaves nothing pending", () => {
    const { gl } = glHarness();
    const getParameter = gl.getParameter;
    restores.push(() => {
      gl.getParameter = getParameter;
    });
    onRenderer([DOUBLE_RED], ({ events }, r) => {
      r.setImage(SMALL);
      r.setParams(identityParams());
      gl.getParameter = (pname: number) =>
        pname === gl.IMPLEMENTATION_COLOR_READ_TYPE ? gl.UNSIGNED_INT_2_10_10_10_REV : Reflect.apply(getParameter, gl, [pname]);
      r.captureFloatFrame();
      gl.getParameter = getParameter;
      const developCost = drawCost(SMALL.width, SMALL.height);
      expect(draws(events)).toEqual([
        { phase: "drawStart", stages: [stageKey(DOUBLE_RED)], cost: developCost },
        { phase: "drawEnd", stages: [stageKey(DOUBLE_RED)], cost: developCost, drawn: false },
      ]);
    });
  });

  it("says nothing without extension stages in it", () => {
    onRenderer([], ({ frame }) => {
      expect(frame({})).toEqual({ events: [], reads: 0 });
    });
  });
});
