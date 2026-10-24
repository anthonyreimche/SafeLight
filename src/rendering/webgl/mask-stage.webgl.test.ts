// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Extension stages inside masks, on the real renderer: a maskable stage runs
// again for each mask whose bag holds its keys, with that mask's values, only
// where the mask covers. Spatial stages run their passes per mask, at most
// LIVE_MASK_COPY_PREPASSES of them in a frame drawn to the canvas.

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CURRENT_PROCESS_VERSION,
  LEGACY_PROCESS_VERSION,
  defaultMaskAdjustments,
  type Mask,
  type MaskComponent,
} from "@/catalog/types";
import type { ProcessingStageContribution, UniformDeclaration } from "@/extensions/types";
import { LIVE_MASK_COPY_PREPASSES } from "./mask-stage-instances";
import type { WebGLRenderer, WebGLRendererOpts } from "./renderer";
import {
  LINEAR_PROBE_PIPELINE,
  floatImage,
  glHarness,
  identityParams,
  pixelAt,
  withRenderer,
} from "./webgl.test-support";

const BASE = 0.1;
const SOURCE = floatImage(8, 8, () => [BASE, BASE, BASE]);
// Columns 0-3 sit left of the gradient's step at u = 0.5, columns 4-7 right of it.
const OUTSIDE = 1;
const INSIDE = 6;

const linear = (id: string, x0: number): MaskComponent => ({
  id,
  kind: "linear",
  mode: "add",
  invert: false,
  linear: { x0, y0: 0, x1: x0 + 1e-4, y1: 0 },
});
/** Covers the right half of the frame. */
const RIGHT_HALF = linear("right", 0.5);
/** Covers the whole frame. */
const EVERYWHERE = linear("all", -1);

const mask = (id: string, bag: Record<string, unknown>, over: Partial<Mask> = {}): Mask => ({
  id,
  name: id,
  visible: true,
  invert: false,
  opacity: 100,
  adj: defaultMaskAdjustments(),
  panels: [],
  components: [RIGHT_HALF],
  bag,
  ...over,
});

const GAIN: ProcessingStageContribution = {
  id: "mask-gain.test",
  name: "Gain",
  phase: "scene-linear",
  glsl: "lin *= gain;",
  uniforms: [{ key: "gain", glslType: "float", default: 1 }],
  mask: { maskable: true },
};
const gain = (value: number) => ({ "mask-gain.test.gain": value });

interface Scene {
  masks?: Mask[];
  bag?: Record<string, unknown>;
  processVersion?: number;
}

function draw<T>(
  stages: ProcessingStageContribution[],
  scene: Scene,
  fn: (r: WebGLRenderer) => T,
  opts: WebGLRendererOpts = {},
): T {
  return withRenderer({ stages, pipeline: LINEAR_PROBE_PIPELINE, ...opts }, (renderer) => {
    renderer.setImage(SOURCE);
    renderer.setContributedParams(scene.bag ?? {});
    renderer.setParams(
      identityParams({
        masks: scene.masks ?? [],
        processVersion: scene.processVersion ?? CURRENT_PROCESS_VERSION,
      }),
    );
    return fn(renderer);
  });
}

const red = (r: WebGLRenderer, x: number): number => pixelAt(r.captureFloatFrame()!, x, 4)[0];

// The probe pipeline reads the plain source a little off BASE; every value is
// measured against the same pixel with nothing applied. Renderers share one
// context, so this is read before any test builds its own.
const PLAIN: Record<number, number> = {};
let PLAIN_V1 = 0;
beforeAll(() => {
  draw([], {}, (r) => {
    for (const x of [OUTSIDE, INSIDE]) PLAIN[x] = red(r, x);
  });
  draw([], { processVersion: LEGACY_PROCESS_VERSION }, (r) => {
    PLAIN_V1 = red(r, INSIDE);
  });
});
const plain = (x: number): number => PLAIN[x];

