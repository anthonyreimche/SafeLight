// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A pass samples its stage's "dynamic" (or "lut") texture under the texture's
// key: row for row as the source lies in the pass, the variant the bag names,
// and data supplied again (a new version) draws the passes again instead of
// reusing the result they drew with the old data.

import { describe, expect, it } from "vitest";
import { CURRENT_PROCESS_VERSION, defaultMaskAdjustments, defaultToneCurves, type Mask } from "@/catalog/types";
import type { ProcessingStageContribution, StageTextureData } from "@/extensions/types";
import type { WebGLRenderer } from "./renderer";
import {
  LINEAR_PROBE_PIPELINE,
  basicStages,
  builtinStages,
  floatImage,
  identityParams,
  masksStagesFor,
  withRenderer,
  type Frame,
} from "./webgl.test-support";

const W = 32;
const H = 24;
const ID = "test.tex";
const TABLE = `${ID}.table`;

/** Every texel differs, in steps a half float holds exactly. */
const value = (x: number, y: number): [number, number, number] => [(8 + x) / 64, (8 + y) / 64, ((x + 2 * y) % 16) / 32];
const SCENE = floatImage(W, H, value);

function table(of: (x: number, y: number) => [number, number, number], version: number): StageTextureData {
  const data = new Float32Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) data.set([...of(x, y), 1], 4 * (y * W + x));
  }
  return { data, width: W, height: H, format: "rgba16f", version };
}

function sampler(glsl: string): ProcessingStageContribution {
  return {
    id: ID,
    name: "Sampler",
    phase: "scene-linear",
    reads: "current",
    glsl: "lin = mix(lin, stageResult, take);",
    uniforms: [{ key: "take", glslType: "float", default: 0 }],
    textures: [{ key: "table", kind: "dynamic" }],
    passes: [{ glsl }],
  };
}

function frame(r: WebGLRenderer): Frame {
  const f = r.captureFloatFrame();
  if (!f) throw new Error("captureFloatFrame returned null");
  return f;
}

function render(glsl: string, textures: Record<string, StageTextureData>, bag: Record<string, unknown> = {}): Frame {
  return withRenderer({ stages: [...basicStages(), sampler(glsl)], pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
    r.setImage(SCENE);
    r.setParams(identityParams({ processVersion: CURRENT_PROCESS_VERSION }));
    r.setStageTextures(textures);
    r.setContributedParams({ [`${ID}.take`]: 1, ...bag });
    return frame(r);
  });
}

const differing = (a: Frame, b: Frame): number => {
  let n = 0;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) n++;
  return n;
};

const SOURCE_AS_READ = "c = readSource(vUv);";
const TABLE_AS_SOURCE = "c = toLin(texture(table, vUv).rgb);";
const flipped = (x: number, y: number) => value(W - 1 - x, H - 1 - y);

