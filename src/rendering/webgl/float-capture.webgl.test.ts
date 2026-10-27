// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// api.develop.captureFloatFrame on the real renderer: readFloatFrame draws the
// live photo into an RGBA32F target at a capture point, as perceptual Rec.709,
// and hands it over in the space asked for, converted on the GPU texel by
// texel before any averaging. The open probe hands the working colour through
// as display values and skips the core shoulder, so on versions 2 and 3 `c` at
// the output stage is the scene as the RGBA16F source holds it, over-range and
// negative values included, and the output-stage twin (output-map.ts) predicts
// the output.

import { describe, expect, it } from "vitest";
import type { ProcessingStageContribution, StageSpace } from "@/extensions/types";
import { OUT_SPACE_CODE, outMatrix } from "../color-space";
import { DEFAULT_CAPTURE_SPACE, type CapturePoint } from "../float-frame";
import { outputPixel } from "../output-map";
import { toStageSpace, type Vec3 } from "../stage-space";
import { WebGLRenderer } from "./renderer";
import {
  OPEN_PROBE, changedState, differing, drainGlErrors, each, expectColour, floatImage, glErrorsDuring, glHarness,
  glState, identityParams, liveFrame, measurementViews, outOfMemoryAtFirstDraw, pixelAt, toHalf, trackGlObjects,
  withRenderer, worstDifference, type FloatImage, type Frame,
} from "./webgl.test-support";

// Over range in every channel, a saturated green whose red and blue fall below
// zero in Rec.709, and two colours in range, as 4 px patches along the top
// half. The bottom half is a dim grey, so a frame read upside down shows.
const PATCHES: Vec3[] = [[2.5, 1.2, 0.6], [-0.2, 0.6, -0.1], [0.5, 0.5, 0.5], [0.1, 0.3, 0.05]];
const GREY: Vec3 = [0.05, 0.05, 0.05];
const W = PATCHES.length * 4;
const H = 8;
const SCENE = floatImage(W, H, (x, y) => (y < H / 2 ? PATCHES[Math.floor(x / 4)] : GREY));
/** A row inside the patches, and one inside the grey, each clear of the edge between them. */
const TOP = 1;
const BOTTOM = H - 2;

const patchAt = (f: Frame, i: number): Vec3 => pixelAt(f, i * 4 + 1, TOP);

function onScene<T>(processVersion: number, fn: (r: WebGLRenderer) => T): T {
  return onImage(SCENE, processVersion, fn);
}

function onImage<T>(image: FloatImage, processVersion: number, fn: (r: WebGLRenderer) => T): T {
  return withRenderer({ stages: [], pipeline: OPEN_PROBE, processVersionCap: 3 }, (r) => {
    r.setImage(image);
    r.setParams(identityParams({ processVersion }));
    return fn(r);
  });
}

const POINTS = ["pre-output", "output"] as const;

/** The space the frame is drawn in, which no conversion touches. */
const AS_DRAWN: StageSpace = { encoding: "perceptual", primaries: "rec709" };

function read(r: WebGLRenderer, point: CapturePoint, maxEdge?: number, space = AS_DRAWN): Frame {
  const f = r.readFloatFrame(point, maxEdge, space);
  if (!f) throw new Error(`readFloatFrame("${point}", ${maxEdge}, ${JSON.stringify(space)}) returned null`);
  return f;
}

/** `f` with each pixel as toStageSpace converts it from the display domain into `space`. */
function inSpace(f: Frame, space: StageSpace): Frame {
  const data = f.data.slice();
  for (let i = 0; i < data.length; i += 4) data.set(toStageSpace([data[i], data[i + 1], data[i + 2]], space, "display"), i);
  return { data, width: f.width, height: f.height };
}

/** The lowest and highest colour value in a frame, alpha left out. */
function extent(f: Frame): [number, number] {
  let low = Infinity;
  let high = -Infinity;
  f.data.forEach((v, i) => {
    if (i % 4 === 3) return;
    low = Math.min(low, v);
    high = Math.max(high, v);
  });
  return [low, high];
}

/** `f` averaged down to w×h: each pixel the mean of the pixels of `f` its
 *  footprint covers, each weighted by the part of it inside. */
function areaMean(f: Frame, w: number, h: number): Frame {
  const across = f.width / w;
  const down = f.height / h;
  const inside = (lo: number, hi: number, i: number): number => Math.max(0, Math.min(hi, i + 1) - Math.max(lo, i));
  const data = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sum = [0, 0, 0];
      for (let j = Math.floor(y * down); j < Math.min(f.height, Math.ceil((y + 1) * down)); j++) {
        for (let i = Math.floor(x * across); i < Math.min(f.width, Math.ceil((x + 1) * across)); i++) {
          const weight = (inside(y * down, (y + 1) * down, j) * inside(x * across, (x + 1) * across, i)) / (across * down);
          pixelAt(f, i, j).forEach((v, ch) => (sum[ch] += weight * v));
        }
      }
      data.set([...sum, 1], (y * w + x) * 4);
    }
  }
  return { data, width: w, height: h };
}

