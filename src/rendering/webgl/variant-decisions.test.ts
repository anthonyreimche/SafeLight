// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What each process version decides in the renderer, pinned as a table: a later
// version adds its own row's behaviour here, and an older version's cannot move
// without one of these cases failing.

import { describe, expect, it } from "vitest";
import { V1_VARIANT, V2_VARIANT, V3_VARIANT } from "./shaders";
import { clippingBits, developedFormatFor, toneShoulderOn } from "./variant-decisions";

const variants = [
  ["v1", V1_VARIANT],
  ["v2", V2_VARIANT],
  ["v3", V3_VARIANT],
] as const;

describe("toneShoulderOn", () => {
  // Version 1 keeps the look its edits were made with when a transform starts
  // setting skipToneShoulder; version 2 and later give the shoulder up.
  const cases = [
    ["v1", V1_VARIANT, false, true],
    ["v1", V1_VARIANT, true, true],
    ["v2", V2_VARIANT, false, true],
    ["v2", V2_VARIANT, true, false],
    ["v3", V3_VARIANT, false, true],
    ["v3", V3_VARIANT, true, false],
  ] as const;
  it.each(cases)("%s, transform skips shoulder %s: %s", (_, variant, skip, expected) => {
    expect(toneShoulderOn(variant, skip)).toBe(expected);
  });
});

describe("developedFormatFor", () => {
  const caps = (float16: boolean, norm16: boolean) => ({ float16, norm16 });
  // [float16 renderable, norm16 available] for each version's expected format.
  const cases = [
    ["v1", V1_VARIANT, true, true, "norm16"],
    ["v1", V1_VARIANT, true, false, "rgba8"],
    ["v1", V1_VARIANT, false, true, "norm16"],
    ["v1", V1_VARIANT, false, false, "rgba8"],
    ["v2", V2_VARIANT, true, true, "float16"],
    ["v2", V2_VARIANT, true, false, "float16"],
    ["v2", V2_VARIANT, false, true, "norm16"],
    ["v2", V2_VARIANT, false, false, "rgba8"],
    ["v3", V3_VARIANT, true, true, "float16"],
    ["v3", V3_VARIANT, true, false, "float16"],
    ["v3", V3_VARIANT, false, true, "norm16"],
    ["v3", V3_VARIANT, false, false, "rgba8"],
  ] as const;
  it.each(cases)("%s, float16 %s, norm16 %s: %s", (_, variant, float16, norm16, expected) => {
    expect(developedFormatFor(variant, caps(float16, norm16))).toBe(expected);
  });
});

describe("clippingBits", () => {
  // Bit 2, the gamut warning, is version 3's: an older program takes any bit as
  // overlay on.
  const expected = { v1: 3, v2: 3, v3: 7 } as const;
  it.each(variants)("%s", (name, variant) => {
    expect(clippingBits(variant)).toBe(expected[name]);
  });
});
