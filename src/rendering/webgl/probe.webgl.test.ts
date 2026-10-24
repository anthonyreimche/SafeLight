// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The eyedropper probe on the real renderer: a 5×5 patch of the live frame,
// read back as linear light where the output stage receives it ("output") or
// where the mask components compare it ("mask"). The probe transform encodes
// the scene as the stock one does and skips the baseline and the shoulder, so
// at identity both points see the scene.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_MASK_PANELS, defaultMaskAdjustments, type DevelopParams, type Mask, type MaskAdjustments,
} from "@/catalog/types";
import type { ResolvedPipeline } from "@/extensions/pipelines";
import type { ProcessingStageContribution } from "@/extensions/types";
import { outputDecode } from "../color-space";
import { encodePerceptual, type Vec3 } from "../stage-space";
import type { ProbePoint, WebGLRenderer } from "./renderer";
import { V2_DEFAULT_PIPELINE_GLSL } from "./shaders";
import {
  OPEN_PROBE, each, expectColour, floatImage, identityParams, pixelAt, toHalf, withRenderer, worstDifference,
  type FloatImage, type Frame,
} from "./webgl.test-support";

/** OPEN_PROBE with the stock version 2 encode, so `c` at the output stage is
 *  the scene perceptually encoded, as a photo's is. */
const PERCEPTUAL_PROBE: ResolvedPipeline = {
  ...OPEN_PROBE,
  id: "test.perceptual-probe",
  glsl: V2_DEFAULT_PIPELINE_GLSL,
  sig: "test.perceptual-probe",
};

// Scene-linear patches 32 px square: a green outside sRGB and a colour inside it.
const PATCHES = { outside: [-0.2, 0.6, -0.1], inside: [0.6, 0.35, 0.25] } satisfies Record<string, Vec3>;
type Patch = keyof typeof PATCHES;
const NAMES = Object.keys(PATCHES) as Patch[];
const SCENE = floatImage(64, 32, (x) => PATCHES[NAMES[Math.floor(x / 32)]]);
const held = (patch: Patch): Vec3 => each(PATCHES[patch], toHalf);
const other = (patch: Patch): Patch => (patch === "outside" ? "inside" : "outside");
// The middle buffer pixel of a patch; the probe reads two either side of it.
const middle = (patch: Patch): [number, number] => [(NAMES.indexOf(patch) * 32 + 16.5) / 64, 16.5 / 32];

// 64×32, a top half and a bottom half crossed by a 1 px column at x = 40 and a
// 1 px row at y = 8. A 5×5 patch centred on the crossing holds 9 line pixels.
const TOP: Vec3 = [0.2, 0.3, 0.4];
const BOTTOM: Vec3 = [0.5, 0.2, 0.1];
const LINE: Vec3 = [0.9, 0.8, 0.1];
const cross = (line: Vec3): FloatImage =>
  floatImage(64, 32, (x, y) => (x === 40 || y === 8 ? line : y < 16 ? TOP : BOTTOM));
const CROSS = cross(LINE);
const CROSSING: Vec3 = each([0, 1, 2], (ch) => (9 * toHalf(LINE[ch]) + 16 * toHalf(TOP[ch])) / 25);
// Lines past white in red, whose encoded red is over 1.
const HOT: Vec3 = [4, 0.8, 0.1];

interface Scene {
  image?: FloatImage;
  masks?: Mask[];
  stages?: ProcessingStageContribution[];
}

function onScene<T>(processVersion: number, fn: (r: WebGLRenderer) => T, scene: Scene = {}): T {
  return withRenderer({ stages: scene.stages ?? [], pipeline: PERCEPTUAL_PROBE, processVersionCap: 3 }, (r) => {
    r.setImage(scene.image ?? SCENE);
    r.setParams(identityParams({ processVersion, masks: scene.masks ?? [] }));
    return fn(r);
  });
}

