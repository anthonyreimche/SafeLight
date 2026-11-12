// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A view-only stage (a focus overlay, say) draws only in the frames the live
// view shows: the renderer that draws them is told so (drawsViewStages), and a
// measuring render, a float capture, the histogram and Upright's downscale
// leave it out there too. Every other renderer, the export's and the
// thumbnails', draws the photo without it whatever its bag holds.

import { describe, expect, it } from "vitest";
import { CURRENT_PROCESS_VERSION } from "@/catalog/types";
import type { ProcessingStageContribution } from "@/extensions/types";
import type { WebGLRenderer, WebGLRendererOpts } from "./renderer";
import {
  LINEAR_PROBE_PIPELINE,
  OPEN_PROBE,
  floatImage,
  glHarness,
  identityParams,
  trackGlObjects,
  withRenderer,
  worstDifference,
} from "./webgl.test-support";

const OVERLAY: ProcessingStageContribution = {
  id: "acme.overlay",
  name: "Overlay",
  phase: "output-encode",
  space: { encoding: "perceptual" },
  glsl: "if (amount > 0.5) c = vec3(1.0, 0.0, 0.0);",
  uniforms: [{ key: "amount", glslType: "float", default: 0 }],
  viewOnly: true,
};

const ON = { "acme.overlay.amount": 1 };
const GREY = floatImage(8, 8, () => [0.18, 0.18, 0.18]);

/** The frame on the canvas: its mean red and green, 0..255. */
function canvasMean(): { r: number; g: number } {
  const { canvas, gl } = glHarness();
  const pixels = new Uint8Array(canvas.width * canvas.height * 4);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  let r = 0;
  let g = 0;
  for (let i = 0; i < pixels.length; i += 4) {
    r += pixels[i];
    g += pixels[i + 1];
  }
  const n = pixels.length / 4;
  return { r: r / n, g: g / n };
}

function withOverlay<T>(opts: Partial<WebGLRendererOpts>, fn: (renderer: WebGLRenderer) => T): T {
  return withRenderer({ stages: [OVERLAY], pipeline: LINEAR_PROBE_PIPELINE, ...opts }, (renderer) => {
    renderer.setParams(identityParams());
    renderer.uploadSource("grey:0", GREY);
    renderer.setContributedParams(ON);
    return fn(renderer);
  });
}

const isRed = ({ r, g }: { r: number; g: number }) => r > 250 && g < 5;

describe("a view-only stage", () => {
  it("draws in the live view's frames for the eye", () => {
    withOverlay({ drawsViewStages: true }, (renderer) => {
      renderer.render();
      expect(isRed(canvasMean())).toBe(true);
    });
  });

  it("is left out of a measuring render, and back in the next frame", () => {
    withOverlay({ drawsViewStages: true }, (renderer) => {
      renderer.render({ viewOverlays: false });
      expect(isRed(canvasMean())).toBe(false);
      renderer.render();
      expect(isRed(canvasMean())).toBe(true);
    });
  });

  it("is left out of a float capture and the histogram", () => {
    withOverlay({ drawsViewStages: true }, (renderer) => {
      renderer.render();
      const frame = renderer.readFloatFrame("output");
      expect(frame).not.toBeNull();
      if (!frame) return;
      expect(frame.data[0]).toBeCloseTo(frame.data[1], 2);
      const histogram = renderer.computeHistogram();
      const top = (h: Uint32Array) => h.findLastIndex((n) => n > 0);
      expect(top(histogram.r)).toBe(top(histogram.g));
    });
  });

  it("is left out of every frame of a renderer that doesn't draw for the eye", () => {
    withOverlay({}, (renderer) => {
      renderer.render();
      expect(isRed(canvasMean())).toBe(false);
    });
  });

  it("leaves the frame as a renderer without the stage draws it", () => {
    const plain = withRenderer({ stages: [], pipeline: LINEAR_PROBE_PIPELINE }, (renderer) => {
      renderer.setParams(identityParams());
      renderer.uploadSource("grey:0", GREY);
      renderer.render();
      return canvasMean();
    });
    const measured = withOverlay({}, (renderer) => {
      renderer.render();
      return canvasMean();
    });
    expect(measured).toEqual(plain);
  });
});

// Its passes cost nothing where its block doesn't draw: no pass draw and no
// target, whatever the bag holds. The worker's thumbnail renderer shares the
// live view's bag, so the overlay's values reach it as they are.
const MEASURING: ProcessingStageContribution = {
  ...OVERLAY,
  id: "acme.measuring",
  glsl: "if (amount > 0.5) c = stageResult;",
  passes: [{ glsl: "c = vec3(1.0, 0.0, 0.0);" }],
  dormantWhen: { amount: 0 },
};
const MEASURING_ON = { "acme.measuring.amount": 1 };

/** Another stage, dormant on the photo. */
const DORMANT: ProcessingStageContribution = {
  id: "acme.gain",
  name: "Gain",
  phase: "scene-linear",
  glsl: "lin *= gain;",
  uniforms: [{ key: "gain", glslType: "float", default: 1 }],
  dormantWhen: { gain: 1 },
};

