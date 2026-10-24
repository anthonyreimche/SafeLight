// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Version 3's export draws on the real renderer: the 16-bit target, and output
// sharpening on the signed colour. The RGBA16F source holds 11 bits, too few
// for a ramp finer than RGBA16F's own, so a stage paints the colour the output
// stage receives from each pixel's position instead. The ramp has 30,000 steps
// across [0.5, 1), perceptual like a photo's, in raster order (left to right,
// top row first) over 200 × 150 pixels.

import { describe, expect, it } from "vitest";
import type { ProcessingStageContribution } from "@/extensions/types";
import { applyOutputSharpening } from "@/modules/export/sharpen";
import { OUT_SPACE_CODE, outMatrix, type ColorSpaceId } from "../color-space";
import { outputPixel } from "../output-map";
import type { Vec3 } from "../stage-space";
import {
  exportNorm16Format, quantise16, type ExportPixels, type ExportPixelsOptions, type ExportTarget, type Sharpen,
} from "./export-draw";
import type { WebGLRenderer } from "./renderer";
import {
  OPEN_PROBE, canvasPixels, changedState, differing, drainGlErrors, each, floatImage, glErrorsDuring, glHarness,
  glState, identityParams, liveFrame, measurementViews, outOfMemoryAtFirstDraw, trackGlObjects, withRenderer,
} from "./webgl.test-support";

/** A frame whose output-stage colour `c` an effects stage paints from each
 *  pixel's column and row (`px`, top row 0). */
interface Scene {
  stage: ProcessingStageContribution;
  width: number;
  height: number;
}

function scene(id: string, width: number, height: number, colour: string): Scene {
  return {
    width,
    height,
    stage: {
      id,
      name: id,
      phase: "effects",
      space: { encoding: "perceptual" },
      glsl: `vec2 px = floor(vUv * vec2(${width}.0, ${height}.0));\nc = ${colour};`,
      uniforms: [],
    },
  };
}

const W = 200;
const H = 150;
const STEPS = W * H;
const RAMP = scene("test.ramp", W, H, `vec3(0.5 + 0.5 * (px.y * ${W}.0 + px.x) / ${STEPS}.0)`);

// In range and on the 8-bit grid: five levels from 90/255 to 166/255, in a
// different diagonal pattern per channel. Unsharp mask at amount 100 keeps it
// inside [14, 242]/255, and the 8-bit frame the CPU path sharpens holds `c`
// exactly, so the two paths differ only in how they blur.
const PATTERN: readonly (readonly [number, number])[] = [[7, 13], [3, 5], [1, 2]];
const textureAt = (x: number, y: number): Vec3 => {
  const level = ([a, b]: readonly [number, number]): number => (90 + 19 * ((a * x + b * y) % 5)) / 255;
  return [level(PATTERN[0]), level(PATTERN[1]), level(PATTERN[2])];
};
const TEXTURE = scene(
  "test.texture",
  48,
  32,
  `(90.0 + 19.0 * mod(vec3(${PATTERN.map(([a, b]) => `${a}.0 * px.x + ${b}.0 * px.y`).join(", ")}), 5.0)) / 255.0`,
);
const IN_RANGE: Sharpen = { amount: 100, radius: 1 };

// A step from a bright warm colour to a near-white one. Sharpened at 150 with
// σ = 2 px, the three columns right of the step overshoot white in red at a
// lightness short of white, so the output stage has chroma to give up there.
const BRIGHT: Vec3 = [0.71, 0.5, 0.3];
const NEAR_WHITE: Vec3 = [0.97, 0.76, 0.56];
const STEP_AT = 12;
const EDGE = scene(
  "test.edge",
  24,
  4,
  `px.x < ${STEP_AT}.0 ? vec3(${BRIGHT.join(", ")}) : vec3(${NEAR_WHITE.join(", ")})`,
);
const OVERSHOOT: Sharpen = { amount: 150, radius: 2 };