function read(r: WebGLRenderer, u: number, v: number, point: ProbePoint): Vec3 {
  const rgb = r.probe(u, v, point);
  if (!rgb) throw new Error("probe returned null");
  return rgb;
}
const probe = (r: WebGLRenderer, patch: Patch, point: ProbePoint): Vec3 => read(r, ...middle(patch), point);

function capture(r: WebGLRenderer): Frame {
  const frame = r.captureFloatFrame();
  if (!frame) throw new Error("captureFloatFrame returned null");
  return frame;
}

const pixel = (f: Frame, patch: Patch): Vec3 => pixelAt(f, NAMES.indexOf(patch) * 32 + 16, 16);

const MAGENTA: [number, number, number] = [1, 0, 1];

/** A mask of one Colour Range component around `target`, tight enough that
 *  only the colour itself is covered whole. */
function colourRange([r, g, b]: Vec3): Mask {
  return {
    id: "picked", name: "Picked", visible: true, invert: false, opacity: 100,
    adj: defaultMaskAdjustments(), panels: [...DEFAULT_MASK_PANELS],
    components: [{
      id: "range", kind: "colorRange", mode: "add", invert: false,
      colorRange: { r, g, b, hueRange: 0.001, satRange: 0.01, smoothness: 0 },
    }],
  };
}

/** A mask over the whole frame (inverted, with no components) applying `adj`. */
function wholeFrame(adj: Partial<MaskAdjustments>): Mask {
  return {
    id: "whole", name: "Whole frame", visible: true, invert: true, opacity: 100,
    adj: { ...defaultMaskAdjustments(), ...adj }, panels: [...DEFAULT_MASK_PANELS], components: [],
  };
}

/** A Colour Range target taken from the probe covers its own patch whole and
 *  leaves the other out. `ahead` are masks listed before the picked one. */
function expectRoundTrip(processVersion: number, over: Partial<DevelopParams> = {}, ahead: Mask[] = []): void {
  onScene(processVersion, (r) => {
    const withPicked = (picked: Mask[]) =>
      identityParams({ processVersion, ...over, masks: [...ahead, ...picked] });
    r.setParams(withPicked([]));
    r.setMaskViz(ahead.length, MAGENTA, 1);
    for (const patch of NAMES) {
      const target = probe(r, patch, "mask");
      r.setParams(withPicked([colourRange(target)]));
      const f = capture(r);
      expectColour(pixel(f, patch), MAGENTA, `${patch} covered`);
      const away = Math.max(...pixel(f, other(patch)).map((v, ch) => Math.abs(v - MAGENTA[ch])));
      expect(away, `${other(patch)} left out`).toBeGreaterThan(0.1);
    }
  });
}

