// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A non-RAW photo read through its input profile reaches the renderer as
// display-referred linear halves (load-image.ts). It renders as the same photo
// does from its 8-bit bitmap where both can hold its colours: no base curve,
// no camera baseline and no clipped-highlight reconstruction. Where only the
// halves can (a colour outside sRGB, a negative channel), it renders without
// NaN, on every process version.

import { describe, expect, it } from "vitest";
import type { InputTransform } from "@/extensions/api/develop";
import { linearizeCodes } from "@/raw/profile-frame";
import type { Float16Source } from "@/rendering/source-sample";
import {
  LINEAR_PROBE_PIPELINE,
  OPEN_PROBE,
  PIXEL_TOLERANCE,
  type Frame,
  identityParams,
  pixelAt,
  withRenderer,
  worstDifference,
} from "./webgl.test-support";
import type { WebGLRenderer, WebGLRendererOpts } from "./renderer";

const W = 16;
const H = 8;

/** sRGB's transfer at `n` even steps: the transform a resolver gives an sRGB file. */
function srgbTable(n: number): Float32Array {
  return Float32Array.from({ length: n }, (_, i) => {
    const x = i / (n - 1);
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  });
}

const SRGB: InputTransform = {
  trc: [srgbTable(4096), srgbTable(4096), srgbTable(4096)],
  toRec709: [1, 0, 0, 0, 1, 0, 0, 0, 1],
};

// Display P3 to Rec.709: P3's green lies outside sRGB, so it comes out with
// negative red and blue.
const P3: InputTransform = {
  ...SRGB,
  toRec709: [1.2249, -0.2247, 0, -0.042, 1.0419, 0, -0.0197, -0.0786, 1.0979],
};

/** Codes for a test card: the left half a checker of red and blue with one
 *  channel at full scale each (where a RAW's highlights would be rebuilt from
 *  their neighbours), the right half flat patches, the last pure green. */
function card(): Uint8ClampedArray<ArrayBuffer> {
  const patches: [number, number, number][] = [[118, 118, 118], [200, 120, 60], [10, 20, 30], [0, 255, 0]];
  const codes = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const rgb: [number, number, number] =
        x < W / 2 ? ((x + y) % 2 === 0 ? [255, 170, 160] : [160, 170, 255]) : patches[Math.floor((x - W / 2) / 2)];
      codes.set([...rgb, 255], (y * W + x) * 4);
    }
  }
  return codes;
}

function converted(codes: Uint8ClampedArray, transform: InputTransform, displayReferred = true): Float16Source {
  const frame = linearizeCodes(codes, W, H, transform, 0);
  return { kind: "float16", ...frame, ...(displayReferred ? { displayReferred: true } : {}) };
}

function render(
  image: Parameters<WebGLRenderer["setImage"]>[0],
  version: 1 | 2 | 3,
  opts: WebGLRendererOpts = {},
  point: "pre-output" | "scene" = "pre-output",
): Frame {
  return withRenderer({ processVersionCap: 3, ...opts }, (renderer) => {
    renderer.setImage(image);
    renderer.setParams(identityParams({ processVersion: version }));
    renderer.render();
    const frame = renderer.readFloatFrame(point);
    if (!frame) throw new Error("readFloatFrame returned null");
    return frame;
  });
}

const VERSIONS = [1, 2, 3] as const;
const GREEN_PATCH: [number, number] = [W - 1, 3];

describe("a display-referred source", () => {
  for (const version of VERSIONS) {
    it(`renders as its 8-bit bitmap does where both hold its colours, version ${version}`, async () => {
      const codes = card();
      const bitmap = await createImageBitmap(new ImageData(codes, W, H));

      const fromHalves = render(converted(codes, SRGB), version);
      const fromBitmap = render(bitmap, version);

      expect(worstDifference(fromHalves, fromBitmap)).toBeLessThan(PIXEL_TOLERANCE);
    });

    it(`renders a colour outside sRGB without NaN, version ${version}`, () => {
      const frame = render(converted(card(), P3), version);

      expect(frame.data.every(Number.isFinite)).toBe(true);
    });
  }

  it("keeps the negative channels of a colour outside sRGB in the scene", () => {
    const [r, g, b] = pixelAt(render(converted(card(), P3), 3, { pipeline: OPEN_PROBE }, "scene"), ...GREEN_PATCH);

    expect(r).toBeLessThan(-0.2);
    expect(g).toBeGreaterThan(1);
    expect(b).toBeLessThan(-0.05);
  });

  // The same halves as a RAW cache entry take the base curve and have their
  // full-scale channels rebuilt: the flag is what keeps both off.
  it("takes the base curve only without the flag", () => {
    const codes = card();
    const flagged = render(converted(codes, SRGB), 1);
    const asRaw = render(converted(codes, SRGB, false), 1);

    expect(worstDifference(flagged, asRaw)).toBeGreaterThan(0.05);
  });

  it("rebuilds no full-scale channel from its neighbours, as a RAW's are", async () => {
    const codes = card();
    // The probe skips the base curve, so only the reconstruction can differ.
    const opts = { pipeline: LINEAR_PROBE_PIPELINE };
    const patches = (x: number) => x >= W / 2;
    const flagged = render(converted(codes, SRGB), 1, opts);
    const asRaw = render(converted(codes, SRGB, false), 1, opts);
    const fromBitmap = render(await createImageBitmap(new ImageData(codes, W, H)), 1, opts);

    expect(worstDifference(flagged, asRaw, patches)).toBeGreaterThan(0.01);
    expect(worstDifference(flagged, fromBitmap)).toBeLessThan(PIXEL_TOLERANCE);
  });
});
