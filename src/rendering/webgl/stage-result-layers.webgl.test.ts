// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A version 2 program whose stages would pass the sampler limit reads their
// prepass results from one TEXTURE_2D_ARRAY. A stage keeps its layer while it
// stays in the stage set, the array grows by exactly the layers it lacks and
// copies the ones it holds, a new source or size starts it over, and an array
// that can't be allocated is reported, not retried every frame. A set that fits
// the limit keeps a texture per stage.

import { afterEach, describe, expect, it, vi } from "vitest";
import { CURRENT_PROCESS_VERSION, type DevelopParams } from "@/catalog/types";
import type { ProcessingStageContribution } from "@/extensions/types";
import { WebGLRenderer } from "./renderer";
import { uniformPrefix } from "./shader-compiler";
import { StageResultLayers } from "./stage-result-layers";
import {
  LINEAR_PROBE_PIPELINE,
  drainGlErrors,
  floatImage,
  glHarness,
  identityParams,
  markerStage,
  pixelAt,
  takingStages,
  trackGlObjects,
  withRenderer,
  type GlObjectCounts,
} from "./webgl.test-support";

const NO_LIVE_OBJECTS: GlObjectCounts = {
  texture: 0,
  framebuffer: 0,
  buffer: 0,
  program: 0,
  shader: 0,
  vertexArray: 0,
};

/** A `size`² RGBA16F framebuffer cleared to `value`, standing in for a stage's
 *  last pass. */
function filled(
  gl: WebGL2RenderingContext,
  value: number,
  size = 4,
): { fbo: WebGLFramebuffer; release(): void } {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, size, size, 0, gl.RGBA, gl.HALF_FLOAT, null);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.clearColor(value, value, value, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return {
    fbo,
    release() {
      gl.deleteFramebuffer(fbo);
      gl.deleteTexture(tex);
    },
  };
}

/** The red channel of texel (`texel`, `texel`) of layer `layer` of `tex`. */
function readLayer(
  gl: WebGL2RenderingContext,
  tex: WebGLTexture,
  layer: number,
  texel = 1,
): number {
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, tex, 0, layer);
  const px = new Float32Array(4);
  gl.readPixels(texel, texel, 1, 1, gl.RGBA, gl.FLOAT, px);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(fbo);
  return px[0];
}

/** Records the framebuffers created until `restore`. */
function watchFramebuffers(gl: WebGL2RenderingContext): { made: WebGLFramebuffer[]; restore(): void } {
  const create = gl.createFramebuffer;
  const made: WebGLFramebuffer[] = [];
  gl.createFramebuffer = () => {
    const fbo = create.call(gl);
    made.push(fbo);
    return fbo;
  };
  return {
    made,
    restore() {
      gl.createFramebuffer = create;
    },
  };
}

/** How many of `fbos` hold a texture other than `current`. A deleted texture
 *  stays alive while a framebuffer that isn't bound holds it, and a handle count
 *  can't see that memory. */
function holdingOtherThan(
  gl: WebGL2RenderingContext,
  fbos: readonly WebGLFramebuffer[],
  current: WebGLTexture,
): number {
  let holding = 0;
  for (const fbo of fbos) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    const held: unknown = gl.getFramebufferAttachmentParameter(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME,
    );
    if (held !== null && held !== current) holding++;
  }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return holding;
}

/** A driver that won't complete a framebuffer on any TEXTURE_2D_ARRAY, counting
 *  the arrays allocated meanwhile. */
function refuseResultArrays(gl: WebGL2RenderingContext): { allocations: number; restore(): void } {
  const original = { texImage3D: gl.texImage3D, checkFramebufferStatus: gl.checkFramebufferStatus };
  const arrays = new Set<WebGLTexture>();
  const fault = {
    allocations: 0,
    restore() {
      Object.assign(gl, original);
    },
  };
  gl.texImage3D = (...args: unknown[]) => {
    const bound: WebGLTexture | null = gl.getParameter(gl.TEXTURE_BINDING_2D_ARRAY);
    if (bound && args[0] === gl.TEXTURE_2D_ARRAY) {
      arrays.add(bound);
      fault.allocations++;
    }
    Reflect.apply(original.texImage3D, gl, args);
  };
  gl.checkFramebufferStatus = (target: number) => {
    const tex: unknown = gl.getFramebufferAttachmentParameter(
      target,
      gl.COLOR_ATTACHMENT0,
      gl.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME,
    );
    if (tex instanceof WebGLTexture && arrays.has(tex)) return gl.FRAMEBUFFER_UNSUPPORTED;
    return original.checkFramebufferStatus.call(gl, target);
  };
  return fault;
}

