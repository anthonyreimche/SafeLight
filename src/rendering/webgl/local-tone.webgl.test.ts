// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Version 2's Highlights and Shadows on the GPU. The probes hand the working
// colour on at half scale, so scene values up to 2.0 survive the capture, and
// reads are doubled back into scene units.

import { describe, expect, it } from "vitest";
import {
  CURRENT_PROCESS_VERSION,
  LEGACY_PROCESS_VERSION,
  defaultToneCurves,
  type DevelopParams,
} from "@/catalog/types";
import { BUILTIN_RESOLVED, type ResolvedPipeline } from "@/extensions/pipelines";
import { toneHighlights, toneShadows } from "../local-tone";
import {
  PIXEL_TOLERANCE,
  floatImage,
  identityParams,
  pixelAt,
  withRenderer,
  worstDifference,
  type FloatImage,
  type Frame,
} from "./webgl.test-support";

const V1 = { processVersion: LEGACY_PROCESS_VERSION };
const V2 = { processVersion: CURRENT_PROCESS_VERSION };
const TOLERANCE = 2 * PIXEL_TOLERANCE;

const HALVING: ResolvedPipeline = {
  id: "test.local-tone-halving",
  glsl: "vec3 pipelineToDisplay(vec3 lin) { return lin * 0.5; }",
  skipBaseCurve: true,
  skipToneShoulder: false,
  sig: "test.local-tone-halving",
};
const SHOULDERLESS: ResolvedPipeline = {
  ...HALVING,
  skipToneShoulder: true,
  sig: "test.local-tone-halving-shoulderless",
};

/** An identity curve with a third point, so both versions sample the LUT. */
const USER_IDENTITY_CURVE = {
  ...defaultToneCurves(),
  rgb: [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }],
};

