// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, expect, it } from "vitest";
import { OUT_SPACE_CODE, buildIccProfile, outMatrix, outMatrixColumnMajor, type ColorSpaceId } from "./color-space";
import { parseDisplayProfile } from "./display-profile";
import {
  JND, OUTPUT_MAP_GLSL, STEPS, gamutMap, gamutShift, lmsMatrices, lmsUniforms, outputPixel, proofUniforms,
} from "./output-map";
import { mat3Invert, mat3Mul, type Mat3 } from "./transform";
import {
  REC2020_TO_REC709, REC709_TO_REC2020, apply3, decodePerceptual, encodePerceptual, type Vec3,
} from "./stage-space";
import { V3_VARIANT, buildFragmentShader } from "./webgl/shaders";

const vec3 = (xs: readonly number[]): Vec3 => [xs[0], xs[1], xs[2]];

const TARGETS: ColorSpaceId[] = ["srgb", "display-p3", "adobe-rgb", "prophoto-rgb"];
const SRGB_TO_XYZ: Mat3 = [0.4124564, 0.3575761, 0.1804375, 0.2126729, 0.7151522, 0.072175, 0.0193339, 0.119192, 0.9503041];
const D65: Vec3 = [0.95047, 1, 1.08883];
const labOfSrgb = (rgb: Vec3): Vec3 => {
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  const [fx, fy, fz] = apply3(SRGB_TO_XYZ, rgb).map((v, k) => f(v / D65[k]));
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
};
function deltaE00([L1, a1, b1]: Vec3, [L2, a2, b2]: Vec3): number {
  const rad = Math.PI / 180;
  const Cb = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const [a1p, a2p] = [(1 + G) * a1, (1 + G) * a2];
  const [C1p, C2p] = [Math.hypot(a1p, b1), Math.hypot(a2p, b2)];
  const hue = (b: number, a: number) => ((Math.atan2(b, a) / rad) + 360) % 360;
  const [h1, h2] = [hue(b1, a1p), hue(b2, a2p)];
  let dh = h2 - h1;
  if (dh > 180) dh -= 360;
  if (dh < -180) dh += 360;
  const dH = 2 * Math.sqrt(C1p * C2p) * Math.sin((dh / 2) * rad);
  const Lb = (L1 + L2) / 2;
  const Cbp = (C1p + C2p) / 2;
  let hb = h1 + h2;
  if (Math.abs(h1 - h2) > 180) hb += 360;
  hb /= 2;
  const T = 1 - 0.17 * Math.cos((hb - 30) * rad) + 0.24 * Math.cos(2 * hb * rad)
    + 0.32 * Math.cos((3 * hb + 6) * rad) - 0.2 * Math.cos((4 * hb - 63) * rad);
  const SL = 1 + (0.015 * (Lb - 50) ** 2) / Math.sqrt(20 + (Lb - 50) ** 2);
  const SC = 1 + 0.045 * Cbp;
  const SH = 1 + 0.015 * Cbp * T;
  const RT = -2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7)) * Math.sin(60 * Math.exp(-(((hb - 275) / 25) ** 2)) * rad);
  const [x, y, z] = [(L2 - L1) / SL, (C2p - C1p) / SC, dH / SH];
  return Math.sqrt(x * x + y * y + z * z + RT * y * z);
}

// OkLab of linear sRGB, for hue and lightness checks.
const okOfSrgb = (rgb: Vec3): Vec3 => {
  const lms = apply3([0.4122214708, 0.5363325363, 0.0514459929, 0.2119034982, 0.6806995451, 0.1073969566, 0.0883024619, 0.2817188376, 0.6299787005], rgb);
  return apply3([0.2104542553, 0.793617785, -0.0040720468, 1.9779984951, -2.428592205, 0.4505937099, 0.0259040371, 0.7827717662, -0.808675766], vec3(lms.map(Math.cbrt)));
};
// The inverse of okOfSrgb, from Ottosson's published OkLab code.
const srgbOfOk = ([L, a, b]: Vec3): Vec3 => {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
};
const okHue = (ok: Vec3) => (Math.atan2(ok[2], ok[1]) * 180) / Math.PI;
const okChroma = (ok: Vec3) => Math.hypot(ok[1], ok[2]);

