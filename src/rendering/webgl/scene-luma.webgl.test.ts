// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// slSceneLuma on a real GL context: the luminance before the core's default
// shoulder on version 2 (carried through later linear edits and the Highlights
// slider), the transform's input under a transform with its own roll-off, and
// the post-shoulder luminance on version 1, where a stage that names it still
// compiles.

import { describe, expect, it } from "vitest";
import { CURRENT_PROCESS_VERSION, LEGACY_PROCESS_VERSION, type DevelopParams } from "@/catalog/types";
import type { ResolvedPipeline } from "@/extensions/pipelines";
import type { ProcessingStageContribution } from "@/extensions/types";
import { toneHighlights } from "../local-tone";
import {
  LINEAR_PROBE_PIPELINE,
  floatImage,
  identityParams,
  pixelAt,
  rendererBuildError,
  withRenderer,
} from "./webgl.test-support";

const V1 = { processVersion: LEGACY_PROCESS_VERSION };
const V2 = { processVersion: CURRENT_PROCESS_VERSION };
// The reader writes slSceneLuma / SCALE, so values up to SCALE read back in [0, 1].
const SCALE = 8;

const READER: ProcessingStageContribution = {
  id: "test.scene-luma",
  name: "Scene luma",
  phase: "output-encode",
  space: { encoding: "perceptual" },
  glsl: `c = vec3(slSceneLuma / ${SCALE}.0);`,
  uniforms: [],
};

const DOUBLER: ProcessingStageContribution = {
  id: "test.double-lin",
  name: "Double",
  phase: "scene-linear",
  glsl: "lin *= 2.0;",
  uniforms: [],
};

const OWN_SHOULDER: ResolvedPipeline = {
  ...LINEAR_PROBE_PIPELINE,
  id: "test.own-shoulder",
  skipToneShoulder: true,
  sig: "test.own-shoulder",
};

function sceneLuma(
  stages: ProcessingStageContribution[],
  pipeline: ResolvedPipeline,
  value: number,
  over: Partial<DevelopParams>,
): number {
  return withRenderer({ stages, pipeline }, (r) => {
    r.setImage(floatImage(16, 16, () => [value, value, value]));
    r.setParams(identityParams(over));
    const frame = r.captureFloatFrame();
    if (!frame) throw new Error("captureFloatFrame returned null");
    return pixelAt(frame, 8, 8)[0] * SCALE;
  });
}

describe("slSceneLuma", () => {
  it("compiles in a post-transform stage for both process versions", () => {
    expect(rendererBuildError({ stages: [READER], pipeline: LINEAR_PROBE_PIPELINE })).toBeNull();
  });

  it("is the luminance before the core shoulder on version 2", () => {
    expect(sceneLuma([READER], LINEAR_PROBE_PIPELINE, 2, V2)).toBeCloseTo(2, 2);
    expect(sceneLuma([READER], LINEAR_PROBE_PIPELINE, 2, { ...V2, exposure: 1 })).toBeCloseTo(4, 2);
  });

  it("carries later linear edits through", () => {
    expect(sceneLuma([DOUBLER, READER], LINEAR_PROBE_PIPELINE, 2, V2)).toBeCloseTo(4, 2);
  });

  it("is the transform's input under a transform with its own roll-off", () => {
    expect(sceneLuma([READER], OWN_SHOULDER, 2, V2)).toBeCloseTo(2, 2);
  });

  // The shoulder it undoes is the default one, the curve at Highlights 0. The
  // slider's own knee and lift stay in, so Highlights below 0 pulls the scene
  // luminance down by the compression it adds and above 0 raises it. On a flat
  // field a pixel is its own region, so the per-pixel curves in local-tone.ts
  // give the expected value: L2 * Lx / L1 at Highlights 0, L2 being the curve
  // at the slider's value.
  const withHighlights = (value: number, highlights: number): number =>
    (value * toneHighlights(value, 0, highlights / 100, false)) /
    toneHighlights(value, 0, 0, false);

  it("carries Highlights below 0 through", () => {
    const v = sceneLuma([READER], LINEAR_PROBE_PIPELINE, 2, { ...V2, highlights: -100 });
    expect(v).toBeCloseTo(withHighlights(2, -100), 2);
    expect(v).toBeLessThan(sceneLuma([READER], LINEAR_PROBE_PIPELINE, 2, V2) - 0.1);
  });

  it("carries Highlights above 0 through", () => {
    const v = sceneLuma([READER], LINEAR_PROBE_PIPELINE, 2, { ...V2, highlights: 100 });
    expect(v).toBeCloseTo(withHighlights(2, 100), 2);
    expect(v).toBeGreaterThan(sceneLuma([READER], LINEAR_PROBE_PIPELINE, 2, V2) + 0.1);
  });

  it("is the post-shoulder luminance on version 1", () => {
    const v = sceneLuma([READER], LINEAR_PROBE_PIPELINE, 2, V1);
    expect(v).toBeGreaterThan(0.85);
    expect(v).toBeLessThan(1);
  });
});
