// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A prepass target the GPU refuses (a result target or the ping-pong pair) is
// reported as an overflowed stage, never drawn into while it holds an older
// image, and not asked for again every frame at the size it was refused at.

import { afterEach, describe, expect, it, vi } from "vitest";
import { CURRENT_PROCESS_VERSION } from "@/catalog/types";
import type { ProcessingStageContribution } from "@/extensions/types";
import type { WebGLRenderer } from "./renderer";
import {
  LINEAR_PROBE_PIPELINE,
  floatImage,
  glHarness,
  identityParams,
  markerStage,
  takingStages,
  withRenderer,
  type Frame,
} from "./webgl.test-support";

const W = 64;
const H = 48;
const SMALL = 32;
const ID = "test.prepass-alloc";
const SCENE = floatImage(W, H, (x, y) => [(x + 1) / 128, (y + 1) / 128, ((x + y) % 16) / 64]);

const STAGE: ProcessingStageContribution = {
  id: ID,
  name: "Prepass alloc",
  phase: "decode",
  glsl: "if (take > 0.5) lin = stageResult;",
  uniforms: [{ key: "take", glslType: "float", default: 0 }],
  passes: [{ uniforms: [{ key: "k", glslType: "float", default: 0.5 }], glsl: "c = vec3(0.9 + k * 0.0001);" }],
};

/** Counts the working-format target allocations (RGBA16F, no pixels: the
 *  ping-pong pair and result targets, in the order a frame makes them), and
 *  refuses those `refused` picks, by size and 1-based count, as a driver
 *  refuses one: with an error, and the texture keeping the image it held.
 *  `apart` runs what must not count (a capture allocates a target of its own). */
function allocations(
  gl: WebGL2RenderingContext,
  refused: (w: number, h: number, count: number) => boolean = () => false,
): { calls: number; refusals: number; apart<T>(run: () => T): T; restore(): void } {
  const { texImage2D } = gl;
  let counting = true;
  const tally = {
    calls: 0,
    refusals: 0,
    apart<T>(run: () => T): T {
      counting = false;
      try {
        return run();
      } finally {
        counting = true;
      }
    },
    restore() {
      gl.texImage2D = texImage2D;
    },
  };
  gl.texImage2D = (...args: unknown[]): void => {
    if (!counting || args[2] !== gl.RGBA16F || args[8] !== null) {
      Reflect.apply(texImage2D, gl, args);
      return;
    }
    tally.calls++;
    const refuse = refused(Number(args[3]), Number(args[4]), tally.calls);
    if (refuse) tally.refusals++;
    // RGBA8 can't take FLOAT texels: INVALID_OPERATION, and no new image.
    Reflect.apply(texImage2D, gl, refuse ? [args[0], args[1], gl.RGBA8, args[3], args[4], 0, gl.RGBA, gl.FLOAT, null] : args);
  };
  return tally;
}

const RESULT_TARGET = 3;

function start(r: WebGLRenderer, maxEdge?: number): void {
  r.setImage(SCENE, maxEdge);
  r.setParams(identityParams({ processVersion: CURRENT_PROCESS_VERSION }));
  r.setContributedParams({ [`${ID}.take`]: 1 });
}

function capture(r: WebGLRenderer): Frame {
  const f = r.captureFloatFrame();
  if (!f) throw new Error("captureFloatFrame returned null");
  return f;
}

/** The pixels showing the stage's result, (r, g, b) all `value`. */
function showing(f: Frame, value: number): number {
  let n = 0;
  for (let i = 0; i < f.data.length; i += 4) {
    if ([0, 1, 2].every((c) => Math.abs(f.data[i + c] - value) < 1e-3)) n++;
  }
  return n;
}

afterEach(() => vi.restoreAllMocks());