// The reviewer's colours (linear Adobe RGB) as working Rec.709, through the
// primaries' XYZ matrices as the spec measured them. The app's own sRGB to
// Adobe matrix, inverted, would put cyan exactly on Adobe RGB's boundary
// instead of 4e-5 inside it, which moves its Adobe cell from 0.349 to 0.350.
const ADOBE_TO_XYZ: Mat3 = [0.5767309, 0.185554, 0.1881852, 0.2973769, 0.6273491, 0.0752741, 0.0270343, 0.0706872, 0.9911085];
const ADOBE_TO_SRGB = mat3Mul(mat3Invert(SRGB_TO_XYZ), ADOBE_TO_XYZ);
const REVIEWER_IN_ADOBE: [string, Vec3][] = [
  ["green", [0, 1, 0]],
  ["cyan", [0, 0.8, 0.8]],
  ["blue-green", [0.05, 0.45, 0.3]],
  ["deep cyan", [0.02, 0.25, 0.35]],
  ["orange-yellow", [0.9, 0.55, 0]],
];
const REVIEWER: [string, Vec3][] = REVIEWER_IN_ADOBE.map(([name, adobe]) => [name, apply3(ADOBE_TO_SRGB, adobe)]);

/** ΔE00 between the intended colour and what a v3 export to `id` holds. Adobe
 *  RGB is read back from a 16-bit file, as the spec measured it; the others as
 *  the mapped float. */
function exportError(work: Vec3, id: ColorSpaceId): number {
  const out = outMatrix(id);
  const mapped = gamutMap(apply3(out, work), lmsMatrices(out));
  const gamma = 2.19921875;
  const to16Bit = (v: number) => Math.round(Math.pow(v, 1 / gamma) * 65535) / 65535;
  const held = id === "adobe-rgb" ? vec3(mapped.map((v) => Math.pow(to16Bit(v), gamma))) : mapped;
  return deltaE00(labOfSrgb(work), labOfSrgb(apply3(mat3Invert(out), held)));
}

// The expected values are the spec's one-decimal measurements; ±0.1 is its tolerance.
const within = (cell: string, actual: number, expected: number) =>
  expect(Math.abs(actual - expected), cell).toBeLessThanOrEqual(0.1);

describe("T1: the reviewer's colours, knee 0.95 (spec section 2)", () => {
  const expected: Record<string, [number, number, number]> = {
    //               Adobe RGB 16-bit, Display P3, sRGB
    green: [0.5, 6.4, 12.7],
    cyan: [0.3, 3.9, 8.3],
    "blue-green": [0.0, 0.9, 5.6],
    "deep cyan": [0.0, 1.2, 4.6],
    "orange-yellow": [0.6, 0.0, 2.8],
  };
  for (const [name, work] of REVIEWER) {
    it(`${name} lands where the spec measured it`, () => {
      const [adobe, p3, srgb] = expected[name];
      within("Adobe RGB", exportError(work, "adobe-rgb"), adobe);
      within("Display P3", exportError(work, "display-p3"), p3);
      within("sRGB", exportError(work, "srgb"), srgb);
    });
  }
});

// Bright Rec.2020 light and the reviewer's colours, mapped into sRGB.
const OUT_OF_GAMUT: Vec3[] = [
  ...REVIEWER.map(([, w]) => w),
  ...([[0, 0.9, 0.9], [0.1, 0.8, 0.1], [0.9, 0.1, 0.9], [0.95, 0.4, 0], [0.05, 0.1, 0.9]] as Vec3[]).map((c) =>
    apply3(REC2020_TO_REC709, c),
  ),
];
const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const toSrgb = (lin: Vec3) => gamutMap(lin, lmsMatrices(IDENTITY));

/** `after` (linear sRGB) holds `before`'s OkLab hue to 0.1 degrees and lightness to 0.001. */
function expectHueAndLightnessKept(before: Vec3, after: Vec3) {
  const [from, to] = [okOfSrgb(before), okOfSrgb(after)];
  let dh = Math.abs(okHue(to) - okHue(from));
  if (dh > 180) dh = 360 - dh;
  expect(dh).toBeLessThan(0.1);
  expect(Math.abs(to[0] - from[0])).toBeLessThan(0.001);
}

describe("T2: mapping keeps hue and lightness", () => {
  it.each(OUT_OF_GAMUT.map((c) => [c]))("%j", (c) => expectHueAndLightnessKept(c, toSrgb(c)));
});