describe("the eyedropper probe", () => {
  it("reads nothing before a source", () => {
    withRenderer({ stages: [], pipeline: PERCEPTUAL_PROBE, processVersionCap: 3 }, (r) => {
      expect(r.probe(0.5, 0.5, "output")).toBeNull();
      expect(r.probe(0.5, 0.5, "mask")).toBeNull();
    });
  });

  it("reads version 3's output signed, as the scene", () => {
    onScene(3, (r) => {
      for (const patch of NAMES) expectColour(probe(r, patch, "output"), held(patch), patch);
      expect(Math.min(...probe(r, "outside", "output"))).toBeLessThan(0);
    });
  });

  it("reads version 2's output as its encode clips it", () => {
    const eotf = outputDecode("srgb");
    onScene(2, (r) => {
      for (const patch of NAMES) {
        const got = probe(r, patch, "output");
        const c = each(held(patch), encodePerceptual);
        expectColour(got, each(c, (v) => eotf(Math.min(Math.max(v, 0), 1))), patch);
        expect(Math.min(...got), patch).toBeGreaterThanOrEqual(0);
      }
    });
  });

  // Each pixel clips before the average, as the encode clips it, so the hot
  // lines' light past white stays out of the patch's colour.
  it("averages version 2's output in linear light, pixel by pixel", () => {
    const eotf = outputDecode("srgb");
    const shown = (scene: Vec3): Vec3 =>
      each(scene, (x) => eotf(Math.min(Math.max(encodePerceptual(toHalf(x)), 0), 1)));
    const want = each([0, 1, 2], (ch) => (9 * shown(HOT)[ch] + 16 * shown(TOP)[ch]) / 25);
    onScene(2, (r) => {
      expectColour(read(r, 40.5 / 64, 8.5 / 32, "output"), want, "crossing");
    }, { image: cross(HOT) });
  });

  for (const processVersion of [2, 3]) {
    it(`reads the scene where version ${processVersion}'s masks compare it`, () => {
      onScene(processVersion, (r) => {
        for (const patch of NAMES) expectColour(probe(r, patch, "mask"), held(patch), patch);
      });
    });
  }

  // The histogram redraws with what the last draw left bound.
  it("leaves the histogram measuring the frame", () => {
    onScene(3, (r) => {
      r.render();
      const frame = r.computeHistogram(true);
      for (const point of ["output", "mask"] as const) {
        probe(r, "inside", point);
        expect(r.computeHistogram(true), point).toEqual(frame);
      }
    });
  });

  // v runs down the frame, and the patch is 5×5 buffer pixels: a flipped v or
  // another size takes in other rows or another count of line pixels.
  it("averages 5×5 buffer pixels around (u, v), v down", () => {
    onScene(3, (r) => {
      expectColour(read(r, 40.5 / 64, 8.5 / 32, "mask"), CROSSING, "crossing");
    }, { image: CROSS });
  });

  // Zoomed 1:1 into the top-right quarter: the patch is 5 buffer pixels of
  // the window, not of the whole image.
  it("sizes the patch to the zoom window's buffer pixels", () => {
    onScene(3, (r) => {
      r.setViewport({ x: 0.5, y: 0, w: 0.5, h: 0.5 }, 32, 16);
      r.render();
      expectColour(read(r, 8.5 / 32, 8.5 / 16, "mask"), CROSSING, "crossing");
    }, { image: CROSS });
  });

  it("keeps a patch at the image's edge inside it", () => {
    onScene(3, (r) => {
      expectColour(read(r, 0, 0, "mask"), each(TOP, toHalf), "top left");
      expectColour(read(r, 1, 1, "mask"), each(BOTTOM, toHalf), "bottom right");
    }, { image: CROSS });
  });

  for (const processVersion of [2, 3]) {
    it(`hands Colour Range a target that selects its own patch whole, version ${processVersion}`, () => {
      expectRoundTrip(processVersion);
    });
  }

  // A global white balance ahead of the mask point and a whole-frame mask's
  // behind it: a target read before the one or after the other misses.
  it("hands Colour Range the colour it compares, away from identity", () => {
    expectRoundTrip(3, { temperature: 4500, tint: 20 }, [wholeFrame({ temperature: 50 })]);
  });

  // A stage that reads the current image gets its input from a draw of the
  // frame's program, cached for the frames after it. One drawn for a probe
  // must hand it the same input, or the live view goes on with a wrong copy.
  it("leaves a stage that reads the current image the input the live view gives it", () => {
    const copy: ProcessingStageContribution = {
      id: "test.current",
      name: "Current copy",
      phase: "scene-linear",
      reads: "current",
      glsl: "lin = mix(lin, stageResult, take);",
      uniforms: [{ key: "take", glslType: "float", default: 0 }],
      passes: [{ glsl: "c = c;" }],
    };
    // A stop up everywhere (±100 is ±2.5 EV), between the probe's point and the stage.
    const brighter = wholeFrame({ exposure: 40 });
    const frame = (probeFirst: boolean) =>
      onScene(3, (r) => {
        r.setContributedParams({ "test.current.take": 1 });
        if (probeFirst) probe(r, "inside", "mask");
        return capture(r);
      }, { masks: [brighter], stages: [copy] });
    expect(worstDifference(frame(true), frame(false))).toBeLessThan(1e-3);
  });
});
