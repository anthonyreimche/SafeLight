// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The develop program's own samplers hold units 0-4 and 6, unit 7 is scratch, and
// stage textures bind from 12 up. Every other unit the context has goes to prepass
// results (SafeLight #155: five units starved a sixth active stage into a no-op).

import { describe, expect, it } from "vitest";
import { prepassUnits } from "./prepass-units";

const from16To31 = Array.from({ length: 16 }, (_, i) => 16 + i);

describe("prepassUnits", () => {
  it("hands out the stage-texture units no texture takes, then every unit above 15", () => {
    expect(prepassUnits(32, 0)).toEqual([8, 9, 10, 11, 5, 12, 13, 14, 15, ...from16To31]);
  });

  it("leaves each stage texture its unit", () => {
    expect(prepassUnits(32, 1)).toEqual([8, 9, 10, 11, 5, 13, 14, 15, ...from16To31]);
    expect(prepassUnits(32, 4)).toEqual([8, 9, 10, 11, 5, ...from16To31]);
  });

  it("counts no more stage textures than the four units the renderer binds them to", () => {
    expect(prepassUnits(32, 6)).toEqual([8, 9, 10, 11, 5, ...from16To31]);
  });

  it("stops below the context's combined unit count", () => {
    expect(prepassUnits(16, 0)).toEqual([8, 9, 10, 11, 5, 12, 13, 14, 15]);
    expect(prepassUnits(16, 4)).toEqual([8, 9, 10, 11, 5]);
    expect(prepassUnits(20, 2)).toEqual([8, 9, 10, 11, 5, 14, 15, 16, 17, 18, 19]);
  });
});
