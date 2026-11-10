// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A kept pass leaves a checkpoint: when a later frame changes only what comes
// after it, the stage starts from the checkpoint instead of drawing from the
// start, and gets exactly the result a full run gets.
//
// The stage: pass 0 draws 4 times (u0) and changes the left half after its
// first draw; pass 1 draws 3 times over the left half only (u1) and writes
// garbage outside it, which its region keeps out of the frame on every draw
// but a whole one; pass 2 draws twice (u2). Passes 0 and 1 are kept.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CURRENT_PROCESS_VERSION,
  LEGACY_PROCESS_VERSION,
  defaultMaskAdjustments,
  type Mask,
  type MaskComponent,
} from "@/catalog/types";
import type { ProcessingStageContribution, StagePass } from "@/extensions/types";
import { encodeHalf } from "@/raw/half-float";
import type { WebGLRenderer, WebGLRendererOpts } from "./renderer";
import {
  LINEAR_PROBE_PIPELINE,
  floatImage,
  glHarness,
  identityParams,
  masksStagesFor,
  trackGlObjects,
  withRenderer,
  type Frame,
} from "./webgl.test-support";

const W = 32;
const H = 24;
const ID = "test.keep";
const SCENE = floatImage(W, H, (x, y) => [0.05 + x / 64, 0.05 + y / 64, 0.3]);
const OTHER = floatImage(W, H, (x, y) => [0.3, 0.05 + x / 64, 0.05 + y / 64]);
/** A cached preview twice the pass size, uploaded whole, so a stage's input is resampled. */
const BIG = (() => {
  const scene = floatImage(W * 2, H * 2, (x, y) => [0.05 + x / 128, 0.05 + y / 128, 0.2 + ((x * 3 + y) % 7) / 64]);
  return { kind: "float16" as const, data: encodeHalf(scene.data), width: scene.width, height: scene.height };
})();
type SourceImage = Parameters<WebGLRenderer["setImage"]>[0];

interface Shape {
  keep?: [boolean, boolean, boolean];
  /** Passes 1 and 2 read their draw counts from n1 and n2. */
  counted?: boolean;
  reads?: "source" | "current";
  /** Pass 2 mixes in fetchInput. */
  fetches?: boolean;
  /** Pass 2 doesn't compile. */
  broken?: boolean;
  maskable?: boolean;
  priority?: number;
}

function keepStage(shape: Shape = {}, id = ID): ProcessingStageContribution {
  const [k0, k1, k2] = shape.keep ?? [true, true, false];
  const kept = (on: boolean): Pick<StagePass, "keep"> => (on ? { keep: true } : {});
  const count = (key: string, fixed: number): StagePass["iterations"] => (shape.counted ? { key, max: 4 } : fixed);
  const last = shape.broken
    ? "c = undefinedValue;"
    : shape.fetches
      ? "c = c * 0.5 + fetchInput(ivec2(gl_FragCoord.xy)) * u2;"
      : "c = c * 0.5 + vec3(u2);";
  return {
    id,
    name: "Keep",
    phase: "scene-linear",
    ...(shape.priority === undefined ? {} : { priority: shape.priority }),
    ...(shape.reads ? { reads: shape.reads } : {}),
    glsl: "if (take > 0.5) lin = stageResult;",
    uniforms: [
      { key: "take", glslType: "float", default: 0 },
      { key: "n1", glslType: "float", default: 3 },
      { key: "n2", glslType: "float", default: 2 },
    ],
    passes: [
      {
        iterations: 4,
        uniforms: [{ key: "u0", glslType: "float", default: 0.25 }],
        glsl: "if (uPassIndex == 0) c = c * (0.5 + u0); else if (gl_FragCoord.x < 16.0) c += vec3(0.03125) * u0;",
        ...kept(k0),
      },
      {
        iterations: count("n1", 3),
        uniforms: [{ key: "u1", glslType: "float", default: 0.0625 }],
        glsl: "if (gl_FragCoord.x < 16.0) c = c * 0.75 + vec3(u1); else c = vec3(-7.0);",
        region: "return ivec4(0, 0, 16, 1 << 20);",
        ...kept(k1),
      },
      {
        iterations: count("n2", 2),
        uniforms: [{ key: "u2", glslType: "float", default: 0.0625 }],
        glsl: last,
        ...kept(k2),
      },
    ],
    ...(shape.maskable ? { mask: { maskable: true as const } } : {}),
  };
}

