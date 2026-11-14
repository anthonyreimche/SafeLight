// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, expect, it } from "vitest";
import {
  DETAIL_GAIN_MAX,
  DETAIL_GAIN_MIN,
  NATIVE_FRAME_MAX_PIXELS,
  baseLuma,
  cutDetailGain,
  windowBox,
  windowSize,
  type FrameRect,
  type NativeLuma,
} from "./native-frame";
import { halfBits, halfToFloatTable } from "./half-float";

const EPS = 1e-4;
const TABLE = halfToFloatTable();

function lumaFrame(width: number, height: number, value: (x: number, y: number) => number): NativeLuma {
  const data = new Uint16Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) data[y * width + x] = halfBits(value(x, y));
  return { data, width, height };
}

/** Deterministic pseudo-random luminance between 0.2 and 1.2. */
function noisyFrame(width: number, height: number): NativeLuma {
  let seed = 987654321;
  return lumaFrame(width, height, () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return 0.2 + (seed % 10000) / 10000;
  });
}

interface Reference {
  width: number;
  height: number;
  rect: FrameRect;
  raw: Float64Array;
}

/** The gain map as the brief defines it, written out straightforwardly: the whole
 *  base grid first, then a clamped bilinear tap per output pixel. */
function reference(
  frame: NativeLuma,
  rect: FrameRect,
  outW: number,
  outH: number,
  baseW: number,
  baseH: number,
): Reference {
  const { width: W, height: H } = frame;
  const luma = (x: number, y: number) => TABLE[frame.data[y * W + x]];
  const base = new Float64Array(baseW * baseH);
  for (let j = 0; j < baseH; j++) {
    const y0 = Math.floor((j * H) / baseH);
    const y1 = Math.max(y0 + 1, Math.floor(((j + 1) * H) / baseH));
    for (let i = 0; i < baseW; i++) {
      const x0 = Math.floor((i * W) / baseW);
      const x1 = Math.max(x0 + 1, Math.floor(((i + 1) * W) / baseW));
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++, n++) sum += luma(x, y);
      base[j * baseW + i] = sum / n;
    }
  }

  const bx0 = Math.max(0, Math.floor(rect.x * W));
  const by0 = Math.max(0, Math.floor(rect.y * H));
  const bx1 = Math.min(W, Math.ceil((rect.x + rect.w) * W));
  const by1 = Math.min(H, Math.ceil((rect.y + rect.h) * H));
  const box = { x: bx0, y: by0, w: bx1 - bx0, h: by1 - by0 };
  const { width, height } = windowSize(box.w, box.h, outW, outH);
  const raw = new Float64Array(width * height);
  const tap = (i: number, j: number) =>
    base[Math.min(baseH - 1, Math.max(0, j)) * baseW + Math.min(baseW - 1, Math.max(0, i))];

  for (let y = 0; y < height; y++) {
    const sy0 = Math.floor((y * box.h) / height);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * box.h) / height));
    for (let x = 0; x < width; x++) {
      const sx0 = Math.floor((x * box.w) / width);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * box.w) / width));
      let sum = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++, n++) sum += luma(box.x + sx, box.y + sy);
      }
      const num = sum / n;

      const u = (box.x + ((x + 0.5) * box.w) / width) / W;
      const v = (box.y + ((y + 0.5) * box.h) / height) / H;
      const fx = u * baseW - 0.5;
      const fy = v * baseH - 0.5;
      const ix = Math.floor(fx);
      const iy = Math.floor(fy);
      const tx = fx - ix;
      const ty = fy - iy;
      const den =
        tap(ix, iy) * (1 - tx) * (1 - ty) +
        tap(ix + 1, iy) * tx * (1 - ty) +
        tap(ix, iy + 1) * (1 - tx) * ty +
        tap(ix + 1, iy + 1) * tx * ty;
      raw[y * width + x] = (num + EPS) / (den + EPS);
    }
  }
  return { width, height, rect: { x: box.x / W, y: box.y / H, w: box.w / W, h: box.h / H }, raw };
}

const clampGain = (g: number) => Math.min(DETAIL_GAIN_MAX, Math.max(DETAIL_GAIN_MIN, g));

/** How many output values stray from the reference by more than half-float
 *  rounding plus a little arithmetic slack. */
