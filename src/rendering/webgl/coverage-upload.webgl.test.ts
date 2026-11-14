// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A brush stroke grows by a dab or two a frame. However much was painted
// before, the renderer rasterizes and uploads only what the added dabs reach
// (the earlier ones are only compared with what it baked), and draws the frame
// a renderer handed the whole history at once draws.

import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MASK_PANELS,
  defaultMaskAdjustments,
  type BrushDab,
  type DevelopParams,
  type Mask,
} from "@/catalog/types";
import type { PaintDab } from "@/extensions/api/contributions";
import type { ProcessingStageContribution } from "@/extensions/types";
import { BAKE_SIZE } from "./mask-coverage";
import type { WebGLRenderer } from "./renderer";
import { isBrushDabList, paintLayersFromValue } from "./stage-coverage";
import {
  LINEAR_PROBE_PIPELINE,
  type Frame,
  floatImage,
  glHarness,
  identityParams,
  masksStages,
  withRenderer,
  worstDifference,
} from "./webgl.test-support";

const WIDTH = 96;
const HEIGHT = 64;
const ASPECT = WIDTH / HEIGHT;

/** Forty strokes of a hundred dabs, each circling its own cell of the photo. */
function history(): BrushDab[] {
  return Array.from({ length: 40 }, (_, k) =>
    Array.from({ length: 100 }, (_, i) => ({
      x: 0.1 + (k % 8) * 0.11 + 0.04 * Math.cos(i * 0.12 + k),
      y: 0.1 + Math.floor(k / 8) * 0.19 + 0.04 * Math.sin(i * 0.12 + k),
      radius: 0.02 + (k % 5) * 0.01,
      feather: 0.5,
      flow: 0.3,
      opacity: 0.7,
      erase: k % 7 === 6,
      strokeStart: i === 0,
    })),
  ).flat();
}

/** The dabs with every property read counted. */
function watched<D extends object>(dabs: D[]): { dabs: D[]; reads: () => number } {
  let reads = 0;
  const proxied = dabs.map(
    (d) =>
      new Proxy(d, {
        get(from, key) {
          reads++;
          return Reflect.get(from, key);
        },
      }),
  );
  return { dabs: proxied, reads: () => reads };
}

/** Texels the calls during `run` upload to any texture. */
function texelsUploaded(run: () => void): number {
  const { gl } = glHarness();
  const whole = vi.spyOn(gl, "texImage2D");
  const sub = vi.spyOn(gl, "texSubImage2D");
  try {
    run();
    const size = (w: unknown, h: unknown) => (typeof w === "number" && typeof h === "number" ? w * h : 0);
    return (
      whole.mock.calls.reduce((n, call) => n + size(call[3], call[4]), 0) +
      sub.mock.calls.reduce((n, call) => n + size(call[4], call[5]), 0)
    );
  } finally {
    whole.mockRestore();
    sub.mockRestore();
  }
}

function brushMask(dabs: BrushDab[]): Mask {
  return {
    id: "m1",
    name: "Brush",
    visible: true,
    invert: false,
    opacity: 100,
    adj: { ...defaultMaskAdjustments(), exposure: 40 },
    panels: [...DEFAULT_MASK_PANELS],
    components: [{ id: "c1", kind: "brush", mode: "add", invert: false, brush: { dabs, feather: 0 } }],
  };
}

const LOCAL_GAIN: ProcessingStageContribution = {
  id: "acme.local",
  name: "Local gain",
  phase: "scene-linear",
  glsl: "lin *= 1.0 + gain * cov(srcUv);",
  uniforms: [{ key: "gain", glslType: "float", default: 0 }],
  textures: [{ key: "cov", kind: "coverage" }],
};

const PAINT_GAIN: ProcessingStageContribution = {
  id: "acme.paint",
  name: "Paint gain",
  phase: "scene-linear",
  glsl: "vec4 p = layers(0, srcUv); lin *= 1.0 + p.a * p.r;",
  uniforms: [],
  textures: [{ key: "layers", kind: "paint" }],
};