/** Each colour value of `a` less `b`'s, alpha left out. */
const minus = (a: Frame, b: Frame): number[] =>
  Array.from(a.data, (v, i) => v - b.data[i]).filter((_, i) => i % 4 !== 3);

function correlation(a: readonly number[], b: readonly number[]): number {
  const mean = (s: readonly number[]): number => s.reduce((t, v) => t + v, 0) / s.length;
  const [ma, mb] = [mean(a), mean(b)];
  let ab = 0;
  let aa = 0;
  let bb = 0;
  a.forEach((v, i) => {
    ab += (v - ma) * (b[i] - mb);
    aa += (v - ma) ** 2;
    bb += (b[i] - mb) ** 2;
  });
  return ab / Math.sqrt(aa * bb);
}

/** `fn`, with each texture allocation recorded as [width, height, internal
 *  format], and those `refused` picks refused as a driver refuses one: with an
 *  error, and no image. `peak` is the most texture memory `fn` held at once,
 *  in bytes: 16 a texel in RGBA32F, 8 in RGBA16F. */
function allocating<T>(
  gl: WebGL2RenderingContext,
  fn: () => T,
  refused: (width: unknown, height: unknown, format: unknown) => boolean = () => false,
): { result: T; allocated: unknown[][]; peak: number } {
  const { texImage2D, deleteTexture } = gl;
  const allocated: unknown[][] = [];
  const bytes = new Map<WebGLTexture, number>();
  let held = 0;
  let peak = 0;
  gl.texImage2D = (...args: unknown[]): void => {
    allocated.push([args[3], args[4], args[2]]);
    // RGBA8 can't take FLOAT texels: INVALID_OPERATION, and no image.
    const refusal = [args[0], args[1], gl.RGBA8, args[3], args[4], 0, gl.RGBA, gl.FLOAT, null];
    const isRefused = refused(args[3], args[4], args[2]);
    Reflect.apply(texImage2D, gl, isRefused ? refusal : args);
    if (isRefused) return;
    const size = Number(args[3]) * Number(args[4]) * (args[2] === gl.RGBA32F ? 16 : 8);
    bytes.set(gl.getParameter(gl.TEXTURE_BINDING_2D), size);
    held += size;
    peak = Math.max(peak, held);
  };
  gl.deleteTexture = (texture: WebGLTexture | null): void => {
    if (texture) held -= bytes.get(texture) ?? 0;
    deleteTexture.call(gl, texture);
  };
  try {
    return { result: fn(), allocated, peak };
  } finally {
    gl.texImage2D = texImage2D;
    gl.deleteTexture = deleteTexture;
  }
}