describe("T3: colours below the knee come back unchanged", () => {
  const inside: Vec3[] = [[0.1, 0.3, 0.05], [0.2, 0.4, 0.9], [0.6, 0.35, 0.25], [0.5, 0.5, 0.5],
    ...Array.from({ length: 11 }, (_, i): Vec3 => [i / 10, i / 10, i / 10])];
  it.each(inside.map((c) => [c]))("%j", (c) => expect(toSrgb(c)).toEqual(c));
});

// A Linux monitor narrower than sRGB: each primary is sRGB's own mixed 70/30
// with white, so sRGB's primaries lie outside it. MONITOR is sRGB-linear to
// display-linear, the matrix the renderer binds for a profile, and the output
// map has to work in that space.
const MONITOR_PRIMARIES: Mat3 = [0.8, 0.1, 0.1, 0.1, 0.8, 0.1, 0.1, 0.1, 0.8];
const MONITOR = mat3Invert(MONITOR_PRIMARIES);
const toMonitor = (lin: Vec3) => gamutMap(apply3(MONITOR, lin), lmsMatrices(MONITOR));

describe("T2 in a monitor's space: mapping keeps hue and lightness", () => {
  // The last three sit inside sRGB but outside this monitor.
  const outside: Vec3[] = [...OUT_OF_GAMUT, [0.9, 0.1, 0.1], [0.1, 0.8, 0.2], [0.1, 0.2, 0.9]];
  it.each(outside.map((c) => [c]))("%j", (c) => {
    expect(apply3(MONITOR, c).some((v) => v < 0 || v > 1), "outside the monitor").toBe(true);
    expectHueAndLightnessKept(c, apply3(MONITOR_PRIMARIES, toMonitor(c)));
  });
});

describe("T3 in a monitor's space: colours inside it come back unchanged", () => {
  const inside: Vec3[] = [[0.4, 0.3, 0.25], [0.2, 0.3, 0.4], [0.6, 0.35, 0.25], [0.3, 0.35, 0.25], [0.5, 0.5, 0.5], [0.1, 0.1, 0.1]];
  it.each(inside.map((c) => [c]))("%j", (c) => {
    const shown = apply3(MONITOR, c);
    expect(shown.every((v) => v >= 0 && v <= 1), "inside the monitor").toBe(true);
    expect(toMonitor(c)).toEqual(shown);
  });
});

describe("T4: a chroma ramp keeps its order", () => {
  // Red-orange at OkLab L 0.7, hue 30°, where sRGB's boundary is at chroma 0.19
  // and Rec.2020's at 0.31. The ramp stops short of Rec.2020's, past which the
  // map is flat by design. At 41 samples the order is strict; 400-sample ramps
  // dip by up to 2.25e-4 OkLab chroma (1% of a JND) from the 10-step bisection.
  const hue = (30 * Math.PI) / 180;
  const ramp = Array.from({ length: 41 }, (_, k) => {
    const chroma = (0.28 * k) / 40;
    return srgbOfOk([0.7, chroma * Math.cos(hue), chroma * Math.sin(hue)]);
  });
  const inUnitCube = (rgb: Vec3) => rgb.every((v) => v >= 0 && v <= 1);

  it("runs from inside sRGB to well past its boundary, still inside Rec.2020", () => {
    expect(inUnitCube(ramp[0])).toBe(true);
    expect(ramp.filter((c) => !inUnitCube(c)).length).toBeGreaterThanOrEqual(10);
    expect(inUnitCube(apply3(REC709_TO_REC2020, ramp[40]))).toBe(true);
  });
  it("maps rising chroma at constant L and h to non-decreasing chroma, rising past the boundary", () => {
    let last = -1;
    for (const lin of ramp) {
      const c = okChroma(okOfSrgb(toSrgb(lin)));
      expect(c).toBeGreaterThanOrEqual(last - 1e-9);
      if (!inUnitCube(lin)) expect(c).toBeGreaterThan(last);
      last = c;
    }
  });
});

describe("T5: the output is always a colour", () => {
  const extremes: Vec3[] = [
    [0, 0, 0], [1e-9, -1e-9, 0], [-0.5, -0.2, -0.1], [1e4, 1e4, 1e4], [1.5, 0.2, 0.2], [-1e-9, -1e-9, -1e-9],
    // Chroma so far past sRGB's boundary that the bisection's last step still lands outside it.
    [0.037, 1.316, 1.459],
  ];
  for (const id of TARGETS) {
    it.each(extremes.map((c) => [c]))(`${id} %j`, (c) => {
      for (const v of gamutMap(c, lmsMatrices(outMatrix(id)))) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    });
  }
});

