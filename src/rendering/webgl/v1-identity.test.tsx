// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Process version 1 is frozen. Every edit saved before process versions
// renders through the version 1 program, so its shader text, and the GLSL the
// injector builds for stages that never declared a space, must stay the
// tokens b1f5ec5 shipped. The uniform bindings, prepass layout and vertex
// shaders that ride with that GLSL are held to the same standard. A failure
// here means an old photo would change.

import { describe, expect, it } from "vitest";
import { V1_VARIANT, VERTEX_SHADER, buildFragmentShader } from "./shaders";
import { PASS_VERTEX_SHADER, buildStageInjection } from "./stage-injection";
import {
  V1_PASS_VERTEX_SHADER,
  V1_STAGE_META,
  V1_VERTEX_SHADER,
} from "./v1-reference-meta";
import {
  V1_INJECTIONS,
  V1_PASS_SOURCES,
  buildV1ReferenceShader,
} from "./v1-reference-shader";
import {
  V1_IDENTITY_CONFIGS,
  V1_IDENTITY_PIPELINES,
  normalizeGlsl,
  projectStageMeta,
} from "./v1-identity.fixtures";

const KEYS = ["uniforms", "helpers", "srcUv", "noiseReduction", "sceneLinear", "effects"] as const;
const lines = (src: string): string[] => normalizeGlsl(src).split("\n");

describe("process version 1 stays frozen", () => {
  for (const [config, stages] of Object.entries(V1_IDENTITY_CONFIGS)) {
    const reference = V1_INJECTIONS[config];

    it(`builds the ${config} stage GLSL b1f5ec5 built`, () => {
      const { injection } = buildStageInjection(stages(), V1_VARIANT);
      for (const key of KEYS) expect(lines(injection[key]), key).toEqual(lines(reference[key]));
    });

    it(`builds the ${config} pass programs b1f5ec5 built`, () => {
      const { prepass } = buildStageInjection(stages(), V1_VARIANT);
      const live = prepass.flatMap((p) => p.passes.map((pass) => normalizeGlsl(pass.fragmentSource)));
      expect(live).toEqual(V1_PASS_SOURCES[config].map(normalizeGlsl));
    });

    it(`derives the ${config} bindings, textures and prepass layout b1f5ec5 derived`, () => {
      const built = buildStageInjection(stages(), V1_VARIANT);
      expect(projectStageMeta(built)).toEqual(V1_STAGE_META[config]);
    });

    for (const [pipeline, glsl] of Object.entries(V1_IDENTITY_PIPELINES)) {
      it(`assembles the ${config} shader under the ${pipeline} transform as b1f5ec5 did`, () => {
        const { injection } = buildStageInjection(stages(), V1_VARIANT);
        const live = buildFragmentShader(glsl, injection, V1_VARIANT);
        expect(lines(live)).toEqual(lines(buildV1ReferenceShader(glsl, reference)));
      });
    }
  }

  it("keeps both vertex shaders as b1f5ec5 shipped them", () => {
    expect(lines(VERTEX_SHADER)).toEqual(lines(V1_VERTEX_SHADER));
    expect(lines(PASS_VERTEX_SHADER)).toEqual(lines(V1_PASS_VERTEX_SHADER));
  });
});

// Every shader comparison above goes through normalizeGlsl, so the freeze is
// exactly as strict as this function is.
describe("normalizeGlsl", () => {
  const SOURCE = [
    "#version 300 es",
    "vec3 tone(vec3 c) {",
    "  return clamp(c * 1.0, 0.0, 1.0);",
    "}",
  ].join("\n");

  it("ignores comments", () => {
    const commented = [
      "// leading note",
      "#version 300 es",
      "vec3 tone(vec3 c) { // trailing note",
      "  /* block",
      "     over two lines */",
      "  return clamp(c * 1.0, /* inline */ 0.0, 1.0);",
      "}",
    ].join("\n");
    expect(normalizeGlsl(commented)).toBe(normalizeGlsl(SOURCE));
  });

  it("ignores indentation, blank lines and runs of whitespace", () => {
    const reflowed = [
      "",
      "   #version 300 es\t",
      "",
      "",
      "vec3   tone(vec3 \t c) {",
      "\t\t",
      "      return   clamp(c *  1.0,  0.0,   1.0);",
      "}",
      "",
    ].join("\n");
    expect(normalizeGlsl(reflowed)).toBe(normalizeGlsl(SOURCE));
    expect(normalizeGlsl(SOURCE.replace(/\n/g, "\r\n"))).toBe(normalizeGlsl(SOURCE));
  });

  it("sees a changed token", () => {
    expect(normalizeGlsl(SOURCE.replace("1.0", "2.0"))).not.toBe(normalizeGlsl(SOURCE));
    expect(normalizeGlsl(SOURCE.replace("clamp(", "max("))).not.toBe(normalizeGlsl(SOURCE));
  });

  it("keeps the code after a // comment that mentions /*", () => {
    const source = "float a = 1.0; // see /* below\nfloat b = 2.0;\nfloat c = 3.0; /* done */";
    expect(normalizeGlsl(source)).toBe("float a = 1.0;\nfloat b = 2.0;\nfloat c = 3.0;");
  });

  it("drops a // inside a block comment along with the block", () => {
    const source = "float a = 1.0; /* one // two\nthree */\nfloat b = 2.0;";
    expect(normalizeGlsl(source)).toBe("float a = 1.0;\nfloat b = 2.0;");
  });

  it("keeps the tokens either side of a comment apart", () => {
    expect(normalizeGlsl("a/**/b")).not.toBe(normalizeGlsl("ab"));
  });
});
