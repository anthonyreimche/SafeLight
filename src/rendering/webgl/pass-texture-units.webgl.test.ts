// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Each texture a pass samples needs a unit of its own while the pass draws.
// Only four were lent: a fifth read unit 0, the previous pass, as its table.
// The pass brightens its result by STEP for each table that holds its own mark,
// so the frame says how many tables the pass read as themselves.

import { describe, expect, it } from "vitest";
import { CURRENT_PROCESS_VERSION } from "@/catalog/types";
import type { ProcessingStageContribution, StageTextureData } from "@/extensions/types";
import { LINEAR_PROBE_PIPELINE, floatImage, identityParams, pixelAt, withRenderer } from "./webgl.test-support";

const ID = "test.tables";
const STEP = 0.05;
const markOf = (i: number) => (i + 1) * 20;

function sampler(n: number): ProcessingStageContribution {
  const keys = Array.from({ length: n }, (_, i) => `t${i}`);
  const tally = keys
    .map((k, i) => `if (abs(texelFetch(${k}, ivec2(0), 0).r * 255.0 - ${markOf(i)}.0) < 0.5) n += 1.0;`)
    .join("\n");
  return {
    id: ID,
    name: "Tables",
    phase: "scene-linear",
    glsl: "if (take > 0.5) lin = stageResult;",
    uniforms: [{ key: "take", glslType: "float", default: 0 }],
    textures: keys.map((key) => ({ key, kind: "lut" as const, format: "rgba8" as const })),
    passes: [{ glsl: `float n = 0.0;\n${tally}\nc = vec3(n * ${STEP});` }],
  };
}

function tablesRead(n: number): number {
  const stage = sampler(n);
  return withRenderer({ stages: [stage], pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
    r.setImage(floatImage(8, 8, () => [0.1, 0.1, 0.1]));
    r.setParams(identityParams({ processVersion: CURRENT_PROCESS_VERSION }));
    const textures: Record<string, StageTextureData> = {};
    for (let i = 0; i < n; i++) {
      textures[`${ID}.t${i}`] = { data: new Uint8Array([markOf(i), 0, 0, 255]), width: 1, height: 1, format: "rgba8", version: 1 };
    }
    r.setStageTextures(textures);
    r.setContributedParams({ [`${ID}.take`]: 1 });
    return Math.round(pixelAt(r.captureFloatFrame()!, 4, 4)[1] / STEP);
  });
}

describe("pass texture units", () => {
  it("lends each of four tables its own unit", () => {
    expect(tablesRead(4)).toBe(4);
  });

  it("lends a fifth and sixth table one too", () => {
    expect(tablesRead(6)).toBe(6);
  });
});
