// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A source keeps its prepass results for as long as it is the one drawn:
// binding the same uploaded source again, or handing it the decoded size it
// already has, draws no prepass. Another source, a re-upload under the same
// key, or a new decoded size draws them all again.

import { describe, expect, it } from "vitest";
import { CURRENT_PROCESS_VERSION } from "@/catalog/types";
import type { ProcessingStageContribution } from "@/extensions/types";
import { encodeHalf } from "@/raw/half-float";
import type { StoredSample } from "@/rendering/source-sample";
import type { WebGLRenderer } from "./renderer";
import {
  LINEAR_PROBE_PIPELINE,
  differing,
  floatImage,
  identityParams,
  markerStage,
  pixelAt,
  takingStages,
  withRenderer,
  type Frame,
} from "./webgl.test-support";

const W = 32;
const H = 24;
const SCENE = floatImage(W, H, (x, y) => [0.05 + x / 64, 0.05 + y / 64, 0.3]);
const OTHER = floatImage(W, H, (x, y) => [0.3, 0.05 + x / 64, 0.05 + y / 64]);

const SOURCE_ID = "test.epoch-source";
const CURRENT_ID = "test.epoch-current";

const STAGES: ProcessingStageContribution[] = [
  {
    id: SOURCE_ID,
    name: "Source",
    phase: "scene-linear",
    priority: 100,
    glsl: "if (take > 0.5) lin = stageResult;",
    uniforms: [{ key: "take", glslType: "float", default: 0 }],
    passes: [{ iterations: 3, uniforms: [{ key: "u", glslType: "float", default: 0.25 }], glsl: "c = c * 0.5 + vec3(u);" }],
  },
  {
    id: CURRENT_ID,
    name: "Current",
    phase: "scene-linear",
    priority: 200,
    reads: "current",
    glsl: "if (take > 0.5) lin = stageResult;",
    uniforms: [{ key: "take", glslType: "float", default: 0 }],
    passes: [{ iterations: 2, glsl: "c = fetchInput(ivec2(gl_FragCoord.xy)) * 0.5 + vec3(0.125);" }],
  },
];

const BAG = { [`${SOURCE_ID}.take`]: 1, [`${SOURCE_ID}.u`]: 0.25, [`${CURRENT_ID}.take`]: 1 };

const PASS_DRAWS = 3 + 2;

interface Drawn {
  frame: Frame;
  pass: number;
  split: number;
}

function capture(r: WebGLRenderer): Drawn {
  const { pass, split } = r.renderDrawCounts;
  const frame = r.captureFloatFrame();
  if (!frame) throw new Error("captureFloatFrame returned null");
  return { frame, pass: r.renderDrawCounts.pass - pass, split: r.renderDrawCounts.split - split };
}

function onRenderer<T>(fn: (r: WebGLRenderer) => T, keepSourceSample = false): T {
  return withRenderer({ stages: STAGES, pipeline: LINEAR_PROBE_PIPELINE, keepPassCheckpoints: true }, (r) => {
    r.keepSourceSample = keepSourceSample;
    r.setContributedParams(BAG);
    r.setParams(identityParams({ processVersion: CURRENT_PROCESS_VERSION }));
    return fn(r);
  });
}

const draws = (d: Drawn) => ({ pass: d.pass, split: d.split });

const halfOf = (image: typeof SCENE, fullWidth = W, fullHeight = H) => ({
  kind: "float16" as const,
  data: encodeHalf(image.data),
  width: image.width,
  height: image.height,
  fullWidth,
  fullHeight,
});

const sampleOf = (sourceWidth: number, sourceHeight: number): StoredSample => ({
  data: new Uint16Array(4),
  width: 1,
  height: 1,
  x: 0,
  y: 0,
  sourceWidth,
  sourceHeight,
});

