// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// slSceneLuma is the scene luminance the display transform would receive if
// the core shoulder hadn't compressed it. Version 2's program records it;
// version 1's text is frozen, so it doesn't. Basic's tone block, an
// extension, records what the shoulder took off.

import { describe, expect, it } from "vitest";
import { shippedProgram, stockProgram } from "./stock-program.test-support";
import { DEFAULT_PIPELINE_GLSL, V1_VARIANT, V2_VARIANT } from "./shaders";

// Whitespace doesn't matter to GLSL, and the tone block wraps its long lines.
const squeeze = (glsl: string): string => glsl.replace(/\s+/g, "");

describe("slSceneLuma in the develop program", () => {
  it("is declared on version 2 after the scene-linear stages, before path-to-white and the transform", () => {
    const src = squeeze(shippedProgram(V2_VARIANT, DEFAULT_PIPELINE_GLSL));
    const at = (glsl: string): number => src.indexOf(squeeze(glsl));
    const decl = at("float slSceneLuma = max(luma(lin), 0.0) * slShoulderGain;");
    expect(decl).toBeGreaterThan(0);
    expect(at("float slShoulderGain = 1.0;")).toBeGreaterThan(0);
    expect(decl).toBeLessThan(at("lin = slPathToWhite(lin);"));
    expect(decl).toBeLessThan(at("vec3 disp ="));
  });

  it("undoes the default shoulder on the pixel/region blend the tone block uses", () => {
    const src = squeeze(shippedProgram(V2_VARIANT, DEFAULT_PIPELINE_GLSL));
    const at = (glsl: string): number => src.indexOf(squeeze(glsl));
    const declared = at("float curveRatio = 1.0;");
    const ratio = at(
      "curveRatio = mix(L1 / slToneHighlights(Lx, E, 0.0), B1 / slToneHighlights(Bx, E, 0.0), abs(H));",
    );
    const blended = at("L1 = mix(L1, Lx * B1 / Bx, abs(H));");
    const gain = at("slShoulderGain = Lx * curveRatio / max(L1, 1e-6);");
    expect(declared).toBeGreaterThan(0);
    expect(ratio).toBeGreaterThan(declared);
    // The pixel's curve is read before the region blend overwrites it.
    expect(blended).toBeGreaterThan(ratio);
    expect(gain).toBeGreaterThan(blended);
    expect(at("float slSceneLuma = max(luma(lin), 0.0) * slShoulderGain;")).toBeGreaterThan(gain);
  });

  it("is absent from version 1, whose text is frozen", () => {
    const src = shippedProgram(V1_VARIANT, DEFAULT_PIPELINE_GLSL);
    expect(src).not.toContain("slSceneLuma");
    expect(src).not.toContain("slShoulderGain");
    expect(src).not.toContain("curveRatio");
  });

  it("puts nothing back while Basic is away: its shoulder gain stands in as 1", () => {
    const src = stockProgram(V2_VARIANT, DEFAULT_PIPELINE_GLSL);
    expect(src).toContain("#define slShoulderGain 1.0");
    expect(src).not.toContain("float slShoulderGain");
    expect(src).toContain("float slSceneLuma = max(luma(lin), 0.0) * slShoulderGain;");
  });
});
