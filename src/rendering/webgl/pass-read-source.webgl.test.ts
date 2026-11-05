// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// readSource in a pass hands over the decoded source at a uv, whatever the
// stage reads: a reads-current stage's pass that samples it gets what a
// source reader's first read gets, on any draw, in the stage's space. A stage
// that names it on version 1 keeps that version's source-reading look.

import { describe, expect, it } from "vitest";
import { CURRENT_PROCESS_VERSION } from "@/catalog/types";
import type { ProcessingStageContribution, StageSpace } from "@/extensions/types";
import { LINEAR_PROBE_PIPELINE, basicStages, floatImage, identityParams, withRenderer, type Frame } from "./webgl.test-support";

const W = 32;
const H = 24;
/** Every texel differs, so a sample read at the wrong place shows. */
const SCENE = floatImage(W, H, (x, y) => [0.05 + (0.35 * x) / W, 0.05 + (0.35 * y) / H, 0.2]);

function reader(reads: "current" | "source", glsl: string, space?: StageSpace, iterations = 1): ProcessingStageContribution {
  return {
    id: "test.reader",
    name: "Reader",
    phase: "scene-linear",
    reads,
    ...(space ? { space } : {}),
    glsl: "lin = mix(lin, stageResult, take);",
    uniforms: [{ key: "take", glslType: "float", default: 0 }],
    passes: [{ glsl, iterations }],
  };
}

function frame(stage: ProcessingStageContribution, processVersion: number): Frame {
  return withRenderer({ stages: [...basicStages(), stage], pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
    r.setImage(SCENE);
    r.setParams(identityParams({ processVersion, exposure: 1 }));
    r.setContributedParams({ "test.reader.take": 1 });
    const f = r.captureFloatFrame();
    if (!f) throw new Error("captureFloatFrame returned null");
    return f;
  });
}

const differing = (a: Frame, b: Frame): number => {
  let n = 0;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) n++;
  return n;
};

describe("readSource in a reads-current pass", () => {
  for (const version of [1, CURRENT_PROCESS_VERSION]) {
    it(`reads the decode a source reader's first read gets, on version ${version}`, () => {
      const source = frame(reader("source", "c = c;"), version);
      const current = frame(reader("current", "c = c;"), version);
      expect(differing(current, source)).toBeGreaterThan(W * H);
      expect(differing(frame(reader("current", "c = readSource(vUv);"), version), source)).toBe(0);
    });
  }

  it("reads it on a later draw too", () => {
    const source = frame(reader("source", "c = c;"), CURRENT_PROCESS_VERSION);
    const later = frame(reader("current", "c = uPassIndex == 0 ? c * 3.0 : readSource(vUv);", undefined, 2), CURRENT_PROCESS_VERSION);
    expect(differing(later, source)).toBe(0);
  });

  it("reads it in the stage's space", () => {
    const space: StageSpace = { encoding: "perceptual" };
    const source = frame(reader("source", "c = c;", space), CURRENT_PROCESS_VERSION);
    expect(differing(frame(reader("current", "c = readSource(vUv);", space), CURRENT_PROCESS_VERSION), source)).toBe(0);
  });

  it("reads the decode in a source reader's pass as its first read does", () => {
    const source = frame(reader("source", "c = c;"), CURRENT_PROCESS_VERSION);
    expect(differing(frame(reader("source", "c = readSource(vUv);"), CURRENT_PROCESS_VERSION), source)).toBe(0);
  });
});