const THUMBNAILS: WebGLRendererOpts = { skipDormantStages: true, wakeTogether: true };

interface FrameCost {
  passes: number;
  framebuffers: number;
  programs: number;
  dormant: readonly string[];
}

/** What `draw` costs a renderer holding MEASURING and DORMANT with `bag`,
 *  after `setup`. */
function costOf(
  opts: WebGLRendererOpts,
  bag: Record<string, unknown>,
  draw: (renderer: WebGLRenderer) => void,
  setup: (renderer: WebGLRenderer) => void = () => {},
): FrameCost {
  const { canvas, gl } = glHarness();
  const tally = trackGlObjects(gl);
  try {
    return withRenderer(
      { stages: [MEASURING, DORMANT], pipeline: LINEAR_PROBE_PIPELINE, ...opts },
      (renderer) => {
        renderer.setParams(identityParams({ processVersion: CURRENT_PROCESS_VERSION }));
        renderer.uploadSource("grey:0", GREY);
        renderer.setContributedParams(bag);
        setup(renderer);
        const passes = renderer.renderDrawCounts.pass;
        const framebuffers = tally.created.framebuffer;
        const programs = tally.created.program;
        draw(renderer);
        return {
          passes: renderer.renderDrawCounts.pass - passes,
          framebuffers: tally.created.framebuffer - framebuffers,
          programs: tally.created.program - programs,
          dormant: renderer.dormantStages,
        };
      },
      canvas,
    );
  } finally {
    tally.restore();
  }
}

describe("a view-only stage's passes", () => {
  it.each<[string, (r: WebGLRenderer) => void]>([
    ["the live view's frame", (r) => r.render()],
    ["a capture drawn as shown", (r) => r.render({ viewOverlays: true })],
  ])("run for %s", (_, draw) => {
    expect(costOf({ drawsViewStages: true }, MEASURING_ON, draw).passes).toBe(1);
  });

  it.each<[string, WebGLRendererOpts, (r: WebGLRenderer) => void, (r: WebGLRenderer) => void]>([
    ["a measuring frame of the live view", { drawsViewStages: true }, (r) => r.render({ viewOverlays: false }), () => {}],
    ["a float capture of the live view", { drawsViewStages: true }, (r) => void r.readFloatFrame("output"), () => {}],
    ["an export's frame", {}, (r) => r.render(), () => {}],
    ["an export's float frame", {}, (r) => void r.readFloatFrame("output"), () => {}],
    ["a thumbnail", THUMBNAILS, (r) => r.render(), () => {}],
    ["a headless frame", THUMBNAILS, (r) => void r.readFloatFrame("output"), (r) => r.wakeAllStages()],
  ])("draw nothing and hold no target for %s", (_, opts, draw, setup) => {
    const on = costOf(opts, MEASURING_ON, draw, setup);
    const off = costOf(opts, {}, draw, setup);
    expect(on.passes).toBe(0);
    expect(on.framebuffers).toBe(off.framebuffers);
    expect(on.programs).toBe(off.programs);
  });

  it("are built ahead by a prewarm hint only where they are drawn", () => {
    const hint = (r: WebGLRenderer) => r.prewarmStages([MEASURING.id]);
    expect(costOf({ drawsViewStages: true }, {}, hint).programs).toBe(1);
    expect(costOf({}, {}, hint).programs).toBe(0);
  });

  it("don't wake the stages of a renderer that draws them out of the live view's bag", () => {
    const on = costOf(THUMBNAILS, MEASURING_ON, (r) => r.render());
    expect(on.dormant).toEqual([MEASURING.id, DORMANT.id]);
  });

  it("are put off by the live view's measuring frames and drawn once for the next frame shown", () => {
    costOf({ drawsViewStages: true }, MEASURING_ON, (r) => {
      r.render({ viewOverlays: false });
      expect(r.renderDrawCounts.pass).toBe(0);
      r.render();
      expect(r.renderDrawCounts.pass).toBe(1);
      r.render({ viewOverlays: false });
      r.render();
      expect(r.renderDrawCounts.pass).toBe(1);
    });
  });
});

