// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// White balance moves colour, not brightness: from version 2 a grey keeps its
// luminance at any Temperature and Tint, as in Lightroom. Version 1 photos keep
// the green-normalized gains they were edited with, Tint's brightness swing
// included.

import { describe, expect, it } from "vitest";
import { CURRENT_PROCESS_VERSION, LEGACY_PROCESS_VERSION, type DevelopParams } from "@/catalog/types";
import type { Vec3 } from "../stage-space";
import { tintGain } from "../blackbody";
import { WHITE_BALANCE_EXTENSION_ID } from "./essential-stages.fixtures";
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
 *  stays under 1 after the largest gain below (2.35 on blue at 3200 K), where
 *  the capture would clip it. */
const WEDGE = [0.02, 0.05, 0.18, 0.3, 0.4];
const MID = 2;
const SOURCE = floatImage(WEDGE.length * 4, 4, (x) => {
  const v = WEDGE[Math.floor(x / 4)];
  return [v, v, v];
});

const STAGES = builtinStages();
const WITHOUT_WHITE_BALANCE = STAGES.filter((s) => s.extensionId !== WHITE_BALANCE_EXTENSION_ID);

function frameOf(params: DevelopParams, stages = STAGES): Frame {
  return withRenderer({ stages, pipeline: OPEN_PROBE, processVersionCap: 3 }, (renderer) => {
    renderer.setImage(SOURCE);
    renderer.setAsShotTemperature(6500);
    renderer.setParams(params);
    const frame = renderer.captureFloatFrame();
    if (!frame) throw new Error("captureFloatFrame returned null");
    return frame;
  });
}

const lumaOf = ([r, g, b]: Vec3) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
/** How far patch `i` moved from the as-shot render, in stops of luminance. */
const stopsMoved = (frame: Frame, neutral: Frame, i: number) =>
  Math.log2(lumaOf(patchPixel(frame, i)) / lumaOf(patchPixel(neutral, i)));

const WB_EDITS: [string, Partial<DevelopParams>][] = [
  ["Tint -150", { tint: -150 }],
  ["Tint -75", { tint: -75 }],
  ["Tint +75", { tint: 75 }],
  ["Tint +150", { tint: 150 }],
  ["3200 K", { temperature: 3200 }],
  ["9000 K", { temperature: 9000 }],
  ["4200 K, Tint +40", { temperature: 4200, tint: 40 }],
];

describe.each([CURRENT_PROCESS_VERSION, 3])("white balance on process version %i", (processVersion) => {
  it("is the decoded image at the as-shot white balance", () => {
    const neutral = frameOf(identityParams({ processVersion }));
    expect(worstDifference(neutral, frameOf(identityParams({ processVersion }), WITHOUT_WHITE_BALANCE))).toBe(0);
  });

  it.each(WB_EDITS)("keeps every grey's luminance at %s", (_, over) => {
    const neutral = frameOf(identityParams({ processVersion }));
    const frame = frameOf(identityParams({ processVersion, ...over }));
    WEDGE.forEach((v, i) => {
      expect(Math.abs(stopsMoved(frame, neutral, i)), `grey ${v}`).toBeLessThan(0.02);
    });
  });

  it("casts magenta at +Tint and green at -Tint, by the slider's green gain", () => {
    for (const tint of [-150, 150]) {
      const [r, g, b] = patchPixel(frameOf(identityParams({ processVersion, tint })), MID);
      expect(g / r, `tint ${tint}`).toBeCloseTo(tintGain(tint), 2);
      expect(b / r, `tint ${tint}`).toBeCloseTo(1, 2);
    }
  });
});

describe("white balance on process version 1", () => {
  const params = (over: Partial<DevelopParams> = {}) => identityParams({ processVersion: LEGACY_PROCESS_VERSION, ...over });
  it("keeps the green-normalized gains: Tint scales green alone", () => {
    const neutral = frameOf(params());
    for (const tint of [-150, 150]) {
      const [r, g, b] = patchPixel(frameOf(params({ tint })), MID);
      const [r0, g0, b0] = patchPixel(neutral, MID);
      expect(r / r0, `tint ${tint}`).toBeCloseTo(1, 3);
      expect(g / g0, `tint ${tint}`).toBeCloseTo(tintGain(tint), 2);
      expect(b / b0, `tint ${tint}`).toBeCloseTo(1, 3);
    }
    expect(stopsMoved(frameOf(params({ tint: 150 })), neutral, MID)).toBeLessThan(-0.75);
  });
});
