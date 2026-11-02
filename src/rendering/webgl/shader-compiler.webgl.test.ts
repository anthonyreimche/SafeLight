// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The namespacing that lets mutually unaware extensions share one program, and
// what the renderer does when a contribution is wrong, checked against a driver.

import { describe, expect, it } from "vitest";
import type { ProcessingStageContribution } from "@/extensions/types";
import {
  emitUniformDecl,
  extractHelperNames,
  helperPrefix,
  replaceIdentifiers,
  uniformPrefix,
} from "./shader-compiler";
import { builtinStages, rendererBuildError } from "./webgl.test-support";

const GLOW: ProcessingStageContribution = {
  id: "acme.glow",
  name: "Glow",
  phase: "effects",
  priority: 20,
  glsl: `color = boost(color, amount);`,
  helpers: `vec3 boost(vec3 col, float amt) { return col * (1.0 + amt); }`,
  uniforms: [{ key: "amount", glslType: "float", default: 0.5 }],
};

/** Same uniform key and same helper name as GLOW, from a different extension —
 *  the collision the prefixes exist to absorb. */
const FADE: ProcessingStageContribution = {
  id: "other.fade",
  name: "Fade",
  phase: "scene-linear",
  priority: 10,
  glsl: `color = boost(color, -amount);`,
  helpers: `vec3 boost(vec3 col, float amt) { return mix(col, vec3(luma(col)), abs(amt)); }`,
  uniforms: [{ key: "amount", glslType: "float", default: 0.25 }],
};

const MALFORMED: ProcessingStageContribution = {
  id: "acme.broken",
  name: "Broken",
  phase: "effects",
  glsl: `color = neverDeclared(color) * missingUniform;`,
  uniforms: [],
};

describe("identifier rewriting", () => {
  it("rewrites whole identifiers only", () => {
    expect(replaceIdentifiers("amount + amountScale", ["amount"], "u_")).toBe(
      "u_amount + amountScale",
    );
  });

  it("does not let a short key match inside a longer one it already rewrote", () => {
    expect(replaceIdentifiers("a + aa", ["a", "aa"], "u_")).toBe("u_a + u_aa");
  });

  it("finds every helper a stage declares", () => {
    expect(
      extractHelperNames(`float one(float x) { return x; }
vec3 two(vec3 c) { return c; }
mat3 three() { return mat3(1.0); }`),
    ).toEqual(["one", "two", "three"]);
  });

  it("gives each stage its own uniform and helper prefix", () => {
    expect(uniformPrefix(GLOW.id)).not.toBe(uniformPrefix(FADE.id));
    expect(helperPrefix(GLOW.id)).not.toBe(helperPrefix(FADE.id));
    expect(uniformPrefix(GLOW.id)).toBe(uniformPrefix(GLOW.id));
  });

  it("emits a declaration per uniform type", () => {
    expect(emitUniformDecl({ key: "k", glslType: "vec3", default: [0, 0, 0] }, "u_")).toBe(
      "uniform vec3 u_k;",
    );
    expect(emitUniformDecl({ key: "lut", glslType: "sampler2D", default: 0 }, "u_")).toBe(
      "uniform sampler2D u_lut;",
    );
  });
});

describe("a malformed contribution", () => {
  it("is reported by the renderer rather than swallowed", () => {
    expect(rendererBuildError({ stages: [{ ...MALFORMED, glsl: `c = neverDeclared(c);` }] }))
      .toContain("neverDeclared");
  });

  it("does not stop the renderer building the shipped program next", () => {
    rendererBuildError({ stages: [{ ...MALFORMED, glsl: `c = neverDeclared(c);` }] });
    expect(rendererBuildError({ stages: builtinStages() })).toBeNull();
  });
});