// Over range in red, which the live view's clipping and gamut warnings paint,
// beside a colour a wide screen or a monitor profile encodes differently.
const VIEWED = scene("test.viewed", 8, 4, "px.x < 4.0 ? vec3(1.2, 0.6, 0.3) : vec3(0.3, 0.6, 0.2)");

/** The Adobe RGB code the output stage makes of ramp step `i`, by the TypeScript twin. */
const twinCode = (i: number): number => {
  const c = 0.5 + (0.5 * i) / STEPS;
  return quantise16(outputPixel([c, c, c], outMatrix("adobe-rgb"), OUT_SPACE_CODE["adobe-rgb"])[0]);
};

function onFrame<T>(
  s: Scene,
  processVersion: number,
  fn: (r: WebGLRenderer) => T,
  space: ColorSpaceId = "srgb",
): T {
  return withRenderer({ stages: [s.stage], pipeline: OPEN_PROBE, processVersionCap: 3 }, (r) => {
    r.setImage(floatImage(s.width, s.height, () => [0.18, 0.18, 0.18]));
    r.setOutputColorSpace(space);
    r.setParams(identityParams({ processVersion }));
    return fn(r);
  });
}

const onRamp = <T>(processVersion: number, fn: (r: WebGLRenderer) => T): T =>
  onFrame(RAMP, processVersion, fn, "adobe-rgb");

function exported(r: WebGLRenderer, opts?: ExportPixelsOptions): ExportPixels {
  const pixels = r.exportPixels(opts);
  if (!pixels) throw new Error("exportPixels returned null");
  return pixels;
}

/** Distinct red codes at or above half scale, where RGBA16F keeps 1,024 values. */
function upperReds(p: ExportPixels): number {
  const codes = new Set<number>();
  for (let i = 0; i < p.data.length; i += 4) if (p.data[i] >= 32768) codes.add(p.data[i]);
  return codes.size;
}

const norm16 = (): boolean => exportNorm16Format(glHarness().gl) !== 0;

/** Today's 8-bit path: the canvas as it stands, sharpened on the CPU, RGBA, top-down. */
function cpuSharpened({ amount, radius }: Sharpen): Uint8ClampedArray {
  const out = applyOutputSharpening(glHarness().canvas, amount, radius);
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("no 2D context");
  return ctx.getImageData(0, 0, out.width, out.height).data;
}

/** A w×h frame sharpened by the unsharp mask in float, top-down: Gaussian taps
 *  out to ceil(3σ), normalised, along x and then y, with the border pixel
 *  repeated past the edge. */
function sharpenedFrame(w: number, h: number, colourAt: (x: number, y: number) => Vec3, { amount, radius }: Sharpen): Vec3[] {
  const reach = Math.ceil(3 * radius);
  const taps = Array.from({ length: 2 * reach + 1 }, (_, i) => Math.exp(-((i - reach) ** 2) / (2 * radius * radius)));
  const total = taps.reduce((a, b) => a + b, 0);
  const frame = (at: (x: number, y: number) => Vec3): Vec3[] =>
    Array.from({ length: w * h }, (_, i) => at(i % w, Math.floor(i / w)));
  const pass = (src: Vec3[], dx: number, dy: number): Vec3[] =>
    frame((x, y) => {
      const sum: [number, number, number] = [0, 0, 0];
      taps.forEach((t, i) => {
        const from = src[Math.min(Math.max(y + dy * (i - reach), 0), h - 1) * w + Math.min(Math.max(x + dx * (i - reach), 0), w - 1)];
        for (let ch = 0; ch < 3; ch++) sum[ch] += (t / total) * from[ch];
      });
      return sum;
    });
  const c = frame(colourAt);
  const blur = pass(pass(c, 1, 0), 0, 1);
  const f = amount / 100;
  return c.map((v, i) => [v[0] + f * (v[0] - blur[i][0]), v[1] + f * (v[1] - blur[i][1]), v[2] + f * (v[2] - blur[i][2])]);
}

