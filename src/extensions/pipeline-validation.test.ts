// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What registerPipeline accepts from a transform's params and derive hook.

import { describe, expect, it } from "vitest";
import type { PipelineContribution } from "./types";
import { isUniformValue, pipelineContractError } from "./pipeline-validation";

const GLSL = "vec3 pipelineToDisplay(vec3 lin) { return gain * lin; }";
const base = (over: Partial<PipelineContribution>): PipelineContribution => ({
  id: "t.p",
  name: "P",
  glsl: GLSL,
  ...over,
});

describe("isUniformValue", () => {
  it("takes finite numbers for float and int, booleans for bool", () => {
    expect(isUniformValue(1.5, "float")).toBe(true);
    expect(isUniformValue(3, "int")).toBe(true);
    expect(isUniformValue(true, "bool")).toBe(true);
    expect(isUniformValue(Number.NaN, "float")).toBe(false);
    expect(isUniformValue(Infinity, "int")).toBe(false);
    expect(isUniformValue(1, "bool")).toBe(false);
    expect(isUniformValue("1", "float")).toBe(false);
  });

  it("takes arrays of exactly the component count for vectors and matrices", () => {
    expect(isUniformValue([1, 2, 3, 4], "vec4")).toBe(true);
    expect(isUniformValue([1, 2, 3], "vec4")).toBe(false);
    expect(isUniformValue([1, 0, 0, 0, 1, 0, 0, 0, 1], "mat3")).toBe(true);
    expect(isUniformValue([1, 0, 0, 0, 1, 0, 0, 0], "mat3")).toBe(false);
    expect(isUniformValue([1, Number.NaN], "vec2")).toBe(false);
  });

  it("never takes a sampler", () => {
    expect(isUniformValue(0, "sampler2D")).toBe(false);
  });
});

describe("pipelineContractError", () => {
  it("accepts a plain transform and one with params and derive", () => {
    expect(pipelineContractError({ id: "t.plain", name: "Plain", glsl: GLSL })).toBeNull();
    expect(
      pipelineContractError(
        base({
          params: [{ key: "gain", glslType: "float", default: 1 }],
          derive: {
            uniforms: [{ key: "scale", glslType: "mat3", default: [1, 0, 0, 0, 1, 0, 0, 0, 1] }],
            fn: () => ({}),
          },
        }),
      ),
    ).toBeNull();
  });

  it("refuses params, helpers or derive without glsl", () => {
    expect(
      pipelineContractError({ id: "t.p", name: "P", params: [{ key: "gain", glslType: "float", default: 1 }] }),
    ).toMatch(/need glsl/);
    expect(pipelineContractError({ id: "t.p", name: "P", helpers: "float f(float x) { return x; }" })).toMatch(
      /need glsl/,
    );
  });

  // Extensions are untyped JavaScript: glsl can be anything.
  it("refuses a glsl that isn't a string", () => {
    const params = [{ key: "gain", glslType: "float" as const, default: 1 }];
    expect(pipelineContractError(Object.assign(base({ params }), { glsl: 42 }))).toMatch(/glsl must be a string/);
    expect(pipelineContractError(Object.assign(base({}), { glsl: { body: GLSL } }))).toMatch(/glsl must be a string/);
  });

  it("refuses a key that isn't a GLSL identifier, or holds a double underscore", () => {
    expect(pipelineContractError(base({ params: [{ key: "2x", glslType: "float", default: 1 }] }))).toMatch(
      /GLSL identifier/,
    );
    expect(pipelineContractError(base({ params: [{ key: "a__b", glslType: "float", default: 1 }] }))).toMatch(
      /GLSL identifier/,
    );
  });

  it("allows only float, int and bool params", () => {
    expect(pipelineContractError(base({ params: [{ key: "v", glslType: "vec3", default: [0, 0, 0] }] }))).toMatch(
      /glslType/,
    );
  });

  it("refuses a default that doesn't fit its type", () => {
    expect(pipelineContractError(base({ params: [{ key: "gain", glslType: "float", default: true }] }))).toMatch(
      /default/,
    );
  });

  it("refuses duplicate keys", () => {
    const gain = { key: "gain", glslType: "float" as const, default: 1 };
    expect(pipelineContractError(base({ params: [gain, gain] }))).toMatch(/twice/);
  });

  it("refuses derive without a function or with a malformed uniform", () => {
    expect(
      pipelineContractError(base({ derive: { uniforms: [], fn: "nope" as unknown as () => Record<string, never> } })),
    ).toMatch(/derive\.fn/);
    expect(
      pipelineContractError(
        base({ derive: { uniforms: [{ key: "m", glslType: "mat4", default: [] }], fn: () => ({}) } }),
      ),
    ).toMatch(/glslType/);
  });
});
