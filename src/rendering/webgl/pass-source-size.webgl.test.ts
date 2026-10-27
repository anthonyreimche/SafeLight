// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A pass program's uSourceSize is the decoded frame's size before the upload
// cap, uSrcLinear says whether the source is a float decode, and
// readSourceSample hands over the centre of a live decode at native resolution,
// or the one a cached preview was stored with, to a renderer that asked to keep
// it (keepSourceSample). Both follow the source bound from the GPU cache, and
// the sample counts against the cache budget. A probe stage copies the uniforms
// into the frame; a second stage writes the values expected, so the comparison
// never assumes what the probe pipeline does to `lin`.

import { describe, expect, it } from "vitest";
import type { ProcessingStageContribution } from "@/extensions/types";
import { encodeHalf } from "@/raw/half-float";
import { cutSourceSample } from "../source-sample";
import type { WebGLRenderer } from "./renderer";
import { LINEAR_PROBE_PIPELINE, floatImage, identityParams, pixelAt, takingStages, withRenderer, type FloatImage, type Frame } from "./webgl.test-support";

const W = 1100;
const H = 740;
const CAP = 128;
/** Every texel encodes its position, so a sample's pixels can be checked against the frame. */
const SOURCE: FloatImage = floatImage(W, H, (x, y) => [x / W, y / H, 0.5]);
const SMALL: FloatImage = floatImage(300, 200, () => [0.2, 0.2, 0.2]);
/** SOURCE as the RAW cache hands it back: a smaller preview with the frame's size and its centre sample. */
const CACHED = {
  kind: "float16" as const,
  data: encodeHalf(SMALL.data),
  width: SMALL.width,
  height: SMALL.height,
  fullWidth: W,
  fullHeight: H,
  sample: cutSourceSample(SOURCE.data, W, H),
};
/** SOURCE as an entry written before 3.1.0 holds it: the preview alone, at SOURCE's aspect. */
const PREVIEW: FloatImage = floatImage(275, 185, () => [0.2, 0.2, 0.2]);
const STALE = { kind: "float16" as const, data: encodeHalf(PREVIEW.data), width: 275, height: 185 };
/** What the entry's rewrite hands over for it. */
const sampleOfSource = () => cutSourceSample(SOURCE.data, W, H);

// A prepass runs only while one of its uniforms holds a value, so the probe has a
// `take` the frame sets (takingStages).
const PROBE: ProcessingStageContribution = {
  id: "test.sourceSize",
  name: "source size probe",
  phase: "decode",
  uniforms: [{ key: "take", glslType: "float", default: 0 }],
  passes: [{ glsl: "c = vec3(uSourceSize.x / 2000.0, uSourceSize.y / 2000.0, uSrcLinear ? 0.9 : 0.1);" }],
  glsl: "if (take > 0.5) lin = stageResult;",
};

function expected(r: number, g: number, b: number): ProcessingStageContribution {
  return {
    id: "test.sourceSizeExpected",
    name: "expected",
    phase: "decode",
    uniforms: [],
    glsl: `lin = vec3(${r.toFixed(4)}, ${g.toFixed(4)}, ${b.toFixed(4)});`,
  };
}

function frameWith(stage: ProcessingStageContribution, fn: (r: WebGLRenderer) => void): Frame {
  return withRenderer({ stages: [stage], pipeline: LINEAR_PROBE_PIPELINE }, (renderer) => {
    fn(renderer);
    renderer.setParams(identityParams());
    renderer.setContributedParams(takingStages([stage]));
    const f = renderer.captureFloatFrame();
    if (!f) throw new Error("captureFloatFrame returned null");
    return f;
  });
}

/** Half-float ping-pong rounds the probe's values; the expected stage writes exact floats. */
function expectSame(got: Frame, want: Frame): void {
  const a = pixelAt(got, 2, 2);
  const b = pixelAt(want, 2, 2);
  for (let i = 0; i < 3; i++) expect(Math.abs(a[i] - b[i])).toBeLessThan(2e-3);
}

