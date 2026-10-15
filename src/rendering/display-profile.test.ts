// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A monitor's ICC profile reduced to what the output-space stage applies: the
// sRGB → monitor matrix and the nearest of the stage's three encodes. The
// export profiles color-space.ts builds are matrix/TRC display profiles too,
// so parsing them must give back the very matrices export converts with.

import { describe, expect, it } from "vitest";
import {
  COLOR_SPACES,
  buildIccProfile,
  outMatrixColumnMajor,
  outputColorants,
  type ColorSpaceId,
  type Xyz,
} from "./color-space";
import {
  PROFILE_ERROR,
  monitorToSrgbLinear,
  parseDisplayProfile,
  type DisplayCurve,
  type MonitorTransform,
} from "./display-profile";

type Rgb = [number, number, number];

// ─── A minimal ICC writer for profiles color-space.ts doesn't build ─────────

interface TagSpec {
  sig: string;
  data: Uint8Array;
}

function ascii(bytes: Uint8Array, offset: number, text: string) {
  for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
}

function typed(type: string, body: number): { bytes: Uint8Array; view: DataView } {
  const bytes = new Uint8Array(body);
  ascii(bytes, 0, type);
  return { bytes, view: new DataView(bytes.buffer) };
}

const s15 = (v: number) => Math.round(v * 65536);

function xyzTag(sig: string, [x, y, z]: Xyz): TagSpec {
  const { bytes, view } = typed("XYZ ", 20);
  view.setInt32(8, s15(x));
  view.setInt32(12, s15(y));
  view.setInt32(16, s15(z));
  return { sig, data: bytes };
}

function curvTag(entries: number[]): Uint8Array {
  const { bytes, view } = typed("curv", 12 + entries.length * 2);
  view.setUint32(8, entries.length);
  entries.forEach((e, i) => view.setUint16(12 + i * 2, e));
  return bytes;
}

const gammaCurv = (gamma: number) => curvTag([Math.round(gamma * 256)]);

function paraTag(fn: number, params: number[]): Uint8Array {
  const { bytes, view } = typed("para", 12 + params.length * 4);
  view.setUint16(8, fn);
  params.forEach((p, i) => view.setInt32(12 + i * 4, s15(p)));
  return bytes;
}

function descTag(text: string): Uint8Array {
  const { bytes, view } = typed("desc", 12 + text.length);
  view.setUint32(8, text.length);
  ascii(bytes, 12, text);
  return bytes;
}

function mlucTag(text: string): Uint8Array {
  const { bytes, view } = typed("mluc", 28 + text.length * 2);
  view.setUint32(8, 1);
  view.setUint32(12, 12);
  ascii(bytes, 16, "enUS");
  view.setUint32(20, text.length * 2);
  view.setUint32(24, 28);
  for (let i = 0; i < text.length; i++) view.setUint16(28 + i * 2, text.charCodeAt(i));
  return bytes;
}

/** rXYZ/gXYZ/bXYZ plus one curve shared by all three channels. */
function matrixShaper(colorants: readonly Xyz[], curve: Uint8Array): TagSpec[] {
  return [
    xyzTag("rXYZ", colorants[0]),
    xyzTag("gXYZ", colorants[1]),
    xyzTag("bXYZ", colorants[2]),
    { sig: "rTRC", data: curve },
    { sig: "gTRC", data: curve },
    { sig: "bTRC", data: curve },
  ];
}

function iccProfile(
  tags: TagSpec[],
  { colorSpace = "RGB ", signature = "acsp" } = {},
): Uint8Array {
  const align4 = (n: number) => (n + 3) & ~3;
  let cursor = 128 + 4 + tags.length * 12;
  const offsets = tags.map((t) => {
    const at = cursor;
    cursor = align4(cursor + t.data.length);
    return at;
  });
  const bytes = new Uint8Array(cursor);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, cursor);
  view.setUint32(8, 0x04300000);
  ascii(bytes, 12, "mntr");
  ascii(bytes, 16, colorSpace);
  ascii(bytes, 20, "XYZ ");
  ascii(bytes, 36, signature);
  view.setUint32(128, tags.length);
  tags.forEach((t, i) => {
    ascii(bytes, 132 + i * 12, t.sig);
    view.setUint32(136 + i * 12, offsets[i]);
    view.setUint32(140 + i * 12, t.data.length);
    bytes.set(t.data, offsets[i]);
  });
  return bytes;
}

