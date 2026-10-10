// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The conversions the core wraps around a stage that declares a space. They
// must invert to float precision (a stage that changes nothing must hand back
// what it got, signs and values above 1 included) and match the GLSL the shader
// runs.

import { describe, expect, it } from "vitest";
import type { StageSpace } from "@/extensions/types";
import {
  REC2020_TO_REC709,
  REC709_TO_REC2020,
  STAGE_SPACE_GLSL,
  decodePerceptual,
  encodePerceptual,
  fromSpaceExpr,
  fromStageSpace,
  isIdentitySpace,
  spaceKey,
  toSpaceExpr,
  toStageSpace,
} from "./stage-space";

const SPACES: StageSpace[] = [
  { encoding: "linear" },
  { encoding: "linear", primaries: "rec2020" },
  { encoding: "perceptual" },
  { encoding: "perceptual", primaries: "rec2020" },
];
const SAMPLES = [-0.4, -0.02, 0, 0.0005, 0.02, 0.18, 0.5, 1, 2.5];

describe("perceptual encoding", () => {
  it("matches the sRGB curve on [0, 1]", () => {
    expect(encodePerceptual(0.18)).toBeCloseTo(0.46135, 4);
    expect(encodePerceptual(1)).toBeCloseTo(1, 12);
    expect(encodePerceptual(0.001)).toBeCloseTo(0.01292, 8);
  });

  it("keeps the sign below black and carries on above white", () => {
    expect(encodePerceptual(-0.18)).toBeCloseTo(-encodePerceptual(0.18), 12);
    expect(encodePerceptual(2)).toBeCloseTo(1.055 * Math.pow(2, 1 / 2.4) - 0.055, 12);
  });

  it("inverts to float precision", () => {
    for (const x of SAMPLES) expect(decodePerceptual(encodePerceptual(x))).toBeCloseTo(x, 9);
  });
});

describe("Rec.709 ↔ Rec.2020", () => {
  it("maps white to white", () => {
    for (let r = 0; r < 3; r++) {
      const row = REC709_TO_REC2020.slice(r * 3, r * 3 + 3);
      expect(row[0] + row[1] + row[2]).toBeCloseTo(1, 6);
    }
  });

  it("puts Rec.709 red where BT.2087 does", () => {
    const red = toStageSpace([1, 0, 0], { encoding: "linear", primaries: "rec2020" }, "scene");
    expect(red[0]).toBeCloseTo(0.6274, 4);
    expect(red[1]).toBeCloseTo(0.0691, 4);
    expect(red[2]).toBeCloseTo(0.0164, 4);
  });

  it("has an inverse that undoes it", () => {
    for (let r = 0; r < 3; r++)
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let k = 0; k < 3; k++)
          sum += REC2020_TO_REC709[r * 3 + k] * REC709_TO_REC2020[k * 3 + c];
        expect(sum).toBeCloseTo(r === c ? 1 : 0, 12);
      }
  });
});

