// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Every read a prepass makes of its own texel should hand back that texel
// exactly. A filtered read at a texel centre can mix in a trace of the
// neighbours, which a long chain of draws compounds: a dark pixel beside a
// highlight brightens a little on every draw. Each test here measures one such
// read on a 1024:1 checker and passes only once it is exact.
//
// Hardware reads them all exactly (NVIDIA on D3D11, Vulkan and OpenGL, and
// WARP, 2026-11-08). SwiftShader leaks about 1e-7 of the neighbours per pixel
// of texture width on every filtered read. A pass now fetches its own texel on
// every draw after the first, so chains are exact there too. A single read (a
// pass's first, the split, stageResult, the frame's own) still leaks once and
// is left as it is, so those tests are expected to fail on SwiftShader.
//
// The stage's inline turns the read's error into the frame: it writes
// 0.4 + scale · error / (bright − dark), and a frame with scale 0 is the
// baseline. The probe path is close to identity near 0.4, so the difference
// over scale is the read's leak as a fraction of the checker's step.

import { describe, expect, it } from "vitest";
import { CURRENT_PROCESS_VERSION } from "@/catalog/types";
import type { ProcessingStageContribution, StagePass } from "@/extensions/types";
import { uniformPrefix } from "./shader-compiler";
import { LINEAR_PROBE_PIPELINE, basicStages, floatImage, glHarness, identityParams, withRenderer, type Frame } from "./webgl.test-support";

const SWIFTSHADER = ((): boolean => {
  const { gl } = glHarness();
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  return /swiftshader/i.test(String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER)));
})();
/** A test of a single filtered read, which SwiftShader leaks. */
const singleRead = SWIFTSHADER ? it.fails : it;

interface Size {
  w: number;
  h: number;
}

const SMALL: Size = { w: 61, h: 37 };
const STAGE_ID = "test.reads";
const RESULT = `${uniformPrefix(STAGE_ID)}stageResult`;

// Both exact in a half float, so a stored texel compares equal to the pattern.
const BRIGHT = 0.5;
const DARK = 1 / 2048;
const checker = ({ w, h }: Size) =>
  floatImage(w, h, (x, y) => {
    const v = (x + y) % 2 === 0 ? BRIGHT : DARK;
    return [v, v, v];
  });

const PATTERN = `float pat(ivec2 p) { return (p.x + p.y) % 2 == 0 ? ${BRIGHT.toFixed(1)} : ${DARK}; }`;

// The texel under the inline's pixel, fetched exactly.
const EXACT = `
  ivec2 size = textureSize(${RESULT}, 0);
  ivec2 t = clamp(ivec2(srcUv * vec2(size)), ivec2(0), size - 1);
  vec3 exact = texelFetch(${RESULT}, t, 0).rgb;`;

/** A stage whose inline writes `error`, an expression over `exact` (the result
 *  texel), `t` (its position), `lin`, `stageResult` and `pat`. */
function readStage(passes: StagePass[], error: string, reads: "current" | "source" = "source"): ProcessingStageContribution {
  return {
    id: STAGE_ID,
    name: "Reads",
    phase: "scene-linear",
    reads,
    helpers: PATTERN,
    glsl: `{${EXACT}\n  vec3 err = ${error};\n  lin = vec3(0.4) + scale * err / ${(BRIGHT - DARK).toFixed(10)};\n}`,
    uniforms: [{ key: "scale", glslType: "float", default: 0 }],
    passes,
  };
}

function frame(s: ProcessingStageContribution, scale: number, size: Size): Frame {
  return withRenderer({ stages: [...basicStages(), s], pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
    r.setImage(checker(size));
    r.setParams(identityParams({ processVersion: CURRENT_PROCESS_VERSION }));
    r.setContributedParams({ [`${STAGE_ID}.scale`]: scale });
    const f = r.captureFloatFrame();
    if (!f) throw new Error("captureFloatFrame returned null");
    return f;
  });
}

interface Leak {
  /** The largest error, as a fraction of the checker's step. */
  worst: number;
  /** The largest on row 0, on the last row and on the rows between. */
  firstRow: number;
  lastRow: number;
  inner: number;
}

// The largest scale that keeps every pixel within 0.3 of the baseline, where
// the probe is close to identity; the f16 capture step (2.4e-4 at 0.4) over
// that scale is the smallest error it sees, 2.4e-9 at the top of the ladder.
const SCALES = [1e5, 1e4, 1e3, 1e2, 10, 1];

