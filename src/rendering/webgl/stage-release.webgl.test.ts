// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What the renderer gives back when an extension is turned off: the bridge
// sends a stage set without its stages and a texture bag without its textures,
// and the GPU copies, the develop programs built with those stages and their
// prepass targets go then, not when the renderer is disposed at restart. Counted
// through a wrapped context against the same renderer before the stage arrived.

import { describe, expect, it } from "vitest";
import type { ProcessingStageContribution, StageTextureData } from "@/extensions/types";
import { WebGLRenderer } from "./renderer";
import {
  type GlObjectTally,
  floatImage,
  glHarness,
  identityParams,
  trackGlObjects,
} from "./webgl.test-support";

/** An extension stage reading a LUT the extension supplies. */
const LUT_STAGE: ProcessingStageContribution = {
  id: "acme.film",
  name: "Film",
  phase: "effects",
  glsl: "c *= texture(ramp, vec2(0.5)).rgb;",
  uniforms: [],
  textures: [{ key: "ramp", kind: "lut" }],
};

const RAMP: StageTextureData = {
  data: new Uint8Array([255, 255, 255, 255]),
  width: 1,
  height: 1,
  format: "rgba8",
  version: 1,
};

/** An extension stage with a prepass, which runs while `amount` isn't zero. */
const PREPASS_STAGE: ProcessingStageContribution = {
  id: "acme.smooth",
  name: "Smooth",
  phase: "scene-linear",
  glsl: "lin = mix(lin, stageResult, amount);",
  uniforms: [{ key: "amount", glslType: "float", default: 0 }],
  passes: [{ glsl: "c = c;" }],
};

/** A renderer with no stages and a photo set, over a counted context. */
function withTally(fn: (renderer: WebGLRenderer, tally: GlObjectTally) => void): void {
  const { canvas, gl } = glHarness();
  const tally = trackGlObjects(gl);
  const renderer = new WebGLRenderer(canvas, { stages: [] });
  try {
    renderer.setImage(floatImage(16, 16, () => [0.2, 0.2, 0.2]));
    renderer.setParams(identityParams());
    fn(renderer, tally);
  } finally {
    renderer.dispose();
    tally.restore();
  }
}

describe("an extension's stages leaving the renderer", () => {
  it("deletes the GPU copy of a stage texture dropped from the bag", () => {
    withTally((renderer, tally) => {
      renderer.setStages([LUT_STAGE]);
      renderer.setStageTextures({ "acme.film.ramp": RAMP });
      renderer.render();
      const uploaded = tally.live.texture;

      renderer.setStageTextures({});

      expect(tally.live.texture).toBe(uploaded - 1);
    });
  });

  it("deletes the develop program built with a stage that has gone", () => {
    withTally((renderer, tally) => {
      renderer.render();
      const programs = tally.live.program;
      renderer.setStages([LUT_STAGE]);
      renderer.render();

      renderer.setStages([]);
      renderer.render();

      expect(tally.live.program).toBe(programs);
    });
  });

  // Turning a stage off and on again must not recompile the set it returns to.
  it("keeps the program of the stage set it returns to", () => {
    withTally((renderer, tally) => {
      renderer.render();
      renderer.setStages([LUT_STAGE]);
      renderer.render();
      const built = tally.created.program;

      renderer.setStages([]);
      renderer.render();

      expect(tally.created.program).toBe(built);
    });
  });

  it("frees a gone stage's prepass targets and programs", () => {
    withTally((renderer, tally) => {
      renderer.render();
      const before = { ...tally.live };
      renderer.setStages([PREPASS_STAGE]);
      renderer.setContributedParams({ "acme.smooth.amount": 1 });
      renderer.render();

      renderer.setStages([]);
      renderer.setContributedParams({});
      renderer.render();

      expect(tally.live).toEqual(before);
    });
  });
});