describe("stage textures in passes", () => {
  it("samples the texture where the source lies, row for row", () => {
    const source = render(SOURCE_AS_READ, {});
    expect(differing(render(TABLE_AS_SOURCE, { [TABLE]: table(value, 1) }), source)).toBe(0);
    expect(differing(render(TABLE_AS_SOURCE, { [TABLE]: table(flipped, 1) }), source)).toBeGreaterThan(W * H);
  });

  it("samples the variant the bag names", () => {
    const source = render(SOURCE_AS_READ, {});
    const textures = { [TABLE]: table(flipped, 1), [`${TABLE}#same`]: table(value, 1) };
    expect(differing(render(TABLE_AS_SOURCE, textures, { [TABLE]: "same" }), source)).toBe(0);
  });

  it("draws the passes again when the texture's data changes", () => {
    withRenderer({ stages: [...basicStages(), sampler(TABLE_AS_SOURCE)], pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
      r.setImage(SCENE);
      r.setParams(identityParams({ processVersion: CURRENT_PROCESS_VERSION }));
      r.setContributedParams({ [`${ID}.take`]: 1 });
      r.setStageTextures({ [TABLE]: table(flipped, 1) });
      const before = frame(r);
      r.setStageTextures({ [TABLE]: table(value, 2) });
      const after = frame(r);
      expect(differing(after, before)).toBeGreaterThan(W * H);
      expect(differing(after, render(SOURCE_AS_READ, {}))).toBe(0);
    });
  });

  it("hands the develop program back the units its passes borrowed: a curve and a mask drawn after them are untouched", () => {
    const masked: Mask = {
      id: "m",
      name: "m",
      visible: true,
      invert: false,
      opacity: 100,
      adj: { ...defaultMaskAdjustments(), exposure: 40 },
      panels: [],
      components: [{ id: "right", kind: "linear", mode: "add", invert: false, linear: { x0: 0.5, y0: 0, x1: 0.5001, y1: 0 } }],
    };
    const curve = { ...defaultToneCurves(), rgb: [{ x: 0, y: 0 }, { x: 0.4, y: 0.7 }, { x: 1, y: 1 }] };
    // Its passes run (a non-zero key) and sample four textures, so they take
    // every unit they borrow, but the inline leaves the image alone.
    const idle: ProcessingStageContribution = {
      ...sampler("c = texture(table, vUv).rgb + texture(t2, vUv).rgb + texture(t3, vUv).rgb + texture(t4, vUv).rgb;"),
      glsl: "lin = mix(lin, stageResult, take * 0.0);",
      textures: ["table", "t2", "t3", "t4"].map((key) => ({ key, kind: "dynamic" as const })),
    };
    const draw = (stages: ProcessingStageContribution[]) =>
      withRenderer({ stages: [...builtinStages(), ...stages], pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
        r.setImage(SCENE);
        r.setParams(identityParams({ processVersion: CURRENT_PROCESS_VERSION, masks: [masked], toneCurve: curve }));
        r.setStageTextures(Object.fromEntries(["table", "t2", "t3", "t4"].map((k, i) => [`${ID}.${k}`, table(flipped, i + 1)])));
        r.setContributedParams({ [`${ID}.take`]: 1 });
        frame(r);
        return frame(r);
      });
    const without = draw([]);
    expect(differing(draw([idle]), without)).toBe(0);
  });

  it("samples the stage's texture in a mask copy's passes", () => {
    const masked = (bag: Record<string, unknown>): Mask => ({
      id: "m",
      name: "m",
      visible: true,
      invert: false,
      opacity: 100,
      adj: defaultMaskAdjustments(),
      panels: [],
      components: [{ id: "right", kind: "linear", mode: "add", invert: false, linear: { x0: 0.5, y0: 0, x1: 0.5001, y1: 0 } }],
      bag,
    });
    const maskable: ProcessingStageContribution = { ...sampler(TABLE_AS_SOURCE), mask: { maskable: true } };
    const out = withRenderer(
      { stages: [...basicStages(), ...masksStagesFor(CURRENT_PROCESS_VERSION), maskable], pipeline: LINEAR_PROBE_PIPELINE },
      (r) => {
        r.setImage(SCENE);
        r.setParams(identityParams({ processVersion: CURRENT_PROCESS_VERSION, masks: [masked({ [`${ID}.take`]: 1 })] }));
        r.setStageTextures({ [TABLE]: table((x, y) => [0.5, 0.25 + (x % 2) / 8, 0.1 + y / 256], 1) });
        return frame(r);
      },
    );
    const at = (x: number, y: number) => out.data.slice(4 * (y * W + x), 4 * (y * W + x) + 3);
    const plain = withRenderer({ stages: [...basicStages(), ...masksStagesFor(CURRENT_PROCESS_VERSION)], pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
      r.setImage(SCENE);
      r.setParams(identityParams({ processVersion: CURRENT_PROCESS_VERSION }));
      return frame(r);
    });
    const was = (x: number, y: number) => plain.data.slice(4 * (y * W + x), 4 * (y * W + x) + 3);
    // Inside the mask the copy draws the table, toLin'd; outside, the photo as it was.
    expect(Array.from(at(2, 5))).toEqual(Array.from(was(2, 5)));
    expect(Math.abs(at(W - 3, 5)[0] - at(W - 3, 6)[0])).toBeLessThan(1e-6);
    expect(Math.abs(at(W - 3, 5)[1] - at(W - 2, 5)[1])).toBeGreaterThan(0.01);
    expect(Array.from(at(W - 3, 5))).not.toEqual(Array.from(was(W - 3, 5)));
  });
});
