// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A four-channel pass carries its alpha from one draw to the next, so a chain
// can keep a fourth value per pixel. Its first draw reads the stage's input
// with an alpha of 1, and the inline still reads the last draw's rgb.

import { describe, expect, it } from "vitest";
import { CURRENT_PROCESS_VERSION } from "@/catalog/types";
import type { ProcessingStageContribution, StagePass } from "@/extensions/types";
import { encodeHalf } from "@/raw/half-float";
import type { WebGLRenderer } from "./renderer";
import { LINEAR_PROBE_PIPELINE, basicStages, floatImage, identityParams, withRenderer, type Frame } from "./webgl.test-support";

const W = 16;
const H = 12;
const SCENE = floatImage(W, H, (x, y) => [0.05 + (0.3 * x) / W, 0.05 + (0.3 * y) / H, 0.2]);

function stage(passes: StagePass[], reads: "current" | "source" = "source"): ProcessingStageContribution {
  return {
    id: "test.channels",
    name: "Channels",
    phase: "scene-linear",
    reads,
    glsl: "lin = mix(lin, stageResult, take);",
    uniforms: [{ key: "take", glslType: "float", default: 0 }],
    passes,
  };
}

function frame(s: ProcessingStageContribution, image: Parameters<WebGLRenderer["setImage"]>[0] = SCENE, maxEdge?: number): Frame {
  return withRenderer({ stages: [...basicStages(), s], pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
    r.setImage(image, maxEdge);
    r.setParams(identityParams({ processVersion: CURRENT_PROCESS_VERSION }));
    r.setContributedParams({ "test.channels.take": 1 });
    const f = r.captureFloatFrame();
    if (!f) throw new Error("captureFloatFrame returned null");
    return f;
  });
}

const greys = (f: Frame): number[] => {
  const out: number[] = [];
  for (let i = 0; i < f.data.length; i += 4) out.push(f.data[i]!, f.data[i + 1]!, f.data[i + 2]!);
  return out;
};

describe("a four-channel pass", () => {
  it("carries alpha from one draw to the next", () => {
    const carried = frame(
      stage([{ channels: 4, iterations: 2, glsl: "if (uPassIndex == 0) c = vec4(0.0, 0.0, 0.0, 0.375); else c = vec4(c.a);" }]),
    );
    for (const v of greys(carried)) expect(v).toBeCloseTo(0.375, 3);
  });

  it("carries it across passes of the same stage", () => {
    const carried = frame(
      stage([
        { channels: 4, glsl: "c = vec4(0.0, 0.0, 0.0, 0.25);" },
        { channels: 4, glsl: "c = vec4(c.a * 2.0);" },
      ]),
    );
    for (const v of greys(carried)) expect(v).toBeCloseTo(0.5, 3);
  });

  it.each(["source", "current"] as const)("reads the input with an alpha of 1 (reads %s)", (reads) => {
    const first = frame(stage([{ channels: 4, glsl: "c = vec4(c.a);" }], reads));
    for (const v of greys(first)) expect(v).toBeCloseTo(1, 3);
  });

  // A long chain reads its own texel on every draw; a filtered read that
  // leaks a little of the neighbours would compound over the chain.
  it("keeps a 1000:1 pattern exact through a long chain", () => {
    const pattern = "float((int(gl_FragCoord.x) + int(gl_FragCoord.y)) % 2 == 0 ? 1000.0 : 1.0)";
    const chained = frame(stage([{ channels: 4, iterations: 400, glsl: `if (uPassIndex == 0) c = vec4(${pattern}) * 0.001;` }]));
    const once = frame(stage([{ channels: 4, glsl: `c = vec4(${pattern}) * 0.001;` }]));
    expect(greys(chained)).toEqual(greys(once));
  });

  it("fetches any texel of the previous draw exactly", () => {
    const pattern = "float((int(gl_FragCoord.x) * 3 + int(gl_FragCoord.y)) % 4 == 0 ? 1.0 : 0.001)";
    const shifted = frame(
      stage([
        { channels: 4, glsl: `c = vec4(${pattern});` },
        { channels: 4, glsl: "c = fetchPrev4(min(ivec2(gl_FragCoord.xy) + ivec2(1, 0), ivec2(floor(1.0 / uTexel + 0.5)) - 1));" },
      ]),
    );
    const want = frame(
      stage([{ channels: 4, glsl: "ivec2 q = min(ivec2(gl_FragCoord.xy) + ivec2(1, 0), ivec2(floor(1.0 / uTexel + 0.5)) - 1); c = vec4(float((q.x * 3 + q.y) % 4 == 0 ? 1.0 : 0.001));" }]),
    );
    expect(greys(shifted)).toEqual(greys(want));
  });

  it("hands the inline the rgb a three-channel pass would", () => {
    const four = frame(stage([{ channels: 4, glsl: "c.rgb *= 0.5;" }]));
    const three = frame(stage([{ glsl: "c *= 0.5;" }]));
    expect(greys(four)).toEqual(greys(three));
  });
});

