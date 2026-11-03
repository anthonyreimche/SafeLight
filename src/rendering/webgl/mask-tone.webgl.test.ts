// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A mask's Temp, Tint and Shadows answer as the global sliders do from
// version 2: white balance moves colour, not a grey's brightness, and Shadows
// takes Basic's curve (local-tone.ts basicShadows), which grows in stops with
// the slider and leaves mid grey put. Version 1 photos keep the mask maths
// they were edited with.

import { describe, expect, it } from "vitest";
import {
  CURRENT_PROCESS_VERSION,
  DEFAULT_MASK_PANELS,
  LEGACY_PROCESS_VERSION,
  defaultMaskAdjustments,
  type DevelopParams,
  type Mask,
} from "@/catalog/types";
import { basicShadows } from "../local-tone";
import { encodePerceptual, type Vec3 } from "../stage-space";
import {
  OPEN_PROBE,
  builtinStages,
  floatImage,
  identityParams,
  patchPixel,
  withRenderer,
  worstDifference,
  type Frame,
} from "./webgl.test-support";

/** A grey wedge, 4 px patches side by side; MID is mid grey. The brightest
 *  stays under 1 after the largest channel gain below. */
const WEDGE = [0.002, 0.01, 0.05, 0.18, 0.4];
const MID = 3;
const SOURCE = floatImage(WEDGE.length * 4, 4, (x) => {
  const v = WEDGE[Math.floor(x / 4)];
  return [v, v, v];
});

/** Covers the whole frame. */
const wholeFrame = (adj: Partial<Mask["adj"]>): Mask => ({
  id: "all",
  name: "all",
  visible: true,
  invert: false,
  opacity: 100,
  adj: { ...defaultMaskAdjustments(), ...adj },
  panels: [...DEFAULT_MASK_PANELS],
  components: [{ id: "c", kind: "linear", mode: "add", invert: false, linear: { x0: -1, y0: 0, x1: -1 + 1e-4, y1: 0 } }],
});

function frameOf(params: DevelopParams): Frame {
  return withRenderer({ stages: builtinStages(), pipeline: OPEN_PROBE, processVersionCap: 3 }, (renderer) => {
    renderer.setImage(SOURCE);
    renderer.setParams(params);
    const frame = renderer.captureFloatFrame();
    if (!frame) throw new Error("captureFloatFrame returned null");
    return frame;
  });
}

const lumaOf = ([r, g, b]: Vec3) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const stopsMoved = (frame: Frame, plain: Frame, i: number) =>
  Math.log2(lumaOf(patchPixel(frame, i)) / lumaOf(patchPixel(plain, i)));

const WB_EDITS: Partial<Mask["adj"]>[] = [
  { tint: 100 },
  { tint: -100 },
  { temperature: 100 },
  { temperature: -100 },
  { temperature: 60, tint: -40 },
];

describe.each([CURRENT_PROCESS_VERSION, 3])("a mask on process version %i", (processVersion) => {
  const withMask = (adj: Partial<Mask["adj"]>) => identityParams({ processVersion, masks: [wholeFrame(adj)] });

  it("changes nothing with every slider at 0", () => {
    expect(worstDifference(frameOf(withMask({})), frameOf(identityParams({ processVersion })))).toBe(0);
  });

  it.each(WB_EDITS)("keeps every grey's luminance at %o", (adj) => {
    const plain = frameOf(identityParams({ processVersion }));
    const frame = frameOf(withMask(adj));
    WEDGE.forEach((v, i) => expect(Math.abs(stopsMoved(frame, plain, i)), `grey ${v}`).toBeLessThan(0.02));
  });

  it("casts magenta at +Tint and warm at +Temp", () => {
    const [r, g, b] = patchPixel(frameOf(withMask({ tint: 100 })), MID);
    expect(g / r).toBeLessThan(0.9);
    expect(b / r).toBeCloseTo(1, 2);
    const [wr, , wb] = patchPixel(frameOf(withMask({ temperature: 100 })), MID);
    expect(wr / wb).toBeGreaterThan(1.5);
  });

  it.each([-100, -50, 50, 100])("takes Basic's Shadows curve at %i", (shadows) => {
    const frame = frameOf(withMask({ shadows }));
    WEDGE.forEach((v, i) => {
      const want = basicShadows(v, shadows / 100);
      expect(Math.abs(Math.log2(lumaOf(patchPixel(frame, i)) / want)), `grey ${v}`).toBeLessThan(0.02);
    });
  });

  it("darkens the deep shadows about twice as far at -100 as at -50, and leaves mid grey", () => {
    const plain = frameOf(identityParams({ processVersion }));
    const half = stopsMoved(frameOf(withMask({ shadows: -50 })), plain, 0);
    const full = stopsMoved(frameOf(withMask({ shadows: -100 })), plain, 0);
    expect(full / half).toBeCloseTo(2, 1);
    expect(Math.abs(stopsMoved(frameOf(withMask({ shadows: -100 })), plain, MID))).toBeLessThan(0.02);
  });
});

describe("a mask on process version 1", () => {
  const params = (adj?: Partial<Mask["adj"]>) =>
    identityParams({ processVersion: LEGACY_PROCESS_VERSION, masks: adj ? [wholeFrame(adj)] : [] });

  it("keeps its channel gains: Tint +100 scales red and blue by 2^0.12, green by 2^-0.2", () => {
    const [r0, g0, b0] = patchPixel(frameOf(params()), MID);
    const [r, g, b] = patchPixel(frameOf(params({ tint: 100 })), MID);
    expect(r / r0).toBeCloseTo(2 ** 0.12, 2);
    expect(g / g0).toBeCloseTo(2 ** -0.2, 2);
    expect(b / b0).toBeCloseTo(2 ** 0.12, 2);
  });

  it("keeps its Shadows: a mix toward L^1.8 weighed by the scene's display tone", () => {
    const frame = frameOf(params({ shadows: -100 }));
    WEDGE.forEach((v, i) => {
      const w = Math.exp(-2.75 * encodePerceptual(v));
      const want = v + (v ** 1.8 - v) * w;
      expect(Math.abs(Math.log2(lumaOf(patchPixel(frame, i)) / want)), `grey ${v}`).toBeLessThan(0.02);
    });
  });
});