function countOffReference(data: Uint16Array, ref: Reference): number {
  let wrong = 0;
  for (let i = 0; i < ref.raw.length; i++) {
    const want = clampGain(ref.raw[i]);
    if (Math.abs(TABLE[data[i]] - want) > want * 2e-3) wrong++;
  }
  return wrong;
}

describe("NATIVE_FRAME_MAX_PIXELS", () => {
  it("is 64 megapixels", () => {
    expect(NATIVE_FRAME_MAX_PIXELS).toBe(64_000_000);
  });
});

describe("DETAIL_GAIN limits", () => {
  it("are 1/8 and 8", () => {
    expect(DETAIL_GAIN_MIN).toBe(0.125);
    expect(DETAIL_GAIN_MAX).toBe(8);
  });
});

describe("windowBox", () => {
  it("floors the near edges and ceils the far edges to whole pixels", () => {
    expect(windowBox({ x: 0.25, y: 0.1, w: 0.3, h: 0.5 }, 10, 10)).toEqual({ x: 2, y: 1, w: 4, h: 5 });
  });

  it("returns the whole frame for the whole-frame rect", () => {
    expect(windowBox({ x: 0, y: 0, w: 1, h: 1 }, 6000, 4000)).toEqual({ x: 0, y: 0, w: 6000, h: 4000 });
  });

  it("clamps to the frame", () => {
    expect(windowBox({ x: -0.5, y: 0.5, w: 1, h: 1 }, 10, 10)).toEqual({ x: 0, y: 5, w: 5, h: 5 });
  });

  it("is null for a rect wholly outside the frame", () => {
    expect(windowBox({ x: 1.5, y: 0, w: 0.2, h: 1 }, 10, 10)).toBeNull();
    expect(windowBox({ x: -1, y: 0, w: 0.5, h: 1 }, 10, 10)).toBeNull();
  });

  it("is null for an empty or inverted rect", () => {
    expect(windowBox({ x: 0.2, y: 0.2, w: 0, h: 0.5 }, 10, 10)).toBeNull();
    expect(windowBox({ x: 0.2, y: 0.2, w: 0.5, h: -0.1 }, 10, 10)).toBeNull();
  });

  it("is null when any field is not finite", () => {
    expect(windowBox({ x: NaN, y: 0, w: 1, h: 1 }, 10, 10)).toBeNull();
    expect(windowBox({ x: 0, y: Infinity, w: 1, h: 1 }, 10, 10)).toBeNull();
    expect(windowBox({ x: 0, y: 0, w: Infinity, h: 1 }, 10, 10)).toBeNull();
    expect(windowBox({ x: 0, y: 0, w: 1, h: NaN }, 10, 10)).toBeNull();
  });

  it("covers a sliver inside one pixel with that whole pixel", () => {
    expect(windowBox({ x: 0.31, y: 0.31, w: 0.01, h: 0.01 }, 10, 10)).toEqual({ x: 3, y: 3, w: 1, h: 1 });
  });
});

describe("windowSize", () => {
  it("keeps the box's size when it fits the output", () => {
    expect(windowSize(100, 50, 200, 200)).toEqual({ width: 100, height: 50 });
  });

  it("scales by one factor so the aspect holds", () => {
    expect(windowSize(400, 200, 100, 100)).toEqual({ width: 100, height: 50 });
    expect(windowSize(200, 400, 100, 100)).toEqual({ width: 50, height: 100 });
  });

  it("is limited by the tighter axis", () => {
    expect(windowSize(1000, 1000, 500, 100)).toEqual({ width: 100, height: 100 });
  });

  it("never upsamples", () => {
    expect(windowSize(10, 10, 1000, 1000)).toEqual({ width: 10, height: 10 });
  });

  it("is at least 1 x 1", () => {
    expect(windowSize(1000, 2, 10, 10)).toEqual({ width: 10, height: 1 });
    expect(windowSize(5, 5, 0.1, 0.1)).toEqual({ width: 1, height: 1 });
  });

  it("treats non-positive or non-finite output sizes as no limit", () => {
    expect(windowSize(300, 200, 0, 0)).toEqual({ width: 300, height: 200 });
    expect(windowSize(300, 200, -5, NaN)).toEqual({ width: 300, height: 200 });
    expect(windowSize(300, 200, Infinity, 100)).toEqual({ width: 150, height: 100 });
  });
});

