// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The version 2 Highlights and Shadows curves, and the regional blend that
// keeps a pixel's ratio to its surroundings.

import { describe, expect, it } from "vitest";
import {
  LOCAL_TONE_GLSL,
  localToneBlend,
  pathToWhite,
  toneHighlights,
  toneShadows,
} from "./local-tone";
import { V2_VARIANT, buildFragmentShader } from "./webgl/shaders";

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
}

/** shaders.ts's version 1 tone block on luminance alone (its colour steps keep
 *  luminance): the shoulder with white held at 1.0, the lift, then Shadows. */
function versionOneChain(lx: number, e: number, h: number, s: number, skip: boolean): number {
  let knee = 0.85;
  let rolloff = 0.5;
  if (h < 0) {
    knee = lerp(0.85, 0.15, -h);
    rolloff = lerp(0.5, 0.2, -h);
  } else if (h > 0) {
    knee = lerp(0.85, 2.0, h);
    rolloff = lerp(0.5, 1.5, h);
  }
  rolloff = Math.max(rolloff, 1 - knee);
  rolloff *= Math.max(2 ** (Math.max(e, 0) * 0.5), 1);
  let y = lx;
  if (lx > knee) {
    const excess = lx - knee;
    y = knee + ((1 - knee) * excess) / (excess + rolloff);
  }
  if (skip) y = lerp(lx, y, Math.max(-h, 0));
  if (h > 0.001) {
    const y0 = Math.max(y, 1e-4);
    let z = lerp(y0, y0 ** lerp(1, 0.5, h), smoothstep(0.3, 0.9, y0) * h);
    if (skip) z = Math.max(z, y0);
    y = z;
  }
  if (Math.abs(s) > 0.001) {
    const y0 = Math.max(y, 1e-4);
    const g = s > 0 ? lerp(1, 0.65, s) : lerp(1, 1.8, -s);
    y = lerp(y0, y0 ** g, Math.exp(-3 * y0) * Math.abs(s));
  }
  return y;
}

const VALUES = [0.002, 0.05, 0.18, 0.5, 0.9, 1.2, 2.5, 8];
const RAMP = [0.5, 1.0, 1.2, 1.425, 1.6, 2.0, 3.0, 6.0, 12.0];

describe("toneHighlights and toneShadows", () => {
  it("match version 1's per-pixel chain wherever Highlights is 0 or below", () => {
    for (const skip of [false, true])
      for (const e of [-1, 0, 1.5])
        for (const h of [0, -0.3, -1])
          for (const s of [-1, -0.4, 0, 0.6, 1])
            for (const x of VALUES) {
              const got = toneShadows(toneHighlights(x, e, h, skip), s);
              expect(got, `x ${x} e ${e} h ${h} s ${s} skip ${skip}`).toBeCloseTo(
                versionOneChain(x, e, h, s, skip),
                12,
              );
            }
  });

  it("keeps brighter input brighter at every Highlights above 0", () => {
    for (const h of [0.01, 0.13, 0.25, 0.5, 1])
      for (const e of [0, 2]) {
        const out = RAMP.map((x) => toneHighlights(x, e, h, false));
        for (let i = 1; i < out.length; i++) {
          expect(out[i], `h ${h} e ${e} at ${RAMP[i]}`).toBeGreaterThan(out[i - 1]);
        }
      }
  });

  it("meets the Highlights 0 curve one slider step above it", () => {
    for (const x of RAMP) {
      expect(Math.abs(toneHighlights(x, 0, 0.01, false) - toneHighlights(x, 0, 0, false))).toBeLessThan(0.025);
    }
  });
});

describe("localToneBlend", () => {
  it("changes nothing with Highlights and Shadows at 0, whatever the region", () => {
    for (const skip of [false, true])
      for (const L of [0.01, 0.4, 1.7])
        for (const B of [L / 4, L, L * 4]) {
          const { l1, l2 } = localToneBlend(L, B, 1, 0, 0, skip);
          expect(l1).toBe(toneHighlights(L * 2, 1, 0, skip));
          expect(l2).toBe(l1);
        }
  });

  it("matches the per-pixel curves on a pixel that is its own region", () => {
    for (const [h, s] of [[-1, 0], [-0.4, 0.6], [0.3, -0.5], [1, 1]]) {
      const { l2 } = localToneBlend(0.7, 0.7, 0.5, h, s, false);
      expect(l2).toBeCloseTo(toneShadows(toneHighlights(0.7 * 2 ** 0.5, 0.5, h, false), s), 12);
    }
  });

  it("keeps the ratio between two pixels of one bright region at Highlights -100", () => {
    const a = localToneBlend(1.8, 1.5, 0, -1, 0, false).l2;
    const b = localToneBlend(1.2, 1.5, 0, -1, 0, false).l2;
    expect(a / b).toBeCloseTo(1.5, 12);
  });

  it("keeps the ratio between two pixels of one dark region at Shadows +100", () => {
    const a = localToneBlend(0.024, 0.02, 0, 0, 1, false).l2;
    const b = localToneBlend(0.016, 0.02, 0, 0, 1, false).l2;
    expect(a / b).toBeCloseTo(1.5, 12);
  });

  it("darkens a bright region step by step as Highlights goes down", () => {
    const out = [0, -0.25, -0.5, -0.75, -1].map((h) => localToneBlend(1.5, 1.5, 0, h, 0, false).l2);
    for (let i = 1; i < out.length; i++) expect(out[i]).toBeLessThan(out[i - 1]);
  });

  it("lifts a dark region step by step as Shadows goes up", () => {
    const out = [0, 0.25, 0.5, 0.75, 1].map((s) => localToneBlend(0.02, 0.02, 0, 0, s, false).l2);
    for (let i = 1; i < out.length; i++) expect(out[i]).toBeGreaterThan(out[i - 1]);
  });

  it("lets a pixel a stop above its region reach white at Highlights -100", () => {
    expect(localToneBlend(3, 2, 0, -1, 0, false).l2).toBeGreaterThan(1);
    expect(toneHighlights(3, 0, -1, false)).toBeLessThan(0.85);
  });

  it("floors the pixel and its region at 1e-4, as the shader does", () => {
    for (const [h, s] of [[-1, 0], [0, 1], [1, -1]]) {
      const atZero = localToneBlend(0, 0, 0, h, s, false);
      const atFloor = localToneBlend(1e-4, 1e-4, 0, h, s, false);
      expect(atZero).toEqual(atFloor);
      expect(Number.isFinite(atZero.l2)).toBe(true);
      expect(localToneBlend(1e-3, 1e-6, 0, h, s, false)).toEqual(localToneBlend(1e-3, 1e-4, 0, h, s, false));
    }
  });

  it("darkens a pixel on a near-black region as Exposure goes down", () => {
    const at = (e: number) => localToneBlend(0.01, 1e-4, e, 0, 1, false).l2;
    expect(at(-2)).toBeLessThan(at(0));
  });
});

