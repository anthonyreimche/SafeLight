// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What the renderer gives back when an extension is turned off: the bridge
// sends a stage set without its stages and a texture bag without its textures,
// and the GPU copies, the develop programs built with those stages and their
// prepass targets go then, not when the renderer is disposed at restart. Counted
// through a wrapped context against the same renderer before the stage arrived.

import { describe, expect, it, vi } from "vitest";
import type { ProcessingStageContribution, StageTextureData } from "@/extensions/types";
import { WebGLRenderer } from "./renderer";
import {
  type GlObjectTally,
  deriveWithoutSettings,
  differing,
  floatImage,
  glErrorsDuring,
  glHarness,
  identityParams,
  liveFrame,
  trackGlObjects,
  withRenderer,
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
  const renderer = new WebGLRenderer(canvas, { stages: [], derive: deriveWithoutSettings });
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

// A prepass result is a full-size float texture (about 90 MB at the 4096 px
// develop cap), and so is each half of the ping-pong pair. A stage that goes
// idle keeps its result while it is still the right answer for this photo, so
// turning it back on, or dragging a slider through zero, costs nothing. Once
// the photo changes that result can never be reused, and an integrated GPU
// with a dozen prepass extensions would otherwise hold over a gigabyte of
// results nothing reads.
describe("an idle stage's prepass memory", () => {
  const OTHER_PHOTO = floatImage(16, 16, () => [0.6, 0.4, 0.3]);

  it("allocates no prepass targets while no stage has run", () => {
    withTally((renderer, tally) => {
      renderer.render();
      const before = tally.live.texture;
      renderer.setStages([PREPASS_STAGE]);
      renderer.render();

      expect(tally.live.texture).toBe(before);
    });
  });

  it("keeps an idle stage's result for the same photo, so turning it back on draws no passes", () => {
    withTally((renderer, tally) => {
      renderer.setStages([PREPASS_STAGE]);
      renderer.setContributedParams({ "acme.smooth.amount": 1 });
      renderer.render();
      const textures = tally.live.texture;
      const made = tally.created.texture;
      const passes = renderer.renderDrawCounts.pass;

      renderer.setContributedParams({ "acme.smooth.amount": 0 });
      renderer.render();
      expect(tally.live.texture).toBe(textures);

      renderer.setContributedParams({ "acme.smooth.amount": 1 });
      renderer.render();
      expect(renderer.renderDrawCounts.pass).toBe(passes);
      expect(tally.created.texture).toBe(made);
    });
  });

  it("frees an idle stage's result and the ping-pong pair once the photo changes", () => {
    withTally((renderer, tally) => {
      renderer.setStages([PREPASS_STAGE]);
      renderer.render();
      const idle = tally.live.texture;
      renderer.setContributedParams({ "acme.smooth.amount": 1 });
      renderer.render();
      expect(tally.live.texture).toBeGreaterThan(idle);

      renderer.setContributedParams({ "acme.smooth.amount": 0 });
      renderer.render();
      renderer.setImage(OTHER_PHOTO);
      renderer.render();

      expect(tally.live.texture).toBe(idle);
    });
  });

  it("keeps the targets of a stage still running on the new photo", () => {
    withTally((renderer, tally) => {
      renderer.setStages([PREPASS_STAGE]);
      renderer.setContributedParams({ "acme.smooth.amount": 1 });
      renderer.render();
      const running = tally.live.texture;
      const made = tally.created.texture;

      renderer.setImage(OTHER_PHOTO);
      renderer.render();

      expect(tally.live.texture).toBe(running);
      // setImage makes the new photo's own texture; the prepass makes nothing new.
      expect(tally.created.texture - made).toBeLessThanOrEqual(1);
    });
  });
});

// The bridge can't know the GPU's texture limit; a texture past it would upload as a
// GL error and the stage would read black with no word of why.
describe("a stage texture larger than the GPU's texture limit", () => {
  it("draws as if not supplied, without a GL error, and says which", () => {
    const { gl } = glHarness();
    const { getParameter } = gl;
    gl.getParameter = (pname: number): unknown =>
      pname === gl.MAX_TEXTURE_SIZE ? 8 : getParameter.call(gl, pname);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      withRenderer({ stages: [LUT_STAGE] }, (renderer) => {
        renderer.setImage(floatImage(16, 16, () => [0.2, 0.2, 0.2]));
        renderer.setParams(identityParams());
        const unsupplied = liveFrame(renderer);
        const wide: StageTextureData = { ...RAMP, data: new Uint8Array(16 * 4).fill(255), width: 16 };
        renderer.setStageTextures({ "acme.film.ramp": wide });

        expect(glErrorsDuring(gl, () => renderer.render())).toEqual([]);
        expect(differing(liveFrame(renderer), unsupplied)).toBe(0);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toMatch(/"acme\.film\.ramp".*16×1.*8/);
      });
    } finally {
      gl.getParameter = getParameter;
      warn.mockRestore();
    }
  });
});