describe("uSourceSize and uSrcLinear in a pass", () => {
  it("read the decoded size of a float source capped at upload, and a linear source", () => {
    const got = frameWith(PROBE, (r) => r.setImage(SOURCE, CAP));
    const want = frameWith(expected(W / 2000, H / 2000, 0.9), (r) => r.setImage(SOURCE, CAP));
    expectSame(got, want);
  });

  it("read a bitmap's own size, and a non-linear source", async () => {
    const bitmap = await createImageBitmap(new ImageData(W, H));
    try {
      const got = frameWith(PROBE, (r) => r.setImage(bitmap, CAP));
      const want = frameWith(expected(W / 2000, H / 2000, 0.1), (r) => r.setImage(SMALL, CAP));
      expectSame(got, want);
    } finally {
      bitmap.close();
    }
  });

  it("follow the source bound from the GPU cache", () => {
    const got = frameWith(PROBE, (r) => {
      r.keepSourceSample = true;
      r.uploadSource("a", SOURCE, CAP);
      r.uploadSource("b", SMALL, CAP);
      expect(r.bindSource("a")).toBe(true);
    });
    const want = frameWith(expected(W / 2000, H / 2000, 0.9), (r) => r.setImage(SMALL, CAP));
    expectSame(got, want);
  });

  it("read the decoded size a cached preview was stored with", () => {
    const got = frameWith(PROBE, (r) => r.setImage(CACHED, CAP));
    const want = frameWith(expected(W / 2000, H / 2000, 0.9), (r) => r.setImage(SMALL, CAP));
    expectSame(got, want);
  });
});

