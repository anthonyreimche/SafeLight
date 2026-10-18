// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, it, expect } from "vitest";
import type { BrushDab } from "@/catalog/types";
import {
  encodeSrgb8,
  findHealSource,
  healColorOffset,
  healImageFromLinear,
  setHealSourceImage,
} from "./heal-source";
import type { HealSource } from "./heal-source";
import { rasterizeRegion, regionAnchor } from "./heal-region";
import type { HealRegion } from "./heal-region";

type RGB = [number, number, number];

function image(w: number, h: number, colorAt: (x: number, y: number) => RGB): Uint8ClampedArray {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = colorAt(x, y);
      const i = (y * w + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return data;
}

const gray = (v: number) => (): RGB => [v, v, v];
const grey = (v: number): RGB => {
  const c = Math.max(0, Math.min(255, Math.round(v)));
  return [c, c, c];
};

// Nearest texel under a UV coordinate, matching the module's uv -> pixel mapping.
function pixelAt(data: Uint8ClampedArray, w: number, h: number, uvx: number, uvy: number): RGB {
  const x = Math.min(w - 1, Math.max(0, Math.round(uvx * w - 0.5)));
  const y = Math.min(h - 1, Math.max(0, Math.round(uvy * h - 0.5)));
  const i = (y * w + x) * 4;
  return [data[i], data[i + 1], data[i + 2]];
}

const useImage = (w: number, h: number, colorAt: (x: number, y: number) => RGB) => {
  const data = image(w, h, colorAt);
  setHealSourceImage(data, w, h);
  return data;
};

// Cleared frame — both entry points bail out on a zero-size image.
const clearImage = () => setHealSourceImage(new Uint8ClampedArray(0), 0, 0);

// Flat mid-grey with one dark disc, in UV coordinates.
const blemishedFrame = (size: number, bx: number, by: number, br: number) =>
  useImage(size, size, (x, y) =>
    Math.hypot((x + 0.5) / size - bx, (y + 0.5) / size - by) < br
      ? [20, 20, 20]
      : [128, 128, 128],
  );

// Deterministic per-pixel noise in [0, 1).
function hash(x: number, y: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
const grain = (amp: number) => (x: number, y: number): RGB => grey(128 + (hash(x, y) * 2 - 1) * amp);

const circle = (x: number, y: number, radius: number, feather = 0.5): HealRegion => ({
  kind: "circle",
  x,
  y,
  radius,
  feather,
});
const dab = (x: number, y: number, radius: number, feather = 0.5): BrushDab => ({
  x,
  y,
  radius,
  feather,
  erase: false,
});
// Dabs every quarter radius from (x0, y0) to (x1, y1), as the brush lays them.
function stroke(x0: number, y0: number, x1: number, y1: number, radius: number, aspect = 1): HealRegion {
  const n = Math.max(1, Math.ceil(Math.hypot((x1 - x0) * aspect, y1 - y0) / (radius * 0.25)));
  const dabs: BrushDab[] = [];
  for (let i = 0; i <= n; i++) dabs.push(dab(x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n, radius));
  return { kind: "brush", dabs };
}

// Every case below expects a usable candidate; the null paths have their own tests.
function healSourceAt(region: HealRegion, mode: "heal" | "clone" = "heal"): HealSource {
  const src = findHealSource(region, mode);
  if (!src) throw new Error("findHealSource found no candidate");
  return src;
}

// A UV coordinate as a pixel position (pixel centres at integers).
const px = (uv: number, size: number) => uv * size - 0.5;

function expectInsideFrame(cx: number, cy: number, reach: number, w: number, h: number) {
  expect(cx - reach).toBeGreaterThan(-1.5);
  expect(cx + reach).toBeLessThan(w - 1 + 1.5);
  expect(cy - reach).toBeGreaterThan(-1.5);
  expect(cy + reach).toBeLessThan(h - 1 + 1.5);
}

describe("healColorOffset", () => {
  it("returns no shift when the frame is empty", () => {
    clearImage();
    expect(healColorOffset(0.5, 0.5, 0.3, 0.3, 0.05, 1)).toEqual({ r: 0, g: 0, b: 0 });
  });

  it("returns no shift when source and destination sit on the same tone", () => {
    useImage(64, 64, gray(128));
    const off = healColorOffset(0.7, 0.5, 0.3, 0.5, 0.05, 1);
    expect(off.r).toBeCloseTo(0, 6);
    expect(off.g).toBeCloseTo(0, 6);
    expect(off.b).toBeCloseTo(0, 6);
  });

  it("measures the surround difference as an encoded 0..1 offset", () => {
    // Split down the middle: the src ring sits entirely in the dark half, the
    // dst ring entirely in the light half, so the offset is the plain difference.
    useImage(64, 64, (x) => (x < 32 ? [60, 60, 60] : [150, 100, 40]));
    const off = healColorOffset(0.75, 0.5, 0.25, 0.5, 0.05, 1);
    expect(off.r).toBeCloseTo((150 - 60) / 255, 5);
    expect(off.g).toBeCloseTo((100 - 60) / 255, 5);
    expect(off.b).toBeCloseTo((40 - 60) / 255, 5);
  });

  it("clamps the offset to ±0.5 on a full black-to-white swing", () => {
    useImage(64, 64, (x) => (x < 32 ? [0, 0, 0] : [255, 255, 255]));
    expect(healColorOffset(0.75, 0.5, 0.25, 0.5, 0.05, 1)).toEqual({ r: 0.5, g: 0.5, b: 0.5 });
    expect(healColorOffset(0.25, 0.5, 0.75, 0.5, 0.05, 1)).toEqual({
      r: -0.5,
      g: -0.5,
      b: -0.5,
    });
  });

  it("keeps the ring inside the frame for a spot on the edge", () => {
    useImage(64, 64, gray(200));
    const off = healColorOffset(0.0, 0.0, 0.5, 0.5, 0.2, 1);
    // Edge clamping repeats border texels, so a flat frame still measures flat.
    expect(off.r).toBeCloseTo(0, 6);
    expect(Number.isFinite(off.g)).toBe(true);
  });
});

describe("findHealSource", () => {
  it("returns null when the frame is empty", () => {
    clearImage();
    expect(findHealSource(circle(0.5, 0.5, 0.05), "heal")).toBeNull();
  });

  it("returns null for a stroke that was erased away", () => {
    useImage(64, 64, gray(128));
    expect(findHealSource({ kind: "brush", dabs: [{ ...dab(0.5, 0.5, 0.05), erase: true }] }, "heal")).toBeNull();
  });

  it("copies plainly with no recolour on a featureless frame", () => {
    useImage(128, 128, gray(128));
    const src = healSourceAt(circle(0.5, 0.5, 0.05));
    expect(src.angle).toBe(0);
    expect(src.scale).toBe(1);
    for (const c of [src.r, src.g, src.b]) expect(c).toBeCloseTo(0, 9);
  });

  it("keeps the whole source and its band inside the frame near every edge", () => {
    useImage(96, 96, grain(30));
    const r = 0.04;
    const f = 0.5;
    // The copied disc plus one band width (the radius) past the blemish.
    const reach = r * (2 + f) * 96;
    for (const [x, y] of [
      [0.06, 0.5], [0.94, 0.5], [0.5, 0.06], [0.5, 0.94],
      [0.06, 0.06], [0.94, 0.06], [0.06, 0.94], [0.94, 0.94],
    ]) {
      const src = healSourceAt(circle(x, y, r, f));
      expectInsideFrame(px(src.x, 96), px(src.y, 96), reach, 96, 96);
    }
  });

  it("keeps a stroke's source inside the frame when it hugs the left edge", () => {
    useImage(256, 256, grain(30));
    const R = 0.04;
    const dabs = [dab(0.1, 0.45, R), dab(0.12, 0.5, R), dab(0.1, 0.55, R), dab(0.14, 0.5, R)];
    const src = healSourceAt({ kind: "brush", dabs });
    // The source is reported for the paint dabs' centroid.
    const dx = src.x - (0.1 + 0.12 + 0.1 + 0.14) / 4;
    const dy = src.y - 0.5;
    // Each copied dab plus one band width (the dab radius).
    for (const d of dabs) expectInsideFrame(px(d.x + dx, 256), px(d.y + dy, 256), 2 * R * 256, 256, 256);
  });

  it("never copies from the blemish it heals", () => {
    useImage(128, 128, (x, y) => [(x * 7) % 256, (y * 13) % 256, (x * 3 + y * 5) % 256]);
    const f = 0.5;
    for (const radius of [0.02, 0.05, 0.09]) {
      const src = healSourceAt(circle(0.5, 0.5, radius, f));
      // The copied disc (radius·(1+f)) stays clear of the blemish (radius).
      expect(Math.hypot(src.x - 0.5, src.y - 0.5) * 128).toBeGreaterThan(radius * (2 + f) * 128 - 1.5);
    }
  });

  it("sources a long thin stroke from right beside it, in step with the texture", () => {
    // Vertical stripes 8 px apart; the stroke runs across them.
    useImage(512, 512, (x) => grey(128 + 50 * Math.sin((2 * Math.PI * x) / 8)));
    const R = 0.01;
    const src = healSourceAt(stroke(0.3, 0.5, 0.7, 0.5, R));
    const dx = (src.x - 0.5) * 512;
    const dy = (src.y - 0.5) * 512;
    expect(Math.abs(dx / 8 - Math.round(dx / 8))).toBeLessThan(1e-6);
    // Clear of the stroke (its blemish is ±0.75R thick, its copy ±R)...
    expect(Math.abs(dy)).toBeGreaterThanOrEqual(1.75 * R * 512 - 1);
    // ...but within a few stroke widths of it.
    expect(Math.abs(dy)).toBeLessThanOrEqual(4 * 2 * R * 512);
  });

  it("sources a thin slanted stroke from beside it at full detail, in step and off the stroke", () => {
    // A sawtooth across a 45° wire, 6 px per tooth along the wire's direction,
    // on a full-size frame. The wire runs from pixel (300, 150) to (750, 600).
    useImage(1024, 683, (x, y) => grey(60 + 25 * ((x + y) % 6)));
    const R = 0.004;
    const wire = stroke(300.5 / 1024, 150.5 / 683, 750.5 / 1024, 600.5 / 683, R, 1024 / 683);
    const t0 = performance.now();
    const src = healSourceAt(wire);
    expect(performance.now() - t0).toBeLessThan(250);
    const a = regionAnchor(wire);
    const dx = (src.x - a.x) * 1024;
    const dy = (src.y - a.y) * 683;
    // Whole pixels, in step with the teeth...
    expect(Math.abs(dx - Math.round(dx)) + Math.abs(dy - Math.round(dy))).toBeLessThan(1e-6);
    expect((((Math.round(dx) + Math.round(dy)) % 6) + 6) % 6).toBe(0);
    // ...within a few stroke widths across the wire...
    expect(Math.abs(dx - dy) / Math.SQRT2).toBeLessThanOrEqual(4 * 2 * R * 683);
    // ...and no copied pixel taken from the wire itself.
    const r = rasterizeRegion(wire, 1024, 683);
    if (!r) throw new Error("the wire rasterised to nothing");
    let onWire = 0;
    for (let k = 0; k < r.copied.length; k += 2) {
      if (r.distToInterior(r.copied[k] + Math.round(dx), r.copied[k + 1] + Math.round(dy)) === 0) onWire++;
    }
    expect(onWire).toBe(0);
  });

  it("follows an edge whose brightness ramps along it, rather than matching brightness", () => {
    // A 20-level step at y = 128 px on a ramp of 1 level per px along x.
    useImage(256, 256, (x, y) => grey(118 + (y >= 128 ? 20 : 0) + (x - 128)));
    const src = healSourceAt(circle(0.5, 0.5, 0.03));
    expect(Math.abs(src.y - 0.5) * 256).toBeLessThanOrEqual(1);
  });

  it("matches the grain of the surroundings, not just their colour", () => {
    // Fine grain on the left half, smooth on the right; the spot sits in the grain near the border.
    useImage(256, 256, (x, y) => (x < 128 ? grain(40)(x, y) : grey(128)));
    const r = 0.03;
    const f = 0.5;
    const src = healSourceAt(circle(0.42, 0.5, r, f));
    // The copied disc and its band come from the grain.
    expect(px(src.x, 256) + r * (2 + f) * 256).toBeLessThan(128);
  });

  it("copies at matching brightness for clone, and takes the nearer source for heal", () => {
    // Horizontal stripes 64 px apart on a gentle ramp along them (0.3 levels per px).
    useImage(256, 256, (x, y) => grey(128 + 40 * Math.sin((2 * Math.PI * y) / 64) + 0.3 * (x - 128)));
    const spot = circle(0.5, 0.5, 0.03);
    const clone = healSourceAt(spot, "clone");
    const heal = healSourceAt(spot, "heal");
    const cdx = (clone.x - 0.5) * 256;
    const cdy = (clone.y - 0.5) * 256;
    const hdx = (heal.x - 0.5) * 256;
    const hdy = (heal.y - 0.5) * 256;
    // Clone: surroundings that match the spot's brightness, so nothing to recolour.
    // The overlay discards a clone's recolour shift; here it stands in for how
    // well the band brightness matches.
    for (const c of [clone.r, clone.g, clone.b]) expect(Math.abs(c)).toBeLessThan(1.5 / 255);
    // Heal: along the stripes, nearer, and recoloured by the ramp it crossed.
    expect(Math.abs(hdy)).toBeLessThanOrEqual(1);
    expect(Math.hypot(hdx, hdy)).toBeLessThan(Math.hypot(cdx, cdy));
    for (const c of [heal.r, heal.g, heal.b]) expect(Math.abs(c + (0.3 * hdx) / 255)).toBeLessThan(1.5 / 255);
  });

  it("matches a heal stroke's brightness, since a brush copies verbatim", () => {
    // The frame above: horizontal stripes on a ramp along them. The shader draws
    // no recolour for a brush, so its shift again stands in for the brightness match.
    useImage(256, 256, (x, y) => grey(128 + 40 * Math.sin((2 * Math.PI * y) / 64) + 0.3 * (x - 128)));
    const src = healSourceAt(stroke(0.45, 0.5, 0.55, 0.5, 0.02), "heal");
    for (const c of [src.r, src.g, src.b]) expect(Math.abs(c)).toBeLessThan(1.5 / 255);
  });

  it("passes over a blemish next to the spot", () => {
    // A dark disc of 0.7R, 2.6R out: the nearest sources that way would copy it.
    const R = 0.05;
    const bx = 0.5 + R * 2.6;
    const data = blemishedFrame(256, bx, 0.5, R * 0.7);
    const src = healSourceAt(circle(0.5, 0.5, R, 0));
    expect(Math.hypot(src.x - bx, src.y - 0.5)).toBeGreaterThan(R * 1.7 - 1 / 128);
    expect(pixelAt(data, 256, 256, src.x, src.y)).toEqual([128, 128, 128]);
  });

  it("rejects a source whose interior carries its own blemish", () => {
    // A small blemish inside the nearest candidate's interior, off its centre.
    const R = 0.05;
    const bx = 0.5 + R * 2.6;
    const by = 0.5 + R * 0.5;
    const data = blemishedFrame(256, bx, by, R * 0.3);
    const src = healSourceAt(circle(0.5, 0.5, R, 0));
    expect(Math.hypot(src.x - bx, src.y - by)).toBeGreaterThan(R * 1.3 - 1 / 128);
    expect(pixelAt(data, 256, 256, src.x, src.y)).toEqual([128, 128, 128]);
  });

  it("matches a dust-sized spot to fine texture", () => {
    // A sawtooth along the diagonal, 6 px per tooth, on a full-size frame.
    useImage(1024, 683, (x, y) => grey(60 + 25 * ((x + y) % 6)));
    const src = healSourceAt(circle(0.5, 0.5, 0.004));
    const dx = Math.round((src.x - 0.5) * 1024);
    const dy = Math.round((src.y - 0.5) * 683);
    expect(src.angle).toBe(0);
    expect((((dx + dy) % 6) + 6) % 6).toBe(0);
  });

  // A bright disc (radius 0.3) centred at (0.5, 0.6): its top rim is a curved edge.
  const rimFrame = () =>
    useImage(256, 256, (x, y) => (Math.hypot((x + 0.5) / 256 - 0.5, (y + 0.5) / 256 - 0.6) < 0.3 ? grey(200) : grey(60)));

  it("turns the source to follow a curved edge", () => {
    rimFrame();
    const src = healSourceAt(circle(0.5, 0.3, 0.03));
    // On the rim...
    expect(Math.abs(Math.hypot(src.x - 0.5, src.y - 0.6) - 0.3) * 256).toBeLessThan(1.5);
    // ...turned by the angle between the radii through source and spot, so the rims line up.
    const toCentre = (x: number, y: number) => Math.atan2(0.6 - y, 0.5 - x);
    const turn = toCentre(0.5, 0.3) - toCentre(src.x, src.y);
    const want = Math.atan2(Math.sin(turn), Math.cos(turn));
    expect(Math.abs(((src.angle - want) * 180) / Math.PI)).toBeLessThan(5);
    expect(Math.abs((src.angle * 180) / Math.PI)).toBeGreaterThan(5);
    expect(src.scale).toBe(1);
  });

  it("keeps a straight edge's source unturned and unscaled", () => {
    useImage(256, 256, (_x, y) => (y < 128 ? grey(60) : grey(200)));
    const src = healSourceAt(circle(0.5, 0.5, 0.03));
    expect(src.angle).toBe(0);
    expect(src.scale).toBe(1);
    expect(Math.abs(src.y - 0.5) * 256).toBeLessThanOrEqual(1);
  });

  it("fine-tunes a turn only about the edge directions it read", () => {
    // A T-junction: bright upper left, mid grey right, dark lower left, the
    // upper edge leaning 10° off vertical. The spot sits on that edge just above
    // the junction. Either side's edge direction calls for a turn of about 74°,
    // and neither polarity beats the plain copy, so the plain copy stays: a few
    // degrees off it is not a turn either side suggests.
    const lean = (100 * Math.PI) / 180;
    useImage(256, 256, (x, y) => {
      const upperLeft = y < 128 && (y - 128) * Math.cos(lean) - (x - 128) * Math.sin(lean) > 0;
      return grey(upperLeft ? 200 : x > 128 ? 120 : 50);
    });
    expect(healSourceAt(circle(0.5, 0.45, 0.03)).angle).toBe(0);
  });

  it("keeps a source on structureless grain unscaled", () => {
    useImage(256, 256, grain(30));
    for (const r of [0.02, 0.03]) {
      for (let i = 0; i < 5; i++) {
        for (let j = 0; j < 4; j++) expect(healSourceAt(circle(0.2 + i * 0.15, 0.2 + j * 0.2, r)).scale).toBe(1);
      }
    }
  });

  it("never turns or scales a brush stroke's source", () => {
    rimFrame();
    const src = healSourceAt(stroke(0.47, 0.3, 0.53, 0.3, 0.02));
    expect(src.angle).toBe(0);
    expect(src.scale).toBe(1);
  });

  it("picks within a generous time budget on a full-size frame", () => {
    useImage(1024, 683, (x, y) =>
      grey(100 + (hash(x, y) * 2 - 1) * 25 + (x > 600 ? 60 : 0) + 30 * Math.sin(y / 9)),
    );
    const blob: BrushDab[] = [];
    for (let row = 0; row < 10; row++) {
      for (let i = 0; i <= 40; i++) blob.push(dab(0.35 + (i / 40) * 0.3, 0.35 + row * 0.03, 0.03));
    }
    const regions: HealRegion[] = [
      circle(0.3, 0.4, 0.01),
      circle(0.5, 0.5, 0.05),
      circle(0.5, 0.5, 0.15),
      stroke(0.2, 0.6, 0.7, 0.6, 0.01, 1024 / 683),
      { kind: "brush", dabs: blob },
    ];
    // One untimed pick first, so the bound measures picks rather than JIT warm-up.
    findHealSource(regions[0], "heal");
    for (const region of regions) {
      const t0 = performance.now();
      const src = findHealSource(region, "heal");
      expect(performance.now() - t0).toBeLessThan(250);
      expect(src).not.toBeNull();
    }
  });
});

describe("encodeSrgb8", () => {
  // The reference: the sRGB curve rounded to 8 bits, headroom clipped to white
  // and negatives to black, stored as the search image stores it.
  const stored = new Uint8ClampedArray(1);
  const reference = (v: number) => {
    const c = Math.max(0, v);
    const enc = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    stored[0] = Math.round(Math.min(255, enc * 255));
    return stored[0];
  };
  // v moved by n representable doubles (v > 0).
  const bits = new Float64Array(1);
  const word = new BigInt64Array(bits.buffer);
  const ulps = (v: number, n: number) => {
    bits[0] = v;
    word[0] += BigInt(n);
    return bits[0];
  };

  it("encodes every linear value exactly as the sRGB curve rounds it", () => {
    const values = [0, -0, -1e-12, -0.05, -3, 0.0031308, 1, 1.0000001, 1.85, 12, 1e30, Infinity, -Infinity, NaN];
    for (let i = 0; i <= 200000; i++) values.push(i / 160000);
    // Either side of every step from k − 1 to k: the curve's inverse at k − ½,
    // then a few doubles and a few tiny fractions away.
    for (let k = 1; k <= 255; k++) {
      const e = (k - 0.5) / 255;
      const t = e <= 0.04045 ? e / 12.92 : Math.pow((e + 0.055) / 1.055, 2.4);
      for (let n = -8; n <= 8; n++) values.push(ulps(t, n));
      for (const f of [1e-12, 1e-9, 1e-6, 1e-3]) values.push(t * (1 - f), t * (1 + f));
    }
    const wrong = values.filter((v) => encodeSrgb8(v) !== reference(v));
    expect(wrong).toEqual([]);
  });
});

// The picker's search image, built from a scene-linear RAW source: averaged
// down in linear light, then encoded to 8-bit sRGB.
describe("healImageFromLinear", () => {
  const rgba = (...px: number[][]) => new Float32Array(px.flat());

  it("averages in linear light before encoding", () => {
    // The mean of 0.2 and 0 is 0.1 linear, which encodes to 89.
    const { data, w, h } = healImageFromLinear(
      rgba([0.2, 0.2, 0.2, 1], [0, 0, 0, 1]),
      2,
      1,
      1,
    );
    expect([w, h]).toEqual([1, 1]);
    expect([...data]).toEqual([89, 89, 89, 255]);
  });

  it("encodes a source that already fits texel for texel", () => {
    const { data } = healImageFromLinear(rgba([0.18, 1, 0.001, 1]), 1, 1, 384);
    expect([...data]).toEqual([118, 255, 3, 255]);
  });

  it("clips headroom to white and negatives to black", () => {
    const { data } = healImageFromLinear(rgba([1.85, -0.05, 12, 1]), 1, 1, 384);
    expect([...data]).toEqual([255, 0, 255, 255]);
  });

  it("caps the long edge and keeps the RGBA8 layout", () => {
    const src = new Float32Array(1000 * 500 * 4).fill(0.5);
    const { data, w, h } = healImageFromLinear(src, 1000, 500, 384);
    expect([w, h]).toEqual([384, 192]);
    expect(data).toBeInstanceOf(Uint8ClampedArray);
    expect(data).toHaveLength(384 * 192 * 4);
    expect([...data.subarray(0, 4)]).toEqual([188, 188, 188, 255]);
  });
});