describe("a refused prepass result target", () => {
  it("overflows the stage, quarantines nothing, never serves the old image, and isn't asked for again at that size", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { gl } = glHarness();
    const quarantined: string[] = [];
    withRenderer({ stages: [STAGE], pipeline: LINEAR_PROBE_PIPELINE, onStageQuarantined: (q) => quarantined.push(q.stageId) }, (r) => {
      start(r, SMALL);
      const healthy = capture(r);
      const shown = healthy.data[0];
      expect(showing(healthy, shown)).toBe(healthy.width * healthy.height);

      const fault = allocations(gl, (_w, _h, count) => count === RESULT_TARGET);
      try {
        start(r);
        r.render();
        expect(r.overflowedStages).toContain(ID);
        expect(fault.calls).toBe(RESULT_TARGET);
        expect(fault.refusals).toBe(1);
        const refusedFrame = fault.apart(() => capture(r));
        expect(refusedFrame.width).toBe(W);
        expect(showing(refusedFrame, shown)).toBe(0);
        r.render();
        expect(r.overflowedStages).toContain(ID);
        expect(showing(fault.apart(() => capture(r)), shown)).toBe(0);
        expect(fault.calls).toBe(RESULT_TARGET);
      } finally {
        fault.restore();
      }
      expect(quarantined).toEqual([]);
      expect(warn.mock.calls.filter(([m]) => String(m).includes(`'${ID}'`)).length).toBe(1);
    });
  });
});

describe("a result target refused once", () => {
  const refusedOnceAtFullSize = (w: number, _h: number, count: number): boolean => w === W && count === RESULT_TARGET;

  it("is asked for again at that size after one allocated at another", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { gl } = glHarness();
    withRenderer({ stages: [STAGE], pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
      r.setParams(identityParams({ processVersion: CURRENT_PROCESS_VERSION }));
      r.setContributedParams({ [`${ID}.take`]: 1 });
      const fault = allocations(gl, refusedOnceAtFullSize);
      try {
        r.uploadSource("a", SCENE);
        r.render();
        expect(r.overflowedStages).toContain(ID);
        expect(r.bindSource("a", SMALL)).toBe(true);
        r.render();
        expect(r.overflowedStages).toEqual([]);
        const shown = fault.apart(() => capture(r)).data[0];
        expect(r.bindSource("a")).toBe(true);
        r.render();
        expect(r.overflowedStages).toEqual([]);
        const back = fault.apart(() => capture(r));
        expect(back.width).toBe(W);
        expect(showing(back, shown)).toBe(back.width * back.height);
      } finally {
        fault.restore();
      }
    });
  });

  it("is asked for again at that size for a new source", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { gl } = glHarness();
    withRenderer({ stages: [STAGE], pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
      const fault = allocations(gl, refusedOnceAtFullSize);
      try {
        start(r);
        r.render();
        expect(r.overflowedStages).toContain(ID);
        start(r);
        r.render();
        expect(r.overflowedStages).toEqual([]);
      } finally {
        fault.restore();
      }
    });
  });
});

describe("a stage refused a target after it ran out of units", () => {
  it("says it was refused", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { gl } = glHarness();
    const { getParameter } = gl;
    gl.getParameter = (pname: number) =>
      pname === gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS ? 16 : Reflect.apply(getParameter, gl, [pname]);
    const stages = Array.from({ length: 10 }, (_, i) => markerStage(i, 0.02));
    const last = stages[9].id;
    try {
      withRenderer({ stages, pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
        r.setImage(SCENE);
        r.setParams(identityParams({ processVersion: CURRENT_PROCESS_VERSION }));
        r.setContributedParams(takingStages(stages));
        r.render();
        expect(r.overflowedStages).toEqual([last]);
        const fault = allocations(gl, (_w, _h, count) => count === 1);
        try {
          r.setContributedParams(takingStages([stages[9]]));
          r.render();
          expect(fault.refusals).toBe(1);
        } finally {
          fault.restore();
        }
      });
    } finally {
      gl.getParameter = getParameter;
    }
    const said = warn.mock.calls.map(([m]) => String(m)).filter((m) => m.includes(`'${last}'`));
    expect(said.some((m) => m.includes("refused"))).toBe(true);
  });
});

