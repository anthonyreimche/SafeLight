// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Which essentials a photo's edit needs: a moved tool whose params are away
// from their defaults, while its extension isn't running.

import { describe, expect, it } from "vitest";
import { DEFAULT_DEVELOP_PARAMS, defaultMaskAdjustments, type DevelopParams } from "@/catalog/types";
import { officialExtension } from "./official-extensions";
import { ESSENTIAL_ADJUSTMENTS, missingAdjustments, stoppedEssentials, withStoppedEssentials } from "./essential-params";

const AS_SHOT = 4237;
/** An unedited photo shot at AS_SHOT, with its default sharpening off so only
 *  the change a test makes counts (Detail counts any sharpening). */
const UNEDITED: DevelopParams = { ...DEFAULT_DEVELOP_PARAMS, temperature: AS_SHOT, sharpening: 0 };
const withVignette: DevelopParams = {
  ...UNEDITED,
  vignette: { ...DEFAULT_DEVELOP_PARAMS.vignette, amount: -20 },
};
const nothingRuns = () => false;

describe("ESSENTIAL_ADJUSTMENTS", () => {
  it("names official essentials only, each once", () => {
    const ids = ESSENTIAL_ADJUSTMENTS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(officialExtension(id)?.essential, id).toBe(true);
  });

  it("gives every params key to one essential", () => {
    const keys = ESSENTIAL_ADJUSTMENTS.flatMap((e) => e.params);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("holds Colour Grading's wheels", () => {
    expect(ESSENTIAL_ADJUSTMENTS.find((e) => e.id === "safelight.color-grading")).toEqual({
      id: "safelight.color-grading",
      name: "Colour Grading",
      params: ["colorGrading"],
    });
  });

  it("holds White Balance's Temp and Tint", () => {
    expect(ESSENTIAL_ADJUSTMENTS.find((e) => e.id === "safelight.white-balance")).toMatchObject({
      id: "safelight.white-balance",
      name: "White Balance",
      params: ["temperature", "tint"],
    });
  });

  it("holds Basic's thirteen sliders", () => {
    expect(ESSENTIAL_ADJUSTMENTS.find((e) => e.id === "safelight.basic")).toEqual({
      id: "safelight.basic",
      name: "Basic",
      params: [
        "exposure",
        "contrast",
        "highlights",
        "highlightDetail",
        "shadows",
        "shadowDetail",
        "whites",
        "blacks",
        "texture",
        "clarity",
        "dehaze",
        "vibrance",
        "saturation",
      ],
    });
  });

  // Noise reduction stays core and renders without Detail; only the panel moved.
  it("holds Detail's sharpening, not the noise reduction core renders", () => {
    expect(ESSENTIAL_ADJUSTMENTS.find((e) => e.id === "safelight.detail")).toMatchObject({
      id: "safelight.detail",
      name: "Detail",
      params: ["sharpening", "sharpenRadius", "sharpenDetail", "sharpenMasking"],
    });
  });

  it("holds the Tone Curve's curves", () => {
    expect(ESSENTIAL_ADJUSTMENTS.find((e) => e.id === "safelight.tone-curve")).toEqual({
      id: "safelight.tone-curve",
      name: "Tone Curve",
      params: ["toneCurve"],
    });
  });

  it("holds HSL's bands", () => {
    expect(ESSENTIAL_ADJUSTMENTS.find((e) => e.id === "safelight.hsl")).toEqual({
      id: "safelight.hsl",
      name: "HSL",
      params: ["hsl"],
    });
  });

  it("holds Effects' vignette and grain", () => {
    expect(ESSENTIAL_ADJUSTMENTS.find((e) => e.id === "safelight.effects")).toEqual({
      id: "safelight.effects",
      name: "Effects",
      params: ["vignette", "grain"],
    });
  });
});

describe("missingAdjustments", () => {
  it("is empty for an unedited photo", () => {
    expect(missingAdjustments(UNEDITED, nothingRuns, AS_SHOT)).toEqual([]);
  });

  it("names the essential whose params the photo changed", () => {
    expect(missingAdjustments(withVignette, nothingRuns, AS_SHOT).map((e) => e.id)).toEqual(["safelight.effects"]);
  });

  it("sees a change in any field of a nested param", () => {
    const grain = { ...UNEDITED, grain: { ...DEFAULT_DEVELOP_PARAMS.grain, size: 40 } };
    expect(missingAdjustments(grain, nothingRuns, AS_SHOT).map((e) => e.id)).toEqual(["safelight.effects"]);
  });

  // A photo opens at its as-shot white balance, which is no adjustment.
  it("counts White Balance only away from the photo's as-shot values", () => {
    const at = (temperature: number, tint: number) =>
      missingAdjustments({ ...UNEDITED, temperature, tint }, nothingRuns, AS_SHOT).map((e) => e.id);
    expect(at(AS_SHOT, 0)).toEqual([]);
    expect(at(AS_SHOT + 300, 0)).toEqual(["safelight.white-balance"]);
    expect(at(AS_SHOT, 12)).toEqual(["safelight.white-balance"]);
  });

  // Every photo opens with some sharpening, which Detail renders.
  it("counts Detail whenever the photo sharpens at all", () => {
    const at = (sharpening: number) =>
      missingAdjustments({ ...UNEDITED, sharpening }, nothingRuns, AS_SHOT).map((e) => e.id);
    expect(at(DEFAULT_DEVELOP_PARAMS.sharpening)).toEqual(["safelight.detail"]);
    expect(at(0)).toEqual([]);
  });

  it("leaves out an essential that is running", () => {
    expect(missingAdjustments(withVignette, (id) => id === "safelight.effects", AS_SHOT)).toEqual([]);
  });
});

describe("Crop & Straighten and Transform", () => {
  it("hold the geometry's params: Crop the crop and straighten, Transform the rest", () => {
    expect(ESSENTIAL_ADJUSTMENTS.find((e) => e.id === "safelight.crop")).toMatchObject({
      name: "Crop & Straighten",
      params: ["crop", "straighten"],
    });
    expect(ESSENTIAL_ADJUSTMENTS.find((e) => e.id === "safelight.transform")).toMatchObject({
      name: "Transform",
      params: ["transform", "uprightMode", "guidedLines"],
    });
  });

  it("are missing for a cropped or keystoned photo", () => {
    const cropped = { ...UNEDITED, crop: { x: 0.1, y: 0, width: 0.8, height: 1 } };
    const keystoned = { ...UNEDITED, transform: { ...DEFAULT_DEVELOP_PARAMS.transform, perspectiveV: 20 } };
    expect(missingAdjustments(cropped, nothingRuns, AS_SHOT).map((e) => e.id)).toEqual(["safelight.crop"]);
    expect(missingAdjustments(keystoned, nothingRuns, AS_SHOT).map((e) => e.id)).toEqual(["safelight.transform"]);
  });
});

describe("Masking", () => {
  it("holds the masks, missing for a photo that has any", () => {
    expect(ESSENTIAL_ADJUSTMENTS.find((e) => e.id === "safelight.masks")).toMatchObject({ name: "Masking", params: ["masks"] });
    const masked = {
      ...UNEDITED,
      masks: [
        {
          id: "m1", name: "Mask", visible: true, invert: true, opacity: 100,
          adj: { ...defaultMaskAdjustments(), exposure: 1 }, panels: [], components: [],
        },
      ],
    };
    expect(missingAdjustments(masked, nothingRuns, AS_SHOT).map((e) => e.id)).toEqual(["safelight.masks"]);
  });
});

describe("Heal", () => {
  it("holds the spots, missing for a photo that has any", () => {
    expect(ESSENTIAL_ADJUSTMENTS.find((e) => e.id === "safelight.heal")).toMatchObject({ name: "Heal", params: ["retouch"] });
    const healed = {
      ...UNEDITED,
      retouch: [
        {
          id: "s1", shape: "circle" as const, mode: "heal" as const, visible: true,
          dstX: 0.5, dstY: 0.5, srcX: 0.4, srcY: 0.5, radius: 0.04, feather: 50, opacity: 100,
        },
      ],
    };
    expect(missingAdjustments(healed, nothingRuns, AS_SHOT).map((e) => e.id)).toEqual(["safelight.heal"]);
  });
});

// A stage that reads another tool's params (Crop's matrix reads Transform's)
// drops that tool with it: derive sees a stopped essential at its defaults.
describe("withStoppedEssentials", () => {
  const keystoned = { ...UNEDITED, transform: { ...DEFAULT_DEVELOP_PARAMS.transform, perspectiveV: 20 } };

  it("puts a stopped essential's params back to their defaults", () => {
    const got = withStoppedEssentials(keystoned, ["safelight.transform"]);
    expect(got.transform).toEqual(DEFAULT_DEVELOP_PARAMS.transform);
    expect(got.vignette).toBe(keystoned.vignette);
  });

  it("hands back the same params when nothing changes, and the same result for the same call", () => {
    expect(withStoppedEssentials(keystoned, [])).toBe(keystoned);
    expect(withStoppedEssentials(UNEDITED, ["safelight.transform"])).toBe(UNEDITED);
    expect(withStoppedEssentials(keystoned, ["safelight.transform"])).toBe(withStoppedEssentials(keystoned, ["safelight.transform"]));
  });

  // A thumbnail's params are reset between the live photo's frames.
  it("hands back the same result for params met again after others", () => {
    const other = { ...UNEDITED, transform: { ...DEFAULT_DEVELOP_PARAMS.transform, perspectiveH: 5 } };
    const live = withStoppedEssentials(keystoned, ["safelight.transform"]);
    withStoppedEssentials(other, ["safelight.transform"]);
    expect(withStoppedEssentials(keystoned, ["safelight.transform"])).toBe(live);
    expect(withStoppedEssentials(keystoned, ["safelight.crop"])).not.toBe(live);
  });
});

describe("stoppedEssentials", () => {
  it("names the essentials neither running nor registering a stage", () => {
    const stopped = stoppedEssentials(["safelight.basic"], [{ extensionId: "safelight.crop" }]);
    expect(stopped).toContain("safelight.transform");
    expect(stopped).not.toContain("safelight.basic");
    expect(stopped).not.toContain("safelight.crop");
  });
});
