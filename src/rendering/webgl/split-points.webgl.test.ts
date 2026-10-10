// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// reads: "current" on the GPU. The renderer draws the develop program up to
// the stage's input into the target its first pass reads, so the passes see
// the image as edited (exposure, earlier stages) instead of the decoded source.

import { describe, expect, it, vi } from "vitest";
import {
  CURRENT_PROCESS_VERSION,
  DEFAULT_CROP,
  type DevelopParams,
  type RetouchSpot,
} from "@/catalog/types";
import type { ProcessingStageContribution, StageTextureData } from "@/extensions/types";
import { WebGLRenderer } from "./renderer";
import {
  LINEAR_PROBE_PIPELINE,
  builtinStages,
  drainGlErrors,
  floatImage,
  glHarness,
  identityParams,
  pixelAt,
  trackGlObjects,
  withRenderer,
  type Frame,
} from "./webgl.test-support";

const V2 = { processVersion: CURRENT_PROCESS_VERSION };
const params = (over: Partial<DevelopParams> = {}) => identityParams({ ...V2, ...over });

function copyStage(over: Partial<ProcessingStageContribution> = {}): ProcessingStageContribution {
  return {
    id: "test.current",
    name: "Current copy",
    phase: "scene-linear",
    reads: "current",
    glsl: "lin = mix(lin, stageResult, take);",
    uniforms: [{ key: "take", glslType: "float", default: 0 }],
    passes: [{ glsl: "c = c;" }],
    ...over,
  };
}

function capture(renderer: WebGLRenderer): Frame {
  const frame = renderer.captureFloatFrame();
  if (!frame) throw new Error("captureFloatFrame returned null");
  return frame;
}

const flat = (v: number) => floatImage(16, 16, () => [v, v, v]);

const HEAL_SPOT: RetouchSpot = {
  id: "s1",
  dstX: 0.5,
  dstY: 0.5,
  srcX: 0.25,
  srcY: 0.25,
  radius: 0.1,
  feather: 0,
  opacity: 100,
  mode: "heal",
  shape: "circle",
  visible: true,
};

// A dark blemish under the spot, on a ramp. The heal reproduces a bare ramp
// exactly, so only the blemish shows whether a split read the healed source.
const BLEMISHED = floatImage(32, 32, (x, y) =>
  x >= 15 && x <= 16 && y >= 15 && y <= 16 ? [0.05, 0.05, 0.05] : [x / 32, y / 32, 0.3],
);

function healed(stages: ProcessingStageContribution[]): Frame {
  return withRenderer({ stages, pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
    r.setImage(BLEMISHED);
    r.setParams(params({ retouch: [HEAL_SPOT] }));
    r.setContributedParams({ "test.current.take": 1 });
    return capture(r);
  });
}

/** Inside the spot, and at two points clear of both the spot and its source. */
function expectAlike(a: Frame, b: Frame): void {
  for (const [x, y] of [[16, 16], [4, 4], [28, 20]] as const)
    for (let i = 0; i < 3; i++) expect(pixelAt(a, x, y)[i]).toBeCloseTo(pixelAt(b, x, y)[i], 2);
}

// The developed target is the only mipmapped texture the renderer draws into.
// Refusing it sends a retouched frame down the in-shader retouch fallback.
function refuseDevelopedTarget(gl: WebGL2RenderingContext): { refused: number; restore(): void } {
  const original = {
    texParameteri: gl.texParameteri,
    checkFramebufferStatus: gl.checkFramebufferStatus,
  };
  const mipmapped = new Set<WebGLTexture>();
  const fault = {
    refused: 0,
    restore() {
      Object.assign(gl, original);
    },
  };
  gl.texParameteri = (target: number, pname: number, param: number) => {
    const bound: WebGLTexture | null = gl.getParameter(gl.TEXTURE_BINDING_2D);
    if (bound && pname === gl.TEXTURE_MIN_FILTER && param === gl.LINEAR_MIPMAP_LINEAR) {
      mipmapped.add(bound);
    }
    original.texParameteri.call(gl, target, pname, param);
  };
  gl.checkFramebufferStatus = (target: number) => {
    const attached: unknown = gl.getFramebufferAttachmentParameter(
      target,
      gl.COLOR_ATTACHMENT0,
      gl.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME,
    );
    if (attached instanceof WebGLTexture && mipmapped.has(attached)) {
      fault.refused++;
      return gl.FRAMEBUFFER_UNSUPPORTED;
    }
    return original.checkFramebufferStatus.call(gl, target);
  };
  return fault;
}

