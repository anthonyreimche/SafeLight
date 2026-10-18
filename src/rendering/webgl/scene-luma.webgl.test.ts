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
import { localToneBlend, toneHighlights } from "../local-tone";
import {
  LINEAR_PROBE_PIPELINE,
  floatImage,
  identityParams,
  pixelAt,
  rendererBuildError,
  withRenderer,
  type FloatImage,
  type Frame,
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

function captured(
  stages: ProcessingStageContribution[],
  pipeline: ResolvedPipeline,
  image: FloatImage,
  over: Partial<DevelopParams>,
): Frame {
  return withRenderer({ stages, pipeline }, (r) => {
    r.setImage(image);
    r.setParams(identityParams(over));
    const frame = r.captureFloatFrame();
    if (!frame) throw new Error("captureFloatFrame returned null");
    return frame;
  });
}

function sceneLuma(
  stages: ProcessingStageContribution[],
  pipeline: ResolvedPipeline,
  value: number,
  over: Partial<DevelopParams>,
): number {
  const image = floatImage(16, 16, () => [value, value, value]);
  return pixelAt(captured(stages, pipeline, image, over), 8, 8)[0] * SCALE;
}

describe("slSceneLuma", () => {
  it("compiles in a post-transform stage for both process versions", () => {
    expect(rendererBuildError({ stages: [READER], pipeline: LINEAR_PROBE_PIPELINE })).toBeNull();
  });

  it("compiles with a reader in every post-transform phase at once, for both process versions", () => {
    const readers = (["display-adjust", "effects", "output-encode"] as const).map((phase) => ({
      ...READER,
      id: `test.scene-luma-${phase}`,
      phase,
    }));
    expect(rendererBuildError({ stages: readers, pipeline: LINEAR_PROBE_PIPELINE })).toBeNull();
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

// One bright pixel on a darker field: its region is darker than it is, so the
// tone block blends the pixel toward the region's curve and slSceneLuma has to
// undo the default shoulder on that same blend. The region luminance has no CPU
// twin, so it is read off the render: the spot's edited luminance (the render
// without the reader) pins the base localToneBlend would have needed, and that
// base gives the expected value. Shadows stays 0, so the Shadows curve doesn't
// enter.
describe("slSceneLuma on a bright spot", () => {
  const SPOT = 2.83;
  const SURROUND = 1;
  const AT = 32;
  const FIELD = floatImage(64, 64, (x, y) => {
    const v = x === AT && y === AT ? SPOT : SURROUND;
    return [v, v, v];
  });

  // The capture clips at 1, so the edited spot is read at a quarter of its value.
  const QUARTERING: ResolvedPipeline = {
    ...LINEAR_PROBE_PIPELINE,
    id: "test.quartering",
    glsl: "vec3 pipelineToDisplay(vec3 lin) { return lin * 0.25; }",
    sig: "test.quartering",
  };

  const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
  const read = (highlights: number): number =>
    pixelAt(captured([READER], LINEAR_PROBE_PIPELINE, FIELD, { ...V2, highlights }), AT, AT)[0] * SCALE;

  /** The base in [SURROUND, SPOT] for which the blend lands on what the render
   *  made of the spot. */
  function baseOf(highlights: number): number {
    const frame = captured([], QUARTERING, FIELD, { ...V2, highlights });
    const edited = pixelAt(frame, AT, AT)[0] * 4;
    let best = SURROUND;
    let error = Infinity;
    for (let i = 0; i <= 2000; i++) {
      const base = SURROUND + ((SPOT - SURROUND) * i) / 2000;
      const off = Math.abs(localToneBlend(SPOT, base, 0, highlights / 100, 0, false).l1 - edited);
      if (off < error) {
        error = off;
        best = base;
      }
    }
    return best;
  }

  /** Lx * R, R being the default shoulder undone on the pixel/region blend. */
  function expected(highlights: number, base: number): number {
    const h = highlights / 100;
    const undone = (x: number): number => toneHighlights(x, 0, h, false) / toneHighlights(x, 0, 0, false);
    return SPOT * mix(undone(SPOT), undone(base), Math.abs(h));
  }

  it("never reads above the scene when Highlights recovers", () => {
    const flat = read(0);
    expect(flat).toBeCloseTo(SPOT, 2);
    for (const highlights of [-100, -50]) {
      const v = read(highlights);
      expect(v, `Highlights ${highlights}`).toBeLessThanOrEqual(SPOT + 1e-3);
      expect(v, `Highlights ${highlights}`).toBeLessThan(flat - 0.1);
    }
  });

  it("reads above the scene when Highlights brightens", () => {
    for (const highlights of [50, 100]) {
      expect(read(highlights), `Highlights ${highlights}`).toBeGreaterThan(SPOT + 0.1);
    }
  });

  for (const highlights of [-100, -50, 50, 100]) {
    it(`undoes the default shoulder on the spot's own region at Highlights ${highlights}`, () => {
      const base = baseOf(highlights);
      // The test only means something where the region really is darker.
      expect(base).toBeLessThan(SPOT - 0.3);
      expect(Math.abs(read(highlights) - expected(highlights, base))).toBeLessThan(0.01);
    });
  }
});
