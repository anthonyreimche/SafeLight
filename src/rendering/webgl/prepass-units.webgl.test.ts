// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The develop draw samples every prepass stage's result at once, so each stage
// that runs this frame needs a texture unit of its own. Results take 8-11 and 5,
// the stage-texture units no texture holds, and every unit above 15 the context
// has; a stage that still finds none is reported. With the first five alone, a
// sixth active stage did nothing (SafeLight #155: the Colour Equaliser behind
// the built-in denoiser and four other extension stages).
//
// Each marker stage writes its own value into its result and brightens the
// frame by STEP only when it reads that value back, so the frame says how many
// stages read their own result.

import { afterEach, describe, expect, it } from "vitest";
import type { ProcessingStageContribution } from "@/extensions/types";
import { uniformPrefix } from "./shader-compiler";
import {
  LINEAR_PROBE_PIPELINE,
  floatImage,
  glHarness,
  identityParams,
  pixelAt,
  withRenderer,
} from "./webgl.test-support";
import type { WebGLRenderer } from "./renderer";

const STEP = 0.05;
const BASE = 0.1;

/** Stage `i`'s result is (i + 1) / 64 everywhere, exact in half float. */
function marker(i: number): ProcessingStageContribution {
  const mark = `${i + 1}.0 / 64.0`;
  return {
    id: `marker-${i}.test`,
    name: `Marker ${i}`,
    phase: "scene-linear",
    priority: 10 + i,
    glsl: `if (take > 0.5 && abs(stageResult.r - ${mark}) < 0.001) lin += vec3(${STEP});`,
    uniforms: [{ key: "take", glslType: "float", default: 0 }],
    passes: [{ glsl: `c = vec3(${mark});` }],
  };
}

const markers = (n: number) => Array.from({ length: n }, (_, i) => marker(i));

/** The bag that turns stages on: each holds a non-zero key, so its prepass runs. */
function taking(stages: readonly ProcessingStageContribution[]): Record<string, number> {
  return Object.fromEntries(stages.map((s) => [`${s.id}.take`, 1]));
}

const SOURCE = floatImage(8, 8, () => [BASE, BASE, BASE]);

const level = (renderer: WebGLRenderer): number => pixelAt(renderer.captureFloatFrame()!, 4, 4)[1];

/** How many STEPs the frame gained over the same frame with every stage idle. */
function stepsTaken(renderer: WebGLRenderer, bag: Record<string, unknown>): number {
  renderer.setContributedParams({});
  const idle = level(renderer);
  renderer.setContributedParams(bag);
  return Math.round((level(renderer) - idle) / STEP);
}

function draw<T>(stages: ProcessingStageContribution[], fn: (r: WebGLRenderer) => T): T {
  const prefixes = new Set(stages.map((s) => uniformPrefix(s.id)));
  expect(prefixes.size).toBe(stages.length);
  return withRenderer({ stages, pipeline: LINEAR_PROBE_PIPELINE }, (renderer) => {
    renderer.setImage(SOURCE);
    renderer.setParams(identityParams());
    return fn(renderer);
  });
}

/** A driver reporting `units` combined texture units, from the next renderer on. */
function combinedUnits(units: number): { restore(): void } {
  const { gl } = glHarness();
  const original = gl.getParameter;
  gl.getParameter = (pname: number) =>
    pname === gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS ? units : Reflect.apply(original, gl, [pname]);
  return {
    restore() {
      gl.getParameter = original;
    },
  };
}

describe("prepass result units", () => {
  // The tenth result sits on unit 16, which a sampler may read: the unit only has
  // to be below MAX_COMBINED_TEXTURE_IMAGE_UNITS.
  it("runs ten active prepass stages, each on its own result", () => {
    const stages = markers(10);
    const steps = draw(stages, (r) => stepsTaken(r, taking(stages)));
    expect(steps).toBe(10);
  });

  it("reports no stage left without a unit when every one gets one", () => {
    const stages = markers(8);
    const overflowed = draw(stages, (r) => {
      r.setContributedParams(taking(stages));
      r.render();
      return r.overflowedStages;
    });
    expect(overflowed).toEqual([]);
  });

  it("leaves a stage texture its unit while the prepass results spread past 11", () => {
    const lut: ProcessingStageContribution = {
      id: "lut.test",
      name: "LUT",
      phase: "scene-linear",
      priority: 90,
      glsl: `if (abs(texture(table, vec2(0.5)).r - 64.0 / 255.0) < 0.002) lin += vec3(${STEP});`,
      uniforms: [],
      textures: [{ key: "table", kind: "lut", width: 1, height: 1, format: "rgba8" }],
    };
    const stages = [...markers(6), lut];
    const steps = draw(stages, (r) => {
      // Until its data arrives the table samples black, so the idle frame has no
      // step from it either.
      const idle = level(r);
      r.setStageTextures({
        "lut.test.table": {
          data: new Uint8Array([64, 64, 64, 255]),
          width: 1,
          height: 1,
          format: "rgba8",
          version: 1,
        },
      });
      r.setContributedParams(taking(markers(6)));
      return Math.round((level(r) - idle) / STEP);
    });
    expect(steps).toBe(7);
  });

  describe("on a context with no units above 15", () => {
    let driver: { restore(): void } | null = null;

    afterEach(() => {
      driver?.restore();
      driver = null;
    });

    it("runs nine, and names the stage that found none", () => {
      driver = combinedUnits(16);
      const stages = markers(10);
      const { steps, overflowed } = draw(stages, (r) => ({
        steps: stepsTaken(r, taking(stages)),
        overflowed: r.overflowedStages,
      }));
      expect(steps).toBe(9);
      expect(overflowed).toEqual(["marker-9.test"]);
    });

    it("stops naming it once the stages ahead of it go idle", () => {
      driver = combinedUnits(16);
      const stages = markers(10);
      const overflowed = draw(stages, (r) => {
        r.setContributedParams(taking(stages));
        r.render();
        r.setContributedParams(taking(stages.slice(1)));
        r.render();
        return r.overflowedStages;
      });
      expect(overflowed).toEqual([]);
    });
  });
});