/** A driver allowing a shader `units` samplers, from the next renderer on. */
function samplerLimit(units: number): { restore(): void } {
  const { gl } = glHarness();
  const original = gl.getParameter;
  gl.getParameter = (pname: number) =>
    pname === gl.MAX_TEXTURE_IMAGE_UNITS ? units : Reflect.apply(original, gl, [pname]);
  return {
    restore() {
      gl.getParameter = original;
    },
  };
}

// The renderer is what enables float color buffers in the app, and passes the
// result as `float`; here nothing has, so RGBA16F isn't yet renderable.
glHarness().gl.getExtension("EXT_color_buffer_float");

describe("StageResultLayers", () => {
  it("keeps each stage's result in its own layer", () => {
    const { gl } = glHarness();
    const layers = new StageResultLayers(gl, true);
    const quarter = filled(gl, 0.25);
    const half = filled(gl, 0.5);
    try {
      expect(layers.reserve(["a", "b"], 4, 4, 1)).toBe(true);
      layers.write("a", quarter.fbo, 4, 4);
      layers.write("b", half.fbo, 4, 4);
      expect(readLayer(gl, layers.texture(), layers.layer("a"))).toBe(0.25);
      expect(readLayer(gl, layers.texture(), layers.layer("b"))).toBe(0.5);
      expect(layers.layer("never.test")).toBe(-1);
    } finally {
      layers.dispose();
      quarter.release();
      half.release();
    }
  });

  it("copies the layers it holds when it grows", () => {
    const { gl } = glHarness();
    const layers = new StageResultLayers(gl, true);
    const quarter = filled(gl, 0.25);
    try {
      layers.reserve(["a"], 4, 4, 1);
      layers.write("a", quarter.fbo, 4, 4);
      expect(layers.reserve(["a", "b"], 4, 4, 1)).toBe(true);
      expect(layers.layer("b")).toBe(1);
      expect(readLayer(gl, layers.texture(), layers.layer("a"))).toBe(0.25);
    } finally {
      layers.dispose();
      quarter.release();
    }
  });

  it("lets go of the old array when it grows", () => {
    const { gl } = glHarness();
    const watch = watchFramebuffers(gl);
    const layers = new StageResultLayers(gl, true);
    try {
      layers.reserve(["a"], 4, 4, 1);
      const old = layers.texture();
      layers.reserve(["a", "b"], 4, 4, 1);
      expect(layers.texture()).not.toBe(old);
      expect(watch.made.length).toBeGreaterThan(0);
      expect(holdingOtherThan(gl, watch.made, layers.texture())).toBe(0);
    } finally {
      layers.dispose();
      watch.restore();
    }
  });

  it("starts over at a new size", () => {
    const { gl } = glHarness();
    const layers = new StageResultLayers(gl, true);
    const half = filled(gl, 0.5, 8);
    try {
      layers.reserve(["a"], 4, 4, 1);
      expect(layers.reserve(["a"], 8, 8, 1)).toBe(true);
      layers.write("a", half.fbo, 8, 8);
      expect(readLayer(gl, layers.texture(), layers.layer("a"), 7)).toBe(0.5);
    } finally {
      layers.dispose();
      half.release();
    }
  });

  // Another source's results can never be read again, since every prepass
  // signature carries the source epoch; copying them would double the peak.
  it("drops the layers of another source instead of copying them", () => {
    const { gl } = glHarness();
    const layers = new StageResultLayers(gl, true);
    const quarter = filled(gl, 0.25);
    try {
      layers.reserve(["a", "b"], 4, 4, 1);
      layers.write("a", quarter.fbo, 4, 4);
      expect(layers.reserve(["b"], 4, 4, 2)).toBe(true);
      expect(layers.layer("a")).toBe(-1);
      expect(readLayer(gl, layers.texture(), layers.layer("b"))).toBe(0);
    } finally {
      layers.dispose();
      quarter.release();
    }
  });

  describe("when the array can't be allocated", () => {
    let fault: { allocations: number; restore(): void } | null = null;

    afterEach(() => {
      fault?.restore();
      fault = null;
    });

    it("keeps the layers held, gives a new stage none, and tries again only once the set changes", () => {
      const { gl } = glHarness();
      const layers = new StageResultLayers(gl, true);
      try {
        expect(layers.reserve(["a"], 4, 4, 1)).toBe(true);
        fault = refuseResultArrays(gl);
        expect(layers.reserve(["a", "b"], 4, 4, 1)).toBe(false);
        expect(layers.layer("a")).toBe(0);
        expect(layers.layer("b")).toBe(-1);
        const tried = fault.allocations;
        expect(layers.reserve(["a", "b"], 4, 4, 1)).toBe(false);
        expect(fault.allocations).toBe(tried);
        layers.release(new Set(["a", "b"]));
        layers.reserve(["a", "b"], 4, 4, 1);
        expect(fault.allocations).toBe(tried + 1);
      } finally {
        layers.dispose();
      }
    });

    // A new source drops the array, so the growth refused next to it may now fit.
    it("tries again once on a new source, not every frame", () => {
      const { gl } = glHarness();
      const layers = new StageResultLayers(gl, true);
      try {
        expect(layers.reserve(["a"], 4, 4, 1)).toBe(true);
        fault = refuseResultArrays(gl);
        expect(layers.reserve(["a", "b"], 4, 4, 1)).toBe(false);
        const tried = fault.allocations;
        layers.reserve(["a", "b"], 4, 4, 2);
        expect(fault.allocations).toBe(tried + 1);
        layers.reserve(["a", "b"], 4, 4, 2);
        expect(fault.allocations).toBe(tried + 1);
      } finally {
        layers.dispose();
      }
    });

    it("lets go of the array it refused", () => {
      const { gl } = glHarness();
      const watch = watchFramebuffers(gl);
      const layers = new StageResultLayers(gl, true);
      try {
        layers.reserve(["a"], 4, 4, 1);
        fault = refuseResultArrays(gl);
        expect(layers.reserve(["a", "b"], 4, 4, 1)).toBe(false);
        expect(fault.allocations).toBeGreaterThan(0);
        expect(holdingOtherThan(gl, watch.made, layers.texture())).toBe(0);
      } finally {
        layers.dispose();
        watch.restore();
      }
    });
  });

  it("gives back every GL object once no stage holds a layer, and on dispose", () => {
    const { gl } = glHarness();
    const quarter = filled(gl, 0.25);
    const tally = trackGlObjects(gl);
    try {
      const layers = new StageResultLayers(gl, true);
      layers.reserve(["a"], 4, 4, 1);
      layers.write("a", quarter.fbo, 4, 4);
      layers.reserve(["a", "b"], 4, 4, 1);
      layers.release(new Set());
      expect(tally.live).toEqual(NO_LIVE_OBJECTS);
      layers.texture();
      layers.reserve(["c"], 4, 4, 1);
      layers.dispose();
      expect(tally.live).toEqual(NO_LIVE_OBJECTS);
    } finally {
      tally.restore();
      quarter.release();
    }
  });
});