function parsed(bytes: Uint8Array) {
  const result = parseDisplayProfile(bytes);
  if (!result.ok) throw new Error(`refused: ${result.error}`);
  return result.profile;
}

function refusal(bytes: Uint8Array): string {
  const result = parseDisplayProfile(bytes);
  if (result.ok) throw new Error("parsed a profile it should refuse");
  return result.error;
}

function expectMatrix(actual: Float32Array, expected: Float32Array, tolerance = 1e-4) {
  expect(actual).toHaveLength(9);
  for (let i = 0; i < 9; i++) expect(Math.abs(actual[i] - expected[i])).toBeLessThan(tolerance);
}

// ─── Parsing ────────────────────────────────────────────────────────────────

const EXPECTED: Record<ColorSpaceId, { curve: DisplayCurve; description: string }> = {
  srgb: { curve: "srgb", description: "sRGB" },
  "display-p3": { curve: "srgb", description: "Display P3" },
  "adobe-rgb": { curve: "gamma22", description: "Adobe RGB (1998) compatible" },
  "prophoto-rgb": { curve: "gamma18", description: "ProPhoto RGB compatible" },
};

describe("parseDisplayProfile", () => {
  for (const { value: id } of COLOR_SPACES) {
    it(`reads ${id}'s export profile as the matrix and curve export converts with`, () => {
      const profile = parsed(buildIccProfile(id));
      expectMatrix(profile.transform.matrix, outMatrixColumnMajor(id));
      expect(profile.transform.curve).toBe(EXPECTED[id].curve);
      expect(profile.description).toBe(EXPECTED[id].description);
    });
  }

  it("reads a one-entry curv as a gamma", () => {
    const adobe = outputColorants("adobe-rgb");
    const profile = parsed(iccProfile(matrixShaper(adobe, gammaCurv(2.2))));
    expect(profile.transform.curve).toBe("gamma22");
    expectMatrix(profile.transform.matrix, outMatrixColumnMajor("adobe-rgb"));
  });

  it("reads parametric curves", () => {
    const srgb = outputColorants("srgb");
    const piecewise = paraTag(3, [2.4, 1 / 1.055, 0.055 / 1.055, 1 / 12.92, 0.04045]);
    expect(parsed(iccProfile(matrixShaper(srgb, piecewise))).transform.curve).toBe("srgb");
    const gamma = paraTag(0, [1.8]);
    expect(parsed(iccProfile(matrixShaper(srgb, gamma))).transform.curve).toBe("gamma18");
  });

  it("reads an empty curv as the identity", () => {
    const profile = parsed(iccProfile(matrixShaper(outputColorants("srgb"), curvTag([]))));
    expect(profile.transform.curve).toBe("gamma18");
  });

  it("reads a version 4 description", () => {
    const tags = [
      ...matrixShaper(outputColorants("display-p3"), gammaCurv(2.2)),
      { sig: "desc", data: mlucTag("Studio Monitor") },
    ];
    expect(parsed(iccProfile(tags)).description).toBe("Studio Monitor");
  });

  it("reads a description of any length, keeping its start", () => {
    const tags = [
      ...matrixShaper(outputColorants("srgb"), gammaCurv(2.2)),
      { sig: "desc", data: descTag("Monitor ".repeat(25_000)) },
    ];
    const { description } = parsed(iccProfile(tags));
    expect(description.startsWith("Monitor Monitor")).toBe(true);
    expect(description.length).toBeLessThanOrEqual(256);
  });

  it("names nothing when the profile carries no description", () => {
    const profile = parsed(iccProfile(matrixShaper(outputColorants("srgb"), gammaCurv(2.2))));
    expect(profile.description).toBe("");
  });

  it("uses the matrix and curves of a profile that also carries LUTs", () => {
    const tags = [
      ...matrixShaper(outputColorants("adobe-rgb"), gammaCurv(2.2)),
      { sig: "A2B0", data: curvTag([0, 65535]) },
    ];
    expectMatrix(parsed(iccProfile(tags)).transform.matrix, outMatrixColumnMajor("adobe-rgb"));
  });

  it("reads a profile handed over at an offset into a larger buffer", () => {
    const profile = buildIccProfile("adobe-rgb");
    const padded = new Uint8Array(profile.length + 16);
    padded.set(profile, 16);
    const shifted = padded.subarray(16);
    expectMatrix(parsed(shifted).transform.matrix, outMatrixColumnMajor("adobe-rgb"));
  });

  describe("refuses", () => {
    const valid = () => iccProfile(matrixShaper(outputColorants("srgb"), gammaCurv(2.2)));

    it("a file too short to be a profile", () => {
      expect(refusal(new Uint8Array(100))).toBe(PROFILE_ERROR.notIcc);
    });

    it("a file without the profile signature", () => {
      const tags = matrixShaper(outputColorants("srgb"), gammaCurv(2.2));
      expect(refusal(iccProfile(tags, { signature: "nope" }))).toBe(PROFILE_ERROR.notIcc);
    });

    it("a profile longer than the file", () => {
      const bytes = valid();
      expect(refusal(bytes.subarray(0, bytes.length - 4))).toBe(PROFILE_ERROR.notIcc);
    });

    it("a tag that runs past the end of the profile", () => {
      const bytes = valid();
      new DataView(bytes.buffer).setUint32(140, 1 << 20);
      expect(refusal(bytes)).toBe(PROFILE_ERROR.notIcc);
    });

    it("a profile that isn't RGB", () => {
      const tags = matrixShaper(outputColorants("srgb"), gammaCurv(2.2));
      expect(refusal(iccProfile(tags, { colorSpace: "CMYK" }))).toBe(PROFILE_ERROR.notRgb);
    });

    it("a profile without all three tone curves", () => {
      const tags = matrixShaper(outputColorants("srgb"), gammaCurv(2.2)).filter(
        (t) => t.sig !== "gTRC",
      );
      expect(refusal(iccProfile(tags))).toBe(PROFILE_ERROR.noMatrix);
    });

    it("a curve type it can't read", () => {
      const tags = matrixShaper(outputColorants("srgb"), paraTag(9, [2.2]));
      expect(refusal(iccProfile(tags))).toBe(PROFILE_ERROR.curveType);
    });

    it("a matrix with its primaries swapped round", () => {
      const [r, g, b] = outputColorants("srgb");
      expect(refusal(iccProfile(matrixShaper([g, b, r], gammaCurv(2.2))))).toBe(
        PROFILE_ERROR.primaries,
      );
    });
  });
});