describe("cutDetailGain on a flat frame", () => {
  const flat = lumaFrame(40, 30, () => 0.3);
  const ONE = halfBits(1);

  it.each([
    ["the whole frame at scale 1", { x: 0, y: 0, w: 1, h: 1 }, 100, 100],
    ["an interior rect at scale 1", { x: 0.3, y: 0.2, w: 0.4, h: 0.5 }, 100, 100],
    ["a corner rect", { x: 0.75, y: 0.8, w: 0.25, h: 0.2 }, 100, 100],
    ["the whole frame averaged down", { x: 0, y: 0, w: 1, h: 1 }, 7, 5],
    ["an odd rect averaged down", { x: 0.11, y: 0.13, w: 0.7, h: 0.6 }, 9, 9],
  ])("gives exactly 1.0 everywhere for %s", (_name, rect, outW, outH) => {
    const gain = cutDetailGain(flat, rect, outW, outH, 17, 11);

    expect(gain).not.toBeNull();
    if (!gain) return;
    let off = 0;
    for (let i = 0; i < gain.data.length; i++) if (gain.data[i] !== ONE) off++;
    expect(off).toBe(0);
    expect(gain.data.length).toBe(gain.width * gain.height);
  });
});

describe("cutDetailGain reconstruction", () => {
  const frame = noisyFrame(64, 48);
  const baseW = 33;
  const baseH = 25;

  it.each([
    ["the whole frame", { x: 0, y: 0, w: 1, h: 1 }],
    ["an interior rect", { x: 0.2, y: 0.3, w: 0.4, h: 0.35 }],
    ["a sliver", { x: 0.5, y: 0.5, w: 0.02, h: 0.02 }],
    ["a rect with fractional edges", { x: 0.123, y: 0.071, w: 0.611, h: 0.43 }],
  ])("gives gains that multiply the base back to the frame's own luminance: %s", (_name, rect) => {
    const gain = cutDetailGain(frame, rect, 1000, 1000, baseW, baseH);
    const ref = reference(frame, rect, 1000, 1000, baseW, baseH);

    expect(gain).not.toBeNull();
    if (!gain) return;
    expect([gain.width, gain.height]).toEqual([ref.width, ref.height]);
    expect(gain.rect).toEqual(ref.rect);
    expect(countOffReference(gain.data, ref)).toBe(0);

    const box = windowBox(rect, 64, 48);
    if (!box) throw new Error("no box");
    let checked = 0;
    let wrong = 0;
    for (let y = 0; y < gain.height; y++) {
      for (let x = 0; x < gain.width; x++) {
        const i = y * gain.width + x;
        const raw = ref.raw[i];
        if (raw < DETAIL_GAIN_MIN || raw > DETAIL_GAIN_MAX) continue;
        const native = TABLE[frame.data[(box.y + y) * 64 + box.x + x]];
        // raw = (N + EPS) / (D + EPS), so D = (N + EPS) / raw - EPS
        const den = (native + EPS) / raw - EPS;
        checked++;
        if (Math.abs(den * TABLE[gain.data[i]] - native) > native * 3e-3 + 1e-3) wrong++;
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(wrong).toBe(0);
  });

  it("reports the whole-pixel rectangle it covers", () => {
    const gain = cutDetailGain(frame, { x: 0.31, y: 0.26, w: 0.38, h: 0.47 }, 1000, 1000, baseW, baseH);

    expect(gain?.rect).toEqual({ x: 19 / 64, y: 12 / 48, w: 26 / 64, h: 24 / 48 });
  });

  it("returns a fresh buffer of halves", () => {
    const a = cutDetailGain(frame, { x: 0, y: 0, w: 1, h: 1 }, 64, 48, baseW, baseH);
    const b = cutDetailGain(frame, { x: 0, y: 0, w: 1, h: 1 }, 64, 48, baseW, baseH);

    expect(a?.data).toBeInstanceOf(Uint16Array);
    expect(a?.data.buffer).not.toBe(b?.data.buffer);
    expect(a?.data.buffer).not.toBe(frame.data.buffer);
  });
});

describe("cutDetailGain clamps", () => {
  it("limits a single very bright pixel on black to the largest gain", () => {
    const frame = lumaFrame(16, 16, (x, y) => (x === 5 && y === 5 ? 1000 : 0));

    const gain = cutDetailGain(frame, { x: 0, y: 0, w: 1, h: 1 }, 16, 16, 4, 4);

    expect(gain?.data[5 * 16 + 5]).toBe(halfBits(DETAIL_GAIN_MAX));
  });

  it("limits a black pixel on bright to the smallest gain", () => {
    const frame = lumaFrame(16, 16, (x, y) => (x === 5 && y === 5 ? 0 : 1));

    const gain = cutDetailGain(frame, { x: 0, y: 0, w: 1, h: 1 }, 16, 16, 4, 4);

    expect(gain?.data[5 * 16 + 5]).toBe(halfBits(DETAIL_GAIN_MIN));
  });

  it("keeps every value inside the limits", () => {
    const frame = lumaFrame(16, 16, (x, y) => ((x * 7 + y * 3) % 5 === 0 ? 500 : 0));

    const gain = cutDetailGain(frame, { x: 0, y: 0, w: 1, h: 1 }, 16, 16, 5, 3);

    expect(gain).not.toBeNull();
    if (!gain) return;
    let outside = 0;
    for (const bits of gain.data) if (TABLE[bits] < DETAIL_GAIN_MIN || TABLE[bits] > DETAIL_GAIN_MAX) outside++;
    expect(outside).toBe(0);
  });
});

describe("cutDetailGain at the frame's edges", () => {
  const frame = noisyFrame(64, 48);

  it.each([
    ["top-left", { x: 0, y: 0, w: 0.2, h: 0.2 }],
    ["top-right", { x: 0.8, y: 0, w: 0.2, h: 0.2 }],
    ["bottom-left", { x: 0, y: 0.8, w: 0.2, h: 0.2 }],
    ["bottom-right", { x: 0.8, y: 0.8, w: 0.2, h: 0.2 }],
    ["a rect reaching past the frame", { x: 0.9, y: 0.9, w: 0.5, h: 0.5 }],
  ])("matches the reference with clamped taps at the %s", (_name, rect) => {
    const gain = cutDetailGain(frame, rect, 1000, 1000, 33, 25);
    const ref = reference(frame, rect, 1000, 1000, 33, 25);

    expect(gain).not.toBeNull();
    if (!gain) return;
    expect([gain.width, gain.height]).toEqual([ref.width, ref.height]);
    expect(countOffReference(gain.data, ref)).toBe(0);
  });
});

describe("cutDetailGain averaged down", () => {
  const frame = noisyFrame(64, 48);

  it.each([
    ["a whole frame", { x: 0, y: 0, w: 1, h: 1 }, 20, 20, 33, 25],
    ["a window", { x: 0.1, y: 0.1, w: 0.8, h: 0.7 }, 20, 20, 33, 25],
    ["a window at an awkward ratio", { x: 0.05, y: 0.12, w: 0.77, h: 0.66 }, 13, 7, 31, 23],
    ["one axis limiting", { x: 0, y: 0, w: 1, h: 1 }, 1000, 5, 40, 30],
  ])("sizes the map with windowSize and matches the reference: %s", (_name, rect, outW, outH, baseW, baseH) => {
    const gain = cutDetailGain(frame, rect, outW, outH, baseW, baseH);
    const ref = reference(frame, rect, outW, outH, baseW, baseH);
    const box = windowBox(rect, 64, 48);
    if (!box) throw new Error("no box");
    const size = windowSize(box.w, box.h, outW, outH);

    expect(gain).not.toBeNull();
    if (!gain) return;
    expect([gain.width, gain.height]).toEqual([size.width, size.height]);
    expect(gain.data.length).toBe(size.width * size.height);
    expect(gain.rect).toEqual(ref.rect);
    expect(countOffReference(gain.data, ref)).toBe(0);
  });
});

describe("cutDetailGain nulls", () => {
  const frame = noisyFrame(64, 48);
  const whole = { x: 0, y: 0, w: 1, h: 1 };

  it("is null for an empty window", () => {
    expect(cutDetailGain(frame, { x: 2, y: 2, w: 1, h: 1 }, 64, 48, 33, 25)).toBeNull();
    expect(cutDetailGain(frame, { x: 0, y: 0, w: NaN, h: 1 }, 64, 48, 33, 25)).toBeNull();
    expect(cutDetailGain(frame, { x: 0, y: 0, w: 0, h: 1 }, 64, 48, 33, 25)).toBeNull();
  });

  it("is null when the data does not match the frame size", () => {
    const short: NativeLuma = { data: frame.data.subarray(0, 64 * 48 - 1), width: 64, height: 48 };
    const long: NativeLuma = { data: new Uint16Array(64 * 48 + 1), width: 64, height: 48 };

    expect(cutDetailGain(short, whole, 64, 48, 33, 25)).toBeNull();
    expect(cutDetailGain(long, whole, 64, 48, 33, 25)).toBeNull();
  });

  it("is null for a frame no larger than its base on either axis", () => {
    expect(cutDetailGain(frame, whole, 64, 48, 64, 25)).toBeNull();
    expect(cutDetailGain(frame, whole, 64, 48, 33, 48)).toBeNull();
    expect(cutDetailGain(frame, whole, 64, 48, 100, 100)).toBeNull();
  });

  it.each([
    ["zero", 0, 25],
    ["negative", 33, -1],
    ["fractional", 33.5, 25],
    ["NaN", 33, NaN],
    ["infinite", Infinity, 25],
  ])("is null for a base size that is %s", (_name, baseW, baseH) => {
    expect(cutDetailGain(frame, whole, 64, 48, baseW, baseH)).toBeNull();
  });

  it("is not null for a base one pixel smaller on each axis", () => {
    expect(cutDetailGain(frame, whole, 64, 48, 63, 47)).not.toBeNull();
  });
});

describe("cutDetailGain speed", () => {
  it("cuts a 1920 x 1080 window of a 3000 x 2000 frame and sees almost no gain on a smooth one", { timeout: 60_000 }, () => {
    const width = 3000;
    const height = 2000;
    const frame = lumaFrame(width, height, (x, y) => 0.3 + (0.4 * x) / width + (0.3 * y) / height);
    const rect = { x: 0.2 + 1e-9, y: 0.2 + 1e-9, w: 0.64 - 2e-9, h: 0.54 - 2e-9 };

    const gain = cutDetailGain(frame, rect, 1920, 1080, 1536, 1024);

    expect(gain).not.toBeNull();
    if (!gain) return;
    expect([gain.width, gain.height]).toEqual([1920, 1080]);
    let outside = 0;
    for (let i = 0; i < gain.data.length; i++) {
      const g = TABLE[gain.data[i]];
      if (g < 0.95 || g > 1.05) outside++;
    }
    expect(outside).toBe(0);
  });
});

// A holder works the base's luminance out once and hands it to every cut: the
// gains must be the ones a cut that works out its own part gives, bit for bit.
describe("cutDetailGain with the base's luminance held", () => {
  const frame = noisyFrame(64, 48);
  const cases: [string, { x: number; y: number; w: number; h: number }, number, number][] = [
    ["an inner window at its own size", { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, 64, 48],
    ["the whole frame", { x: 0, y: 0, w: 1, h: 1 }, 64, 48],
    ["a corner", { x: 0.7, y: 0.6, w: 0.3, h: 0.4 }, 64, 48],
    ["a window averaged down", { x: 0.1, y: 0.1, w: 0.8, h: 0.8 }, 20, 15],
  ];
  for (const [label, rect, outW, outH] of cases) {
    it(`gives the same gains for ${label}`, () => {
      const base = baseLuma(frame, 33, 25);
      if (!base) throw new Error("no base");
      const own = cutDetailGain(frame, rect, outW, outH, 33, 25);
      const held = cutDetailGain(frame, rect, outW, outH, 33, 25, base);
      if (!own || !held) throw new Error("no gain");
      expect([held.width, held.height]).toEqual([own.width, own.height]);
      expect(held.rect).toEqual(own.rect);
      let differing = 0;
      for (let i = 0; i < own.data.length; i++) if (held.data[i] !== own.data[i]) differing++;
      expect(differing).toBe(0);
    });
  }

  it("holds one value per base texel, and none for a frame no larger than the base", () => {
    expect(baseLuma(frame, 33, 25)?.length).toBe(33 * 25);
    expect(baseLuma(frame, 64, 25)).toBeNull();
    expect(baseLuma(frame, 33, 48)).toBeNull();
    expect(baseLuma(frame, 0, 25)).toBeNull();
  });

  it("refuses a base of another size", () => {
    const base = baseLuma(frame, 33, 25);
    if (!base) throw new Error("no base");
    expect(cutDetailGain(frame, { x: 0, y: 0, w: 1, h: 1 }, 64, 48, 32, 24, base)).toBeNull();
  });
});