describe("reads current", () => {
  it("hands the passes the exposed image, where a source reader gets the decode", () => {
    const run = (reads: "current" | "source") =>
      withRenderer({ stages: [copyStage({ reads })], pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
        r.setImage(flat(0.2));
        r.setParams(params({ exposure: 1 }));
        r.setContributedParams({ "test.current.take": 1 });
        return pixelAt(capture(r), 8, 8)[1];
      });
    expect(run("current")).toBeCloseTo(0.4, 2);
    expect(run("source")).toBeCloseTo(0.2, 2);
  });

  it("redraws the split for an upstream change, not for the stage's own inline param", () => {
    withRenderer({ stages: [copyStage()], pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
      r.setImage(flat(0.2));
      r.setParams(params({ exposure: 1 }));
      r.setContributedParams({ "test.current.take": 1 });
      r.render();
      const first = r.renderDrawCounts.split;
      r.setContributedParams({ "test.current.take": 0.5 });
      r.render();
      expect(r.renderDrawCounts.split).toBe(first);
      r.setParams(params({ exposure: 0.5 }));
      r.render();
      expect(r.renderDrawCounts.split).toBe(first + 1);
    });
  });

  // Serialising the develop params is the costly part of a split's key (masks
  // carry their brush dabs), so frames that replaced nothing upstream, the
  // stage's own inline param included, must not do it.
  it("serialises nothing for frames that replaced no input but the stage's own param", () => {
    withRenderer({ stages: [copyStage()], pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
      r.setImage(flat(0.2));
      r.setParams(params({ exposure: 1 }));
      r.setContributedParams({ "test.current.take": 1 });
      r.render();
      const stringify = vi.spyOn(JSON, "stringify");
      try {
        r.render();
        r.render();
        r.setContributedParams({ "test.current.take": 0.5 });
        r.render();
        const idle = stringify.mock.calls.length;
        r.setParams(params({ exposure: 0.5 }));
        r.render();
        const replaced = stringify.mock.calls.length - idle;
        expect(idle).toBe(0);
        expect(replaced).toBeGreaterThan(0);
      } finally {
        stringify.mockRestore();
      }
    });
  });

  // The tests below keep one renderer across frames: a split's cache entry
  // outlives the frame, so only a later frame shows what its key missed.
  it("redraws a split when an upstream stage's param changes", () => {
    const gain: ProcessingStageContribution = {
      id: "test.gain",
      name: "Gain",
      phase: "scene-linear",
      priority: 10,
      glsl: "lin *= gain;",
      uniforms: [{ key: "gain", glslType: "float", default: 1 }],
    };
    const stages = [gain, copyStage({ priority: 20 })];
    withRenderer({ stages, pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
      r.setImage(flat(0.2));
      r.setParams(params());
      r.setContributedParams({ "test.gain.gain": 1, "test.current.take": 1 });
      expect(pixelAt(capture(r), 8, 8)[1]).toBeCloseTo(0.2, 2);
      const drawn = r.renderDrawCounts.split;
      r.setContributedParams({ "test.gain.gain": 2, "test.current.take": 1 });
      expect(pixelAt(capture(r), 8, 8)[1]).toBeCloseTo(0.4, 2);
      expect(r.renderDrawCounts.split).toBe(drawn + 1);
    });
  });

  it("redraws a display reader's split for a Contrast change, but not a scene reader's", () => {
    const scene = copyStage({ id: "test.scene" });
    const display = copyStage({
      id: "test.display",
      phase: "display-adjust",
      glsl: "c = mix(c, stageResult, take);",
    });
    const contrasted = withRenderer({ stages: [], pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
      r.setImage(flat(0.2));
      r.setParams(params({ contrast: 50 }));
      return pixelAt(capture(r), 8, 8)[1];
    });
    withRenderer({ stages: [scene, display], pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
      r.setImage(flat(0.2));
      r.setContributedParams({ "test.scene.take": 1, "test.display.take": 1 });
      r.setParams(params());
      expect(pixelAt(capture(r), 8, 8)[1]).toBeCloseTo(0.2, 2);
      const drawn = r.renderDrawCounts.split;
      r.setParams(params({ contrast: 50 }));
      expect(pixelAt(capture(r), 8, 8)[1]).toBeCloseTo(contrasted, 2);
      expect(r.renderDrawCounts.split).toBe(drawn + 1);
    });
  });

  // The export renderer shares the main thread's stage-texture record, which a
  // texture swap updates in place.
  it("redraws a split when an upstream stage's texture is swapped in place", () => {
    const lut: ProcessingStageContribution = {
      id: "test.lut",
      name: "LUT",
      phase: "scene-linear",
      priority: 10,
      glsl: "lin *= texture(ramp, vec2(0.5)).g * 2.0;",
      uniforms: [],
      textures: [{ key: "ramp", kind: "lut" }],
    };
    const ramp = (green: number, version: number): StageTextureData => ({
      data: new Uint8Array([0, green, 0, 255]),
      width: 1,
      height: 1,
      format: "rgba8",
      version,
    });
    const textures: Record<string, StageTextureData> = { "test.lut.ramp": ramp(128, 1) };
    const stages = [lut, copyStage({ priority: 20 })];
    withRenderer({ stages, pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
      r.setImage(flat(0.2));
      r.setParams(params());
      r.setContributedParams({ "test.current.take": 1 });
      r.setStageTextures(textures);
      expect(pixelAt(capture(r), 8, 8)[1]).toBeCloseTo(0.2 * (128 / 255) * 2, 2);
      const drawn = r.renderDrawCounts.split;
      textures["test.lut.ramp"] = ramp(64, 2);
      expect(pixelAt(capture(r), 8, 8)[1]).toBeCloseTo(0.2 * (64 / 255) * 2, 2);
      expect(r.renderDrawCounts.split).toBe(drawn + 1);
    });
  });

  // A noise-reduction reader's input is cut ahead of white balance and
  // exposure, so neither can stale it.
  it("keeps a noise-reduction reader's split through an Exposure change", () => {
    const reader = copyStage({ phase: "noise-reduction" });
    withRenderer({ stages: [reader], pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
      r.setImage(flat(0.2));
      r.setContributedParams({ "test.current.take": 1 });
      r.setParams(params());
      expect(pixelAt(capture(r), 8, 8)[1]).toBeCloseTo(0.2, 2);
      const drawn = r.renderDrawCounts.split;
      r.setParams(params({ exposure: 1 }));
      expect(pixelAt(capture(r), 8, 8)[1]).toBeCloseTo(0.4, 2);
      expect(r.renderDrawCounts.split).toBe(drawn);
    });
  });

  it("includes an earlier current stage's result in a later stage's split", () => {
    const doubler = copyStage({
      id: "test.doubler",
      priority: 10,
      glsl: "lin = mix(lin, stageResult * 2.0, take);",
    });
    const reader = copyStage({ id: "test.reader", priority: 20 });
    withRenderer({ stages: [doubler, reader], pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
      r.setImage(flat(0.2));
      r.setParams(params());
      r.setContributedParams({ "test.doubler.take": 1, "test.reader.take": 1 });
      expect(pixelAt(capture(r), 8, 8)[1]).toBeCloseTo(0.4, 2);
    });
  });

  // At exposure 0 the earlier stage's result equals the decode, which hides a
  // later split reading the wrong texture; exposure tells them apart. The
  // second frame runs with every target already allocated, where unit 0 still
  // holds a ping-pong texture from the earlier stage's passes.
  it("hands a later split the earlier stage's result from the same frame, every frame", () => {
    const { gl } = glHarness();
    drainGlErrors(gl);
    const doubler = copyStage({
      id: "test.doubler",
      priority: 10,
      glsl: "lin = mix(lin, stageResult * 2.0, take);",
    });
    const reader = copyStage({ id: "test.reader", priority: 20 });
    withRenderer({ stages: [doubler, reader], pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
      r.setImage(flat(0.2));
      r.setContributedParams({ "test.doubler.take": 1, "test.reader.take": 1 });
      for (const exposure of [1, 0.5]) {
        r.setParams(params({ exposure }));
        expect(pixelAt(capture(r), 8, 8)[1]).toBeCloseTo(0.2 * 2 ** exposure * 2, 2);
      }
      expect(r.renderDrawCounts.split).toBe(4);
    });
    expect(gl.getError()).toBe(gl.NO_ERROR);
  });

  // A split draw skips geometry: the main draw samples the stage's result at
  // the warped position, so a split that warped too would warp twice.
  it("lines the split up with the source under a geometry stage", () => {
    const mirror: ProcessingStageContribution = {
      id: "test.mirror",
      name: "Mirror",
      phase: "geometry",
      glsl: "srcUv.x = 1.0 - srcUv.x;",
      uniforms: [],
    };
    // Under the core shoulder's knee, so the probe reads the ramp back as is.
    const ramp = floatImage(32, 8, (x) => [x / 64, x / 64, x / 64]);
    const row = (stages: ProcessingStageContribution[]) =>
      withRenderer({ stages, pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
        r.setImage(ramp);
        r.setParams(params());
        r.setContributedParams({ "test.current.take": 1 });
        const frame = capture(r);
        return [0, 5, 10, 20, 31].map((x) => pixelAt(frame, x, 4)[1]);
      });
    const mirrored = row([mirror]);
    expect(mirrored[0]).toBeCloseTo(31 / 64, 2);
    const withStage = row([mirror, copyStage()]);
    for (let i = 0; i < mirrored.length; i++) expect(withStage[i]).toBeCloseTo(mirrored[i], 2);
  });

  it("gives an effects stage the image as of the end of display-adjust", () => {
    const adjust: ProcessingStageContribution = {
      id: "test.adjust",
      name: "Adjust",
      phase: "display-adjust",
      glsl: "c *= 0.5;",
      uniforms: [],
    };
    const effect = copyStage({
      id: "test.effect",
      phase: "effects",
      glsl: "c = mix(c, stageResult, take);",
    });
    const out = (stages: ProcessingStageContribution[]) =>
      withRenderer({ stages, pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
        r.setImage(flat(0.6));
        r.setParams(params());
        r.setContributedParams({ "test.effect.take": 1 });
        return pixelAt(capture(r), 8, 8)[1];
      });
    expect(out([adjust, effect])).toBeCloseTo(out([adjust]), 2);
    // Ahead of an earlier effects stage too, not at the stage's own position.
    const quarter: ProcessingStageContribution = {
      id: "test.quarter",
      name: "Quarter",
      phase: "effects",
      priority: 30,
      glsl: "c *= 0.25;",
      uniforms: [],
    };
    expect(out([adjust, quarter, effect])).toBeCloseTo(out([adjust]), 2);
  });

  // The stage's inline glsl blends stageResult into its variable in the
  // declared space, so the split must write that space too.
  it("hands a stage that declared a space its input in that space", () => {
    const wide = copyStage({ space: { encoding: "linear", primaries: "rec2020" } });
    const colour = floatImage(16, 16, () => [0.4, 0.2, 0.1]);
    const pixel = (stages: ProcessingStageContribution[]) =>
      withRenderer({ stages, pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
        r.setImage(colour);
        r.setParams(params());
        r.setContributedParams({ "test.current.take": 1 });
        return pixelAt(capture(r), 8, 8);
      });
    const plain = pixel([]);
    const read = pixel([wide]);
    for (let i = 0; i < 3; i++) expect(read[i]).toBeCloseTo(plain[i], 2);
  });

  it("lines the split up with the source under a crop", () => {
    const ramp = floatImage(32, 8, (x) => [x / 32, x / 32, x / 32]);
    withRenderer({ stages: [copyStage()], pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
      r.setImage(ramp);
      r.setParams(params({ crop: { ...DEFAULT_CROP, x: 0.25, width: 0.5 } }));
      r.setContributedParams({ "test.current.take": 1 });
      const frame = capture(r);
      for (const j of [0, 5, 10, 15]) expect(pixelAt(frame, j, 4)[1]).toBeCloseTo((8 + j) / 32, 2);
    });
  });

  it("reads the patched source when heal spots are present, without GL errors", () => {
    const { gl } = glHarness();
    drainGlErrors(gl);
    expectAlike(healed([copyStage()]), healed([]));
    expect(gl.getError()).toBe(gl.NO_ERROR);
  });

  it("applies the retouch itself when there is no patched source", () => {
    const { gl } = glHarness();
    drainGlErrors(gl);
    const fault = refuseDevelopedTarget(gl);
    try {
      expectAlike(healed([copyStage()]), healed([]));
      expect(fault.refused).toBeGreaterThan(0);
    } finally {
      fault.restore();
    }
    expect(gl.getError()).toBe(gl.NO_ERROR);
  });

  it("draws no splits for a stage set without current readers", () => {
    withRenderer({ stages: builtinStages() }, (r) => {
      r.setImage(flat(0.2));
      r.setParams(params({ luminanceNR: 40 }));
      r.setContributedParams({ "builtin.denoise.lumAmount": 40 });
      r.render();
      r.render();
      expect(r.renderDrawCounts.split).toBe(0);
    });
  });

  it("gives back every GL object on dispose", () => {
    const { canvas, gl } = glHarness();
    const tally = trackGlObjects(gl);
    try {
      const r = new WebGLRenderer(canvas, {
        stages: [copyStage()],
        pipeline: LINEAR_PROBE_PIPELINE,
      });
      r.setImage(flat(0.2));
      r.setParams(params({ exposure: 1 }));
      r.setContributedParams({ "test.current.take": 1 });
      r.render();
      r.dispose();
      expect(Object.values(tally.live).every((n) => n === 0)).toBe(true);
    } finally {
      tally.restore();
    }
  });

  it("falls back to the source, warning once, on a GPU without float render targets", () => {
    const { canvas, gl } = glHarness();
    const getExtension = gl.getExtension.bind(gl);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    gl.getExtension = ((name: string) =>
      name === "EXT_color_buffer_float" ? null : getExtension(name)) as typeof gl.getExtension;
    try {
      const r = new WebGLRenderer(canvas, {
        stages: [copyStage()],
        pipeline: LINEAR_PROBE_PIPELINE,
      });
      try {
        r.setImage(flat(0.2));
        r.setParams(params({ exposure: 1 }));
        r.setContributedParams({ "test.current.take": 1 });
        r.render();
        r.render();
        const px = new Uint8Array(4);
        gl.readPixels(8, 8, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        expect(px[1] / 255).toBeCloseTo(0.2, 1);
        const warnings = warn.mock.calls.filter((c) => String(c[0]).includes("test.current"));
        expect(warnings).toHaveLength(1);
      } finally {
        r.dispose();
      }
    } finally {
      gl.getExtension = getExtension;
      warn.mockRestore();
    }
  });
});