// Where it doesn't draw, nothing of a view-only stage reaches the frame: not
// the clip a display stage without a space is handed on version 2, nor the
// conversion into a space it declares, nor the loss of the elision between
// the stages either side of it.
describe("a view-only stage that isn't drawn", () => {
  const LIFTED = floatImage(8, 8, (x, y) => [0.1 + x / 10, 0.2 + y / 12, 0.6]);
  const BRIGHT: ProcessingStageContribution = {
    id: "acme.bright",
    name: "Bright",
    phase: "effects",
    space: { encoding: "linear" },
    glsl: "c *= 4.0;",
    uniforms: [],
  };
  const AFTER: ProcessingStageContribution = { ...BRIGHT, id: "acme.after", phase: "output-encode", glsl: "c *= 0.5;" };
  const aid = (id: string, space?: ProcessingStageContribution["space"]): ProcessingStageContribution => ({
    id,
    name: "Aid",
    phase: "output-encode",
    priority: 50,
    ...(space ? { space } : {}),
    glsl: "if (amount > 0.5) c = vec3(0.0);",
    uniforms: [{ key: "amount", glslType: "float", default: 0 }],
    viewOnly: true,
  });
  const AFTER_LAST: ProcessingStageContribution = { ...AFTER, priority: 900 };

  const frame = (stages: ProcessingStageContribution[]) =>
    withRenderer({ stages, pipeline: OPEN_PROBE }, (r) => {
      r.setImage(LIFTED);
      r.setParams(identityParams({ processVersion: CURRENT_PROCESS_VERSION }));
      const read = r.readFloatFrame("pre-output");
      if (!read) throw new Error("no float frame");
      return read;
    });

  it.each<[string, ProcessingStageContribution]>([
    ["one without a space, which version 2 would hand clipped values", aid("acme.legacy-aid")],
    ["one in another space", aid("acme.spaced-aid", { encoding: "linear", primaries: "rec2020" })],
  ])("leaves the frame as without it: %s", (_, stage) => {
    const without = frame([BRIGHT, AFTER_LAST]);
    expect(Math.max(...without.data)).toBeGreaterThan(1);
    expect(worstDifference(frame([BRIGHT, stage, AFTER_LAST]), without)).toBe(0);
  });

  it("draws in its own space where it is drawn", () => {
    const stage = aid("acme.spaced-aid", { encoding: "linear", primaries: "rec2020" });
    const shown = withRenderer({ stages: [BRIGHT, stage, AFTER_LAST], pipeline: OPEN_PROBE, drawsViewStages: true }, (r) => {
      r.setImage(LIFTED);
      r.setParams(identityParams({ processVersion: CURRENT_PROCESS_VERSION }));
      r.setContributedParams({ "acme.spaced-aid.amount": 1 });
      r.render();
      return canvasMean();
    });
    expect(shown.r).toBeLessThan(1);
    expect(shown.g).toBeLessThan(1);
  });
});

// A stage that reads the image as edited up to it (reads "current") draws its
// passes from a split of the develop program. A view aid ahead of it never
// reaches that input, so a measuring frame that reuses the result reads no aid.
describe("a view-only stage ahead of a stage that reads the current image", () => {
  const SCENE = floatImage(8, 8, (x, y) => [0.1 + x / 40, 0.15 + y / 50, 0.3]);
  const AID: ProcessingStageContribution = {
    id: "acme.scene-aid",
    name: "Aid",
    phase: "scene-linear",
    priority: 10,
    glsl: "if (amount > 0.5) lin = vec3(4.0, 0.0, 0.0);",
    uniforms: [{ key: "amount", glslType: "float", default: 0 }],
    viewOnly: true,
  };
  const READER: ProcessingStageContribution = {
    id: "acme.reader",
    name: "Reader",
    phase: "scene-linear",
    priority: 20,
    reads: "current",
    glsl: "if (on > 0.5) lin = stageResult;",
    uniforms: [{ key: "on", glslType: "float", default: 0 }],
    passes: [{ glsl: "c = c * 0.5;" }],
  };
  const BAG = { "acme.scene-aid.amount": 1, "acme.reader.on": 1 };
  const measured = (stages: ProcessingStageContribution[], first: (r: WebGLRenderer) => void) =>
    withRenderer({ stages, pipeline: OPEN_PROBE, drawsViewStages: true }, (r) => {
      r.setImage(SCENE);
      r.setParams(identityParams({ processVersion: CURRENT_PROCESS_VERSION }));
      r.setContributedParams(BAG);
      first(r);
      const read = r.readFloatFrame("pre-output");
      if (!read) throw new Error("no float frame");
      return read;
    });

  it("leaves the aid out of the reader's result a measurement reuses after a live frame", () => {
    const plain = measured([READER], () => {});
    expect(worstDifference(measured([AID, READER], (r) => r.render()), plain)).toBe(0);
  });
});

// Turned off in the live view, a view aid holds no full-size result for the
// photo; a measuring frame in between leaves its result in place.
describe("a view-only stage turned off", () => {
  it("gives its result target back, and runs its passes anew when turned on", () => {
    const { canvas, gl } = glHarness();
    const tally = trackGlObjects(gl);
    try {
      withRenderer(
        { stages: [MEASURING], pipeline: LINEAR_PROBE_PIPELINE, drawsViewStages: true },
        (r) => {
          r.setParams(identityParams({ processVersion: CURRENT_PROCESS_VERSION }));
          r.uploadSource("grey:0", GREY);
          r.setContributedParams(MEASURING_ON);
          r.render();
          const held = tally.live.framebuffer;
          r.render({ viewOverlays: false });
          r.render();
          expect(r.renderDrawCounts.pass).toBe(1);
          expect(tally.live.framebuffer).toBe(held);

          r.setContributedParams({});
          r.render();
          expect(tally.live.framebuffer).toBeLessThan(held);

          r.setContributedParams(MEASURING_ON);
          r.render();
          expect(r.renderDrawCounts.pass).toBe(2);
        },
        canvas,
      );
    } finally {
      tally.restore();
    }
  });
});
