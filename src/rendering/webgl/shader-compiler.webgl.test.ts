// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The compiler that turns extension contributions into GLSL. Its whole job is
// to let mutually unaware extensions share one program, so the assertions here
// are about namespacing, ordering, and what happens when a contribution is
// wrong — each checked against a driver, not against expected source text.

import { describe, expect, it } from "vitest";
import type { ProcessingStageContribution } from "@/extensions/types";
import {
  compileShaderSource,
  compilerSignature,
  emitUniformDecl,
  extractHelperNames,
  helperPrefix,
  replaceIdentifiers,
  simpleHash,
  uniformPrefix,
} from "./shader-compiler";
import {
  buildProgram,
  builtinStages,
  glHarness,
  releaseProgram,
  rendererBuildError,
} from "./webgl.test-support";

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

function compiles(stages: ProcessingStageContribution[]): string | null {
  const { gl } = glHarness();
  const source = compileShaderSource(stages);
  const build = buildProgram(gl, source.vertexSource, source.fragmentSource);
  releaseProgram(gl, build);
  return build.error;
}

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

describe("compileShaderSource", () => {
  it("compiles with no stages", () => {
    expect(compiles([])).toBeNull();
  });

  it("compiles a stage's uniforms, helpers and body", () => {
    expect(compiles([GLOW])).toBeNull();
  });

  it("compiles two stages that share a uniform key and a helper name", () => {
    expect(compiles([GLOW, FADE])).toBeNull();
  });

  it("maps each qualified key to its namespaced uniform", () => {
    const source = compileShaderSource([GLOW, FADE]);
    const glow = source.uniformNameMap.get("acme.glow.amount");
    const fade = source.uniformNameMap.get("other.fade.amount");
    expect(glow).toBe(`${uniformPrefix(GLOW.id)}amount`);
    expect(fade).toBe(`${uniformPrefix(FADE.id)}amount`);
    expect(glow).not.toBe(fade);
    expect(source.uniformTypes.get(glow!)).toBe("float");
    expect(source.defaults.get("other.fade.amount")).toBe(0.25);
  });

  it("orders stages by phase, then by priority", () => {
    const late: ProcessingStageContribution = { ...GLOW, id: "acme.late", priority: 90 };
    // FADE is scene-linear (earlier phase) despite GLOW's lower priority number.
    expect(compileShaderSource([GLOW, late, FADE]).stageIds).toEqual([
      "other.fade",
      "acme.glow",
      "acme.late",
    ]);
  });

  it("compiles a produced inter-stage variable read by a later stage", () => {
    const producer: ProcessingStageContribution = {
      id: "acme.producer",
      name: "Producer",
      phase: "scene-linear",
      glsl: `color = max(color, 0.0);`,
      uniforms: [],
      produces: [{ name: "sceneLuma", glslType: "float", producer: "luma(color)" }],
    };
    const consumer: ProcessingStageContribution = {
      id: "acme.consumer",
      name: "Consumer",
      phase: "effects",
      glsl: `color *= 1.0 + sceneLuma * 0.0;`,
      uniforms: [],
      consumes: ["sceneLuma"],
    };
    const source = compileShaderSource([producer, consumer]);
    expect(source.fragmentSource).toContain("isv_sceneLuma");
    expect(compiles([producer, consumer])).toBeNull();
  });

  it("keys the signature on the stage set and its GLSL", () => {
    expect(compilerSignature([GLOW, FADE])).toBe(compilerSignature([GLOW, FADE]));
    expect(compilerSignature([GLOW])).not.toBe(
      compilerSignature([{ ...GLOW, glsl: `${GLOW.glsl} // edited` }]),
    );
    expect(simpleHash("a")).not.toBe(simpleHash("b"));
  });
});

describe("a malformed contribution", () => {
  it("fails to compile, with the driver's diagnostic", () => {
    const error = compiles([MALFORMED]);
    expect(error).not.toBeNull();
    expect(error).toContain("neverDeclared");
  });

  it("leaves the stage-free program compiling afterwards", () => {
    compiles([MALFORMED]);
    expect(compiles([])).toBeNull();
  });

  it("is reported by the renderer rather than swallowed", () => {
    expect(rendererBuildError({ stages: [{ ...MALFORMED, glsl: `c = neverDeclared(c);` }] }))
      .toContain("neverDeclared");
  });

  it("does not stop the renderer building the shipped program next", () => {
    rendererBuildError({ stages: [{ ...MALFORMED, glsl: `c = neverDeclared(c);` }] });
    expect(rendererBuildError({ stages: builtinStages() })).toBeNull();
  });
});