const BAG = { [`${ID}.take`]: 1, [`${ID}.u0`]: 0.25, [`${ID}.u1`]: 0.0625, [`${ID}.u2`]: 0.0625 };

interface Scene {
  bag: Record<string, unknown>;
  processVersion?: number;
  masks?: Mask[];
}

function setScene(r: WebGLRenderer, scene: Scene): void {
  r.setContributedParams(scene.bag);
  r.setParams(identityParams({ processVersion: scene.processVersion ?? CURRENT_PROCESS_VERSION, masks: scene.masks ?? [] }));
}

/** A frame and the pass draws it took. */
function capture(r: WebGLRenderer): { frame: Frame; draws: number } {
  const before = r.renderDrawCounts.pass;
  const frame = r.captureFloatFrame();
  if (!frame) throw new Error("captureFloatFrame returned null");
  return { frame, draws: r.renderDrawCounts.pass - before };
}

/** A renderer that keeps checkpoints, as the live view's does, with SCENE set. */
function onRenderer<T>(
  stages: ProcessingStageContribution[],
  fn: (r: WebGLRenderer) => T,
  opts: WebGLRendererOpts = { keepPassCheckpoints: true },
): T {
  return withRenderer({ stages, pipeline: LINEAR_PROBE_PIPELINE, ...opts }, (r) => {
    r.setImage(SCENE);
    return fn(r);
  });
}

/** The frame a renderer that never drew before, and keeps no checkpoints, gives for `scene`. */
function fresh(stages: ProcessingStageContribution[], scene: Scene, image: SourceImage = SCENE, maxEdge?: number): Frame {
  return withRenderer({ stages, pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
    r.setImage(image, maxEdge);
    setScene(r, scene);
    return capture(r).frame;
  });
}

const differing = (a: Frame, b: Frame): number => {
  expect([a.width, a.height]).toEqual([b.width, b.height]);
  let n = 0;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) n++;
  return n;
};

afterEach(() => vi.restoreAllMocks());

