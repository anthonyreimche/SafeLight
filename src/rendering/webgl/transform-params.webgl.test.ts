// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A display transform's params and derived uniforms on the real renderer:
// bound from the bag each frame, without another program build when a value
// changes, matrices column-major as GLSL takes them.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePipelineFor } from "@/extensions/pipelines";
import { registerPipeline, unregisterExtension, useRegistry } from "@/extensions/registry";
import { bagForRender } from "@/extensions/transform-derive";
import type { PipelineContribution, StageSpace } from "@/extensions/types";
import type { Vec3 } from "../stage-space";
import type { WebGLRenderer } from "./renderer";
import {
  each,
  expectColour,
  floatImage,
  glHarness,
  identityParams,
  pixelAt,
  rendererBuildError,
  toHalf,
  withRenderer,
} from "./webgl.test-support";

const SOURCE: Vec3 = [0.2, 0.4, 0.1];
const SCENE = floatImage(8, 8, () => SOURCE);
const AS_DRAWN: StageSpace = { encoding: "perceptual", primaries: "rec709" };
const HALF = each(SOURCE, toHalf);

const GAIN: PipelineContribution = {
  id: "test.gain",
  name: "Gain",
  glsl: "vec3 pipelineToDisplay(vec3 lin) { return gain * lin; }",
  skipBaseCurve: true,
  skipToneShoulder: true,
  params: [{ key: "gain", glslType: "float", default: 1 }],
};

// scale's first column is (g, 0.5, 0): the output's green takes half the input's
// red, which only a column-major upload gives.
const MATRIX: PipelineContribution = {
  id: "test.matrix",
  name: "Matrix",
  glsl: "vec3 pipelineToDisplay(vec3 lin) { return scale * lin + offset.xyz; }",
  skipBaseCurve: true,
  skipToneShoulder: true,
  params: [{ key: "gain", glslType: "float", default: 1 }],
  derive: {
    uniforms: [
      { key: "scale", glslType: "mat3", default: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
      { key: "offset", glslType: "vec4", default: [0, 0, 0, 0] },
    ],
    fn: (v) => {
      const g = v.gain as number;
      return { scale: [g, 0.5, 0, 0, g, 0, 0, 0, g], offset: [0.05, 0, 0, 0] };
    },
  },
};

beforeEach(() => {
  useRegistry.setState({ pipelines: {} });
  registerPipeline("test", GAIN);
  registerPipeline("test", MATRIX);
});

afterEach(() => {
  vi.restoreAllMocks();
  unregisterExtension("test");
});

function onTransform<T>(id: string, fn: (r: WebGLRenderer) => T): T {
  return withRenderer({ stages: [], pipeline: resolvePipelineFor(id) }, (r) => {
    r.setImage(SCENE);
    r.setParams(identityParams({ processVersion: 2, displayTransform: id }));
    return fn(r);
  });
}

function preOutput(r: WebGLRenderer): Vec3 {
  const f = r.readFloatFrame("pre-output", Infinity, AS_DRAWN);
  if (!f) throw new Error("readFloatFrame returned null");
  return pixelAt(f, 4, 4);
}

describe("a transform's params", () => {
  it("bind from the photo's bag, and default without a value", () => {
    onTransform(GAIN.id, (r) => {
      expectColour(preOutput(r), HALF, "no value");
      r.setContributedParams({ "test.gain.gain": 2 });
      expectColour(preOutput(r), each(HALF, (x) => 2 * x), "gain 2");
    });
  });

  // The bag comes from storage and extensions: a value can be any type, and a
  // float can be NaN or infinite.
  it("bind the default for a bag value that doesn't fit the param", () => {
    onTransform(GAIN.id, (r) => {
      for (const value of [Number.NaN, Infinity, "2", false]) {
        r.setContributedParams({ "test.gain.gain": value });
        expectColour(preOutput(r), HALF, String(value));
      }
    });
  });

  it("re-render with a new value without building another program", () => {
    onTransform(GAIN.id, (r) => {
      r.setContributedParams({ "test.gain.gain": 2 });
      preOutput(r);
      const link = vi.spyOn(glHarness().gl, "linkProgram");
      r.setContributedParams({ "test.gain.gain": 3 });
      expectColour(preOutput(r), each(HALF, (x) => 3 * x), "gain 3");
      expect(link).not.toHaveBeenCalled();
    });
  });

  it("take a re-registered default, which leaves the program's signature alone", () => {
    onTransform(GAIN.id, (r) => {
      expectColour(preOutput(r), HALF, "default 1");
      const before = resolvePipelineFor(GAIN.id);
      const link = vi.spyOn(glHarness().gl, "linkProgram");
      registerPipeline("test", { ...GAIN, params: [{ key: "gain", glslType: "float", default: 2 }] });
      const after = resolvePipelineFor(GAIN.id);
      expect(after.sig).toBe(before.sig);
      r.setActivePipeline(after);
      expectColour(preOutput(r), each(HALF, (x) => 2 * x), "default 2");
      expect(link).not.toHaveBeenCalled();
    });
  });
});

// A transform that fails to build renders with the built-in and says so only
// in the console, so the rig has to count that as the build error it is.
describe("a tuned transform's build", () => {
  it("is a build error when it falls back to the built-in, and none when it compiles", () => {
    registerPipeline("test", { ...GAIN, id: "test.broken", glsl: "vec3 pipelineToDisplay(vec3 lin) { return gain * undeclared; }" });
    expect(rendererBuildError({ stages: [], pipeline: resolvePipelineFor("test.broken") })).toMatch(/test\.broken/);
    expect(rendererBuildError({ stages: [], pipeline: resolvePipelineFor(GAIN.id) })).toBeNull();
    expect(rendererBuildError({ stages: [], pipeline: resolvePipelineFor(MATRIX.id) })).toBeNull();
  });
});

describe("a transform's derived uniforms", () => {
  it("bind from the bag bagForRender builds, matrices column-major", () => {
    const pipeline = resolvePipelineFor(MATRIX.id);
    onTransform(MATRIX.id, (r) => {
      r.setContributedParams(bagForRender(pipeline, { "test.matrix.gain": 1 }));
      expectColour(preOutput(r), [HALF[0] + 0.05, 0.5 * HALF[0] + HALF[1], HALF[2]], "derived");
    });
  });

  it("bind their declared defaults while the bag holds none", () => {
    onTransform(MATRIX.id, (r) => {
      r.setContributedParams({ "test.matrix.gain": 1 });
      expectColour(preOutput(r), HALF, "defaults");
    });
  });
});