describe("an out-of-memory raised earlier in a frame that allocates prepass targets", () => {
  const TABLE = new Uint8Array([64, 64, 64, 255]);
  const LUT: ProcessingStageContribution = {
    id: "test.prepass-alloc-lut",
    name: "LUT",
    phase: "scene-linear",
    priority: 90,
    glsl: "lin += vec3(texture(table, vec2(0.5)).r * 0.0);",
    uniforms: [],
    textures: [{ key: "table", kind: "lut", width: 1, height: 1, format: "rgba8" }],
  };

  // The table's upload runs out of memory, said only at the next getError.
  function tableUploadOutOfMemory<T>(gl: WebGL2RenderingContext, fn: () => T): T {
    const { texImage2D, getError } = gl;
    let pending = false;
    gl.texImage2D = (...args: unknown[]): void => {
      if (args[8] === TABLE) pending = true;
      Reflect.apply(texImage2D, gl, args);
    };
    gl.getError = (): number => {
      if (!pending) return getError.call(gl);
      pending = false;
      return gl.OUT_OF_MEMORY;
    };
    try {
      return fn();
    } finally {
      gl.texImage2D = texImage2D;
      gl.getError = getError;
    }
  }

  function firstFrame<T>(capture: (r: WebGLRenderer) => T, outOfMemory = true): T {
    const { gl } = glHarness();
    return withRenderer({ stages: [STAGE, LUT], pipeline: LINEAR_PROBE_PIPELINE, processVersionCap: 3 }, (r) => {
      start(r);
      r.setParams(identityParams({ processVersion: 3 }));
      r.setStageTextures({
        [`${LUT.id}.table`]: { data: TABLE, width: 1, height: 1, format: "rgba8", version: 1 },
      });
      return outOfMemory ? tableUploadOutOfMemory(gl, () => capture(r)) : capture(r);
    });
  }

  it("fails a float capture", () => {
    expect(firstFrame((r) => r.captureFloatFrame(), false)).not.toBeNull();
    expect(firstFrame((r) => r.captureFloatFrame())).toBeNull();
  });

  it("fails an export", () => {
    // One target, so the export can't step down to another and draw again.
    expect(firstFrame((r) => r.exportPixels({ targets: ["float32"] }), false)).not.toBeNull();
    expect(firstFrame((r) => r.exportPixels({ targets: ["float32"] }))).toBeNull();
  });
});

describe("a refused ping-pong pair", () => {
  it("overflows the stages that would run, isn't asked for again at that size, and is at another", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { gl } = glHarness();
    withRenderer({ stages: [STAGE], pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
      start(r, SMALL);
      const shown = capture(r).data[0];

      const fault = allocations(gl, (w) => w > 48);
      try {
        start(r);
        r.render();
        expect(r.overflowedStages).toContain(ID);
        const tried = fault.calls;
        expect(tried).toBeGreaterThan(0);
        expect(showing(fault.apart(() => capture(r)), shown)).toBe(0);
        r.render();
        expect(r.overflowedStages).toContain(ID);
        expect(fault.calls).toBe(tried);

        start(r, 40);
        r.render();
        expect(r.overflowedStages).toEqual([]);
        const resized = fault.apart(() => capture(r));
        expect(resized.width).toBe(40);
        expect(showing(resized, shown)).toBe(resized.width * resized.height);
      } finally {
        fault.restore();
      }
    });
  });
});

describe("prepass targets on the healthy path", () => {
  it("allocates the ping-pong pair and the result target once over many frames at one size", () => {
    const { gl } = glHarness();
    const targets = allocations(gl);
    try {
      withRenderer({ stages: [STAGE], pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
        start(r);
        for (let i = 0; i < 6; i++) {
          r.setContributedParams({ [`${ID}.take`]: 1, [`${ID}.k`]: i / 8 });
          r.render();
          expect(r.overflowedStages).toEqual([]);
        }
      });
    } finally {
      targets.restore();
    }
    expect(targets.calls).toBe(RESULT_TARGET);
  });
});
