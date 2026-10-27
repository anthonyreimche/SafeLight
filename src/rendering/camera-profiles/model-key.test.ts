// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A photo knows its camera by EXIF Make and Model; the camera profile tables
// know it by Adobe's UniqueCameraModel. Both must reduce to the same key.

import { describe, expect, it } from "vitest";
import { modelKey, normalizeModelKey } from "./model-key";

// EXIF Make and Model as the camera writes them, and Adobe's spelling of the
// same camera (from the Adobe Standard DCP file names, 2026-10-26).
const PAIRS: [string, string, string][] = [
  ["NIKON CORPORATION", "NIKON Z 6_2", "Nikon Z 6 2"],
  ["NIKON CORPORATION", "NIKON D3400", "Nikon D3400"],
  ["Canon", "Canon EOS R5", "Canon EOS R5"],
  ["SONY", "ILCE-7M3", "Sony ILCE-7M3"],
  ["Panasonic", "DC-G9M2", "Panasonic DC-G9M2"],
  ["FUJIFILM", "X-T5", "Fujifilm X-T5"],
  ["RICOH IMAGING COMPANY, LTD.", "PENTAX K-1", "PENTAX K-1"],
  ["RICOH IMAGING COMPANY, LTD.", "GR III", "RICOH GR III"],
  ["OM Digital Solutions", "OM-1", "OM Digital Solutions OM-1"],
];

describe("modelKey", () => {
  for (const [make, model, adobe] of PAIRS) {
    it(`meets Adobe's "${adobe}" from ${make} / ${model}`, () => {
      expect(modelKey(make, model)).toBe(normalizeModelKey(adobe));
    });
  }

  it("keeps the first word of a maker it doesn't know", () => {
    expect(modelKey("ACME Imaging Corp.", "X1 Pro")).toBe("acme x1 pro");
  });

  it("has no key for a photo without a model", () => {
    expect(modelKey("NIKON CORPORATION", undefined)).toBeUndefined();
    expect(modelKey("NIKON CORPORATION", "  ")).toBeUndefined();
  });
});

describe("normalizeModelKey", () => {
  it("ignores case, underscores and spacing", () => {
    expect(normalizeModelKey("Nikon Z 6_2")).toBe("nikon z 6 2");
    expect(normalizeModelKey("  RICOH  GR III ")).toBe("ricoh gr iii");
    expect(normalizeModelKey("PENTAX K-1")).toBe(normalizeModelKey("Pentax K-1"));
  });
});