describe("a stage with kept passes", () => {
  it("draws every pass the first time", () => {
    onRenderer([keepStage()], (r) => {
      setScene(r, { bag: BAG });
      expect(capture(r).draws).toBe(9);
      expect(capture(r).draws).toBe(0);
    });
  });

  it("draws only the last pass when its value changes, and gets a full run's result", () => {
    const scene = { bag: { ...BAG, [`${ID}.u2`]: 0.125 } };
    const resumed = onRenderer([keepStage()], (r) => {
      setScene(r, { bag: BAG });
      capture(r);
      setScene(r, scene);
      return capture(r);
    });
    expect(resumed.draws).toBe(2);
    expect(differing(resumed.frame, fresh([keepStage()], scene))).toBe(0);
  });

  it("draws the passes after the first when the middle one's value changes", () => {
    const scene = { bag: { ...BAG, [`${ID}.u1`]: 0.125 } };
    const resumed = onRenderer([keepStage()], (r) => {
      setScene(r, { bag: BAG });
      capture(r);
      setScene(r, scene);
      return capture(r);
    });
    expect(resumed.draws).toBe(5);
    expect(differing(resumed.frame, fresh([keepStage()], scene))).toBe(0);
  });

  it("draws the first pass again once nothing after it draws, since its last draw is then the result", () => {
    const stage = keepStage({ counted: true });
    const scene = { bag: { ...BAG, [`${ID}.n1`]: 0, [`${ID}.n2`]: 0 } };
    const alone = onRenderer([stage], (r) => {
      setScene(r, { bag: BAG });
      capture(r);
      setScene(r, scene);
      return capture(r);
    });
    expect(alone.draws).toBe(4);
    expect(differing(alone.frame, fresh([stage], scene))).toBe(0);
  });

  it("shows the garbage a whole draw of the middle pass would write", () => {
    const whole = keepStage();
    const passes = whole.passes ?? [];
    const unregioned = { ...whole, passes: passes.map((p, i) => (i === 1 ? { ...p, region: undefined } : p)) };
    expect(differing(fresh([unregioned], { bag: BAG }), fresh([whole], { bag: BAG }))).toBeGreaterThan(0);
  });

  it("goes back and forth between values, resuming each time", () => {
    const a = { bag: BAG };
    const b = { bag: { ...BAG, [`${ID}.u1`]: 0.125, [`${ID}.u2`]: 0.25 } };
    const frames = onRenderer([keepStage()], (r) => {
      setScene(r, a);
      capture(r);
      setScene(r, b);
      const first = capture(r);
      setScene(r, a);
      const back = capture(r);
      setScene(r, b);
      return [first, back, capture(r)];
    });
    expect(frames.map((f) => f.draws)).toEqual([5, 5, 5]);
    expect(differing(frames[0].frame, fresh([keepStage()], b))).toBe(0);
    expect(differing(frames[1].frame, fresh([keepStage()], a))).toBe(0);
  });

  it.each([
    ["the first pass's value", (r: WebGLRenderer) => setScene(r, { bag: { ...BAG, [`${ID}.u0`]: 0.5, [`${ID}.u2`]: 0.125 } })],
    ["the source", (r: WebGLRenderer) => {
      r.setImage(OTHER);
      setScene(r, { bag: { ...BAG, [`${ID}.u2`]: 0.125 } });
    }],
    ["the size", (r: WebGLRenderer) => {
      r.setImage(SCENE, 16);
      setScene(r, { bag: { ...BAG, [`${ID}.u2`]: 0.125 } });
    }],
    ["the process version", (r: WebGLRenderer) => setScene(r, { bag: { ...BAG, [`${ID}.u2`]: 0.125 }, processVersion: LEGACY_PROCESS_VERSION })],
  ])("draws every pass again when %s changes", (_, change) => {
    const draws = onRenderer([keepStage()], (r) => {
      setScene(r, { bag: BAG });
      capture(r);
      change(r);
      return capture(r).draws;
    });
    expect(draws).toBe(9);
  });

  it("draws every pass again when the image upstream of a reads-current stage changes", () => {
    const upstream: ProcessingStageContribution = {
      id: "test.keep-upstream",
      name: "Upstream",
      phase: "decode",
      glsl: "lin *= gain;",
      uniforms: [{ key: "gain", glslType: "float", default: 1 }],
    };
    const stages = [upstream, keepStage({ reads: "current" })];
    const scene = { bag: { ...BAG, "test.keep-upstream.gain": 1.25, [`${ID}.u2`]: 0.125 } };
    const changed = onRenderer(stages, (r) => {
      setScene(r, { bag: { ...BAG, "test.keep-upstream.gain": 1.5 } });
      capture(r);
      setScene(r, scene);
      return capture(r);
    });
    expect(changed.draws).toBe(9);
    expect(differing(changed.frame, fresh(stages, scene))).toBe(0);
  });

  it("fetches its own input on a resumed draw, after a later stage has fetched its own", () => {
    const later: ProcessingStageContribution = {
      id: "test.keep-later",
      name: "Later",
      phase: "scene-linear",
      priority: 200,
      reads: "current",
      glsl: "if (take > 0.5) lin = stageResult;",
      uniforms: [{ key: "take", glslType: "float", default: 0 }],
      passes: [{ iterations: 2, glsl: "c = fetchInput(ivec2(gl_FragCoord.xy)) * 0.5 + vec3(0.125);" }],
    };
    const stages = [keepStage({ reads: "current", fetches: true, priority: 100 }), later];
    const scene = { bag: { ...BAG, "test.keep-later.take": 1, [`${ID}.u2`]: 0.5 } };
    const resumed = onRenderer(stages, (r) => {
      setScene(r, { bag: { ...BAG, "test.keep-later.take": 1, [`${ID}.u2`]: 0.25 } });
      capture(r);
      setScene(r, scene);
      return capture(r);
    });
    expect(resumed.draws).toBe(2 + 2);
    expect(differing(resumed.frame, fresh(stages, scene))).toBe(0);
  });

  it("resumes on an input resampled from a larger source, which it draws again", () => {
    const stage = keepStage({ fetches: true });
    const scene = { bag: { ...BAG, [`${ID}.u2`]: 0.5 } };
    const resumed = withRenderer({ stages: [stage], pipeline: LINEAR_PROBE_PIPELINE, keepPassCheckpoints: true }, (r) => {
      r.setImage(BIG, W);
      setScene(r, { bag: { ...BAG, [`${ID}.u2`]: 0.25 } });
      capture(r);
      const splits = r.renderDrawCounts.split;
      setScene(r, scene);
      const frame = capture(r);
      return { ...frame, inputs: r.renderDrawCounts.split - splits };
    });
    expect(resumed.frame.width).toBe(W);
    expect({ draws: resumed.draws, inputs: resumed.inputs }).toEqual({ draws: 2, inputs: 1 });
    expect(differing(resumed.frame, fresh([stage], scene, BIG, W))).toBe(0);
  });

  it("keeps nothing for a kept last pass, which its cached result already covers", () => {
    const lastOnly = keepStage({ keep: [false, false, true] });
    const { gl } = glHarness();
    const textures = (stage: ProcessingStageContribution) => {
      const tally = trackGlObjects(gl);
      try {
        return onRenderer([stage], (r) => {
          setScene(r, { bag: BAG });
          capture(r);
          setScene(r, { bag: { ...BAG, [`${ID}.u2`]: 0.125 } });
          const draws = capture(r).draws;
          return { draws, textures: tally.created.texture };
        });
      } finally {
        tally.restore();
      }
    };
    expect(textures(lastOnly)).toEqual(textures(keepStage({ keep: [false, false, false] })));
    expect(textures(lastOnly).draws).toBe(9);
  });
});

