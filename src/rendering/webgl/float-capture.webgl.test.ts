// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// api.develop.captureFloatFrame on the real renderer: readFloatFrame draws the
// live photo into an RGBA32F target at a capture point, as perceptual Rec.709.
// The open probe hands the working colour through as display values and skips
// the core shoulder, so on versions 2 and 3 `c` at the output stage is the
// scene as the RGBA16F source holds it, over-range and negative values
// included, and the output-stage twin (output-map.ts) predicts the output.

import { describe, expect, it } from "vitest";
import type { ProcessingStageContribution } from "@/extensions/types";
import { OUT_SPACE_CODE, outMatrix } from "../color-space";
import { DEFAULT_CAPTURE_SPACE, toFloatFrame, type CapturePoint } from "../float-frame";
import { outputPixel } from "../output-map";
import { REC709_TO_REC2020, apply3, decodePerceptual, type Vec3 } from "../stage-space";
import { WebGLRenderer } from "./renderer";
import {
  OPEN_PROBE, changedState, differing, drainGlErrors, each, expectColour, floatImage, glErrorsDuring, glHarness,
  glState, identityParams, liveFrame, measurementViews, outOfMemoryAtFirstDraw, pixelAt, toHalf, trackGlObjects,
  withRenderer, type FloatImage, type Frame,
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

function read(r: WebGLRenderer, point: CapturePoint, maxEdge?: number): Frame {
  const f = r.readFloatFrame(point, maxEdge);
  if (!f) throw new Error(`readFloatFrame("${point}", ${maxEdge}) returned null`);
  return f;
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

  it("converts into Rec.2020 as the TypeScript twin rotates the Rec.709 frame", () => {
    onScene(3, (r) => {
      const f = read(r, "pre-output");
      const narrow = toFloatFrame(f.data.slice(), W, H, DEFAULT_CAPTURE_SPACE, "pre-output");
      const wide = toFloatFrame(f.data.slice(), W, H, { encoding: "linear", primaries: "rec2020" }, "pre-output");
      PATCHES.forEach((p, i) => {
        expectColour(patchAt(narrow, i), each(each(p, toHalf), decodePerceptual), `patch ${i}, linear Rec.709`);
        expectColour(patchAt(wide, i), apply3(REC709_TO_REC2020, patchAt(narrow, i)), `patch ${i}, linear Rec.2020`);
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
  // what that draw left is undefined.
  it("returns null when the driver runs out of memory at the first draw into its target", () => {
    const { gl } = glHarness();
    onScene(3, (r) => {
      expect(outOfMemoryAtFirstDraw(gl, { textures: 1 }, () => r.readFloatFrame("pre-output"))).toBeNull();
      expect(r.readFloatFrame("pre-output"), "the next capture").not.toBeNull();
    });
  });

  it("isn't refused for an out-of-memory error raised before it", () => {
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
        expect(r.readFloatFrame("pre-output")).not.toBeNull();
      } finally {
        gl.getError = getError;
      }
    });
  });

  // An allocation the driver refuses raises an error and leaves its target
  // incomplete; the next reader of the queue mustn't find it.
  it("leaves no allocation error behind when its target can't be allocated", () => {
    const { gl } = glHarness();
    onScene(3, (r) => {
      const texImage2D = gl.texImage2D;
      // RGBA8 can't take FLOAT texels: INVALID_OPERATION, and no image.
      gl.texImage2D = (...args: unknown[]): void => {
        Reflect.apply(texImage2D, gl, [args[0], args[1], gl.RGBA8, args[3], args[4], 0, gl.RGBA, gl.FLOAT, null]);
      };
      drainGlErrors(gl);
      try {
        expect(r.readFloatFrame("pre-output")).toBeNull();
      } finally {
        gl.texImage2D = texImage2D;
      }
      expect(gl.getError()).toBe(gl.NO_ERROR);
    });
  });

  // computeHistogram and Upright redraw with whatever the last frame left bound.
  // A capped frame is drawn at a size other than the canvas's.
  it("leaves the live frame, GL state and GL objects as it found them", () => {
    const { gl } = glHarness();
    for (const point of ["pre-output", "output"] as const) {
      for (const maxEdge of [Infinity, W / 2]) {
        const at = `${point} at ${maxEdge}`;
        onScene(3, (r) => {
          const before = liveFrame(r);
          const histogram = r.computeHistogram(true);
          const state = glState(gl);
          const tally = trackGlObjects(gl);
          let errors: number[] = [];
          try {
            errors = glErrorsDuring(gl, () => read(r, point, maxEdge));
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

  // At fit the live frame is the Develop render resolution, 4096 px by
  // default, so the API asks for a measuring edge, which is drawn at that
  // size: the pipeline drawn smaller, not a shrunk copy of the full view. Tone
  // and colour match it; sharpening, noise reduction and texture take their
  // radii from the photo's pixels, so only these flat and box-averaged scenes
  // are compared with the full frame.
  describe("capped at a long edge", () => {
    it("draws the frame at the capped size, its aspect kept, with the full frame's colour on a flat scene", () => {
      onImage(floatImage(96, 64, () => PATCHES[0]), 3, (r) => {
        for (const point of ["pre-output", "output"] as const) {
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

    // The read-back size alone doesn't say what was drawn: a full-size draw
    // shrunk by a blit before it is read would also read 512 × 4.
    it("allocates one float target for the capture, at the capped size", () => {
      const { gl } = glHarness();
      onImage(floatImage(2048, 16, () => GREY), 3, (r) => {
        const texImage2D = gl.texImage2D;
        const allocated: unknown[][] = [];
        gl.texImage2D = (...args: unknown[]): void => {
          allocated.push([args[3], args[4], args[2]]);
          Reflect.apply(texImage2D, gl, args);
        };
        try {
          read(r, "pre-output", 512);
        } finally {
          gl.texImage2D = texImage2D;
        }
        expect(allocated).toEqual([[512, 4, gl.RGBA32F]]);
      });
    });

    // A 64×32 photo whose right half is the zoom window: a ramp across it, ±0.15
    // alternating by pixel, and a spike on every fourth column. A single pixel
    // keeps the alternation, and a bilinear sample from the middle of a 4×4
    // box misses the spike: only the box average has neither. Every value is
    // inside [0, 1], so what is compared is the averaging, not the pipeline's
    // handling of colour above 1.
    const WINDOW = { x: 0.5, y: 0, w: 0.5, h: 1 };
    const detail = (x: number, y: number): Vec3 => {
      if (x < 32) return GREY;
      const ramp = (x - 32) / 32;
      const alternation = (x + y) % 2 === 0 ? 0.15 : -0.15;
      const spike = x % 4 === 0 ? 0.3 : 0;
      return [0.2 + 0.3 * ramp + alternation + spike, 0.5 - 0.3 * ramp - alternation, 0.35 + alternation];
    };

    /** The mean of the n×n box of `f` whose top-left is (x, y), in each channel. */
    function boxMean(f: Frame, x: number, y: number, n: number): Vec3 {
      const sum = [0, 0, 0];
      for (let dy = 0; dy < n; dy++) {
        for (let dx = 0; dx < n; dx++) pixelAt(f, x + dx, y + dy).forEach((v, ch) => (sum[ch] += v / (n * n)));
      }
      return [sum[0], sum[1], sum[2]];
    }

    for (const edge of [16, 8]) {
      it(`draws a zoomed window as the box average of the window drawn in full, at ${edge} px`, () => {
        const n = 32 / edge;
        onImage(floatImage(64, 32, detail), 3, (r) => {
          r.setViewport(WINDOW, 32, 32);
          const live = liveFrame(r);
          const full = read(r, "pre-output");
          expect([full.width, full.height], "the window drawn in full").toEqual([32, 32]);
          // The window's own corner, so a frame of the whole image shows.
          expectColour(pixelAt(full, 0, 0), each(detail(32, 0), toHalf), "the window's corner");
          for (const point of ["pre-output", "output"] as const) {
            const capped = read(r, point, edge);
            expect([capped.width, capped.height], point).toEqual([edge, edge]);
            for (let y = 0; y < edge; y++) {
              for (let x = 0; x < edge; x++) {
                const mean = boxMean(full, x * n, y * n, n);
                const want = point === "pre-output" ? mean : outputPixel(mean, outMatrix("srgb"), OUT_SPACE_CODE.srgb);
                expectColour(pixelAt(capped, x, y), want, `${point} (${x}, ${y})`);
              }
            }
          }
          expect(r.viewport, "the zoom window").toEqual(WINDOW);
          expect(differing(liveFrame(r), live), "the live zoomed frame").toBe(0);
        });
      });
    }
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