describe("a maskable stage in a mask", () => {
  afterEach(() => vi.restoreAllMocks());

  it("applies the mask's values where the mask covers, and nowhere else", () => {
    draw([GAIN], { masks: [mask("m", gain(2))] }, (r) => {
      expect(red(r, OUTSIDE)).toBeCloseTo(plain(OUTSIDE), 4);
      expect(red(r, INSIDE)).toBeCloseTo(2 * plain(INSIDE), 3);
    });
  });

  it("runs after the stage itself, which still follows the photo's bag", () => {
    draw([GAIN], { masks: [mask("m", gain(2))], bag: gain(3) }, (r) => {
      expect(red(r, OUTSIDE)).toBeCloseTo(3 * plain(OUTSIDE), 3);
      expect(red(r, INSIDE)).toBeCloseTo(6 * plain(INSIDE), 3);
    });
  });

  it("chains the copies of masks that overlap", () => {
    const masks = [mask("a", gain(2)), mask("b", gain(1.5))];
    draw([GAIN], { masks }, (r) => expect(red(r, INSIDE)).toBeCloseTo(3 * plain(INSIDE), 3));
  });

  it("follows its mask when the masks are reordered", () => {
    const left = mask("left", {}, { components: [{ ...RIGHT_HALF, invert: true }] });
    const right = mask("right", gain(2));
    draw([GAIN], { masks: [left, right] }, (r) => {
      expect(red(r, OUTSIDE)).toBeCloseTo(plain(OUTSIDE), 4);
      expect(red(r, INSIDE)).toBeCloseTo(2 * plain(INSIDE), 3);
    });
  });

  it("blends by the mask's opacity", () => {
    draw([GAIN], { masks: [mask("m", gain(2), { opacity: 50 })] }, (r) => {
      expect(red(r, INSIDE)).toBeCloseTo(1.5 * plain(INSIDE), 3);
    });
  });

  it("applies nothing while the mask is hidden", () => {
    draw([GAIN], { masks: [mask("m", gain(2), { visible: false })] }, (r) => {
      expect(red(r, INSIDE)).toBeCloseTo(plain(INSIDE), 4);
    });
  });

  it("applies nothing on a version 1 photo", () => {
    const v1 = { masks: [mask("m", gain(2))], processVersion: LEGACY_PROCESS_VERSION };
    draw([GAIN], v1, (r) => expect(red(r, INSIDE)).toBeCloseTo(PLAIN_V1, 4));
  });

  it("runs no copy of a stage that didn't opt in", () => {
    const plainStage = { ...GAIN, mask: undefined };
    draw([plainStage], { masks: [mask("m", gain(2))] }, (r) => {
      expect(red(r, INSIDE)).toBeCloseTo(plain(INSIDE), 4);
    });
  });
});

// A display stage that declares no space is handed clipped values on version 2.
// Its mask copy clips only the pixels its mask covers: past white, the stage's
// own output must survive outside the mask, which a halving stage at the end
// brings back under white to read.
describe("a display stage without a space in a mask", () => {
  const ADD: ProcessingStageContribution = {
    id: "mask-add.test",
    name: "Add",
    phase: "effects",
    glsl: "c += vec3(add);",
    uniforms: [{ key: "add", glslType: "float", default: 0 }],
    mask: { maskable: true },
  };
  const HALVE: ProcessingStageContribution = {
    id: "mask-halve.test",
    name: "Halve",
    phase: "output-encode",
    priority: 100000,
    glsl: "c *= 0.5;",
    uniforms: [],
    space: { encoding: "perceptual" },
  };
  const add = (value: number) => ({ "mask-add.test.add": value });

  it("clips only inside its mask, leaving the stage's output past white elsewhere", () => {
    const photo = draw([ADD, HALVE], { bag: add(1.2) }, (r) => red(r, OUTSIDE));
    // The positive control: the pixel the stage takes past white survives
    // halving above where white would land.
    expect(photo).toBeGreaterThan(0.5 + 0.05);
    draw([ADD, HALVE], { bag: add(1.2), masks: [mask("m", add(0.25))] }, (r) => {
      expect(red(r, OUTSIDE)).toBeCloseTo(photo, 3);
      expect(red(r, INSIDE)).not.toBeCloseTo(photo, 2);
    });
  });
});

