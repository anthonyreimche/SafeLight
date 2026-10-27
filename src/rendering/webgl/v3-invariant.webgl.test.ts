// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What this guards: on version 3 nothing is clipped before the output stage.
// One over-range, out-of-gamut scene goes through the whole default stage set,
// and the signed `c` the output stage receives (readFloatFrame at "pre-output")
// must keep every channel below 0 and, under a transform that skips the core
// shoulder, every channel above 1. Each ingredient is a place a clip could hide:
// - the shipping defaults' Colour NR and sharpening: the built-in denoiser
//   stores the frame in its prepass targets, and sharpening adds detail taps
// - core Vignette and Grain, whose version 1 helpers end in a clamp
// - a mask with scene-only adjustments: mask stage 2 must leave its area alone
// - a clone spot, so the frame develops from the patched copy
// - an extension display stage that declares the display's own space
// - a reads-current stage with a wide space, whose split stores the image
// The read-back is shown able to see a clip: an active Whites, a legacy display
// stage, a mask display adjustment, and the same assertions on process version
// 1, which clips after the transform.

import { describe, expect, it } from "vitest";
import { DEFAULT_DEVELOP_PARAMS, defaultMaskAdjustments } from "@/catalog/types";
import type { DevelopParams, Mask, RetouchSpot } from "@/catalog/types";
import { BUILTIN_RESOLVED, type ResolvedPipeline } from "@/extensions/pipelines";
import type { ProcessingStageContribution } from "@/extensions/types";
import type { Vec3 } from "../stage-space";
import { denoiseBag } from "./builtin-denoise";
import { OPEN_PROBE, builtinStages, floatImage, pixelAt, toHalf, withRenderer, type Frame } from "./webgl.test-support";

// Six 72 px patches across, in two rows; the mask covers the bottom row only.
// A patch is read as the mean of the 7 x 7 block at its centre, which keeps
// 33 px from its edges, beyond the built-in denoiser's widest a-trous tap
// (dilation 16 x 2 = 32 px): with smaller patches its colour NR smooths chroma
// across them (with 8 px patches the grey picked up its neighbour's red). The
// mean takes grain (sigma up to 0.028 here) down to a seventh, so grain on a
// channel clipped at 0 can't pass for one that kept its sign.
const PATCHES: Vec3[] = [
  [3.0, 3.0, 3.0], // bright neutral: all three channels over 1
  [-0.2, 0.6, -0.1], // saturated green outside sRGB
  [2.5, 1.2, 0.6], // bright orange, two channels over
  [-0.05, 0.25, 0.35], // deep cyan, red below 0
  [0.18, 0.18, 0.18], // grey
  [1.6, -0.1, 0.3], // over-range red, green below 0
];
const P = 72;
const SCENE = floatImage(PATCHES.length * P, 2 * P, (x) => PATCHES[Math.floor(x / P)]);
type Row = 0 | 1;
function at(f: Frame, i: number, row: Row): Vec3 {
  const sum: [number, number, number] = [0, 0, 0];
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      pixelAt(f, i * P + P / 2 + dx, row * P + P / 2 + dy).forEach((v, ch) => (sum[ch] += v / 49));
    }
  }
  return sum;
}

const amount = (key: string, def = 0) => [{ key, glslType: "float" as const, default: def }];

/** Declares the display's own space and changes nothing. */
const SPACED_DISPLAY: ProcessingStageContribution = {
  id: "invariant.spaced",
  name: "Spaced",
  phase: "display-adjust",
  priority: 120,
  space: { encoding: "perceptual" },
  glsl: "c *= spGain;",
  uniforms: amount("spGain", 1),
};
/** The same without `space`: the legacy contract hands it [0, 1]. */
const LEGACY_DISPLAY: ProcessingStageContribution = {
  ...SPACED_DISPLAY,
  id: "invariant.legacy",
  name: "Legacy",
  space: undefined,
  glsl: "c *= lgGain;",
  uniforms: amount("lgGain", 1),
};
/** Reads the current image through a split, in linear Rec.2020, and puts it back. */
const WIDE_READER: ProcessingStageContribution = {
  id: "invariant.reader",
  name: "Wide reader",
  phase: "display-adjust",
  priority: 110,
  reads: "current",
  space: { encoding: "linear", primaries: "rec2020" },
  glsl: "c = mix(c, stageResult, rdMix);",
  uniforms: amount("rdMix"),
  passes: [{ glsl: "c = readPrev(vUv);" }],
};
const FULL_SET = [...builtinStages(), SPACED_DISPLAY, WIDE_READER];
const BAG = { "invariant.reader.rdMix": 1 };

