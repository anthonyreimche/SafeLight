// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// slSceneLuma is the scene luminance the display transform would receive if
// the core shoulder hadn't compressed it. Version 2's program records it;
// version 1's text is frozen, so it doesn't.

import { describe, expect, it } from "vitest";
import { DEFAULT_PIPELINE_GLSL, V1_VARIANT, V2_VARIANT, buildFragmentShader } from "./shaders";

describe("slSceneLuma in the develop program", () => {
  it("is declared on version 2 after the scene-linear stages, before path-to-white and the transform", () => {
    const src = buildFragmentShader(DEFAULT_PIPELINE_GLSL, undefined, V2_VARIANT);
    const decl = src.indexOf("float slSceneLuma = max(luma(lin), 0.0) * slShoulderGain;");
    expect(decl).toBeGreaterThan(0);
    const gain = src.indexOf(
      "slShoulderGain = Lx / max(abs(H) > 0.001 ? slToneHighlights(Lx, E, 0.0) : L1, 1e-6);",
    );
    expect(gain).toBeGreaterThan(0);
    expect(src.indexOf("float slShoulderGain = 1.0;")).toBeLessThan(gain);
    expect(gain).toBeLessThan(decl);
    expect(decl).toBeLessThan(src.indexOf("lin = slPathToWhite(lin);"));
    expect(decl).toBeLessThan(src.indexOf("vec3 disp ="));
  });

  it("is absent from version 1, whose text is frozen", () => {
    const src = buildFragmentShader(DEFAULT_PIPELINE_GLSL, undefined, V1_VARIANT);
    expect(src).not.toContain("slSceneLuma");
    expect(src).not.toContain("slShoulderGain");
  });
});