describe("a spatial stage in a mask", () => {
  const LEVEL: UniformDeclaration = { key: "level", glslType: "float", default: 0 };
  // Its pass writes `level`; the inline adds the result wherever take is on.
  const LEVELLED: ProcessingStageContribution = {
    id: "mask-level.test",
    name: "Level",
    phase: "scene-linear",
    glsl: "if (take > 0.5) lin += stageResult;",
    uniforms: [{ key: "take", glslType: "float", default: 0 }],
    passes: [{ glsl: "c = vec3(level);", uniforms: [LEVEL] }],
    mask: { maskable: true },
  };
  const level = (value: number) => ({ "mask-level.test.take": 1, "mask-level.test.level": value });

  it("runs the passes with the mask's values", () => {
    draw([LEVELLED], { masks: [mask("m", level(0.25))], bag: level(0.125) }, (r) => {
      expect(red(r, OUTSIDE)).toBeCloseTo(plain(OUTSIDE) + 0.125, 3);
      expect(red(r, INSIDE)).toBeCloseTo(plain(INSIDE) + 0.375, 3);
    });
  });

  it("runs the passes for a mask while the stage itself is off", () => {
    draw([LEVELLED], { masks: [mask("m", level(0.25))] }, (r) => {
      expect(red(r, OUTSIDE)).toBeCloseTo(plain(OUTSIDE), 3);
      expect(red(r, INSIDE)).toBeCloseTo(plain(INSIDE) + 0.25, 3);
    });
  });

  it("runs no passes for a hidden mask", () => {
    draw([LEVELLED], { masks: [mask("m", level(0.25), { visible: false })] }, (r) => {
      const before = r.renderDrawCounts.pass;
      red(r, INSIDE);
      expect(r.renderDrawCounts.pass - before).toBe(0);
    });
  });

  describe("in more masks than a canvas frame runs", () => {
    const STEP = 1 / 64;
    const masks = Array.from({ length: LIVE_MASK_COPY_PREPASSES + 2 }, (_, i) =>
      mask(`m${i}`, level(STEP), { components: [EVERYWHERE] }),
    );
    const live = { maskCopyPrepassesPerFrame: LIVE_MASK_COPY_PREPASSES };

    /** The pass draws one canvas frame takes, and whether it left any for the next. */
    function canvasFrame(r: WebGLRenderer) {
      const before = r.renderDrawCounts.pass;
      r.render();
      return { draws: r.renderDrawCounts.pass - before, pending: r.prepassPending };
    }

    it("runs the first ones' passes and leaves the rest to the frames after", () => {
      draw([LEVELLED], { masks }, (r) => {
        expect(canvasFrame(r)).toEqual({ draws: LIVE_MASK_COPY_PREPASSES, pending: true });
        expect(canvasFrame(r)).toEqual({ draws: 2, pending: false });
        expect(canvasFrame(r)).toEqual({ draws: 0, pending: false });
      }, live);
    });

    it("shows the ones it put off only once their passes have run", () => {
      draw([LEVELLED], { masks }, (r) => {
        const first = canvasFrame(r);
        expect(first.pending).toBe(true);
        // A capture is never put off: it runs the remaining passes and shows all.
        expect(red(r, INSIDE)).toBeCloseTo(plain(INSIDE) + masks.length * STEP, 3);
      }, live);
    });

    it("runs every mask's passes in one frame without a limit", () => {
      draw([LEVELLED], { masks }, (r) => {
        expect(canvasFrame(r)).toEqual({ draws: masks.length, pending: false });
      });
    });
  });
});

describe("more mask copies than the GPU holds", () => {
  afterEach(() => vi.restoreAllMocks());

  // A quarter of the context's fragment uniform vectors: the stage alone fits
  // beside the core's own uniforms, but not once per mask in eight masks.
  const heavy = (): ProcessingStageContribution => {
    const { gl } = glHarness();
    const count = Math.floor(gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS) / 4);
    const keys = Array.from({ length: count }, (_, i) => `k${i}`);
    return {
      id: "mask-heavy.test",
      name: "Heavy",
      phase: "scene-linear",
      // One statement per key: a single sum of them all is "too complex" to compile.
      glsl: ["vec4 sum = vec4(0.0);", ...keys.map((k) => `sum += ${k};`), "lin = lin * gain + sum.xyz * 0.0001;"].join(
        "\n",
      ),
      uniforms: [
        { key: "gain", glslType: "float", default: 1 },
        ...keys.map((key): UniformDeclaration => ({ key, glslType: "vec4", default: [0, 0, 0, 0] })),
      ],
      mask: { maskable: true },
    };
  };
  const masks = Array.from({ length: 8 }, (_, i) => mask(`m${i}`, { "mask-heavy.test.gain": 2 }));

  it("draws without the copies and names them as overflowed", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    draw([heavy()], { masks, bag: { "mask-heavy.test.gain": 3 } }, (r) => {
      expect(red(r, INSIDE)).toBeCloseTo(3 * plain(INSIDE), 3);
      expect(r.overflowedStages).toContain("mask-heavy.test@0");
      expect(r.overflowedStages).toHaveLength(masks.length);
    });
  });
});