/** A Float32 uniform, read column-major, equals the row-major `expected`. */
function expectColumnMajor(uniform: Float32Array, expected: Mat3): void {
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      expect(Math.abs(uniform[col * 3 + row] - expected[row * 3 + col]), `${row},${col}`).toBeLessThanOrEqual(1e-6);
    }
  }
}

describe("lmsUniforms", () => {
  it.each(TARGETS)("%s: the Float32 uniforms read column-major equal lmsMatrices", (id) => {
    const expected = lmsMatrices(outMatrix(id));
    const uniforms = lmsUniforms(outMatrixColumnMajor(id));
    expectColumnMajor(uniforms.toLms, expected.toLms);
    expectColumnMajor(uniforms.fromLms, expected.fromLms);
  });
});

describe("proofUniforms", () => {
  // Proof space, display, and whether the display holds the proof space whole.
  const PAIRS: [ColorSpaceId, ColorSpaceId, boolean][] = [
    ["srgb", "display-p3", true],
    ["srgb", "adobe-rgb", true],
    ["display-p3", "display-p3", true],
    ["prophoto-rgb", "display-p3", false],
    ["adobe-rgb", "display-p3", false],
    ["display-p3", "srgb", false],
  ];
  it.each(PAIRS)("%s on %s: the proof's LMS pair, proof to display, and whether it fits", (proof, display, fits) => {
    const uniforms = proofUniforms(outMatrixColumnMajor(proof), outMatrixColumnMajor(display));
    expectColumnMajor(uniforms.toLms, lmsMatrices(outMatrix(proof)).toLms);
    expectColumnMajor(uniforms.fromLms, lmsMatrices(outMatrix(proof)).fromLms);
    expectColumnMajor(uniforms.toOut, mat3Mul(outMatrix(display), mat3Invert(outMatrix(proof))));
    expect(uniforms.fits).toBe(fits);
  });

  it("lets a monitor profile's rounding hold sRGB whole", () => {
    const parsed = parseDisplayProfile(buildIccProfile("adobe-rgb"));
    if (!parsed.ok) throw new Error(parsed.error);
    expect(proofUniforms(outMatrixColumnMajor("srgb"), parsed.profile.transform.matrix).fits).toBe(true);
  });
});

describe("outputPixel", () => {
  it("encodes an in-gamut sRGB colour with the sRGB curve", () => {
    const [r] = outputPixel([0.5, 0.5, 0.5], IDENTITY, 0);
    expect(r).toBeCloseTo(0.5, 6);
  });
  it("uses the Adobe RGB curve for code 2", () => {
    const [r] = outputPixel([0.5, 0.5, 0.5], outMatrix("adobe-rgb"), 2);
    const lin = Math.pow((0.5 + 0.055) / 1.055, 2.4);
    expect(r).toBeCloseTo(Math.pow(lin, 1 / 2.19921875), 5);
  });
  it("uses the ROMM curve for code 3", () => {
    const [r] = outputPixel([0.5, 0.5, 0.5], outMatrix("prophoto-rgb"), 3);
    const lin = Math.pow((0.5 + 0.055) / 1.055, 2.4);
    expect(r).toBeCloseTo(Math.pow(lin, 1 / 1.8), 5);
  });
});

describe("gamutShift", () => {
  it("is zero inside the knee", () => expect(gamutShift([0.6, 0.45, 0.4], IDENTITY)).toBe(0));
  it.each(OUT_OF_GAMUT.map((c) => [c]))("is the OkLab distance the map moves %j", (c) => {
    const [from, to] = [okOfSrgb(c), okOfSrgb(toSrgb(c))];
    const moved = Math.hypot(from[0] - to[0], from[1] - to[1], from[2] - to[2]);
    expect(gamutShift(vec3(c.map(encodePerceptual)), IDENTITY)).toBeCloseTo(moved, 9);
  });
});