const STEP = 0.02;
const BASE = 0.1;
const V2 = identityParams({ processVersion: CURRENT_PROCESS_VERSION });
const V1 = identityParams();
const SOURCE = floatImage(8, 8, () => [BASE, BASE, BASE]);

const markers = (n: number): ProcessingStageContribution[] =>
  Array.from({ length: n }, (_, i) => markerStage(i, STEP));
const level = (r: WebGLRenderer): number => pixelAt(r.captureFloatFrame()!, 4, 4)[1];
const stepsOver = (idle: number, lit: number): number => Math.round((lit - idle) / STEP);

function onRenderer<T>(
  stages: ProcessingStageContribution[],
  params: DevelopParams,
  fn: (r: WebGLRenderer) => T,
): T {
  return withRenderer({ stages, pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
    r.setImage(SOURCE);
    r.setParams(params);
    return fn(r);
  });
}

/** Reads its result by name with texelFetch, as the Colour Equaliser reads its table. */
function namedStage(): ProcessingStageContribution {
  const id = "named.test";
  const sampler = `${uniformPrefix(id)}stageResult`;
  return {
    id,
    name: "Named",
    phase: "scene-linear",
    priority: 90,
    glsl:
      `if (take > 0.5 && abs(texelFetch(${sampler}, ivec2(0), 0).r - 0.75) < 0.001) ` +
      `lin += vec3(${STEP});`,
    uniforms: [{ key: "take", glslType: "float", default: 0 }],
    passes: [{ glsl: "c = vec3(0.75);" }],
  };
}