/** Over the bottom row, +1 EV and no display adjustment unless `over` adds one. */
function bottomMask(over: Partial<Mask["adj"]> = {}): Mask {
  return {
    id: "m",
    name: "bottom",
    visible: true,
    invert: false,
    opacity: 100,
    adj: { ...defaultMaskAdjustments(), exposure: 40, ...over },
    panels: ["core.basic"],
    components: [{ id: "c", kind: "linear", mode: "add", invert: false, linear: { x0: 0, y0: 0.45, x1: 0, y1: 0.55 } }],
  };
}

/** In a corner, away from every sampled pixel. */
const CORNER_SPOT: RetouchSpot = {
  id: "s",
  shape: "circle",
  mode: "clone",
  visible: true,
  dstX: 0.02,
  dstY: 0.05,
  srcX: 0.04,
  srcY: 0.05,
  radius: 0.02,
  feather: 0,
  opacity: 100,
};

/** The shipping defaults (sharpening 25, Colour NR 25) with every ingredient in use. */
function fullParams(processVersion: number, over: Partial<DevelopParams> = {}): DevelopParams {
  return {
    ...DEFAULT_DEVELOP_PARAMS,
    processVersion,
    vignette: { ...DEFAULT_DEVELOP_PARAMS.vignette, amount: -30 },
    grain: { ...DEFAULT_DEVELOP_PARAMS.grain, amount: 20 },
    masks: [bottomMask()],
    retouch: [CORNER_SPOT],
    ...over,
  };
}

function preOutput(pipeline: ResolvedPipeline, params: DevelopParams, stages = FULL_SET): Frame {
  return withRenderer({ stages, pipeline, processVersionCap: 3 }, (r) => {
    r.setImage(SCENE);
    r.setContributedParams({ ...BAG, ...denoiseBag(params) });
    r.setParams(params);
    r.render();
    // The identity space hands back `c` itself, unconverted.
    const frame = r.readFloatFrame("pre-output", Infinity, { encoding: "perceptual" });
    if (!frame) throw new Error("readFloatFrame returned null");
    return frame;
  });
}

interface Sample {
  patch: number;
  label: string;
  src: number;
  got: number;
}
const samples = (f: Frame, rows: readonly Row[] = [0, 1]): Sample[] =>
  rows.flatMap((row) =>
    PATCHES.flatMap((src, patch) =>
      at(f, patch, row).map((got, ch) => ({
        patch,
        label: `patch ${patch} ch ${ch} row ${row}: ${src[ch]} -> ${got}`,
        src: src[ch],
        got,
      })),
    ),
  );

// A channel this far outside [0, 1] is one nothing clipped. A clip can leave
// less: the averaged grain (within about 0.012) and the reads-current split's
// RGBA16F store, which moves a clipped channel by up to ~6e-4 (seen: -0.00062,
// 1.00004). The smallest source excursion, the cyan's -0.05, keeps over 0.04.
const MARGIN = 0.02;
/** The samples whose source lies clearly outside [0, 1], and whether each kept its side. */
const outsideUnit = (f: Frame, rows?: readonly Row[]) =>
  samples(f, rows)
    .filter(({ src }) => src < -0.04 || src > 1.05)
    .map((s) => ({ ...s, kept: s.src < 0 ? s.got < -MARGIN : s.got > 1 + MARGIN }));
const labels = (list: readonly { label: string }[]) => list.map((s) => s.label);