const luma = ([r, g, b]: readonly number[]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function render(pipeline: ResolvedPipeline, source: FloatImage, over: Partial<DevelopParams>): Frame {
  return withRenderer({ stages: [], pipeline }, (renderer) => {
    renderer.setImage(source);
    renderer.setParams(identityParams(over));
    const frame = renderer.captureFloatFrame();
    if (!frame) throw new Error("captureFloatFrame returned null");
    return frame;
  });
}

/** Scene luminance the probe shows at (x, y). */
const sceneLuma = (frame: Frame, x: number, y: number) => 2 * luma(pixelAt(frame, x, y));

const flat = (value: number) => floatImage(16, 16, () => [value, value, value]);

/** Greys striped ±20% a pixel apart, from deep shadow to past white. */
const STRIPED = floatImage(64, 16, (x) => {
  const v = 0.01 * 2 ** ((x >> 1) / 4) * (x % 2 === 0 ? 1.2 : 0.8);
  return [v, v, v];
});

describe("version 2 Highlights and Shadows on a flat grey", () => {
  const CASES: [number, number][] = [[-100, 0], [-40, 60], [0, -50], [0, 100], [30, 0], [100, 100]];
  for (const [highlights, shadows] of CASES) {
    for (const exposure of [0, 1.5]) {
      it(`land where the TypeScript curves do at Highlights ${highlights}, Shadows ${shadows}, Exposure ${exposure}`, () => {
        for (const value of [0.05, 0.3, 0.9, 1.6]) {
          const expected = toneShadows(
            toneHighlights(value * 2 ** exposure, exposure, highlights / 100, false),
            shadows / 100,
          );
          const frame = render(HALVING, flat(value), { ...V2, highlights, shadows, exposure });
          expect(Math.abs(sceneLuma(frame, 8, 8) - expected), `at ${value}`).toBeLessThan(TOLERANCE);
        }
      });
    }
  }

  for (const [highlights, shadows] of CASES.filter(([h]) => h <= 0)) {
    it(`land where the TypeScript curves do without the core shoulder at Highlights ${highlights}, Shadows ${shadows}`, () => {
      for (const value of [0.05, 0.3, 0.9, 1.6]) {
        const expected = toneShadows(toneHighlights(value, 0, highlights / 100, true), shadows / 100);
        const frame = render(SHOULDERLESS, flat(value), { ...V2, highlights, shadows });
        expect(Math.abs(sceneLuma(frame, 8, 8) - expected), `at ${value}`).toBeLessThan(TOLERANCE);
      }
    });
  }

  const RAMP = [0.5, 1.0, 1.2, 1.425, 1.6, 2.0, 3.0, 6.0, 12.0];
  const RISING = [
    { highlights: 25, exposure: 0 },
    { highlights: 50, exposure: 0 },
    { highlights: 100, exposure: 0 },
    { highlights: 50, exposure: 2 },
  ];
  for (const { highlights, exposure } of RISING) {
    it(`keeps brighter input brighter at Highlights +${highlights}, Exposure +${exposure}`, () => {
      const out = RAMP.map((value) =>
        sceneLuma(render(HALVING, flat(value / 2 ** exposure), { ...V2, highlights, exposure }), 8, 8),
      );
      for (let i = 1; i < out.length; i++) {
        expect(out[i], `${RAMP[i - 1]} → ${RAMP[i]}`).toBeGreaterThan(out[i - 1]);
      }
    });
  }
});

describe("version 2 with Highlights and Shadows at 0", () => {
  // Version 1 keeps the core shoulder under a skip-shoulder transform, so there the versions differ by design.
  for (const pipeline of [HALVING]) {
    for (const exposure of [-1, 0, 1.5]) {
      it(`renders as version 1 does under ${pipeline.sig} at Exposure ${exposure}`, () => {
        const over = { exposure, toneCurve: USER_IDENTITY_CURVE };
        const a = render(pipeline, STRIPED, { ...V1, ...over });
        const b = render(pipeline, STRIPED, { ...V2, ...over });
        expect(worstDifference(a, b)).toBeLessThan(5e-4);
      });
    }
  }
});

// On a flat field every tap reads the pixel's own value, so the region is the
// pixel and version 2 must render what version 1 does: its per-pixel curves
// are the same functions, and its automatic band detail is zero on a flat
// field. The region base decodes its taps itself (sRGB decode, baseline tone,
// white-balance gain), so this guards that the taps decode the source as the
// pixel does: it fails only when they decode it differently.
describe("version 2 Highlights and Shadows on a flat field under the built-in transform", () => {
  function frames(source: FloatImage | ImageBitmap, over: Partial<DevelopParams>): [Frame, Frame] {
    const draw = (version: Partial<DevelopParams>) =>
      withRenderer({ stages: [], pipeline: BUILTIN_RESOLVED }, (renderer) => {
        renderer.setAsShotTemperature(6500);
        renderer.setImage(source);
        renderer.setParams(identityParams({ ...version, toneCurve: USER_IDENTITY_CURVE, ...over }));
        const frame = renderer.captureFloatFrame();
        if (!frame) throw new Error("captureFloatFrame returned null");
        return frame;
      });
    return [draw(V1), draw(V2)];
  }

  for (const slider of [{ highlights: -100 }, { shadows: 100 }]) {
    it(`renders a float source with a white-balance gain as version 1 does at ${JSON.stringify(slider)}`, () => {
      // A warm grey of luminance 0.3, at 4000 K against an as-shot 6500 K.
      const warm = floatImage(16, 16, () => [0.3625, 0.29, 0.2175]);
      const [v1, v2] = frames(warm, { ...slider, temperature: 4000 });
      expect(worstDifference(v1, v2)).toBeLessThan(5e-4);
    });

    it(`renders an 8-bit source as version 1 does at ${JSON.stringify(slider)}`, async () => {
      const bytes = new Uint8ClampedArray(16 * 16 * 4);
      for (let i = 0; i < bytes.length; i += 4) bytes.set([150, 120, 95, 255], i);
      const bitmap = await createImageBitmap(new ImageData(bytes, 16, 16));
      const [v1, v2] = frames(bitmap, slider);
      expect(worstDifference(v1, v2)).toBeLessThan(5e-4);
    });
  }
});

/** Left half a dark region around 0.02, right half a bright one around 1.5,
 *  both striped ±20% a pixel apart: log2(1.2 / 0.8) of texture. */
function regions(width: number, height: number): FloatImage {
  return floatImage(width, height, (x) => {
    const v = (x < width / 2 ? 0.02 : 1.5) * (x % 2 === 0 ? 1.2 : 0.8);
    return [v, v, v];
  });
}
const STRIPE_EV = Math.log2(1.2 / 0.8);

/** Column windows, as fractions of the width, clear of the borders and of the
 *  boundary between the regions by more than the outer ring. */
const DARK: [number, number] = [0.1, 0.4];
const BRIGHT: [number, number] = [0.6, 0.9];

function windowPixels(frame: Frame, [x0, x1]: [number, number]): [number, number][] {
  const out: [number, number][] = [];
  const from = Math.round(x0 * frame.width);
  const to = Math.round(x1 * frame.width);
  for (let y = 8; y < frame.height - 8; y += 8) for (let x = from; x < to - 1; x++) out.push([x, y]);
  return out;
}

function meanLuma(frame: Frame, window: [number, number]): number {
  const px = windowPixels(frame, window);
  return px.reduce((sum, [x, y]) => sum + sceneLuma(frame, x, y), 0) / px.length;
}

/** The share of the scene's stripe texture the frame keeps in the window. */
function textureKept(frame: Frame, window: [number, number]): number {
  const px = windowPixels(frame, window);
  const steps = px.map(([x, y]) => Math.abs(Math.log2(sceneLuma(frame, x, y) / sceneLuma(frame, x + 1, y))));
  return steps.reduce((a, b) => a + b, 0) / steps.length / STRIPE_EV;
}

describe("version 2 Highlights and Shadows on regions", () => {
  const scene = regions(512, 256);

  it("pull a bright region down at Highlights -100 and keep its texture", () => {
    const before = render(HALVING, scene, V2);
    const after = render(HALVING, scene, { ...V2, highlights: -100 });
    const legacy = render(HALVING, scene, { ...V1, highlights: -100 });
    expect(meanLuma(after, BRIGHT)).toBeLessThan(meanLuma(before, BRIGHT) - 0.15);
    expect(textureKept(after, BRIGHT)).toBeGreaterThan(0.8);
    expect(textureKept(after, BRIGHT)).toBeLessThan(1.2);
    expect(textureKept(legacy, BRIGHT)).toBeLessThan(0.5);
  });

  it("lift a dark region at Shadows +100 and keep its texture", () => {
    const before = render(HALVING, scene, V2);
    const after = render(HALVING, scene, { ...V2, shadows: 100 });
    expect(meanLuma(after, DARK)).toBeGreaterThan(2 * meanLuma(before, DARK));
    expect(textureKept(after, DARK)).toBeGreaterThan(0.8);
    expect(textureKept(after, DARK)).toBeLessThan(1.2);
  });

  it("darken a dark region at Shadows -100 and keep its texture", () => {
    const before = render(HALVING, scene, V2);
    const after = render(HALVING, scene, { ...V2, shadows: -100 });
    expect(meanLuma(after, DARK)).toBeLessThan(0.5 * meanLuma(before, DARK));
    expect(textureKept(after, DARK)).toBeGreaterThan(0.8);
    expect(textureKept(after, DARK)).toBeLessThan(1.2);
  });

  it("let a pixel a stop above its region still reach white at Highlights -100", () => {
    const speck = floatImage(512, 256, (x, y) => {
      const v = Math.abs(x - 384) <= 1 && Math.abs(y - 128) <= 1 ? 3 : 1.5;
      return [v, v, v];
    });
    // Version 1 leaves the speck at about 0.8.
    expect(sceneLuma(render(HALVING, speck, { ...V2, highlights: -100 }), 384, 128)).toBeGreaterThan(1.0);
    expect(sceneLuma(render(HALVING, speck, { ...V1, highlights: -100 }), 384, 128)).toBeLessThan(0.85);
  });

  it("find the same regions at any source size", () => {
    const over = { ...V2, highlights: -100, shadows: 100 };
    const big = render(HALVING, regions(512, 256), over);
    const small = render(HALVING, regions(256, 128), over);
    for (const window of [DARK, BRIGHT]) {
      expect(Math.abs(meanLuma(small, window) / meanLuma(big, window) - 1)).toBeLessThan(0.03);
    }
  });

  it("treat a point 3 EV above a deep-shadow region as its own region at Shadows +100", () => {
    // A star, lamp or hot pixel. Lifted with its region's gain (about x9 at
    // 0.002) it would clip; as its own region it follows the curve itself, as
    // a flat field of its value does.
    const star = floatImage(512, 256, (x, y) => {
      const v = x === 128 && y === 128 ? 0.016 : 0.002;
      return [v, v, v];
    });
    const point = sceneLuma(render(HALVING, star, { ...V2, shadows: 100 }), 128, 128);
    const alone = sceneLuma(render(HALVING, flat(0.016), { ...V2, shadows: 100 }), 8, 8);
    expect(point, `point ${point}, flat field ${alone}`).toBeLessThan(1.5 * alone);
  });
});

describe("the region around an edge", () => {
  // Steps at x = 256 from a dark side to a bright one: 6 EV and 2 EV.
  const STEPS: [number, number][] = [[0.02, 1.28], [0.4, 1.6]];
  for (const [dark, bright] of STEPS) {
    const edge = floatImage(512, 64, (x) => {
      const v = x < 256 ? dark : bright;
      return [v, v, v];
    });
    for (const over of [{ highlights: -100 }, { shadows: 100 }]) {
      // 2 EV at Highlights -100 measured 12.46% within 4 px and 6.05% beyond, the rings' moderate-edge halo, unchanged since Task 3.
      const [near, far] = dark === 0.4 && "highlights" in over ? [0.15, 0.07] : [0.1, 0.05];
      it(`keeps each side of a ${Math.log2(bright / dark)} EV step near its far field at ${JSON.stringify(over)}`, () => {
        const frame = render(HALVING, edge, { ...V2, ...over });
        const farDark = sceneLuma(frame, 56, 32);
        const farBright = sceneLuma(frame, 456, 32);
        for (let d = 1; d <= 31; d++) {
          // Within the guide's reach (0.5% of the long edge, about 3 px here)
          // a pixel may pick up a little of the other side.
          const bound = d <= 4 ? near : far;
          const darkOff = sceneLuma(frame, 256 - d, 32) / farDark - 1;
          const brightOff = sceneLuma(frame, 255 + d, 32) / farBright - 1;
          expect(Math.abs(darkOff), `dark side, ${d} px: ${darkOff}`).toBeLessThan(bound);
          expect(Math.abs(brightOff), `bright side, ${d} px: ${brightOff}`).toBeLessThan(bound);
        }
      });
    }
  }
});

/** A deterministic hash of a pixel position, in [0, 1). */
function hash(x: number, y: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** `regions` with 4-px stripes and ±1.5 EV of per-pixel noise, as in a
 *  high-ISO shadow. */
function noisyRegions(width: number, height: number): FloatImage {
  return floatImage(width, height, (x, y) => {
    const level = x < width / 2 ? 0.02 : 1.5;
    const v = level * ((x >> 2) % 2 === 0 ? 1.2 : 0.8) * 2 ** (3 * hash(x, y) - 1.5);
    return [v, v, v];
  });
}

/** Mean |log2| step between neighbouring 4 × 8 pixel blocks across the
 *  window, so the noise averages out inside each block. */
function blockSteps(
  lum: (x: number, y: number) => number,
  width: number,
  height: number,
  [x0, x1]: [number, number],
): number {
  const from = Math.ceil((x0 * width) / 4) * 4;
  const to = Math.floor((x1 * width) / 4) * 4;
  const block = (bx: number, by: number) => {
    let sum = 0;
    for (let y = by; y < by + 8; y++) for (let x = bx; x < bx + 4; x++) sum += lum(x, y);
    return sum / 32;
  };
  let sum = 0;
  let n = 0;
  for (let by = 8; by + 16 <= height; by += 8) {
    for (let bx = from; bx + 8 <= to; bx += 4) {
      sum += Math.abs(Math.log2(block(bx, by) / block(bx + 4, by)));
      n++;
    }
  }
  return sum / n;
}

describe("version 2 Highlights and Shadows on noisy regions", () => {
  const scene = noisyRegions(512, 256);
  const sceneLum = (x: number, y: number) => scene.data[(y * 512 + x) * 4 + 1];
  const kept = (frame: Frame, window: [number, number]) =>
    blockSteps((x, y) => sceneLuma(frame, x, y), frame.width, frame.height, window) /
    blockSteps(sceneLum, 512, 256, window);

  it("keep a noisy dark region's texture at Shadows +100", () => {
    const after = render(HALVING, scene, { ...V2, shadows: 100 });
    const k = kept(after, DARK);
    expect(k, `kept ${k}`).toBeGreaterThan(0.85);
    expect(k, `kept ${k}`).toBeLessThan(1.15);
  });

  it("keep a noisy bright region's texture at Highlights -100", () => {
    const after = render(HALVING, scene, { ...V2, highlights: -100 });
    const k = kept(after, BRIGHT);
    expect(k, `kept ${k}`).toBeGreaterThan(0.85);
    expect(k, `kept ${k}`).toBeLessThan(1.15);
  });
});

/** The scene colour the probe shows at (x, y). */
const sceneRgb = (frame: Frame, x: number, y: number) =>
  pixelAt(frame, x, y).map((v) => v * 2) as [number, number, number];

const flatColour = (rgb: readonly [number, number, number]) => floatImage(16, 16, () => rgb);

const saturationOf = (c: readonly number[]) => (Math.max(...c) - Math.min(...c)) / Math.max(...c);

describe("version 2's path to white", () => {
  const ORANGE = [0.5, 0.15, 0.05] as const;

  it("eases a saturated colour toward white as Exposure pushes it past white", () => {
    const v1 = sceneRgb(render(HALVING, flatColour(ORANGE), { ...V1, exposure: 1.5 }), 8, 8);
    const v2 = sceneRgb(render(HALVING, flatColour(ORANGE), { ...V2, exposure: 1.5 }), 8, 8);
    // Version 1 scales every channel by the luminance shoulder's ratio, so red
    // overshoots white and clips at the output.
    expect(v1[0]).toBeGreaterThan(1.3);
    expect(Math.max(...v2), `v2 ${v2}`).toBeLessThanOrEqual(1.001);
    expect(saturationOf(v2)).toBeLessThan(saturationOf(v1) - 0.1);
    expect(Math.abs(luma(v2) - luma(v1))).toBeLessThan(TOLERANCE);
    // Straight toward the grey of the same luminance: the hue stays.
    const L = luma(v1);
    const step = (v2[0] - L) / (v1[0] - L);
    expect(Math.abs(v2[1] - L - step * (v1[1] - L))).toBeLessThan(TOLERANCE);
  });

  it("leaves a colour whose strongest channel stays under 0.9 as version 1 renders it", () => {
    const over = { toneCurve: USER_IDENTITY_CURVE };
    const a = render(HALVING, flatColour(ORANGE), { ...V1, ...over });
    const b = render(HALVING, flatColour(ORANGE), { ...V2, ...over });
    expect(worstDifference(a, b)).toBeLessThan(5e-4);
  });

  it("leaves a transform with its own roll-off to shape bright colours itself", () => {
    const out = sceneRgb(render(SHOULDERLESS, flatColour([0.6, 0.18, 0.06]), { ...V2, exposure: 1 }), 8, 8);
    [1.2, 0.36, 0.12].forEach((v, i) => expect(Math.abs(out[i] - v), `channel ${i}`).toBeLessThan(TOLERANCE));
  });
});
