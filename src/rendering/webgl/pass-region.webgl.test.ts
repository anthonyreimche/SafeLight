// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A pass that names its region has each draw write only that rectangle; the
// texels outside keep what the same ping-pong target last held. The stage's
// first two draws and its last are drawn whole whatever the region says.
// These passes add to every texel on every draw, against the region's rule, so
// what they leave shows which texels each draw wrote.

import { describe, expect, it } from "vitest";
import { CURRENT_PROCESS_VERSION } from "@/catalog/types";
import type { ProcessingStageContribution, StagePass } from "@/extensions/types";
import { LINEAR_PROBE_PIPELINE, basicStages, floatImage, identityParams, withRenderer, type Frame } from "./webgl.test-support";

const W = 16;
const H = 12;
const SCENE = floatImage(W, H, (x, y) => [0.05 + (0.3 * x) / W, 0.05 + (0.3 * y) / H, 0.2]);
const STEP = 0.0625;
const COUNT = "if (uPassIndex == 0) c = vec4(0.0); c += " + String(STEP) + ";";

function stage(passes: StagePass[], bag: Record<string, unknown> = {}): Frame {
  const s: ProcessingStageContribution = {
    id: "test.region",
    name: "Region",
    phase: "scene-linear",
    glsl: "lin = mix(lin, stageResult, take);",
    uniforms: [{ key: "take", glslType: "float", default: 0 }],
    passes,
  };
  return withRenderer({ stages: [...basicStages(), s], pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
    r.setImage(SCENE);
    r.setParams(identityParams({ processVersion: CURRENT_PROCESS_VERSION }));
    r.setContributedParams({ "test.region.take": 1, ...bag });
    const f = r.captureFloatFrame();
    if (!f) throw new Error("captureFloatFrame returned null");
    return f;
  });
}

// The frame a pass that writes `steps(x, y)` counts everywhere in one draw leaves.
function counted(steps: string): Frame {
  return stage([{ channels: 4, glsl: `ivec2 q = ivec2(gl_FragCoord.xy); c = vec4(float(${steps}) * ${String(STEP)});` }]);
}

const greys = (f: Frame): number[] => {
  const out: number[] = [];
  for (let i = 0; i < f.data.length; i += 4) out.push(f.data[i]!, f.data[i + 1]!, f.data[i + 2]!);
  return out;
};

// Five draws over targets A, B, A, B and the result: the middle three draw the
// region, so outside it draw 4 reads what draw 1 left in B.
describe("a pass's region", () => {
  it("is all a middle draw writes", () => {
    const drawn = stage([{ channels: 4, iterations: 5, glsl: COUNT, region: "return ivec4(0, 0, 4, 1 << 20);" }]);
    expect(greys(drawn)).toEqual(greys(counted("q.x < 4 ? 5 : 3")));
  });

  it("can be any rectangle, clipped to the frame", () => {
    const drawn = stage([{ channels: 4, iterations: 5, glsl: COUNT, region: "return ivec4(2, 3, 10, 7);" }]);
    expect(greys(drawn)).toEqual(greys(counted("q.x >= 2 && q.x < 10 && q.y >= 3 && q.y < 7 ? 5 : 3")));
  });

  it("draws nothing when empty", () => {
    const drawn = stage([{ channels: 4, iterations: 5, glsl: COUNT, region: "return ivec4(5, 5, 5, 9);" }]);
    expect(greys(drawn)).toEqual(greys(counted("3")));
  });

  it("reads the pass's uniforms", () => {
    const drawn = stage(
      [
        {
          channels: 4,
          iterations: 5,
          glsl: COUNT,
          uniforms: [{ key: "edge", glslType: "float", default: 0 }],
          region: "return ivec4(0, 0, int(edge), 1 << 20);",
        },
      ],
      { "test.region.edge": 6 },
    );
    expect(greys(drawn)).toEqual(greys(counted("q.x < 6 ? 5 : 3")));
  });

  it("counts the stage's draws, not the pass's", () => {
    const drawn = stage([
      { channels: 4, iterations: 2, glsl: COUNT },
      { channels: 4, iterations: 3, glsl: `c += ${String(STEP)};`, region: "return ivec4(0, 0, 4, 1 << 20);" },
    ]);
    expect(greys(drawn)).toEqual(greys(counted("q.x < 4 ? 5 : 3")));
  });

  it("hands the fragment program the same texel centres", () => {
    const uv = "if (uPassIndex == 2) c = vec4(vUv * 0.5, gl_FragCoord.xy * 0.01);";
    const regioned = stage([{ channels: 4, iterations: 4, glsl: uv, region: "return ivec4(0, 0, 1 << 20, 1 << 20);" }]);
    const whole = stage([{ channels: 4, iterations: 4, glsl: uv }]);
    const a = greys(regioned);
    const b = greys(whole);
    expect(a.length).toBe(b.length);
    a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, 5));
  });
});