// Version 1 clips after the transform, so the same assertions must fail there:
// each case runs on it expecting every channel back inside [0, 1].
const VERSIONS = [
  { version: 3, clips: false },
  { version: 1, clips: true },
] as const;

describe("the signed colour reaching the output stage", () => {
  it("is the scene itself on version 3 under the open probe with nothing in use", () => {
    const quiet = fullParams(3, {
      sharpening: 0,
      colorNR: 0,
      vignette: DEFAULT_DEVELOP_PARAMS.vignette,
      grain: DEFAULT_DEVELOP_PARAMS.grain,
      masks: [],
      retouch: [],
    });
    for (const { label, src, got } of samples(preOutput(OPEN_PROBE, quiet, builtinStages()))) {
      expect(Math.abs(got - toHalf(src)), label).toBeLessThan(2e-3 * Math.max(1, Math.abs(src)));
    }
  });

  describe.each(VERSIONS)("on process version $version", ({ version, clips }) => {
    it(`${clips ? "loses" : "keeps"} channels below 0 and above 1 through the full stage set without the shoulder`, () => {
      const f = preOutput(OPEN_PROBE, fullParams(version));
      const outside = outsideUnit(f);
      expect(labels(outside.filter((s) => s.kept === clips))).toEqual([]);
      // The mask's +1 EV reached the covered row, clipped there only on version 1.
      const [masked, unmasked] = [at(f, 0, 1)[0], at(f, 0, 0)[0]];
      if (clips) expect(masked).toBeLessThan(1 + MARGIN);
      else expect(masked).toBeGreaterThan(1.5 * unmasked);
    });

    // With the shoulder, path-to-white (slPathToWhite) draws any colour whose
    // strongest channel passes 0.9 toward its own luminance, so a bright
    // out-of-gamut colour loses its negative channels there by design (the
    // orange, the red, and every patch in the +1 EV row). The green and the cyan
    // in the uncovered row are left alone by it, and must keep them.
    it(`${clips ? "loses" : "keeps"} channels below 0 under the default transform where the shoulder leaves the colour alone`, () => {
      const f = preOutput(BUILTIN_RESOLVED, fullParams(version));
      const leftAlone = outsideUnit(f, [0]).filter((s) => s.patch === 1 || s.patch === 3);
      expect(leftAlone.length).toBeGreaterThan(0);
      expect(labels(leftAlone.filter((s) => s.kept === clips))).toEqual([]);
      // Path-to-white at work, not a clip: the +1 EV green is drawn to a bright near-grey.
      if (!clips) expect(Math.min(...at(f, 1, 1))).toBeGreaterThan(0.5);
    });
  });

  describe("read back inside [0, 1] where something clips on version 3", () => {
    // Grain, sharpening and NR off, so nothing after the clip moves a value, and
    // no wide reader, whose split moves a clipped channel (see MARGIN).
    const CONTROL = [...builtinStages(), SPACED_DISPLAY];
    const quiet = (over: Partial<DevelopParams>) =>
      fullParams(3, { grain: DEFAULT_DEVELOP_PARAMS.grain, sharpening: 0, colorNR: 0, ...over });
    const outside = (f: Frame, row: Row) => labels(samples(f, [row]).filter(({ got }) => got < -1e-6 || got > 1 + 1e-6));

    it("an active Whites clips its input", () => {
      expect(outside(preOutput(OPEN_PROBE, quiet({ whites: 50 }), CONTROL), 0)).toEqual([]);
    });

    it("a legacy display stage without a space is handed [0, 1]", () => {
      expect(outside(preOutput(OPEN_PROBE, quiet({}), [...builtinStages(), LEGACY_DISPLAY]), 0)).toEqual([]);
    });

    it("a mask with a display adjustment clips the covered row only", () => {
      const f = preOutput(OPEN_PROBE, quiet({ masks: [bottomMask({ contrast: 10 })] }), CONTROL);
      expect(outside(f, 1)).toEqual([]);
      expect(samples(f, [0]).some(({ got }) => got > 1.5)).toBe(true);
      expect(samples(f, [0]).some(({ got }) => got < -0.04)).toBe(true);
    });
  });
});