const pixel = (px: ArrayLike<number>, i: number): Vec3 => [px[i * 4], px[i * 4 + 1], px[i * 4 + 2]];
const farthest = (a: Vec3, b: Vec3): number => Math.max(...a.map((v, ch) => Math.abs(v - b[ch])));

/** `fn` with each RGBA32F allocation after the first `allowed` refused. */
function refusingFloat32<T>(gl: WebGL2RenderingContext, allowed: number, fn: () => T): T {
  const texImage2D = gl.texImage2D;
  let left = allowed;
  gl.texImage2D = (...args: unknown[]): void => {
    const refused = args[2] === gl.RGBA32F && left-- <= 0;
    // RGBA8 can't take FLOAT texels: INVALID_OPERATION, and no image.
    const refusal = [args[0], args[1], gl.RGBA8, args[3], args[4], 0, gl.RGBA, gl.FLOAT, null];
    Reflect.apply(texImage2D, gl, refused ? refusal : args);
  };
  try {
    return fn();
  } finally {
    gl.texImage2D = texImage2D;
  }
}

describe("version 3's 16-bit export target", () => {
  it("keeps the ramp's steps in a float32 target, top-down, as the twin codes them", () => {
    onRamp(3, (r) => {
      const p = exported(r, { targets: ["float32"] });
      expect([p.target, p.width, p.height]).toEqual(["float32", W, H]);
      let worst = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) worst = Math.max(worst, Math.abs(p.data[(y * W + x) * 4] - twinCode(y * W + x)));
      }
      expect(worst, "worst red code against the twin").toBeLessThanOrEqual(1);
      expect(upperReds(p)).toBeGreaterThanOrEqual(20000);
    });
  });

  // The positive control: the same frame through today's target.
  it("keeps no more than RGBA16F's steps in a float16 target, quantised as today's capture is", () => {
    onRamp(3, (r) => {
      const p = exported(r, { targets: ["float16"] });
      expect(p.target).toBe("float16");
      expect(upperReds(p)).toBeLessThanOrEqual(1100);
      const capture = r.captureFloatFrame();
      if (!capture) throw new Error("captureFloatFrame returned null");
      expect(differing(p.data, Uint16Array.from(capture.data, quantise16))).toBe(0);
    });
  });

  it("reads a norm16 target within a code of the float32 one", (ctx) => {
    if (!norm16()) ctx.skip();
    onRamp(3, (r) => {
      const p = exported(r, { targets: ["norm16"] });
      const f = exported(r, { targets: ["float32"] });
      expect(p.target).toBe("norm16");
      let worst = 0;
      for (let i = 0; i < p.data.length; i++) worst = Math.max(worst, Math.abs(p.data[i] - f.data[i]));
      expect(worst).toBeLessThanOrEqual(1);
    });
  });

  it("steps down past a target the context lacks", () => {
    onRamp(3, (r) => {
      const best = norm16() ? "norm16" : "float32";
      expect(exported(r, { targets: ["norm16", "float32"] }).target).toBe(best);
      expect(exported(r).target).toBe(best);
    });
  });

  // The first framebuffer reads incomplete, as one a driver can't render does.
  it("steps down past a target it can't complete, and frees it", () => {
    const { gl } = glHarness();
    onRamp(3, (r) => {
      const status = gl.checkFramebufferStatus;
      let calls = 0;
      gl.checkFramebufferStatus = (target: number): number =>
        calls++ === 0 ? gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT : status.call(gl, target);
      const tally = trackGlObjects(gl);
      try {
        expect(exported(r, { targets: ["float32", "float16"] }).target).toBe("float16");
        expect([tally.live.texture, tally.live.framebuffer], "textures, framebuffers").toEqual([0, 0]);
      } finally {
        tally.restore();
        gl.checkFramebufferStatus = status;
      }
    });
  });

  // An allocation the driver refuses raises an error and leaves its target
  // incomplete. The error decides the step-down, so none is left behind.
  it("leaves no allocation error behind when no target can be allocated", () => {
    const { gl } = glHarness();
    onRamp(3, (r) => {
      const texImage2D = gl.texImage2D;
      // RGBA8 can't take FLOAT texels: INVALID_OPERATION, and no image.
      gl.texImage2D = (...args: unknown[]): void => {
        Reflect.apply(texImage2D, gl, [args[0], args[1], gl.RGBA8, args[3], args[4], 0, gl.RGBA, gl.FLOAT, null]);
      };
      drainGlErrors(gl);
      try {
        expect(r.exportPixels({ targets: ["float32", "float16"] })).toBeNull();
      } finally {
        gl.texImage2D = texImage2D;
      }
      expect(gl.getError()).toBe(gl.NO_ERROR);
    });
  });

  // Some drivers report running out of memory only at the first draw into a
  // target. The first read-back here is followed by OUT_OF_MEMORY.
  it("steps down past a target the driver runs out of memory on at its first draw", () => {
    const { gl } = glHarness();
    onRamp(3, (r) => {
      const { readPixels, getError } = gl;
      let reads = 0;
      let outOfMemory = false;
      gl.readPixels = (...args: unknown[]): void => {
        if (reads++ === 0) outOfMemory = true;
        Reflect.apply(readPixels, gl, args);
      };
      gl.getError = (): number => {
        if (!outOfMemory) return getError.call(gl);
        outOfMemory = false;
        return gl.OUT_OF_MEMORY;
      };
      try {
        expect(exported(r, { targets: ["float32", "float16"] }).target).toBe("float16");
      } finally {
        gl.readPixels = readPixels;
        gl.getError = getError;
      }
    });
  });

  // Every target reads back into one 8 B/px array, so a frame too large for it
  // is too large for them all.
  it("returns null for a frame too large to read back, and frees its target", () => {
    const { gl } = glHarness();
    onRamp(3, (r) => {
      const readPixels = gl.readPixels;
      gl.readPixels = (): void => {
        throw new RangeError("Array buffer allocation failed");
      };
      const tally = trackGlObjects(gl);
      try {
        expect(r.exportPixels({ targets: ["float32", "float16"] })).toBeNull();
        expect(r.exportPixels({ targets: ["float32", "float16"], sharpen: IN_RANGE })).toBeNull();
        expect([tally.live.texture, tally.live.framebuffer], "textures, framebuffers").toEqual([0, 0]);
      } finally {
        tally.restore();
        gl.readPixels = readPixels;
      }
    });
  });

  // A RangeError from drawing the frame is a fault (a stack overflow, say), not
  // a frame too large to read back.
  it("lets a RangeError from drawing the frame through, and frees its target", () => {
    const { gl } = glHarness();
    onRamp(3, (r) => {
      liveFrame(r);
      const drawArrays = gl.drawArrays;
      gl.drawArrays = (): void => {
        throw new RangeError("Maximum call stack size exceeded");
      };
      const tally = trackGlObjects(gl);
      try {
        expect(() => r.exportPixels({ targets: ["float32", "float16"] })).toThrow(RangeError);
        expect(() => r.exportPixels({ targets: ["float32", "float16"], sharpen: IN_RANGE })).toThrow(RangeError);
        expect([tally.live.texture, tally.live.framebuffer], "textures, framebuffers").toEqual([0, 0]);
      } finally {
        tally.restore();
        gl.drawArrays = drawArrays;
      }
    });
  });

  it("refuses a photo without the signed output stage, and a renderer without a source", () => {
    for (const processVersion of [1, 2]) {
      onRamp(processVersion, (r) => {
        expect(r.signedOutputFor(identityParams({ processVersion })), `version ${processVersion}`).toBe(false);
        expect(r.exportPixels(), `version ${processVersion}`).toBeNull();
      });
    }
    // Under the shipping cap a version 3 photo renders as version 2.
    withRenderer({ stages: [RAMP.stage], pipeline: OPEN_PROBE }, (r) => {
      r.setImage(floatImage(W, H, () => [0.18, 0.18, 0.18]));
      r.setParams(identityParams({ processVersion: 3 }));
      expect(r.signedOutputFor(identityParams({ processVersion: 3 }))).toBe(false);
      expect(r.exportPixels()).toBeNull();
    });
    withRenderer({ stages: [RAMP.stage], pipeline: OPEN_PROBE, processVersionCap: 3 }, (r) => {
      r.setParams(identityParams({ processVersion: 3 }));
      expect(r.signedOutputFor(identityParams({ processVersion: 3 }))).toBe(true);
      expect(r.exportPixels()).toBeNull();
    });
  });

  // computeHistogram and Upright redraw with whatever the last frame left bound.
  it("leaves the live frame, GL state and GL objects as it found them", () => {
    const { gl } = glHarness();
    const draws: [string, (r: WebGLRenderer) => unknown][] = [
      ["16-bit", (r) => exported(r)],
      ["16-bit sharpened", (r) => exported(r, { sharpen: IN_RANGE })],
      ["8-bit sharpened", (r) => expect(r.renderSharpened(IN_RANGE)).toBe(true)],
    ];
    for (const [label, draw] of draws) {
      onRamp(3, (r) => {
        const before = liveFrame(r);
        const histogram = r.computeHistogram(true);
        const state = glState(gl);
        const tally = trackGlObjects(gl);
        let errors: number[] = [];
        try {
          errors = glErrorsDuring(gl, () => draw(r));
          expect([tally.live.texture, tally.live.framebuffer], `${label}: textures, framebuffers`).toEqual([0, 0]);
        } finally {
          tally.restore();
        }
        expect(errors, `${label}: GL errors from the export`).toEqual([]);
        expect(changedState(state, glState(gl)), `${label}: GL state changed`).toEqual([]);
        expect(r.computeHistogram(true), `${label}: a histogram redrawn after it`).toEqual(histogram);
        const after = liveFrame(r);
        expect(gl.getError(), `${label}: GL error in the next frame`).toBe(gl.NO_ERROR);
        expect(differing(after, before), label).toBe(0);
      });
    }
  });

  // A batch export's renderer never shows any of these, but a live one could.
  describe("draws export frames as measurements", () => {
    const exports = (r: WebGLRenderer): ArrayLike<number>[] => {
      const sixteen = exported(r, { targets: ["float32"] }).data;
      const sharpened = exported(r, { targets: ["float32"], sharpen: IN_RANGE }).data;
      expect(r.renderSharpened(IN_RANGE)).toBe(true);
      expect(glHarness().gl.drawingBufferColorSpace, "the canvas's tag after renderSharpened").toBe("srgb");
      return [sixteen, sharpened, canvasPixels()];
    };
    let plainFrames: { live: Uint8Array; exports: ArrayLike<number>[] } | null = null;
    const plain = () => (plainFrames ??= onFrame(VIEWED, 3, (r) => ({ live: liveFrame(r), exports: exports(r) })));
    for (const [label, view] of measurementViews()) {
      it(`without ${label}`, () => {
        const { live, exports: measured } = plain();
        onFrame(VIEWED, 3, (r) => {
          view(r);
          expect(differing(liveFrame(r), live), "the live frame shows it").toBeGreaterThan(0);
          const viewed = exports(r);
          ["16-bit", "16-bit sharpened", "8-bit sharpened"].forEach((kind, i) => {
            expect(differing(viewed[i], measured[i]), kind).toBe(0);
          });
        });
      });
    }
  });
});