describe("a source's prepass results", () => {
  it("are drawn the first time", () => {
    const first = onRenderer((r) => {
      r.uploadSource("a", SCENE);
      return capture(r);
    });
    expect(first.pass).toBe(PASS_DRAWS);
    expect(first.split).toBeGreaterThan(0);
  });

  it("are kept when the same source is bound again", () => {
    const again = onRenderer((r) => {
      r.uploadSource("a", SCENE);
      capture(r);
      expect(r.bindSource("a")).toBe(true);
      return capture(r);
    });
    expect(draws(again)).toEqual({ pass: 0, split: 0 });
  });

  it("are kept when the source is handed the decoded size it already has", () => {
    const sampled = onRenderer((r) => {
      r.uploadSource("a", halfOf(SCENE));
      capture(r);
      expect(r.setSourceSample("a", W, H, sampleOf(W, H))).toBe(true);
      return capture(r);
    }, true);
    expect(draws(sampled)).toEqual({ pass: 0, split: 0 });
  });

  it("are drawn again when the source is handed a new decoded size", () => {
    const sampled = onRenderer((r) => {
      r.uploadSource("a", halfOf(SCENE));
      capture(r);
      expect(r.setSourceSample("a", W * 2, H * 2, sampleOf(W * 2, H * 2))).toBe(true);
      return capture(r);
    }, true);
    expect(sampled.pass).toBe(PASS_DRAWS);
  });

  it("are drawn again on going back to a source after another", () => {
    const back = onRenderer((r) => {
      r.uploadSource("a", SCENE);
      capture(r);
      r.uploadSource("b", OTHER);
      capture(r);
      expect(r.bindSource("a")).toBe(true);
      return capture(r);
    });
    expect(back.pass).toBe(PASS_DRAWS);
    expect(back.split).toBeGreaterThan(0);
  });

  it("are drawn again for a re-upload under the same key, which shows its own pixels", () => {
    const fresh = onRenderer((r) => {
      r.uploadSource("b", OTHER);
      return capture(r);
    });
    const reuploaded = onRenderer((r) => {
      r.uploadSource("a", SCENE);
      capture(r);
      r.uploadSource("a", OTHER);
      return capture(r);
    });
    expect(reuploaded.pass).toBe(PASS_DRAWS);
    expect(reuploaded.split).toBeGreaterThan(0);
    expect(differing(reuploaded.frame.data, fresh.frame.data)).toBe(0);
  });
});

describe("a source's results in the shared result array", () => {
  const STEP = 0.02;
  const FLAT = floatImage(8, 8, () => [0.1, 0.1, 0.1]);
  // Thirty result samplers are past what SwiftShader allows a shader, so the
  // set takes the shared array.
  const stages = Array.from({ length: 30 }, (_, i) => markerStage(i, STEP));
  const level = (r: WebGLRenderer): number => pixelAt(r.captureFloatFrame()!, 4, 4)[1];

  it("are drawn again on going back to a source after one that left them all idle", () => {
    const steps = withRenderer({ stages, pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
      r.setParams(identityParams({ processVersion: CURRENT_PROCESS_VERSION }));
      r.uploadSource("a", FLAT);
      const idle = level(r);
      r.setContributedParams(takingStages(stages));
      level(r);
      r.setContributedParams({});
      r.uploadSource("b", FLAT);
      level(r);
      r.setContributedParams(takingStages(stages));
      expect(r.bindSource("a")).toBe(true);
      return Math.round((level(r) - idle) / STEP);
    });
    expect(steps).toBe(30);
  });

  it("are drawn again on going back to a size after one that left them all idle", () => {
    const taking = takingStages(stages);
    const fresh = withRenderer({ stages, pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
      r.setParams(identityParams({ processVersion: CURRENT_PROCESS_VERSION }));
      r.setContributedParams(taking);
      r.uploadSource("a", FLAT);
      return r.captureFloatFrame()!;
    });
    const back = withRenderer({ stages, pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
      r.setParams(identityParams({ processVersion: CURRENT_PROCESS_VERSION }));
      r.setContributedParams(taking);
      r.uploadSource("a", FLAT);
      r.captureFloatFrame();
      r.setContributedParams({});
      expect(r.bindSource("a", 4)).toBe(true);
      r.captureFloatFrame();
      r.setContributedParams(taking);
      expect(r.bindSource("a")).toBe(true);
      const before = r.renderDrawCounts.pass;
      const frame = r.captureFloatFrame()!;
      return { frame, pass: r.renderDrawCounts.pass - before };
    });
    expect(back.pass).toBe(stages.length);
    expect(differing(back.frame.data, fresh.data)).toBe(0);
  });
});