describe("kept passes in masks", () => {
  const right: MaskComponent = { id: "right", kind: "linear", mode: "add", invert: false, linear: { x0: 0.5, y0: 0, x1: 0.5001, y1: 0 } };
  const left: MaskComponent = { ...right, id: "left", invert: true };
  const mask = (id: string, component: MaskComponent, u2: number): Mask => ({
    id,
    name: id,
    visible: true,
    invert: false,
    opacity: 100,
    adj: defaultMaskAdjustments(),
    panels: [],
    components: [component],
    bag: { ...BAG, [`${ID}.u2`]: u2 },
  });
  const stages = () => [...masksStagesFor(CURRENT_PROCESS_VERSION), keepStage({ maskable: true })];

  it("keep checkpoints per mask, and each resumes", () => {
    const start = [mask("a", left, 0.0625), mask("b", right, 0.125)];
    const first = [mask("a", left, 0.25), mask("b", right, 0.125)];
    const both = [mask("a", left, 0.25), mask("b", right, 0.5)];
    const frames = onRenderer(stages(), (r) => {
      setScene(r, { bag: {}, masks: start });
      const full = capture(r);
      setScene(r, { bag: {}, masks: first });
      const one = capture(r);
      setScene(r, { bag: {}, masks: both });
      return [full, one, capture(r)];
    });
    expect(frames.map((f) => f.draws)).toEqual([18, 2, 2]);
    expect(differing(frames[2].frame, fresh(stages(), { bag: {}, masks: both }))).toBe(0);
  });
});