describe("version 3's output sharpening", () => {
  // The CPU path blurs with CSS blur(), which this rig's software canvas
  // approximates with three box passes: at σ = 1 px the kernel [1, 3, 4, 3, 1]
  // / 12, read from its impulse response, against the Gaussian's seven taps.
  // It also reads past the frame as transparent where the GPU repeats the
  // border texel. On this scene the two paths differ by up to 3 codes three or
  // more pixels from the edge, and by 13 at the corner (x 47, y 0, red). So the
  // GPU is held to the float unsharp mask within an 8-bit step everywhere, and
  // to the CPU path within those 3 codes where neither blur reaches the edge.
  it("sharpens an in-range frame as the float unsharp mask does, and as the CPU path does inside the edge", () => {
    onFrame(TEXTURE, 3, (r) => {
      r.render();
      const cpu = cpuSharpened(IN_RANGE);
      expect(r.renderSharpened(IN_RANGE)).toBe(true);
      const gpu = canvasPixels();
      const { width, height } = TEXTURE;
      const reach = Math.ceil(3 * IN_RANGE.radius);
      let toTwin = 0;
      let toCpu = 0;
      sharpenedFrame(width, height, textureAt, IN_RANGE).forEach((want, i) => {
        toTwin = Math.max(toTwin, farthest(pixel(gpu, i), each(want, (v) => v * 255)));
        const [x, y] = [i % width, Math.floor(i / width)];
        if (Math.min(x, y, width - 1 - x, height - 1 - y) >= reach) toCpu = Math.max(toCpu, farthest(pixel(gpu, i), pixel(cpu, i)));
      });
      expect(toTwin, "against the float unsharp mask").toBeLessThanOrEqual(1);
      expect(toCpu, "against the CPU path, inside the edge").toBeLessThanOrEqual(3);
    });
  });

  // The Export panel slider's top radius reaches 9 px, the passes' last tap.
  it("sharpens at the slider's top radius as the float unsharp mask does", () => {
    const widest: Sharpen = { amount: 100, radius: 3 };
    onFrame(TEXTURE, 3, (r) => {
      expect(r.renderSharpened(widest)).toBe(true);
      const gpu = canvasPixels();
      let worst = 0;
      sharpenedFrame(TEXTURE.width, TEXTURE.height, textureAt, widest).forEach((want, i) => {
        worst = Math.max(worst, farthest(pixel(gpu, i), each(want, (v) => v * 255)));
      });
      expect(worst, "against the float unsharp mask").toBeLessThanOrEqual(1);
    });
  });

  it("maps the overshoot past white at an edge, where the CPU path clips it", () => {
    onFrame(EDGE, 3, (r) => {
      // Every row is the same, so the top one stands for the frame.
      const sharp = sharpenedFrame(EDGE.width, EDGE.height, (x) => (x < STEP_AT ? BRIGHT : NEAR_WHITE), OVERSHOOT)
        .slice(0, EDGE.width);
      const over = [STEP_AT, STEP_AT + 1, STEP_AT + 2];
      for (const x of over) expect(sharp[x][0], `column ${x}'s red overshoots white`).toBeGreaterThan(1);
      expect(sharp[STEP_AT + 3][0], "the fourth column's red").toBeLessThan(1);

      r.render();
      const cpu = cpuSharpened(OVERSHOOT);
      expect(r.renderSharpened(OVERSHOOT)).toBe(true);
      const gpu = canvasPixels();
      const srgb = outMatrix("srgb");
      sharp.forEach((colour, x) => {
        const mapped = each(outputPixel(colour, srgb, OUT_SPACE_CODE.srgb), (v) => v * 255);
        expect(farthest(pixel(gpu, x), mapped), `column ${x} against the twin's mapped colour`).toBeLessThanOrEqual(1);
      });
      for (const x of over) {
        expect(pixel(cpu, x)[0], `the CPU path's red, column ${x}`).toBe(255);
        const clipped = each(sharp[x], (v) => Math.min(Math.max(v, 0), 1) * 255);
        expect(farthest(pixel(gpu, x), clipped), `column ${x} against a hard clip`).toBeGreaterThan(2);
      }
      for (let i = 1; i < over.length; i++) {
        expect(farthest(pixel(gpu, over[i]), pixel(gpu, over[i - 1])), `columns ${over[i - 1]} and ${over[i]}`)
          .toBeGreaterThanOrEqual(1);
      }
    });
  });

  it("changes nothing at amount 0", () => {
    const zero: Sharpen = { amount: 0, radius: 1 };
    const scenes: [Scene, ColorSpaceId][] = [[TEXTURE, "srgb"], [EDGE, "srgb"], [RAMP, "adobe-rgb"]];
    for (const [s, space] of scenes) {
      onFrame(s, 3, (r) => {
        r.render();
        const plain = canvasPixels();
        expect(r.renderSharpened(zero)).toBe(true);
        expect(differing(canvasPixels(), plain), `${s.stage.id}, 8-bit`).toBe(0);
        const sixteen = exported(r, { targets: ["float32"] }).data;
        expect(differing(exported(r, { targets: ["float32"], sharpen: zero }).data, sixteen), `${s.stage.id}, 16-bit`)
          .toBe(0);
      }, space);
    }
  });

  for (const target of ["float32", "norm16"] as const) {
    it(`sharpens a ${target} export as it sharpens the 8-bit one, within an 8-bit step`, (ctx) => {
      if (target === "norm16" && !norm16()) ctx.skip();
      const cases: [Scene, Sharpen][] = [[TEXTURE, IN_RANGE], [EDGE, OVERSHOOT]];
      for (const [s, sharpen] of cases) {
        onFrame(s, 3, (r) => {
          expect(r.renderSharpened(sharpen)).toBe(true);
          const eight = canvasPixels();
          const sixteen = exported(r, { targets: [target], sharpen });
          expect(sixteen.target).toBe(target);
          let worst = 0;
          for (let i = 0; i < eight.length; i++) worst = Math.max(worst, Math.abs(sixteen.data[i] / 257 - eight[i]));
          expect(worst, s.stage.id).toBeLessThanOrEqual(1);
          expect(differing(sixteen.data, exported(r, { targets: [target] }).data), `${s.stage.id} is sharpened`)
            .toBeGreaterThan(0);
        });
      }
    });
  }

  it("refuses a photo without the signed output stage, a renderer without a source, and a context with no float target", () => {
    for (const processVersion of [1, 2]) {
      onFrame(TEXTURE, processVersion, (r) => {
        expect(r.renderSharpened(IN_RANGE), `version ${processVersion}`).toBe(false);
        expect(r.exportPixels({ sharpen: IN_RANGE }), `version ${processVersion}`).toBeNull();
      });
    }
    withRenderer({ stages: [TEXTURE.stage], pipeline: OPEN_PROBE }, (r) => {
      r.setImage(floatImage(TEXTURE.width, TEXTURE.height, () => [0.18, 0.18, 0.18]));
      r.setParams(identityParams({ processVersion: 3 }));
      expect(r.renderSharpened(IN_RANGE), "under the shipping cap").toBe(false);
    });
    withRenderer({ stages: [TEXTURE.stage], pipeline: OPEN_PROBE, processVersionCap: 3 }, (r) => {
      r.setParams(identityParams({ processVersion: 3 }));
      expect(r.renderSharpened(IN_RANGE), "without a source").toBe(false);
    });
    // Every framebuffer reads incomplete, as on a context that renders no float target.
    const { gl } = glHarness();
    onFrame(TEXTURE, 3, (r) => {
      const plain = liveFrame(r);
      const status = gl.checkFramebufferStatus;
      gl.checkFramebufferStatus = (): number => gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT;
      const tally = trackGlObjects(gl);
      try {
        expect(r.renderSharpened(IN_RANGE), "with no float target").toBe(false);
        expect(r.exportPixels({ sharpen: IN_RANGE }), "with no float target").toBeNull();
        expect([tally.live.texture, tally.live.framebuffer], "textures, framebuffers").toEqual([0, 0]);
      } finally {
        tally.restore();
        gl.checkFramebufferStatus = status;
      }
      expect(differing(canvasPixels(), plain), "the canvas, left for the CPU path").toBe(0);
    });
  });

  // `c` and its horizontal blur get textures of their own, which a driver can
  // run out of memory on at their first draw, leaving them undefined.
  it("steps `c` down past a texture the driver runs out of memory on at its first draw, or draws nothing", () => {
    const { gl } = glHarness();
    onFrame(TEXTURE, 3, (r) => {
      // The renderer makes its own targets now, so those made later are the export's.
      liveFrame(r);
      const sharpened = () => r.exportPixels({ targets: ["float16"], sharpen: IN_RANGE });
      const halfFloatC = outOfMemoryAtFirstDraw(gl, { textures: 1 }, sharpened);
      expect(halfFloatC?.target, "a float16 export, `c`'s float32 out of memory").toBe("float16");
      // `c` itself draws, so a check between its draw and the blur's would miss this.
      const blurOnly = outOfMemoryAtFirstDraw(gl, { passOver: 1, textures: 1 }, sharpened);
      expect(blurOnly?.target, "a float16 export, only the blur's float32 out of memory").toBe("float16");
      const plain = liveFrame(r);
      const tally = trackGlObjects(gl);
      try {
        const every = { textures: Infinity };
        expect(outOfMemoryAtFirstDraw(gl, every, () => r.renderSharpened(IN_RANGE)), "8-bit").toBe(false);
        expect(outOfMemoryAtFirstDraw(gl, every, () => r.exportPixels({ sharpen: IN_RANGE })), "16-bit").toBeNull();
        expect([tally.live.texture, tally.live.framebuffer], "textures, framebuffers").toEqual([0, 0]);
      } finally {
        tally.restore();
      }
      expect(differing(canvasPixels(), plain), "the canvas, left undrawn").toBe(0);
    });
  });

  // A float32 or norm16 export whose `c` fell to half float would carry 11-bit
  // sharpening as full precision. It steps down to a float16 export instead,
  // which says what it holds; that and the canvas take `c` in half float.
  it("keeps `c` as precise as its export target", () => {
    const { gl } = glHarness();
    onFrame(TEXTURE, 3, (r) => {
      liveFrame(r);
      const sharpened = (targets: readonly ExportTarget[]) => () => exported(r, { targets, sharpen: IN_RANGE }).target;
      // The first RGBA32F is the export target's.
      const refused = refusingFloat32(gl, 1, sharpened(["float32", "float16"]));
      expect(refused, "a float32 export, `c`'s float32 refused").toBe("float16");
      const outOfMemory = outOfMemoryAtFirstDraw(gl, { textures: 1 }, sharpened(["float32", "float16"]));
      expect(outOfMemory, "a float32 export, `c`'s float32 out of memory").toBe("float16");
      expect(refusingFloat32(gl, 0, sharpened(["float16"])), "a float16 export").toBe("float16");
      expect(refusingFloat32(gl, 0, () => r.renderSharpened(IN_RANGE)), "8-bit").toBe(true);
    });
  });

  it("gives its programs back with the renderer", () => {
    const { gl } = glHarness();
    const tally = trackGlObjects(gl);
    try {
      onFrame(TEXTURE, 3, (r) => {
        expect(r.renderSharpened(IN_RANGE)).toBe(true);
        exported(r, { sharpen: IN_RANGE });
      });
      expect(tally.live).toEqual({ texture: 0, framebuffer: 0, buffer: 0, program: 0, shader: 0, vertexArray: 0 });
    } finally {
      tally.restore();
    }
  });
});