// ─── The eyedroppers' way back ──────────────────────────────────────────────

// encodeOutput (shaders.ts) for the three codes a display curve borrows.
const ENCODE: Record<DisplayCurve, (v: number) => number> = {
  srgb: (v) => (v < 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055),
  gamma22: (v) => Math.pow(v, 1 / 2.19921875),
  gamma18: (v) => (v < 0.001953125 ? v * 16 : Math.pow(v, 1 / 1.8)),
};

function encodeOutput(t: MonitorTransform, lin: Rgb): Rgb {
  const m = t.matrix;
  const out: Rgb = [0, 0, 0];
  for (let row = 0; row < 3; row++) {
    const v = m[row] * lin[0] + m[3 + row] * lin[1] + m[6 + row] * lin[2];
    out[row] = ENCODE[t.curve](Math.min(1, Math.max(0, v)));
  }
  return out;
}

describe("monitorToSrgbLinear", () => {
  const COLOURS: Rgb[] = [
    [0.18, 0.18, 0.18],
    [0.9, 0.05, 0.02],
    [0.02, 0.6, 0.1],
    [0.05, 0.08, 0.7],
    [1, 1, 1],
  ];

  it("keeps a monitor colour sRGB can't hold inside sRGB's range", () => {
    const back = monitorToSrgbLinear(parsed(buildIccProfile("adobe-rgb")).transform);
    for (const v of back(0, 1, 0)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  for (const id of ["display-p3", "adobe-rgb", "prophoto-rgb"] as const) {
    it(`undoes the ${id} conversion of an sRGB colour`, () => {
      const t = parsed(buildIccProfile(id)).transform;
      const back = monitorToSrgbLinear(t);
      for (const lin of COLOURS) {
        const shown = encodeOutput(t, lin);
        const measured = back(shown[0], shown[1], shown[2]);
        for (let c = 0; c < 3; c++) expect(Math.abs(measured[c] - lin[c])).toBeLessThan(1e-4);
      }
    });
  }
});