describe("float capture of the live photo", () => {
  it("hands over version 3's signed colour at pre-output, top-down, as the source holds it", () => {
    onScene(3, (r) => {
      const f = read(r, "pre-output");
      expect([f.width, f.height]).toEqual([W, H]);
      PATCHES.forEach((p, i) => expectColour(patchAt(f, i), each(p, toHalf), `patch ${i}`));
      expectColour(pixelAt(f, 1, BOTTOM), each(GREY, toHalf), "the grey below");
      const [low, high] = extent(f);
      expect(high).toBeGreaterThan(1);
      expect(low).toBeLessThan(0);
    });
  });

  it("hands over version 3's output as the output stage maps it into sRGB, in [0, 1]", () => {
    onScene(3, (r) => {
      const f = read(r, "output");
      PATCHES.forEach((p, i) => {
        expectColour(patchAt(f, i), outputPixel(each(p, toHalf), outMatrix("srgb"), OUT_SPACE_CODE.srgb), `patch ${i}`);
      });
      const [low, high] = extent(f);
      expect(low).toBeGreaterThanOrEqual(0);
      expect(high).toBeLessThanOrEqual(1);
    });
  });

  it("hands over version 2's colour above 1 at pre-output", () => {
    onScene(2, (r) => {
      const f = read(r, "pre-output");
      PATCHES.forEach((p, i) => expectColour(patchAt(f, i), each(p, toHalf), `patch ${i}`));
      expect(extent(f)[1]).toBeGreaterThan(1);
    });
  });

  // Version 1 clamps the display transform's result, so its `c` is in [0, 1]
  // and the output stage, encoding sRGB, hands it on as it is.
  it("hands over version 1's c, clamped after the display transform", () => {
    onScene(1, (r) => {
      const pre = read(r, "pre-output");
      const [low, high] = extent(pre);
      expect(low).toBeGreaterThanOrEqual(0);
      expect(high).toBeLessThanOrEqual(1);
      expect(differing(pre.data, read(r, "output").data)).toBe(0);
    });
  });

  // A stage paints 2,048 steps across [0.5, 1), twice what RGBA16F holds there.
  it("keeps more steps than half float holds, in an RGBA32F target", () => {
    const ramp: ProcessingStageContribution = {
      id: "test.ramp",
      name: "test.ramp",
      phase: "effects",
      space: { encoding: "perceptual" },
      glsl: "vec2 px = floor(vUv * vec2(64.0, 32.0));\nc = vec3(0.5 + 0.5 * (px.y * 64.0 + px.x) / 2048.0);",
      uniforms: [],
    };
    withRenderer({ stages: [ramp], pipeline: OPEN_PROBE, processVersionCap: 3 }, (r) => {
      r.setImage(floatImage(64, 32, () => GREY));
      r.setParams(identityParams({ processVersion: 3 }));
      const reds = read(r, "pre-output").data.filter((_, i) => i % 4 === 0);
      expect(new Set(reds).size).toBe(2048);
    });
  });

  // The renderer converts the frame from the perceptual Rec.709 it is drawn in,
  // texel by texel, in the first pass that reads it, so a smaller frame is the
  // mean of converted values: in a linear space, the mean of the light. The
  // TypeScript conversion (toStageSpace) is the twin.
  describe("in the space asked for", () => {
    // Whether the scene keeps a value below 0 there: its out-of-gamut green
    // lies inside Rec.2020.
    const SPACES: [string, StageSpace, boolean][] = [
      ["linear Rec.709", DEFAULT_CAPTURE_SPACE, true],
      ["linear Rec.2020", { encoding: "linear", primaries: "rec2020" }, false],
      ["perceptual Rec.2020", { encoding: "perceptual", primaries: "rec2020" }, false],
      // A plain-JS extension can leave `encoding` out, which reads as perceptual.
      ["Rec.2020 without an encoding", { primaries: "rec2020" } as StageSpace, false],
    ];
    // 16 × 8 shrunk to 6 × 3: footprints 2⅔ px each way, most straddling two
    // patches or a patch and the grey, so averaging and converting don't commute.
    const EDGE = 6;

    it.each(SPACES)("converts the full frame into %s on the GPU, through a second full-size target", (_label, space, belowZero) => {
      const { gl } = glHarness();
      onScene(3, (r) => {
        for (const point of POINTS) {
          const want = inSpace(read(r, point), space);
          const { result, allocated } = allocating(gl, () => read(r, point, Infinity, space));
          expect(allocated, `${point}: the frame, then its conversion`).toEqual([[W, H, gl.RGBA32F], [W, H, gl.RGBA32F]]);
          expect(worstDifference(result, want), point).toBeLessThan(2e-3);
          if (point === "output") continue;
          const [low, high] = extent(result);
          expect(high, `${point}: above 1`).toBeGreaterThan(1);
          expect(low < 0, `${point}: below 0 (${low})`).toBe(belowZero);
        }
      });
    });

    it.each(SPACES)("averages %s values: each pixel converted first, then the box mean", (_label, space) => {
      onScene(3, (r) => {
        for (const point of POINTS) {
          const drawn = read(r, point);
          const want = areaMean(inSpace(drawn, space), EDGE, EDGE / 2);
          const capped = read(r, point, EDGE, space);
          expect([capped.width, capped.height], point).toEqual([EDGE, EDGE / 2]);
          expect(worstDifference(capped, want), point).toBeLessThan(2e-3);
          // Converting the mean instead misses by more than that, so the order is pinned.
          const late = inSpace(areaMean(drawn, EDGE, EDGE / 2), space);
          expect(worstDifference(late, want), `${point}: the mean converted`).toBeGreaterThan(2e-3);
        }
      });
    });

    it("defaults to linear Rec.709", () => {
      onScene(3, (r) => {
        const f = r.readFloatFrame("pre-output");
        expect(differing(f?.data ?? [], read(r, "pre-output", Infinity, DEFAULT_CAPTURE_SPACE).data)).toBe(0);
      });
    });

    it("hands over perceptual Rec.709 as drawn, read directly from one target", () => {
      const { gl } = glHarness();
      onScene(3, (r) => {
        for (const point of POINTS) {
          const drawn = read(r, point);
          for (const space of [{ encoding: "perceptual" }, { primaries: "rec709" }, AS_DRAWN] as StageSpace[]) {
            const at = `${point} in ${JSON.stringify(space)}`;
            const { result, allocated } = allocating(gl, () => read(r, point, Infinity, space));
            expect(allocated, at).toEqual([[W, H, gl.RGBA32F]]);
            expect(differing(result.data, drawn.data), at).toBe(0);
            expect(result.data.filter((a, i) => i % 4 === 3 && a !== 1).length, `${at}: alpha other than 1`).toBe(0);
          }
        }
      });
    });

    // A capped frame still passes through the converting pass, which must leave
    // the space it is drawn in alone: decoded and encoded again, 1000 comes back
    // about 8 off, where slEncodePerceptual's mix cancels.
    it("averages perceptual Rec.709 as drawn, far over range too", () => {
      onImage(floatImage(W, H, (x, y) => (x < 4 && y < H / 2 ? [1000, 1000, 1000] : GREY)), 3, (r) => {
        const drawn = read(r, "pre-output");
        expectColour(pixelAt(drawn, 1, TOP), [1000, 1000, 1000], "the patch as drawn");
        expect(worstDifference(read(r, "pre-output", EDGE), areaMean(drawn, EDGE, EDGE / 2))).toBeLessThan(2e-3);
      });
    });
  });

  // renderPhotoFloatFrame reads the worker's thumb renderer: built without high
  // bit depth, with the photo's source uploaded once at 1280 px and bound at
  // the measuring edge, as a thumbnail from a resident source binds it.
  it("reads the thumb renderer's frame at most 640 px on its long edge, over range at pre-output", () => {
    const stripe = 400;
    const photo = floatImage(PATCHES.length * stripe, 64, (x, y) => (y < 32 ? PATCHES[Math.floor(x / stripe)] : GREY));
    withRenderer({ stages: [], pipeline: OPEN_PROBE, processVersionCap: 3, highBitDepth: false }, (r) => {
      r.uploadSource("photo:0", photo, 1280, false, false, true, true);
      expect(r.bindSource("photo:0", 640)).toBe(true);
      r.setParams(identityParams({ processVersion: 3 }));
      const f = read(r, "pre-output");
      expect(f.width).toBe(640);
      expect(f.height).toBeLessThan(f.width);
      expect(extent(f)[1]).toBeGreaterThan(1);
      const scale = f.width / photo.width;
      PATCHES.forEach((p, i) => {
        expectColour(pixelAt(f, Math.round((i + 0.5) * stripe * scale), 4), each(p, toHalf), `patch ${i}`);
      });
    });
  });

  it("returns null without a source, and on a GPU without float render targets", () => {
    withRenderer({ stages: [], pipeline: OPEN_PROBE, processVersionCap: 3 }, (r) => {
      r.setParams(identityParams({ processVersion: 3 }));
      expect(r.readFloatFrame("pre-output")).toBeNull();
    });
    const { canvas, gl } = glHarness();
    const getExtension = gl.getExtension.bind(gl);
    gl.getExtension = ((name: string) =>
      name === "EXT_color_buffer_float" ? null : getExtension(name)) as typeof gl.getExtension;
    try {
      const r = new WebGLRenderer(canvas, { stages: [], pipeline: OPEN_PROBE, processVersionCap: 3 });
      try {
        r.setImage(SCENE);
        r.setParams(identityParams({ processVersion: 3 }));
        expect(r.readFloatFrame("pre-output")).toBeNull();
        expect(r.readFloatFrame("output")).toBeNull();
      } finally {
        r.dispose();
      }
    } finally {
      gl.getExtension = getExtension;
    }
  });

  // Some drivers report the memory only at the first draw into a target, and
  // what that draw left is undefined. The frame as drawn has no other target.
  it("returns null when the driver runs out of memory at the first draw into its target", () => {
    const { gl } = glHarness();
    onScene(3, (r) => {
      expect(outOfMemoryAtFirstDraw(gl, { textures: 1 }, () => r.readFloatFrame("pre-output", Infinity, AS_DRAWN))).toBeNull();
      expect(r.readFloatFrame("pre-output", Infinity, AS_DRAWN), "the next capture").not.toBeNull();
    });
  });

  for (const [label, space] of [["as drawn", AS_DRAWN], ["converted", DEFAULT_CAPTURE_SPACE]] as const) {
    it(`isn't refused for an out-of-memory error raised before it, ${label}`, () => {
      const { gl } = glHarness();
      onScene(3, (r) => {
        const getError = gl.getError;
        let earlier = true;
        gl.getError = (): number => {
          if (!earlier) return getError.call(gl);
          earlier = false;
          return gl.OUT_OF_MEMORY;
        };
        try {
          expect(r.readFloatFrame("pre-output", Infinity, space)).not.toBeNull();
        } finally {
          gl.getError = getError;
        }
      });
    });

    // An allocation the driver refuses raises an error and leaves its target
    // incomplete; the next reader of the queue mustn't find it.
    it(`leaves no allocation error behind when its target can't be allocated, ${label}`, () => {
      const { gl } = glHarness();
      onScene(3, (r) => {
        const texImage2D = gl.texImage2D;
        // RGBA8 can't take FLOAT texels: INVALID_OPERATION, and no image.
        gl.texImage2D = (...args: unknown[]): void => {
          Reflect.apply(texImage2D, gl, [args[0], args[1], gl.RGBA8, args[3], args[4], 0, gl.RGBA, gl.FLOAT, null]);
        };
        drainGlErrors(gl);
        try {
          expect(r.readFloatFrame("pre-output", Infinity, space)).toBeNull();
        } finally {
          gl.texImage2D = texImage2D;
        }
        expect(gl.getError()).toBe(gl.NO_ERROR);
      });
    });

    // computeHistogram and Upright redraw with whatever the last frame left
    // bound. A capped or converted frame goes through passes with programs of
    // their own, at sizes other than the canvas's.
    it(`leaves the live frame, GL state and GL objects as it found them, ${label}`, () => {
      const { gl } = glHarness();
      for (const point of POINTS) {
        for (const maxEdge of [Infinity, W / 2]) {
          const at = `${point} at ${maxEdge}`;
          onScene(3, (r) => {
            const before = liveFrame(r);
            const histogram = r.computeHistogram(true);
            const state = glState(gl);
            const tally = trackGlObjects(gl);
            let errors: number[] = [];
            try {
              errors = glErrorsDuring(gl, () => read(r, point, maxEdge, space));
              expect([tally.live.texture, tally.live.framebuffer], `${at}: textures, framebuffers`).toEqual([0, 0]);
            } finally {
              tally.restore();
            }
            expect(errors, `${at}: GL errors from the capture`).toEqual([]);
            expect(changedState(state, glState(gl)), `${at}: GL state changed`).toEqual([]);
            expect(r.computeHistogram(true), `${at}: a histogram redrawn after it`).toEqual(histogram);
            expect(differing(liveFrame(r), before), at).toBe(0);
            expect(gl.getError(), `${at}: GL error in the next frame`).toBe(gl.NO_ERROR);
          });
        }
      }
    });
  }

  // At fit the live frame is the Develop render resolution, 4096 px by
  // default, so the API asks for a measuring edge. A capped frame is the full
  // view's frame averaged down, so it is compared with areaMean of the full
  // frame: tone, colour and detail alike.
  describe("capped at a long edge", () => {
    it("shrinks the frame to the capped size, its aspect kept, with the full frame's colour on a flat scene", () => {
      onImage(floatImage(96, 64, () => PATCHES[0]), 3, (r) => {
        for (const point of POINTS) {
          const full = read(r, point);
          const capped = read(r, point, 24);
          expect([full.width, full.height, capped.width, capped.height], point).toEqual([96, 64, 24, 16]);
          const colour = pixelAt(full, 0, 0);
          for (let y = 0; y < capped.height; y++) {
            for (let x = 0; x < capped.width; x++) expectColour(pixelAt(capped, x, y), colour, `${point} (${x}, ${y})`);
          }
        }
      });
    });

    it("hands over the patches at pre-output, over range and below zero", () => {
      onScene(3, (r) => {
        const f = read(r, "pre-output", W / 2);
        expect([f.width, f.height]).toEqual([W / 2, H / 2]);
        PATCHES.forEach((p, i) => expectColour(pixelAt(f, i * 2, 0), each(p, toHalf), `patch ${i}`));
        const [low, high] = extent(f);
        expect(high).toBeGreaterThan(1);
        expect(low).toBeLessThan(0);
      });
    });

    it("draws the canvas's size for Infinity and for an edge at or above it", () => {
      onScene(3, (r) => {
        const full = read(r, "pre-output");
        for (const maxEdge of [Infinity, W, 4096]) {
          const f = read(r, "pre-output", maxEdge);
          expect([f.width, f.height], String(maxEdge)).toEqual([W, H]);
          expect(differing(f.data, full.data), String(maxEdge)).toBe(0);
        }
      });
    });

    // Wider than the API's default edge, which the renderer doesn't apply.
    it("reads back proportionally fewer floats from a larger canvas", () => {
      const { gl } = glHarness();
      onImage(floatImage(2048, 16, () => GREY), 3, (r) => {
        const readPixels = gl.readPixels;
        const sizes: [unknown, unknown][] = [];
        gl.readPixels = (...args: unknown[]): void => {
          sizes.push([args[2], args[3]]);
          Reflect.apply(readPixels, gl, args);
        };
        try {
          const full = read(r, "pre-output");
          const capped = read(r, "pre-output", 512);
          expect([full.data.length, capped.data.length]).toEqual([2048 * 16 * 4, 512 * 4 * 4]);
          expect(sizes).toEqual([[2048, 16], [512, 4]]);
        } finally {
          gl.readPixels = readPixels;
        }
      });
    });

    // The read-back size alone doesn't say what was drawn: the frame drawn at
    // the capped size, its detail tools at another scale, would read 512 × 4 too.
    // The intermediate is freed once the first pass has read it, so it and the
    // second pass's target are never held together.
    it("draws the full view into one float intermediate and shrinks it through two pass targets", () => {
      const { gl } = glHarness();
      onImage(floatImage(2048, 16, () => GREY), 3, (r) => {
        const { allocated, peak } = allocating(gl, () => read(r, "pre-output", 512));
        expect(allocated).toEqual([[2048, 16, gl.RGBA32F], [512, 16, gl.RGBA32F], [512, 4, gl.RGBA32F]]);
        expect(peak, "bytes held at once").toBe((2048 * 16 + 512 * 16) * 16);
      });
    });

    // A ramp across `width` px, ±0.15 alternating by pixel, and a spike on
    // every fourth column. A single pixel keeps the alternation, and a bilinear
    // sample from the middle of a 4×4 box misses the spike: only the box
    // average has neither, and at a ratio that isn't whole only the
    // area-weighted one.
    const textured = (width: number) => (x: number, y: number): Vec3 => {
      const ramp = x / width;
      const alternation = (x + y) % 2 === 0 ? 0.15 : -0.15;
      const spike = x % 4 === 0 ? 0.3 : 0;
      return [0.2 + 0.3 * ramp + alternation + spike, 0.5 - 0.3 * ramp - alternation, 0.35 + alternation];
    };
    // A 64×32 photo whose right half, textured, is the zoom window.
    const WINDOW = { x: 0.5, y: 0, w: 0.5, h: 1 };
    const detail = (x: number, y: number): Vec3 => (x < 32 ? GREY : textured(32)(x - 32, y));

    for (const edge of [16, 8]) {
      it(`draws a zoomed window as the box average of the window drawn in full, at ${edge} px`, () => {
        onImage(floatImage(64, 32, detail), 3, (r) => {
          r.setViewport(WINDOW, 32, 32);
          const live = liveFrame(r);
          for (const point of POINTS) {
            const full = read(r, point);
            expect([full.width, full.height], `${point}: the window drawn in full`).toEqual([32, 32]);
            const capped = read(r, point, edge);
            expect([capped.width, capped.height], point).toEqual([edge, edge]);
            expect(worstDifference(capped, areaMean(full, edge, edge)), point).toBeLessThan(2e-3);
          }
          // The window's own corner, so a frame of the whole image shows.
          expectColour(pixelAt(read(r, "pre-output"), 0, 0), each(detail(32, 0), toHalf), "the window's corner");
          expect(r.viewport, "the zoom window").toEqual(WINDOW);
          expect(differing(liveFrame(r), live), "the live zoomed frame").toBe(0);
        });
      });
    }

    it("averages each pixel's footprint exactly at a ratio that isn't whole", () => {
      onImage(floatImage(100, 64, textured(100)), 3, (r) => {
        for (const point of POINTS) {
          const capped = read(r, point, 30);
          expect([capped.width, capped.height], point).toEqual([30, 19]);
          expect(worstDifference(capped, areaMean(read(r, point), 30, 19)), point).toBeLessThan(2e-3);
        }
      });
    });

    // Smoothed noise, detail a few pixels across. The core's capture
    // sharpening samples the source's mips at fixed levels, so in a frame drawn
    // at a third or a quarter of the view's size it would read a coarser base
    // level than its blur and work against the detail. At a quarter such a
    // frame would match the box average without sharpening, mip 2 being one,
    // so only the detail tools tell it apart.
    const NOISE = (() => {
      const [w, h] = [192, 96];
      let seed = 12345;
      const random = (): number => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
      const noise = Array.from({ length: w * h }, () => 0.1 + 0.8 * random());
      const at = (x: number, y: number): number =>
        noise[Math.min(Math.max(y, 0), h - 1) * w + Math.min(Math.max(x, 0), w - 1)];
      return floatImage(w, h, (x, y) => {
        let sum = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) sum += at(x + dx, y + dy);
        return [sum / 25, sum / 25, sum / 25];
      });
    })();

    for (const processVersion of [2, 3]) {
      for (const shrink of [3, 4]) {
        it(`keeps the full view's detail at 1/${shrink}, capture sharpening included, on version ${processVersion}`, () => {
          const [w, h] = [NOISE.width / shrink, NOISE.height / shrink];
          const frames = (point: CapturePoint, sharpening: number): { full: Frame; capped: Frame } =>
            onImage(NOISE, processVersion, (r) => {
              r.setParams(identityParams({ processVersion, sharpening }));
              return { full: read(r, point), capped: read(r, point, w) };
            });
          for (const point of POINTS) {
            const plain = frames(point, 0);
            const sharpened = frames(point, 100);
            const averaged = areaMean(sharpened.full, w, h);
            expect(worstDifference(sharpened.capped, averaged), `${point}: the full frame averaged down`).toBeLessThan(2e-3);
            // Well above that tolerance, so the comparison sees sharpening.
            const effect = minus(sharpened.capped, plain.capped);
            expect(Math.max(...effect.map(Math.abs)), `${point}: sharpening's effect`).toBeGreaterThan(5e-3);
            const fullEffect = minus(averaged, areaMean(plain.full, w, h));
            expect(correlation(effect, fullEffect), `${point}: against the full frame's, averaged down`).toBeGreaterThan(0.9);
          }
        });
      }
    }

    // A driver may refuse the full-size intermediate, or run out of memory only
    // at its first draw, which leaves it undefined. Half float then holds the
    // frame before it is averaged. The first pass's target is allocated while
    // the intermediate is held, so when that fails, half float's smaller
    // intermediate is tried too; the second pass's comes after the
    // intermediate is freed, so a retry would meet the same refusal.
    it("steps its intermediate down to half float, or returns null and leaks nothing", () => {
      const { gl } = glHarness();
      onImage(floatImage(100, 64, textured(100)), 3, (r) => {
        const want = areaMean(read(r, "pre-output"), 30, 19);
        const capped = (): Frame | null => r.readFloatFrame("pre-output", 30, AS_DRAWN);
        const sized = (w: number, h: number, ...formats: number[]) => (width: unknown, height: unknown, format: unknown) =>
          width === w && height === h && (formats.length === 0 || formats.some((f) => f === format));
        const once = (refuse: (width: unknown, height: unknown, format: unknown) => boolean) => {
          let refusals = 1;
          return (width: unknown, height: unknown, format: unknown): boolean => refuse(width, height, format) && refusals-- > 0;
        };
        const halfFloat = [[100, 64, gl.RGBA32F], [100, 64, gl.RGBA16F], [30, 64, gl.RGBA32F], [30, 19, gl.RGBA32F]];
        const retried = [[100, 64, gl.RGBA32F], [30, 64, gl.RGBA32F], [100, 64, gl.RGBA16F], [30, 64, gl.RGBA32F], [30, 19, gl.RGBA32F]];
        const steppedDown: [string, { result: Frame | null; allocated: unknown[][] }, unknown[][]][] = [
          ["RGBA32F refused", allocating(gl, capped, sized(100, 64, gl.RGBA32F)), halfFloat],
          ["out of memory at RGBA32F's first draw", allocating(gl, () => outOfMemoryAtFirstDraw(gl, { textures: 1 }, capped)), halfFloat],
          ["the first pass's target refused behind RGBA32F", allocating(gl, capped, once(sized(30, 64))), retried],
          [
            "out of memory at the first pass behind RGBA32F",
            allocating(gl, () => outOfMemoryAtFirstDraw(gl, { passOver: 1, textures: 1 }, capped)),
            retried,
          ],
        ];
        for (const [label, { result, allocated }, shapes] of steppedDown) {
          expect(allocated, label).toEqual(shapes);
          if (!result) throw new Error(`${label}: no frame`);
          expect(worstDifference(result, want), label).toBeLessThan(2e-3);
        }
        const tally = trackGlObjects(gl);
        try {
          const nulls: [string, () => Frame | null][] = [
            ["both intermediates refused", () => allocating(gl, capped, sized(100, 64)).result],
            ["out of memory at both", () => outOfMemoryAtFirstDraw(gl, { textures: 2 }, capped)],
            ["the first pass's target refused behind both", () => allocating(gl, capped, sized(30, 64)).result],
            ["the second pass's target refused", () => allocating(gl, capped, sized(30, 19)).result],
            ["out of memory at the second pass", () => outOfMemoryAtFirstDraw(gl, { passOver: 2, textures: 1 }, capped)],
          ];
          for (const [label, capture] of nulls) {
            expect(capture(), label).toBeNull();
            expect([tally.live.texture, tally.live.framebuffer], `${label}: textures, framebuffers`).toEqual([0, 0]);
            expect(gl.getError(), `${label}: an error left behind`).toBe(gl.NO_ERROR);
          }
        } finally {
          tally.restore();
        }
        expect(worstDifference(read(r, "pre-output", 30), want), "the next capture").toBeLessThan(2e-3);
      });
    });

    it("frees its targets after each capture, and builds its programs once, freed with the renderer", () => {
      const { gl } = glHarness();
      const tally = trackGlObjects(gl);
      try {
        onImage(floatImage(100, 64, textured(100)), 3, (r) => {
          read(r, "pre-output");
          const captures = [
            ["first capped", 30, AS_DRAWN, 3, 2],
            ["second capped", 30, AS_DRAWN, 3, 0],
            ["converted, uncapped", Infinity, DEFAULT_CAPTURE_SPACE, 2, 0],
          ] as const;
          for (const [capture, maxEdge, space, targets, programs] of captures) {
            const created = { ...tally.created };
            const live = { ...tally.live };
            read(r, "pre-output", maxEdge, space);
            const made = (k: "texture" | "framebuffer" | "program"): number => tally.created[k] - created[k];
            expect([made("texture"), made("framebuffer"), made("program")], `${capture}: made`).toEqual([targets, targets, programs]);
            expect([tally.live.texture - live.texture, tally.live.framebuffer - live.framebuffer], `${capture}: kept`)
              .toEqual([0, 0]);
          }
        });
        expect(tally.live).toEqual({ texture: 0, framebuffer: 0, buffer: 0, program: 0, shader: 0, vertexArray: 0 });
      } finally {
        tally.restore();
      }
    });
  });

  // An extension measures the frame, whatever the live view is showing.
  describe("draws a measurement", () => {
    const frames = (r: WebGLRenderer): Float32Array[] => [read(r, "pre-output").data, read(r, "output").data];
    let plainFrames: { live: Uint8Array; frames: Float32Array[] } | null = null;
    const plain = () => (plainFrames ??= onScene(3, (r) => ({ live: liveFrame(r), frames: frames(r) })));
    for (const [label, view] of measurementViews()) {
      it(`without ${label}`, () => {
        const { live, frames: measured } = plain();
        onScene(3, (r) => {
          view(r);
          expect(differing(liveFrame(r), live), "the live frame shows it").toBeGreaterThan(0);
          frames(r).forEach((f, i) => expect(differing(f, measured[i]), ["pre-output", "output"][i]).toBe(0));
        });
      });
    }
  });
});