describe("readSourceSample", () => {
  it("hands over the centre of a live float decode at native resolution", () => {
    withRenderer({ stages: [], pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
      r.keepSourceSample = true;
      r.setImage(SOURCE, CAP);
      expect(r.sourceFullSize).toEqual({ width: W, height: H });
      expect(r.sourceNative).toBe(true);
      const sample = r.readSourceSample();
      if (!sample) throw new Error("no sample");
      expect(sample).toMatchObject({ width: 1024, height: H, x: 38, y: 0, sourceWidth: W, sourceHeight: H });
      for (const [i, j] of [[0, 0], [1023, 739], [511, 370]]) {
        const o = (j * sample.width + i) * 4;
        expect(Math.abs(sample.data[o] - (38 + i) / W)).toBeLessThan(1e-3);
        expect(Math.abs(sample.data[o + 1] - j / H)).toBeLessThan(1e-3);
        expect(sample.data[o + 2]).toBe(0.5);
        expect(sample.data[o + 3]).toBe(1);
      }
    });
  });

  it("is null for a bitmap and for the camera preview standing in for the photo", async () => {
    const bitmap = await createImageBitmap(new ImageData(64, 48));
    try {
      withRenderer({ stages: [], pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
        r.keepSourceSample = true;
        r.setImage(bitmap, CAP);
        expect(r.sourceNative).toBe(false);
        expect(r.readSourceSample()).toBeNull();
        r.setImage({ ...SMALL, isFallbackPreview: true }, CAP);
        expect(r.sourceNative).toBe(false);
        expect(r.readSourceSample()).toBeNull();
      });
    } finally {
      bitmap.close();
    }
  });

  it("hands over the sample a cached preview was stored with, and reports the frame's size", () => {
    withRenderer({ stages: [], pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
      r.keepSourceSample = true;
      r.setImage(CACHED, CAP);
      expect(r.sourceFullSize).toEqual({ width: W, height: H });
      expect(r.sourceNative).toBe(true);
      const sample = r.readSourceSample();
      if (!sample) throw new Error("no sample");
      expect(sample).toMatchObject({ width: 1024, height: H, x: 38, y: 0, sourceWidth: W, sourceHeight: H });
      for (const [i, j] of [[0, 0], [1023, 739], [511, 370]]) {
        const o = (j * sample.width + i) * 4;
        expect(Math.abs(sample.data[o] - (38 + i) / W)).toBeLessThan(1e-3);
        expect(Math.abs(sample.data[o + 1] - j / H)).toBeLessThan(1e-3);
      }
    });
  });

  it("is null for a cached preview stored without one, which reports its own size", () => {
    withRenderer({ stages: [], pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
      r.keepSourceSample = true;
      const data = encodeHalf(new Float32Array(200 * 150 * 4).fill(0.25));
      r.setImage({ kind: "float16", data, width: 200, height: 150 }, CAP);
      expect(r.sourceNative).toBe(false);
      expect(r.readSourceSample()).toBeNull();
      expect(r.sourceFullSize).toEqual({ width: 200, height: 150 });
    });
  });

  it("keeps no cached sample unless the renderer is asked to, and still reports the frame's size", () => {
    withRenderer({ stages: [], pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
      r.setImage(CACHED, CAP);
      expect(r.sourceNative).toBe(false);
      expect(r.readSourceSample()).toBeNull();
      expect(r.sourceFullSize).toEqual({ width: W, height: H });
    });
  });

  it("follows a cached source bound from the GPU cache", () => {
    withRenderer({ stages: [], pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
      r.keepSourceSample = true;
      r.uploadSource("a", CACHED, CAP);
      r.uploadSource("b", SMALL, CAP);
      expect(r.readSourceSample()?.sourceWidth).toBe(300);
      expect(r.bindSource("a")).toBe(true);
      expect(r.readSourceSample()?.sourceWidth).toBe(W);
      expect(r.sourceFullSize).toEqual({ width: W, height: H });
    });
  });

  it("keeps nothing unless the renderer is asked to, and still reports the decoded size", () => {
    withRenderer({ stages: [], pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
      expect(r.keepSourceSample).toBe(false);
      r.setImage(SOURCE, CAP);
      expect(r.sourceNative).toBe(false);
      expect(r.readSourceSample()).toBeNull();
      expect(r.sourceFullSize).toEqual({ width: W, height: H });
      r.uploadSource("a", SOURCE, CAP);
      expect(r.readSourceSample()).toBeNull();
    });
  });

  it("follows the source bound from the GPU cache", () => {
    withRenderer({ stages: [], pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
      r.keepSourceSample = true;
      r.uploadSource("a", SOURCE, CAP);
      r.uploadSource("b", SMALL, CAP);
      expect(r.readSourceSample()?.sourceWidth).toBe(300);
      expect(r.bindSource("a")).toBe(true);
      expect(r.readSourceSample()?.sourceWidth).toBe(W);
      expect(r.sourceFullSize).toEqual({ width: W, height: H });
    });
  });
});

describe("the sample against the cache budget", () => {
  // Each entry's texture estimate is a fraction of a megabyte at CAP; SOURCE's
  // sample alone is 1024 × 740 × 8 bytes, about 6 MB, so this budget holds both
  // textures and not a sample beside them.
  const BUDGET = 1 << 20;

  /** Upload "a" then "b" under the budget; "b" is bound, so only "a" can be evicted. */
  function aSurvives(keep: boolean): boolean {
    return withRenderer({ stages: [], pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
      r.setCacheBudget(BUDGET);
      r.keepSourceSample = keep;
      r.uploadSource("a", SOURCE, CAP);
      r.uploadSource("b", SMALL, CAP);
      return r.hasSource("a");
    });
  }

  it("evicts a source whose kept sample outgrows it", () => {
    expect(aSurvives(true)).toBe(false);
  });

  it("keeps the same source resident when no sample is kept", () => {
    expect(aSurvives(false)).toBe(true);
  });
});