describe("a proof space", () => {
  const P3 = outMatrix("display-p3");
  const PROPHOTO = outMatrix("prophoto-rgb");
  const P3_CODE = OUT_SPACE_CODE["display-p3"];
  const encoded = (lin: Vec3): Vec3 => vec3(lin.map(encodePerceptual));
  // Past sRGB's boundary by the blue primary sRGB and Display P3 share, where
  // mapping the proofed colour again would compress it a second time.
  const SHARED_BLUE: Vec3 = [0.05, -0.1, 1];
  const SCENE: Vec3[] = [...OUT_OF_GAMUT.map(encoded), SHARED_BLUE, [0.6, 0.45, 0.4], [0.5, 0.5, 0.5]];

  it.each(SCENE.map((c) => [c]))("on a display that holds it shows the proof's own output %j", (c) => {
    const proofed = outputPixel(c, P3, P3_CODE, IDENTITY);
    const converted = encoded(apply3(P3, vec3(outputPixel(c, IDENTITY, 0).map(decodePerceptual))));
    for (let ch = 0; ch < 3; ch++) expect(proofed[ch]).toBeCloseTo(converted[ch], 9);
  });

  // Clipped into the display instead, these colours would turn in hue.
  it.each(OUT_OF_GAMUT.map((c) => [c]))("wider than the display is mapped again into it %j", (c) => {
    const shown = vec3(outputPixel(encoded(c), P3, P3_CODE, PROPHOTO).map(decodePerceptual));
    expectHueAndLightnessKept(c, apply3(mat3Invert(P3), shown));
  });

  it("leaves a colour inside both alone", () => {
    const c: Vec3 = [0.6, 0.45, 0.4];
    const plain = outputPixel(c, P3, P3_CODE);
    for (const proof of [IDENTITY, PROPHOTO]) {
      const proofed = outputPixel(c, P3, P3_CODE, proof);
      for (let ch = 0; ch < 3; ch++) expect(proofed[ch]).toBeCloseTo(plain[ch], 9);
    }
  });

  // Spec D7: the warning shows what the proof and the display's map moved together.
  it("moves a colour the display holds by what the proof moves it", () => {
    const p3Green = encoded(apply3(mat3Invert(P3), [0.05, 0.75, 0.1]));
    expect(gamutShift(p3Green, P3)).toBe(0);
    expect(gamutShift(p3Green, P3, IDENTITY)).toBeGreaterThan(JND);
    expect(gamutShift(p3Green, P3, IDENTITY)).toBeCloseTo(gamutShift(p3Green, IDENTITY), 9);
  });
});

/** Each top-level GLSL function's body, by name. */
const bodies = (glsl: string): Record<string, string> =>
  Object.fromEntries([...glsl.matchAll(/^\w+ (\w+)\([^)]*\) \{\n([\s\S]*?)^\}/gm)].map((m) => [m[1], m[2]]));
const callersOf = (fn: string): [string, string][] =>
  Object.entries(bodies(OUTPUT_MAP_GLSL)).filter(([, body]) => new RegExp(`\\b${fn}\\(`).test(body));

describe("OUTPUT_MAP_GLSL's cost", () => {
  it("reads no textures and loops a fixed number of times", () => {
    expect(OUTPUT_MAP_GLSL).not.toMatch(/\btexture|texelFetch/);
    const loops = OUTPUT_MAP_GLSL.match(/for\s*\([^)]*\)/g) ?? [];
    expect(loops.length).toBe(2);
    for (const loop of loops) expect(loop).toBe(`for (int i = 0; i < ${STEPS}; i++)`);
  });
  // Both loops are slGamutMap's, so a pixel pays them for every call it reaches.
  it("maps in slOutputLinear alone: once, and once more for a proof", () => {
    const callers = callersOf("slGamutMap");
    expect(callers.map(([name]) => name)).toEqual(["slOutputLinear"]);
    const body = callers[0][1];
    expect(body.match(/\bslGamutMap\(/g)).toHaveLength(2);
    expect(body).toMatch(/if \(uProof\) \{[^}]*\bslGamutMap\(/);
  });
  it("maps a pixel once in the clipping overlay, the warning reusing the mapped colour", () => {
    expect(callersOf("slOutputLinear").map(([name]) => name)).toEqual(["slOutput"]);
    const overlay = /else if \(uShowClipping > 0\) \{([\s\S]*?)\} else \{/.exec(buildFragmentShader(null, undefined, V3_VARIANT));
    expect(overlay?.[1].match(/\bslOutput\w*\(/g)).toEqual(["slOutputLinear("]);
  });
});