describe("stage spaces", () => {
  it("treats the working space of each domain as identity", () => {
    expect(isIdentitySpace(undefined, "scene")).toBe(true);
    expect(isIdentitySpace({ encoding: "linear" }, "scene")).toBe(true);
    expect(isIdentitySpace({ encoding: "perceptual" }, "display")).toBe(true);
    expect(isIdentitySpace({ encoding: "linear" }, "display")).toBe(false);
    expect(isIdentitySpace({ encoding: "perceptual" }, "scene")).toBe(false);
    expect(spaceKey(undefined, "scene")).toBe(
      spaceKey({ encoding: "linear", primaries: "rec709" }, "scene"),
    );
  });

  for (const domain of ["scene", "display"] as const)
    for (const space of SPACES) {
      const desc = `round-trips ${space.encoding}/${
        space.primaries ?? "rec709"
      } in the ${domain} domain to float precision`;
      it(desc, () => {
        for (const v of SAMPLES) {
          const back = fromStageSpace(
            toStageSpace([v, v * 0.5, -v], space, domain),
            space,
            domain,
          );
          expect(back[0]).toBeCloseTo(v, 9);
          expect(back[1]).toBeCloseTo(v * 0.5, 9);
          expect(back[2]).toBeCloseTo(-v, 9);
        }
      });
    }

  it("emits no GLSL for an identity conversion", () => {
    expect(toSpaceExpr(undefined, "scene", "lin")).toBe("lin");
    expect(fromSpaceExpr({ encoding: "perceptual" }, "display", "c")).toBe("c");
  });

  it("emits all 9 matrix entries column-major for both REC709↔REC2020", () => {
    const m709to20 = STAGE_SPACE_GLSL.match(/SL_REC709_TO_REC2020 = mat3\(([^)]*)\)/)![1]
      .split(",")
      .map(Number);
    const m20to709 = STAGE_SPACE_GLSL.match(/SL_REC2020_TO_REC709 = mat3\(([^)]*)\)/)![1]
      .split(",")
      .map(Number);
    // Column-major: [c0r0, c0r1, c0r2, c1r0, c1r1, c1r2, c2r0, c2r1, c2r2]
    // maps to row-major: [r0c0, r0c1, r0c2, r1c0, r1c1, r1c2, r2c0, r2c1, r2c2]
    // so GLSL[c * 3 + r] should equal M[r * 3 + c]
    for (let c = 0; c < 3; c++)
      for (let r = 0; r < 3; r++) {
        expect(m709to20[c * 3 + r]).toBeCloseTo(REC709_TO_REC2020[r * 3 + c], 10);
        expect(m20to709[c * 3 + r]).toBeCloseTo(REC2020_TO_REC709[r * 3 + c], 10);
      }
  });

  it("emits exact GLSL strings for toSpaceExpr and fromSpaceExpr", () => {
    // Table-driven: 4 spaces × 2 domains × 2 directions with v = "x"
    const testCases: Array<{
      space: StageSpace | undefined;
      domain: "scene" | "display";
      toExpr: string;
      fromExpr: string;
    }> = [
      // scene domain: working space = linear rec709
      { space: undefined, domain: "scene", toExpr: "x", fromExpr: "x" },
      {
        space: { encoding: "linear" },
        domain: "scene",
        toExpr: "x",
        fromExpr: "x",
      },
      {
        space: { encoding: "linear", primaries: "rec2020" },
        domain: "scene",
        toExpr: "(SL_REC709_TO_REC2020 * x)",
        fromExpr: "(SL_REC2020_TO_REC709 * x)",
      },
      {
        space: { encoding: "perceptual" },
        domain: "scene",
        toExpr: "slEncodePerceptual(x)",
        fromExpr: "slDecodePerceptual(x)",
      },
      {
        space: { encoding: "perceptual", primaries: "rec2020" },
        domain: "scene",
        toExpr: "slEncodePerceptual(SL_REC709_TO_REC2020 * x)",
        fromExpr: "(SL_REC2020_TO_REC709 * slDecodePerceptual(x))",
      },
      // display domain: working space = perceptual rec709
      { space: undefined, domain: "display", toExpr: "x", fromExpr: "x" },
      {
        space: { encoding: "linear" },
        domain: "display",
        toExpr: "slDecodePerceptual(x)",
        fromExpr: "slEncodePerceptual(x)",
      },
      {
        space: { encoding: "linear", primaries: "rec2020" },
        domain: "display",
        toExpr: "(SL_REC709_TO_REC2020 * slDecodePerceptual(x))",
        fromExpr: "slEncodePerceptual(SL_REC2020_TO_REC709 * x)",
      },
      {
        space: { encoding: "perceptual" },
        domain: "display",
        toExpr: "x",
        fromExpr: "x",
      },
      {
        space: { encoding: "perceptual", primaries: "rec2020" },
        domain: "display",
        toExpr: "slEncodePerceptual(SL_REC709_TO_REC2020 * slDecodePerceptual(x))",
        fromExpr: "slEncodePerceptual(SL_REC2020_TO_REC709 * slDecodePerceptual(x))",
      },
    ];

    for (const { space, domain, toExpr, fromExpr } of testCases) {
      expect(toSpaceExpr(space, domain, "x")).toBe(toExpr);
      expect(fromSpaceExpr(space, domain, "x")).toBe(fromExpr);
      const idents = new Set<string>();
      for (const id of toExpr.matchAll(/\b(sl\w+|SL_\w+)\b/g)) idents.add(id[1]);
      for (const id of fromExpr.matchAll(/\b(sl\w+|SL_\w+)\b/g)) idents.add(id[1]);
      for (const id of idents)
        expect(STAGE_SPACE_GLSL).toMatch(
          new RegExp(String.raw`\b(?:mat3|vec3)\s+${id}\b`),
        );
    }
  });
});