// An entry written before 3.1.0 is rewritten in the background while its photo
// is on the GPU; the resident source takes the decoded size and the sample in
// place, and passes drawn with the old size are drawn again.
describe("setSourceSample", () => {
  it("patches the bound cached source, and the next frame's passes read the decoded size", () => {
    const { before, after } = withRenderer({ stages: [PROBE], pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
      r.keepSourceSample = true;
      r.uploadSource("a", STALE, CAP);
      r.setParams(identityParams());
      r.setContributedParams(takingStages([PROBE]));
      const first = r.captureFloatFrame();
      expect(r.sourceNative).toBe(false);

      expect(r.setSourceSample("a", W, H, sampleOfSource())).toBe(true);

      expect(r.sourceFullSize).toEqual({ width: W, height: H });
      expect(r.sourceNative).toBe(true);
      expect(r.readSourceSample()).toMatchObject({ width: 1024, height: H, x: 38, y: 0, sourceWidth: W, sourceHeight: H });
      const second = r.captureFloatFrame();
      if (!first || !second) throw new Error("captureFloatFrame returned null");
      return { before: first, after: second };
    });
    expectSame(before, frameWith(expected(275 / 2000, 185 / 2000, 0.9), (r) => r.setImage(SMALL, CAP)));
    expectSame(after, frameWith(expected(W / 2000, H / 2000, 0.9), (r) => r.setImage(SMALL, CAP)));
  });

  it("patches a resident source that is not bound, which binds native", () => {
    withRenderer({ stages: [], pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
      r.keepSourceSample = true;
      r.uploadSource("a", STALE, CAP);
      r.uploadSource("b", SMALL, CAP);

      expect(r.setSourceSample("a", W, H, sampleOfSource())).toBe(true);

      expect(r.sourceFullSize).toEqual({ width: 300, height: 200 });
      expect(r.readSourceSample()?.sourceWidth).toBe(300);
      expect(r.bindSource("a")).toBe(true);
      expect(r.sourceNative).toBe(true);
      expect(r.sourceFullSize).toEqual({ width: W, height: H });
      expect(r.readSourceSample()?.sourceWidth).toBe(W);
    });
  });

  it("changes nothing for a key not resident, a source with its own sample, or a size turned the other way", () => {
    withRenderer({ stages: [], pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
      r.keepSourceSample = true;
      r.uploadSource("live", SOURCE, CAP);
      r.uploadSource("a", STALE, CAP);

      expect(r.setSourceSample("missing", W, H, sampleOfSource())).toBe(false);
      expect(r.setSourceSample("live", W, H, cutSourceSample(SMALL.data, 300, 200))).toBe(false);
      expect(r.setSourceSample("a", H, W, sampleOfSource())).toBe(false);
      // Every comparison with NaN is false, so a guard that only refuses what it
      // can compare would let these through.
      expect(r.setSourceSample("a", NaN, H, sampleOfSource())).toBe(false);
      expect(r.setSourceSample("a", W, NaN, sampleOfSource())).toBe(false);
      expect(r.setSourceSample("a", Infinity, H, sampleOfSource())).toBe(false);

      expect(r.sourceNative).toBe(false);
      expect(r.sourceFullSize).toEqual({ width: 275, height: 185 });
      expect(r.bindSource("live")).toBe(true);
      expect(r.readSourceSample()?.sourceWidth).toBe(W);
    });
  });

  it("changes nothing on a renderer that keeps no samples", () => {
    withRenderer({ stages: [], pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
      r.uploadSource("a", STALE, CAP);
      expect(r.setSourceSample("a", W, H, sampleOfSource())).toBe(false);
      expect(r.sourceFullSize).toEqual({ width: 275, height: 185 });
      expect(r.sourceNative).toBe(false);
    });
  });

  it("counts the sample against the cache budget", () => {
    withRenderer({ stages: [], pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
      // Two 275 × 185 RGBA16F textures with mips are about 1.1 MB; SOURCE's
      // sample is 1024 × 740 × 8 bytes, about 6 MB. 4 MB holds the first, not both.
      r.setCacheBudget(1 << 22);
      r.keepSourceSample = true;
      r.uploadSource("a", STALE, CAP);
      r.uploadSource("b", { ...STALE }, CAP);
      expect(r.hasSource("a")).toBe(true);

      expect(r.setSourceSample("a", W, H, sampleOfSource())).toBe(true);

      expect(r.hasSource("a")).toBe(false);
      expect(r.hasSource("b")).toBe(true);
    });
  });
});
