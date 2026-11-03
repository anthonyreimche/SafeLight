// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Finding the stages a develop program fails to build with, by building it with
// fewer of them. Every build is a whole develop compile, so the count matters as
// much as the answer.

import { describe, expect, it } from "vitest";
import type { ProcessingStageContribution } from "@/extensions/types";
import { PASS_PRELUDE } from "./export-draw";
import { createProgram, isolateFailingStages } from "./program-cache";
import { FRAGMENT_SHADER, V2_VARIANT, VERTEX_SHADER } from "./shaders";
import { buildStageInjection, PASS_VERTEX_SHADER } from "./stage-injection";

const STAGES = ["a", "b", "c", "d", "e", "f", "g", "h"];

/** A build that fails with a log naming each broken stage it is handed. */
function breaksWith(broken: readonly string[]) {
  const subsets: string[][] = [];
  const build = (subset: readonly string[]): string | null => {
    subsets.push([...subset]);
    const bad = subset.filter((s) => broken.includes(s));
    return bad.length > 0 ? `'${bad[0]}' : undeclared identifier` : null;
  };
  return { build, subsets };
}

describe("isolateFailingStages", () => {
  it("names the one stage whose GLSL doesn't compile, with its log", () => {
    const { build, subsets } = breaksWith(["e"]);
    const failing = isolateFailingStages(STAGES, "the whole set failed", build);
    expect(failing).toEqual([{ stage: "e", log: "'e' : undeclared identifier" }]);
    // The stock build, a bisection of eight, and the set without it.
    expect(subsets.length).toBeLessThanOrEqual(5);
  });

  it("names each of several broken stages", () => {
    const { build } = breaksWith(["b", "g"]);
    const failing = isolateFailingStages(STAGES, "the whole set failed", build);
    expect(failing.map((f) => f.stage)).toEqual(["b", "g"]);
  });

  it("blames the stage that carries the set past a limit", () => {
    const build = (subset: readonly string[]) => (subset.length > 6 ? "too many uniforms" : null);
    const failing = isolateFailingStages(STAGES, "too many uniforms", build);
    expect(failing.map((f) => f.stage)).toEqual(["g", "h"]);
    expect(failing[0].log).toBe("too many uniforms");
  });

  it("blames none when the program fails without any of them", () => {
    const { build, subsets } = breaksWith([]);
    const fails = (subset: readonly string[]) => build(subset) ?? "the base shader failed";
    expect(isolateFailingStages(STAGES, "the base shader failed", fails)).toEqual([]);
    expect(subsets).toEqual([[]]);
  });

  // A lost context fails every build after it, whatever it holds: nothing found
  // then is to blame.
  it("blames none once the builds can no longer be trusted", () => {
    const { build, subsets } = breaksWith(["e"]);
    let lost = false;
    const losing = (subset: readonly string[]) => {
      const result = build(subset);
      lost = true;
      return result;
    };
    expect(isolateFailingStages(STAGES, "the whole set failed", losing, undefined, () => lost)).toEqual([]);
    expect(subsets).toEqual([[]]);
  });

  it("stops at its build limit, keeping what it found", () => {
    const { build, subsets } = breaksWith(["a", "b", "c", "d"]);
    const failing = isolateFailingStages(STAGES, "the whole set failed", build, 6);
    expect(subsets.length).toBe(6);
    expect(failing.length).toBeGreaterThan(0);
    expect(failing.length).toBeLessThan(4);
  });
});

/** The fragment source createProgram hands the driver for `fsSrc`. */
function compiledFragment(vsSrc: string, fsSrc: string): string {
  const sources = new Map<object, string>();
  const types = new Map<object, number>();
  const gl = {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    createShader: (type: number) => {
      const shader = {};
      types.set(shader, type);
      return shader;
    },
    shaderSource: (shader: object, src: string) => sources.set(shader, src),
    compileShader: () => {},
    getShaderParameter: () => true,
    createProgram: () => ({}),
    attachShader: () => {},
    bindAttribLocation: () => {},
    linkProgram: () => {},
    deleteShader: () => {},
    getProgramParameter: () => true,
  } as unknown as WebGL2RenderingContext;
  createProgram(gl, vsSrc, fsSrc);
  const fragment = [...sources].find(([shader]) => types.get(shader) === gl.FRAGMENT_SHADER);
  if (!fragment) throw new Error("no fragment shader compiled");
  return fragment[1];
}

const count = (text: string, part: string) => text.split(part).length - 1;

const BLURRED: ProcessingStageContribution = {
  id: "acme.blur",
  name: "Blur",
  phase: "scene-linear",
  glsl: "lin = mix(lin, stageResult, amount);",
  uniforms: [{ key: "amount", glslType: "float", default: 1 }],
  passes: [{ glsl: "c = readPrev(vUv);" }],
};

// A sampler2D is lowp unless declared otherwise, and drivers that lower lowp to
// fp16 clip HDR values read through it.
describe("createProgram's fragment precision", () => {
  it("declares highp sampler2D for the develop program, right after #version", () => {
    const src = compiledFragment(VERTEX_SHADER, FRAGMENT_SHADER);
    expect(count(src, "precision highp sampler2D;")).toBe(1);
    expect(src.split("\n").slice(0, 2)).toEqual(["#version 300 es", "precision highp sampler2D;"]);
    expect(src.replace("precision highp sampler2D;\n", "")).toBe(FRAGMENT_SHADER);
  });

  it("declares it for a stage's pass program", () => {
    const pass = buildStageInjection([BLURRED], V2_VARIANT).prepass[0].passes[0].fragmentSource;
    expect(count(compiledFragment(PASS_VERTEX_SHADER, pass), "precision highp sampler2D;")).toBe(1);
  });

  it("leaves a source that declares its sampler precision as it is", () => {
    const src = `${PASS_PRELUDE}uniform sampler2D uSrc;\nvoid main() { fragColor = texture(uSrc, vec2(0.0)); }\n`;
    expect(compiledFragment(PASS_VERTEX_SHADER, src)).toBe(src);
  });
});