// Two samplers past the develop shader's six: a set of three stages or more
// takes the shared array.
const FEW_SAMPLERS = 8;

describe("version 2 stage results on the renderer", () => {
  let driver: { restore(): void } | null = null;

  afterEach(() => {
    driver?.restore();
    driver = null;
  });

  // Thirty result samplers plus the develop shader's own six are past the 32
  // samplers SwiftShader allows a shader, so this only builds with the array.
  it("runs thirty active stages, each on its own layer", () => {
    const stages = markers(30);
    const steps = onRenderer(stages, V2, (r) => {
      const idle = level(r);
      r.setContributedParams(takingStages(stages));
      return stepsOver(idle, level(r));
    });
    expect(steps).toBe(30);
  });

  it("runs a stage that reads its own result sampler by name beside them", () => {
    driver = samplerLimit(FEW_SAMPLERS);
    const stages = [...markers(10), namedStage()];
    const steps = onRenderer(stages, V2, (r) => {
      const idle = level(r);
      r.setContributedParams(takingStages(stages));
      return stepsOver(idle, level(r));
    });
    expect(steps).toBe(11);
  });

  it("leaves the frame bit-identical while every stage is idle", () => {
    const bare = onRenderer([], V2, (r) => r.captureFloatFrame()!);
    const idle = onRenderer(markers(30), V2, (r) => r.captureFloatFrame()!);
    expect(Array.from(idle.data)).toEqual(Array.from(bare.data));
  });

  // While every stage idles the sampler reads a stand-in, which must sit on the
  // array's unit from the frame that makes it. That unit is the first of the
  // prepass pool: 8, with no stage textures. An earlier renderer's deleted array
  // can still be reported there, so the binding has to be a live texture.
  it("binds the stand-in array on the array's unit from its first frame", () => {
    driver = samplerLimit(FEW_SAMPLERS);
    const { gl } = glHarness();
    const live = onRenderer(markers(3), V2, (r) => {
      level(r);
      const active: number = gl.getParameter(gl.ACTIVE_TEXTURE);
      gl.activeTexture(gl.TEXTURE8);
      const bound: unknown = gl.getParameter(gl.TEXTURE_BINDING_2D_ARRAY);
      gl.activeTexture(active);
      return bound instanceof WebGLTexture && gl.isTexture(bound);
    });
    expect(live).toBe(true);
  });

  it("grows as stages turn on, running only the new stage's pass, and none once nothing changes", () => {
    driver = samplerLimit(FEW_SAMPLERS);
    const stages = markers(5);
    onRenderer(stages, V2, (r) => {
      const idle = level(r);
      for (let k = 1; k <= stages.length; k++) {
        r.setContributedParams(takingStages(stages.slice(0, k)));
        const before = r.renderDrawCounts.pass;
        const lit = level(r);
        expect(r.renderDrawCounts.pass - before).toBe(1);
        expect(stepsOver(idle, lit)).toBe(k);
      }
      const before = r.renderDrawCounts.pass;
      level(r);
      expect(r.renderDrawCounts.pass).toBe(before);
    });
  });

  it("keeps a result for each version when frames alternate between them", () => {
    driver = samplerLimit(FEW_SAMPLERS);
    const stages = markers(3);
    onRenderer(stages, V2, (r) => {
      const idle2 = level(r);
      r.setParams(V1);
      const idle1 = level(r);
      r.setContributedParams(takingStages(stages));
      // Version 1 lights first, so a result it cached is there to stand in for
      // version 2's layer, which nothing has written yet.
      level(r);
      r.setParams(V2);
      level(r);
      const before = r.renderDrawCounts.pass;
      r.setParams(V1);
      const lit1 = level(r);
      r.setParams(V2);
      const lit2 = level(r);
      expect(r.renderDrawCounts.pass).toBe(before);
      expect(stepsOver(idle2, lit2)).toBe(3);
      expect(stepsOver(idle1, lit1)).toBe(3);
    });
  });

  it("gives back the array's textures and framebuffers as its stages leave, and all on dispose", () => {
    driver = samplerLimit(FEW_SAMPLERS);
    const { canvas, gl } = glHarness();
    const tally = trackGlObjects(gl);
    try {
      const r = new WebGLRenderer(canvas, { stages: [], pipeline: LINEAR_PROBE_PIPELINE });
      r.setImage(SOURCE);
      r.setParams(V2);
      r.render();
      const bare = { texture: tally.live.texture, framebuffer: tally.live.framebuffer };
      const stages = markers(4);
      r.setStages(stages);
      r.setContributedParams(takingStages(stages));
      r.render();
      r.setStages([]);
      r.render();
      expect({ texture: tally.live.texture, framebuffer: tally.live.framebuffer }).toEqual(bare);
      r.dispose();
      expect(tally.live).toEqual(NO_LIVE_OBJECTS);
    } finally {
      tally.restore();
    }
  });

  it("draws without the stages it can't allocate a layer for, and names them", () => {
    driver = samplerLimit(FEW_SAMPLERS);
    const { gl } = glHarness();
    const fault = refuseResultArrays(gl);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const stages = markers(3);
      const { steps, overflowed } = onRenderer(stages, V2, (r) => {
        const idle = level(r);
        r.setContributedParams(takingStages(stages));
        drainGlErrors(gl);
        const lit = level(r);
        expect(gl.getError()).toBe(gl.NO_ERROR);
        level(r);
        return { steps: stepsOver(idle, lit), overflowed: [...r.overflowedStages] };
      });
      expect(steps).toBe(0);
      expect(overflowed).toEqual(stages.map((s) => s.id));
      const warned = warn.mock.calls.map(([message]) => String(message));
      expect(warned).toHaveLength(stages.length);
      for (const s of stages) expect(warned.filter((m) => m.includes(`'${s.id}'`))).toHaveLength(1);
    } finally {
      warn.mockRestore();
      fault.restore();
    }
  });

  // A sampler per stage is a texture per stage, each small, which a GPU that
  // refuses the one large array still gives.
  it("draws a set that fits the sampler limit without the shared array", () => {
    const { gl } = glHarness();
    const fault = refuseResultArrays(gl);
    try {
      const stages = markers(3);
      const { steps, overflowed } = onRenderer(stages, V2, (r) => {
        const idle = level(r);
        r.setContributedParams(takingStages(stages));
        return { steps: stepsOver(idle, level(r)), overflowed: [...r.overflowedStages] };
      });
      expect(steps).toBe(3);
      expect(overflowed).toEqual([]);
    } finally {
      fault.restore();
    }
  });

  it("lets go of the array once the stage set comes to fit the sampler limit", () => {
    driver = samplerLimit(FEW_SAMPLERS);
    const { gl } = glHarness();
    const stages = markers(3);
    const { array, live } = onRenderer(stages, V2, (r) => {
      r.setContributedParams(takingStages(stages));
      level(r);
      const active: number = gl.getParameter(gl.ACTIVE_TEXTURE);
      gl.activeTexture(gl.TEXTURE8);
      const bound: unknown = gl.getParameter(gl.TEXTURE_BINDING_2D_ARRAY);
      gl.activeTexture(active);
      r.setStages(stages.slice(0, 2));
      level(r);
      return { array: bound, live: bound instanceof WebGLTexture && gl.isTexture(bound) };
    });
    expect(array).toBeInstanceOf(WebGLTexture);
    expect(live).toBe(false);
  });
});