describe("the cost of the region base", () => {
  it("reads the source twenty times a pixel: the guide's four taps and the two rings", () => {
    expect(LOCAL_TONE_GLSL.match(/\btexture(?:Lod)?\s*\(/g)).toHaveLength(1);
    expect(LOCAL_TONE_GLSL.match(/\bslLocalToneTap\(/g)).toHaveLength(3);
    expect(LOCAL_TONE_GLSL).toContain("for (int i = 0; i < 4; i++)");
    expect(LOCAL_TONE_GLSL).toContain("for (int ring = 0; ring < 2; ring++)");
    expect(LOCAL_TONE_GLSL).toContain("for (int i = 0; i < 8; i++)");
    const v2 = buildFragmentShader(null, undefined, V2_VARIANT);
    expect(v2.match(/\bslLocalToneBase\(/g)).toHaveLength(2);
  });
});

type Rgb = [number, number, number];
const lumaOf = ([r, g, b]: Rgb) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const scaled = ([r, g, b]: Rgb, k: number): Rgb => [r * k, g * k, b * k];
const SATURATED: Rgb[] = [[1, 0.3, 0.1], [0.2, 1, 0.15], [0.1, 0.25, 1], [1, 0.9, -0.05], [0.9, 0.05, 0.6]];

describe("pathToWhite", () => {
  it("leaves a colour whose strongest channel is at most 0.9 as it is", () => {
    for (const c of [[0.9, 0.3, 0.1], [0.5, 0.5, 0.5], [0.02, 0.4, 0.88], [0.9, -0.1, 0.2]] as Rgb[]) {
      expect(pathToWhite(c)).toEqual(c);
    }
  });

  it("keeps the luminance of a bright saturated colour", () => {
    for (const c of SATURATED)
      for (const k of [1, 1.5, 3, 8]) {
        const lit = scaled(c, k * 0.4);
        if (lumaOf(lit) >= 1) continue;
        expect(lumaOf(pathToWhite(lit))).toBeCloseTo(lumaOf(lit), 12);
      }
  });

  it("keeps every channel below white while the luminance is", () => {
    for (const c of SATURATED)
      for (const k of [1, 1.5, 3, 8, 30]) {
        const lit = scaled(c, k * 0.4);
        if (lumaOf(lit) >= 1) continue;
        expect(Math.max(...pathToWhite(lit))).toBeLessThan(1);
      }
  });

  it("only moves a colour straight toward the grey of its luminance", () => {
    const c: Rgb = [1.4, 0.42, 0.14];
    const L = lumaOf(c);
    const out = pathToWhite(c);
    const ratio = (out[0] - L) / (c[0] - L);
    expect(ratio).toBeGreaterThan(0);
    expect(ratio).toBeLessThan(1);
    for (let i = 1; i < 3; i++) expect(out[i] - L).toBeCloseTo(ratio * (c[i] - L), 12);
  });

  it("turns whiter step by step as a colour brightens", () => {
    const saturation = (c: Rgb) => (Math.max(...c) - Math.min(...c)) / Math.max(...c);
    // Up to the brightness where the luminance itself reaches white.
    const out = [0.9, 1.2, 1.6, 2.2, 2.6].map((k) => saturation(pathToWhite(scaled([0.8, 0.24, 0.08], k))));
    for (let i = 1; i < out.length; i++) expect(out[i]).toBeLessThan(out[i - 1]);
  });

  it("starts without a jump at a strongest channel of 0.9", () => {
    const below = pathToWhite([0.9, 0.3, 0.1]);
    const above = pathToWhite([0.9001, 0.30003, 0.10001]);
    for (let i = 0; i < 3; i++) expect(Math.abs(above[i] - below[i])).toBeLessThan(2e-4);
  });

  it("leaves a grey alone, however bright", () => {
    for (const v of [0.95, 1, 1.3]) expect(pathToWhite([v, v, v])).toEqual([v, v, v]);
  });
});
