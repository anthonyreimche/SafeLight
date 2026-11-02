// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The renderer binds array, matrix and per-photo texture uniforms from the
// param bag: each probe stage writes what it reads straight into the output.

import { describe, expect, it } from "vitest";
import type { ProcessingStageContribution, StageTextureData, UniformDeclaration } from "@/extensions/types";
import {
  expectColour,
  floatImage,
  glHarness,
  glErrorsDuring,
  identityParams,
  pixelAt,
  withRenderer,
} from "./webgl.test-support";
import type { WebGLRenderer } from "./renderer";

type Vec3 = [number, number, number];

const probe = (
  glsl: string,
  uniforms: UniformDeclaration[],
  textures: ProcessingStageContribution["textures"] = [],
): ProcessingStageContribution & { extensionId: string } => ({
  id: "safelight.basic.probe",
  name: "Probe",
  phase: "effects",
  glsl,
  uniforms,
  textures,
  extensionId: "safelight.basic",
});

const key = (k: string) => `safelight.basic.probe.${k}`;

function draw(renderer: WebGLRenderer, bag: Record<string, unknown>): Vec3 {
  renderer.setContributedParams(bag);
  renderer.render();
  const frame = renderer.captureFloatFrame();
  if (!frame) throw new Error("captureFloatFrame returned null");
  return pixelAt(frame, 2, 2);
}

function withProbe<T>(stage: ProcessingStageContribution, fn: (r: WebGLRenderer) => T): T {
  return withRenderer({ stages: [stage] }, (renderer) => {
    renderer.setImage(floatImage(4, 4, () => [0.5, 0.5, 0.5]));
    renderer.setParams(identityParams());
    return fn(renderer);
  });
}

const QUARTERS: Vec3 = [0.25, 0.5, 0.75];

describe("array uniforms from the bag", () => {
  it("binds a float array", () => {
    const stage = probe("c = vec3(uW[0], uW[1], uW[2]);", [
      { key: "uW", glslType: "float", length: 3, default: [0, 0, 0] },
    ]);
    withProbe(stage, (r) => expectColour(draw(r, { [key("uW")]: QUARTERS }), QUARTERS, "float[3]"));
  });

  it("binds a vec2 array from its flattened numbers", () => {
    const stage = probe("c = vec3(uV[0].y, uV[1].x, uV[1].y);", [
      { key: "uV", glslType: "vec2", length: 2, default: [0, 0, 0, 0] },
    ]);
    withProbe(stage, (r) => expectColour(draw(r, { [key("uV")]: [0, 0.25, 0.5, 0.75] }), QUARTERS, "vec2[2]"));
  });

  it("binds an int array", () => {
    const stage = probe("c = vec3(float(uI[0]), float(uI[1]), float(uI[2])) / 4.0;", [
      { key: "uI", glslType: "int", length: 3, default: [0, 0, 0] },
    ]);
    withProbe(stage, (r) => expectColour(draw(r, { [key("uI")]: [1, 2, 3] }), QUARTERS, "int[3]"));
  });

  it("binds the default while the bag has none, or has the wrong count", () => {
    const stage = probe("c = vec3(uW[0], uW[1], uW[2]);", [
      { key: "uW", glslType: "float", length: 3, default: QUARTERS },
    ]);
    withProbe(stage, (r) => {
      expectColour(draw(r, {}), QUARTERS, "no entry");
      const { gl } = glHarness();
      const errors = glErrorsDuring(gl, () => expectColour(draw(r, { [key("uW")]: [1, 1] }), QUARTERS, "short"));
      expect(errors).toEqual([]);
    });
  });
});

describe("matrix uniforms from the bag", () => {
  it("binds a mat3, column-major", () => {
    const stage = probe("c = uM * vec3(1.0, 0.0, 0.0);", [
      { key: "uM", glslType: "mat3", default: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
    ]);
    withProbe(stage, (r) =>
      expectColour(draw(r, { [key("uM")]: [0.25, 0.5, 0.75, 0, 0, 0, 0, 0, 0] }), QUARTERS, "mat3"),
    );
  });

  it("binds a mat4, column-major", () => {
    const stage = probe("c = (uM * vec4(1.0, 0.0, 0.0, 0.0)).rgb;", [
      { key: "uM", glslType: "mat4", default: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
    ]);
    const columns = [0.25, 0.5, 0.75, 0, ...new Array<number>(12).fill(0)];
    withProbe(stage, (r) => expectColour(draw(r, { [key("uM")]: columns }), QUARTERS, "mat4"));
  });
});

describe("per-photo textures from the bag", () => {
  const texel = (rgb: Vec3, version: number): StageTextureData => ({
    data: new Uint8Array([...rgb, 255]),
    width: 1,
    height: 1,
    format: "rgba8",
    version,
  });
  const stage = probe("c = texture(uLut, vec2(0.5)).rgb;", [], [{ key: "uLut", kind: "photo" }]);
  const as8 = (rgb: Vec3): Vec3 => [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255];

  it("samples what the bag holds, uploaded again for a new version only", () => {
    withProbe(stage, (r) => {
      expectColour(draw(r, { [key("uLut")]: texel([64, 128, 191], 1) }), as8([64, 128, 191]), "first");
      expectColour(draw(r, { [key("uLut")]: texel([191, 128, 64], 2) }), as8([191, 128, 64]), "new version");
      expectColour(draw(r, { [key("uLut")]: texel([0, 0, 0], 2) }), as8([191, 128, 64]), "same version");
    });
  });

  it("samples black while the bag has none", () => {
    withProbe(stage, (r) => expectColour(draw(r, {}), [0, 0, 0], "none"));
  });
});

describe("derived values with the params", () => {
  const stage = {
    ...probe("c = vec3(uLevel);", [{ key: "uLevel", glslType: "float", default: 0 }]),
    derive: (p: { exposure: number }) => ({ uLevel: p.exposure }),
  };

  it("are derived by a renderer in the window from its own stages", () => {
    withRenderer({ stages: [stage] }, (r) => {
      r.setImage(floatImage(4, 4, () => [0.5, 0.5, 0.5]));
      r.setParams(identityParams({ exposure: 0.25 }));
      expectColour(draw(r, {}), [0.25, 0.25, 0.25], "derived");
    });
  });

  it("are taken as handed over, as the worker's are", () => {
    withRenderer({ stages: [stage] }, (r) => {
      r.setImage(floatImage(4, 4, () => [0.5, 0.5, 0.5]));
      r.setParams(identityParams({ exposure: 0.25 }), { [key("uLevel")]: 0.75 });
      expectColour(draw(r, {}), [0.75, 0.75, 0.75], "handed over");
    });
  });

  it("win over a bag entry under the same key", () => {
    withRenderer({ stages: [stage] }, (r) => {
      r.setImage(floatImage(4, 4, () => [0.5, 0.5, 0.5]));
      r.setParams(identityParams({ exposure: 0.25 }));
      expectColour(draw(r, { [key("uLevel")]: 0.75 }), [0.25, 0.25, 0.25], "derived wins");
    });
  });
});