describe("a kept pass's checkpoint", () => {
  const { gl } = glHarness();

  it("is kept only by a renderer asked to, as the live view's is: an export draws each photo once", () => {
    const tally = trackGlObjects(gl);
    const exported = (stage: ProcessingStageContribution) =>
      onRenderer(
        [stage],
        (r) => {
          setScene(r, { bag: BAG });
          capture(r);
          setScene(r, { bag: { ...BAG, [`${ID}.u2`]: 0.125 } });
          return { draws: capture(r).draws, live: tally.live.texture };
        },
        {},
      );
    try {
      expect(exported(keepStage())).toEqual(exported(keepStage({ keep: [false, false, false] })));
      expect(exported(keepStage()).draws).toBe(9);
    } finally {
      tally.restore();
    }
  });

  /** Live textures after each step of `steps`, run on one renderer. */
  function liveTextures(stage: ProcessingStageContribution, steps: ((r: WebGLRenderer) => void)[]): number[] {
    const tally = trackGlObjects(gl);
    try {
      return onRenderer([stage], (r) =>
        steps.map((step) => {
          step(r);
          r.render();
          return tally.live.texture;
        }),
      );
    } finally {
      tally.restore();
    }
  }

  it("is freed with the source, and the stage's last result, once the stage goes idle", () => {
    const steps = [
      (r: WebGLRenderer) => setScene(r, { bag: BAG }),
      (r: WebGLRenderer) => r.setImage(OTHER),
      (r: WebGLRenderer) => {
        r.setImage(SCENE);
        setScene(r, { bag: {} });
      },
    ];
    const kept = liveTextures(keepStage(), steps);
    const plain = liveTextures(keepStage({ keep: [false, false, false] }), steps);
    expect(kept.map((n, i) => n - plain[i])).toEqual([2, 2, 0]);
  });

  it("is freed when a later pass fails to compile, and the stage is taken out", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const steps = [(r: WebGLRenderer) => setScene(r, { bag: BAG })];
    const kept = liveTextures(keepStage({ broken: true }), steps);
    const plain = liveTextures(keepStage({ broken: true, keep: [false, false, false] }), steps);
    expect(kept).toEqual(plain);
  });

  it("isn't kept when it can't be allocated, and the stage runs whole, warning once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const stage = keepStage({ counted: true });
    const scene = { bag: { ...BAG, [`${ID}.u2`]: 0.125 } };
    const { createFramebuffer, checkFramebufferStatus } = gl;
    const refused = new Set<WebGLFramebuffer>();
    const frames = onRenderer([stage], (r) => {
      // Nothing follows pass 0 yet, so it keeps nothing.
      setScene(r, { bag: { ...BAG, [`${ID}.n1`]: 0, [`${ID}.n2`]: 0 } });
      r.render();
      gl.createFramebuffer = () => {
        const fbo = createFramebuffer.call(gl);
        refused.add(fbo);
        return fbo;
      };
      gl.checkFramebufferStatus = (target: number) =>
        refused.has(gl.getParameter(gl.FRAMEBUFFER_BINDING)) ? gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT : checkFramebufferStatus.call(gl, target);
      try {
        setScene(r, { bag: BAG });
        r.render();
      } finally {
        gl.createFramebuffer = createFramebuffer;
        gl.checkFramebufferStatus = checkFramebufferStatus;
      }
      setScene(r, scene);
      return [capture(r), capture(r)];
    });
    expect(refused.size).toBeGreaterThan(0);
    expect(frames.map((f) => f.draws)).toEqual([9, 0]);
    expect(differing(frames[0].frame, fresh([stage], scene))).toBe(0);
    expect(warn.mock.calls.filter(([m]) => String(m).includes(`'${ID}'`) && String(m).includes("checkpoint"))).toHaveLength(1);
  });
});