const coloured = (dabs: BrushDab[]): PaintDab[] => dabs.map((d) => ({ ...d, color: [1, 0.5, 0] }));

interface Case {
  name: string;
  stages: ProcessingStageContribution[];
  /** The params and bag that paint `dabs`. */
  paint: (dabs: BrushDab[]) => { params: DevelopParams; bag: Record<string, unknown> };
  /** Checks the dabs as the renderer does before it trusts a bag value. */
  check?: (dabs: BrushDab[]) => void;
}

const CASES: Case[] = [
  {
    name: "a brush mask",
    stages: masksStages(),
    paint: (dabs) => ({ params: identityParams({ masks: [brushMask(dabs)] }), bag: {} }),
  },
  {
    name: "an extension's coverage texture",
    stages: [LOCAL_GAIN],
    paint: (dabs) => ({ params: identityParams(), bag: { "acme.local.gain": 1, "acme.local.cov": dabs } }),
    check: (dabs) => isBrushDabList(dabs),
  },
  {
    name: "an extension's paint layer",
    stages: [PAINT_GAIN],
    paint: (dabs) => ({
      params: identityParams(),
      bag: { "acme.paint.layers": [{ id: "a", dabs: dabs as PaintDab[] }] },
    }),
    check: (dabs) => paintLayersFromValue([{ id: "a", dabs }]),
  },
];

const source = floatImage(WIDTH, HEIGHT, (x) => {
  const v = 0.05 + 0.3 * ((x + 0.5) / WIDTH);
  return [v, v, v];
});

function show(renderer: WebGLRenderer, painted: { params: DevelopParams; bag: Record<string, unknown> }): void {
  renderer.setParams(painted.params);
  renderer.setContributedParams(painted.bag);
}

function capture(renderer: WebGLRenderer): Frame {
  const frame = renderer.captureFloatFrame();
  if (!frame) throw new Error("captureFloatFrame returned null");
  return frame;
}

describe("a brush stroke growing on top of thousands of dabs", () => {
  for (const { name, stages, paint, check } of CASES) {
    it(`compares each earlier dab once, and uploads and draws only what the added dab reaches, for ${name}`, () => {
      const isPaint = name.includes("paint layer");
      const plain = history();
      const before = isPaint ? coloured(plain) : plain;
      const last = plain[plain.length - 1];
      const added: BrushDab = { ...last, x: last.x + 0.004, strokeStart: false };
      const grown = [...before, ...(isPaint ? coloured([added]) : [added])];
      const options = { stages, pipeline: LINEAR_PROBE_PIPELINE };

      const reference = withRenderer(options, (renderer) => {
        renderer.setImage(source);
        show(renderer, paint(structuredClone(grown)));
        return capture(renderer);
      });

      const seen = watched(before);
      withRenderer(options, (renderer) => {
        renderer.setImage(source);
        show(renderer, paint(seen.dabs));
        renderer.render();

        // New params with the same dabs upload what any change of params does
        // (a mask's curve table, say), and nothing for the coverage.
        const anyChange = texelsUploaded(() => {
          show(renderer, paint(seen.dabs.slice()));
          renderer.render();
        });

        // A bag value is checked dab by dab before the renderer trusts it (it is
        // sidecar JSON). The bake compares each dab it already holds once with
        // the values it baked (ten fields, and a paint dab's colour), and
        // rasterizes none of them.
        const next = [...seen.dabs, ...grown.slice(before.length)];
        let checking = seen.reads();
        check?.(next);
        checking = seen.reads() - checking;
        const readsBefore = seen.reads();
        const texels = texelsUploaded(() => {
          show(renderer, paint(next));
          renderer.render();
        });
        expect(seen.reads() - readsBefore - checking).toBeLessThanOrEqual(11 * before.length);
        const rx = (added.radius / ASPECT) * BAKE_SIZE;
        const ry = added.radius * BAKE_SIZE;
        expect(texels - anyChange).toBeGreaterThan(0);
        expect(texels - anyChange).toBeLessThanOrEqual((2 * rx + 4) * (2 * ry + 4));
        expect(worstDifference(capture(renderer), reference)).toBe(0);
      });
    });
  }
});