function leak(s: ProcessingStageContribution, size: Size = SMALL): Leak {
  const base = frame(s, 0, size);
  for (const scale of SCALES) {
    const f = frame(s, scale, size);
    if (f.width !== size.w || f.height !== size.h) throw new Error(`frame is ${f.width}x${f.height}`);
    const rows = Array.from({ length: size.h }, () => 0);
    for (let y = 0; y < size.h; y++) {
      for (let x = 0; x < size.w; x++) {
        const o = (y * size.w + x) * 4 + 1;
        rows[y] = Math.max(rows[y]!, Math.abs(f.data[o]! - base.data[o]!));
      }
    }
    if (Math.max(...rows) < 0.3 || scale === 1) {
      const at = (v: number) => v / scale;
      return {
        worst: at(Math.max(...rows)),
        firstRow: at(rows[0]!),
        lastRow: at(rows[size.h - 1]!),
        inner: at(Math.max(...rows.slice(1, -1))),
      };
    }
  }
  throw new Error("unreachable");
}

const report = (label: string, l: Leak): void => {
  const e = (v: number) => v.toExponential(2);
  console.log(`[leak] ${label}: worst ${e(l.worst)} (row 0 ${e(l.firstRow)}, last ${e(l.lastRow)}, between ${e(l.inner)})`);
};

/** A pass that writes the checker on its first draw and copies its own texel
 *  on every later one. */
const copyChain = (draws: number, channels: 3 | 4): StagePass => ({
  ...(channels === 4 ? { channels } : {}),
  iterations: draws,
  helpers: PATTERN,
  glsl: `if (uPassIndex == 0) c = ${channels === 4 ? "vec4" : "vec3"}(pat(ivec2(gl_FragCoord.xy)));`,
});

const copy = (channels: 3 | 4): StagePass => (channels === 4 ? { channels: 4, glsl: "c = c;" } : { glsl: "c = c;" });

describe("a three-channel chain", () => {
  it.each([2, 10, 100, 400])("keeps a 1024:1 checker exact through %i draws", (draws) => {
    const l = leak(readStage([copyChain(draws, 3)], "exact - vec3(pat(t))"));
    report(`3-ch chain, ${draws} draws`, l);
    expect(l.worst).toBe(0);
  });

  // One filtered copy at a working size: the trace grows with the texture.
  it("copies its own texel exactly at 2039 x 1361", () => {
    const l = leak(readStage([copyChain(2, 3)], "exact - vec3(pat(t))"), { w: 2039, h: 1361 });
    report("3-ch chain, 2 draws, 2039x1361", l);
    expect(l.worst).toBe(0);
  });

  it("matches a four-channel chain, which fetches its texel", () => {
    const l = leak(readStage([copyChain(400, 4)], "exact - vec3(pat(t))"));
    report("4-ch chain, 400 draws", l);
    expect(l.worst).toBe(0);
  });
});

describe("a pass's first read", () => {
  // A reads-current stage's first pass reads the split draw: the develop
  // program stopped at the stage's input. A four-channel pass fetches it
  // exactly, so it sees the split alone; a three-channel pass adds its
  // filtered read.
  singleRead.each([4, 3] as const)("hands a %i-channel pass of a reads-current stage the frame's own input", (channels) => {
    const l = leak(readStage([copy(channels)], "exact - lin", "current"));
    report(`split, ${channels}-ch pass`, l);
    expect(l.worst).toBe(0);
  });

  singleRead.each([4, 3] as const)("hands a %i-channel pass of a reads-source stage the source texel", (channels) => {
    const l = leak(readStage([copy(channels)], "exact - vec3(pat(t))"));
    report(`source, ${channels}-ch pass`, l);
    expect(l.worst).toBe(0);
  });

  // What the split is held to: the develop program's own read of the source.
  singleRead("follows the frame, whose own input is the source texel", () => {
    const l = leak(readStage([copy(4)], "lin - vec3(pat(t))"));
    report("frame input", l);
    expect(l.worst).toBe(0);
  });
});

describe("the inline's stageResult", () => {
  singleRead("is the result texel under the pixel", () => {
    const l = leak(readStage([{ channels: 4, helpers: PATTERN, glsl: "c = vec4(pat(ivec2(gl_FragCoord.xy)));" }], "stageResult - exact"));
    report("stageResult", l);
    expect(l.worst).toBe(0);
  });
});