describe("the scene point", () => {
  it.each([2, 3])("hands over lin as the transform receives it, before any display tool (version %i)", (v) => {
    const frame = onScene(v, (r) => {
      r.setParams(identityParams({ processVersion: v, whites: 60, blacks: -40 }));
      return read(r, "scene", Infinity, DEFAULT_CAPTURE_SPACE);
    });
    PATCHES.forEach((p, i) => expectColour(patchAt(frame, i), each(p, toHalf), `patch ${i}`));
  });

  it("differs from pre-output once a display tool is in use", () => {
    const [scene, pre] = onScene(2, (r) => {
      r.setParams(identityParams({ processVersion: 2, whites: 60 }));
      return [read(r, "scene", Infinity, DEFAULT_CAPTURE_SPACE), read(r, "pre-output", Infinity, DEFAULT_CAPTURE_SPACE)];
    });
    expect(Math.abs(patchAt(scene, 2)[0] - patchAt(pre, 2)[0])).toBeGreaterThan(0.01);
  });

  // Version 1 keeps the core shoulder on whatever the transform, so what the
  // transform receives is bounded already: in range it is the source, over
  // range it falls short of it.
  it("reads a version 1 photo, after the core shoulder", () => {
    const frame = onScene(1, (r) => read(r, "scene", Infinity, DEFAULT_CAPTURE_SPACE));
    for (const i of [2, 3]) expectColour(patchAt(frame, i), each(PATCHES[i], toHalf), `patch ${i}`);
    expect(patchAt(frame, 0)[0]).toBeLessThan(2);
  });

  it("leaves the live program as it was", () => {
    const [before, after] = onScene(2, (r) => {
      r.setParams(identityParams({ processVersion: 2, whites: 60 }));
      const first = read(r, "pre-output", Infinity, DEFAULT_CAPTURE_SPACE);
      read(r, "scene", Infinity, DEFAULT_CAPTURE_SPACE);
      return [first, read(r, "pre-output", Infinity, DEFAULT_CAPTURE_SPACE)];
    });
    expectColour(patchAt(after, 2), patchAt(before, 2), "pre-output after a scene capture");
  });

  // computeHistogram and Upright redraw with whatever the last frame left
  // bound, so the scene program must not be the one left behind.
  it("leaves the live frame and its histogram as they were", () => {
    onScene(2, (r) => {
      r.setParams(identityParams({ processVersion: 2, whites: 60 }));
      const before = liveFrame(r);
      const histogram = r.computeHistogram(true);
      read(r, "scene", Infinity, DEFAULT_CAPTURE_SPACE);
      expect(r.computeHistogram(true), "a histogram redrawn after it").toEqual(histogram);
      expect(differing(liveFrame(r), before)).toBe(0);
    });
  });
});