/** A cached preview larger than the passes, uploaded whole with its mips: the
 *  first draw samples between two levels, or on one at a scale of 2. */
function larger(scale: number) {
  const w = Math.round(W * scale);
  const h = Math.round(H * scale);
  const scene = floatImage(w, h, (x, y) => [
    0.05 + (0.8 * ((x * 7 + y * 3) % 31)) / 31,
    0.05 + (0.8 * ((x * 5 + y * 11) % 17)) / 17,
    (x + y) % 2 === 0 ? 0.7 : 0.1,
  ]);
  return { kind: "float16" as const, data: encodeHalf(scene.data), width: w, height: h };
}

// The first draw's read used to be texture(), whose level comes from the
// fragment's derivatives; it now takes the pass texel as the gradient, which
// picks the same level. Each check draws that read as it was, inline.
describe("a four-channel pass's first draw on a source of another size", () => {
  const AT = "(vec2(ivec2(gl_FragCoord.xy)) + 0.5) * uTexel";
  const OFFSET = "vUv + vec2(0.3, -0.2) * uTexel";

  it.each([1.5, 2, 2.5])("fetches what it fetched before at a scale of %f", (scale) => {
    const image = larger(scale);
    const now = frame(stage([{ channels: 4, glsl: "c.rgb = c.rgb * 0.5 + 0.25;" }]), image, W);
    const before = frame(
      stage([{ channels: 4, glsl: `if (uPrevRaw) c = vec4(toLin(texture(uPrevPass, ${AT}).rgb), 1.0); c.rgb = c.rgb * 0.5 + 0.25;` }]),
      image,
      W,
    );
    expect(now.width).toBe(W);
    expect(greys(now)).toEqual(greys(before));
  });

  it("reads a level other than the full-size one there, so a texel fetch would differ", () => {
    const image = larger(1.5);
    const now = frame(stage([{ channels: 4, glsl: "c.rgb = c.rgb * 0.5 + 0.25;" }]), image, W);
    const full = frame(
      stage([{ channels: 4, glsl: `if (uPrevRaw) c = vec4(toLin(textureLod(uPrevPass, ${AT}, 0.0).rgb), 1.0); c.rgb = c.rgb * 0.5 + 0.25;` }]),
      image,
      W,
    );
    expect(greys(now)).not.toEqual(greys(full));
  });

  it.each([1.5, 2])("samples what it sampled before at a scale of %f, on every draw", (scale) => {
    const image = larger(scale);
    const now = frame(stage([{ channels: 4, iterations: 2, glsl: `c = readPrev4(${OFFSET});` }]), image, W);
    const read = `texture(uPrevPass, ${OFFSET})`;
    const before = frame(
      stage([{ channels: 4, iterations: 2, glsl: `c = uPrevRaw ? vec4(toLin(${read}.rgb), 1.0) : ${read};` }]),
      image,
      W,
    );
    expect(greys(now)).toEqual(greys(before));
  });
});
