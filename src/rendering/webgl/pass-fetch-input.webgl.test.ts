// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// fetchInput(texel) in a pass hands over, exactly, what the stage's first draw
// reads at that texel, on any draw of any pass: the source as the stage sees
// it, or for a reads-current stage the image up to the stage. Each pass here
// checks what it fetched against what it should be and writes 1 where they
// are equal, so the stage's inline shows the texels that weren't.

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { CURRENT_PROCESS_VERSION } from "@/catalog/types";
import type { ProcessingStageContribution, StagePass, StageSpace } from "@/extensions/types";
import { encodeHalf } from "@/raw/half-float";
import { toSpaceExpr } from "../stage-space";
import type { WebGLRenderer } from "./renderer";
import {
  LINEAR_PROBE_PIPELINE,
  floatImage,
  freshContext,
  glHarness,
  identityParams,
  trackGlObjects,
  withRenderer,
  type FreshContext,
  type Frame,
} from "./webgl.test-support";

const W = 64;
const H = 48;
const ID = "test.fetch-input";

/** Every texel differs from its neighbours, and every value is exact in a half float. */
const value = (x: number, y: number): [number, number, number] => [
  (x + 1) / 128,
  (y + 1) / 128,
  (((x * 7 + y * 3) % 32) + 1) / 64,
];
const SCENE = floatImage(W, H, value);
const PATTERN = `vec3 pat(ivec2 t) {
  return vec3(float(t.x + 1) / 128.0, float(t.y + 1) / 128.0, float((t.x * 7 + t.y * 3) % 32 + 1) / 64.0);
}`;
/** A permutation of the frame whose neighbours land far apart, so a filtered
 *  read of a texel there samples a coarser mip level. */
const SCRAMBLE = `ivec2 scramble(ivec2 t) { return ivec2((t.x * 17 + 5) % ${W}, (t.y * 13 + 7) % ${H}); }`;
const HERE = "ivec2(gl_FragCoord.xy)";

/** The inline: 0.05 where the result says the pass saw what it should, 0.8 where it didn't. */
const SHOW = "if (take > 0.5) lin = vec3(stageResult.r > 0.5 ? 0.05 : 0.8);";

function stage(passes: StagePass[], over: Partial<ProcessingStageContribution> = {}): ProcessingStageContribution {
  return {
    id: ID,
    name: "Fetch input",
    phase: "decode",
    glsl: SHOW,
    uniforms: [{ key: "take", glslType: "float", default: 0 }],
    passes,
    ...over,
  };
}

/** A pass that writes 1 where `got` equals `want` on its last draw, and
 *  scrambles the ping-pong on every draw before it. */
const checking = (got: string, want: string, draws = 1, helpers = ""): StagePass => ({
  iterations: draws,
  helpers: `${PATTERN}\n${SCRAMBLE}\n${helpers}`,
  glsl: `if (uPassIndex < uPassCount - 1) c = c * 3.0 + 1.0; else c = vec3(all(equal(${got}, ${want})) ? 1.0 : 0.0);`,
});

interface Drawn {
  frame: Frame;
  split: number;
  pass: number;
  textures: number;
}

function draw(
  stages: ProcessingStageContribution[],
  image: Parameters<WebGLRenderer["setImage"]>[0] = SCENE,
  maxEdge?: number,
): Drawn {
  const { gl } = glHarness();
  const tally = trackGlObjects(gl);
  try {
    return withRenderer({ stages, pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
      r.setImage(image, maxEdge);
      r.setParams(identityParams({ processVersion: CURRENT_PROCESS_VERSION }));
      r.setContributedParams({ [`${ID}.take`]: 1 });
      const before = r.renderDrawCounts;
      const frame = r.captureFloatFrame();
      if (!frame) throw new Error("captureFloatFrame returned null");
      const after = r.renderDrawCounts;
      return { frame, split: after.split - before.split, pass: after.pass - before.pass, textures: tally.created.texture };
    });
  } finally {
    tally.restore();
  }
}

/** The pixels whose pass saw something other than it should have. */
const mismatches = (f: Frame): number => {
  let n = 0;
  for (let i = 0; i < f.data.length; i += 4) if (f.data[i + 1] > 0.4) n++;
  return n;
};

const differing = (a: Frame, b: Frame): number => {
  expect(a.data.length).toBe(b.data.length);
  let n = 0;
  for (let i = 0; i < a.data.length; i++) if (a.data[i] !== b.data[i]) n++;
  return n;
};

afterEach(() => vi.restoreAllMocks());

describe("fetchInput for a stage reading the source at its own size", () => {
  const SCRAMBLED = `pat(scramble(${HERE}))`;

  it("reads the source exactly on the first draw", () => {
    const drawn = draw([stage([checking(`fetchInput(scramble(${HERE}))`, SCRAMBLED)])]);
    expect(drawn.frame.width).toBe(W);
    expect(mismatches(drawn.frame)).toBe(0);
  });

  it("reads it exactly on a later draw", () => {
    expect(mismatches(draw([stage([checking(`fetchInput(scramble(${HERE}))`, SCRAMBLED, 6)])]).frame)).toBe(0);
  });

  it("is what readSource can't be: readSource filters, and reads a blurred level there", () => {
    const uv = `(vec2(scramble(${HERE})) + 0.5) * uTexel`;
    expect(mismatches(draw([stage([checking(`readSource(${uv})`, SCRAMBLED, 6)])]).frame)).toBeGreaterThan(W * H / 2);
  });

  it("clamps texels outside the frame to its edge", () => {
    const outside = checking(`fetchInput(${HERE} - ivec2(${W}, ${H}))`, "pat(ivec2(0))");
    expect(mismatches(draw([stage([outside])]).frame)).toBe(0);
  });

  it("reads it in the stage's space", () => {
    const space: StageSpace = { encoding: "linear", primaries: "rec2020" };
    const converted = toSpaceExpr(space, "scene", `toLin(texelFetch(uSourceImage, ${HERE}, 0).rgb)`);
    const inSpace = draw([stage([checking(`fetchInput(${HERE})`, converted, 3)], { space })]);
    expect(mismatches(inSpace.frame)).toBe(0);
    const unconverted = draw([stage([checking(`fetchInput(${HERE})`, `toLin(texelFetch(uSourceImage, ${HERE}, 0).rgb)`, 3)], { space })]);
    expect(mismatches(unconverted.frame)).toBeGreaterThan(W * H / 2);
  });

  it("adds no draw and no target", () => {
    const plain = draw([stage([{ glsl: "c = vec3(1.0);", iterations: 3 }])]);
    const fetching = draw([stage([checking(`fetchInput(${HERE})`, `pat(${HERE})`, 3)])]);
    expect(mismatches(fetching.frame)).toBe(0);
    expect({ split: fetching.split, pass: fetching.pass, textures: fetching.textures }).toEqual({
      split: plain.split,
      pass: plain.pass,
      textures: plain.textures,
    });
  });
});

/** A cached preview twice the pass size: it is uploaded whole, so the passes
 *  draw it scaled down, and the scaled values aren't exact in a half float. */
const BIG = (() => {
  const scene = floatImage(W * 2, H * 2, (x, y) => value(x >> 1, y >> 1).map((v, i) => v + ((x + y + i) % 3) / 512) as [number, number, number]);
  return { kind: "float16" as const, data: encodeHalf(scene.data), width: scene.width, height: scene.height };
})();

describe("fetchInput for a stage reading a source larger than its passes", () => {
  const later = (channels: 3 | 4): StagePass =>
    channels === 4
      ? { channels, iterations: 3, glsl: `if (uPassIndex < uPassCount - 1) c = c * 3.0 + 1.0; else c = vec4(fetchInput(${HERE}), 1.0);` }
      : { iterations: 3, glsl: `if (uPassIndex < uPassCount - 1) c = c * 3.0 + 1.0; else c = fetchInput(${HERE});` };
  const first = (channels: 3 | 4): StagePass => (channels === 4 ? { channels, glsl: "c = c;" } : { glsl: "c = c;" });
  const SHOWN = "if (take > 0.5) lin = stageResult;";

  it.each([3, 4] as const)("reads what a %i-channel first draw reads", (channels) => {
    const read = draw([stage([first(channels)], { glsl: SHOWN })], BIG, W);
    const fetched = draw([stage([later(channels)], { glsl: SHOWN })], BIG, W);
    expect(read.frame.width).toBe(W);
    expect(differing(fetched.frame, read.frame)).toBe(0);
  });

  it("agrees with the first draw's own read to the precision the input is stored at", () => {
    const close = `vec3 f = fetchInput(${HERE}); c = vec3(all(lessThanEqual(abs(c - f), abs(c) / 2048.0 + 1e-7)) ? 1.0 : 0.0);`;
    expect(mismatches(draw([stage([{ glsl: close }])], BIG, W).frame)).toBe(0);
  });

  it("draws no input while every pass that fetches it draws 0 times", () => {
    const counted = (fetches: boolean) =>
      stage([{ glsl: "c = c;" }, { iterations: { key: "n", max: 2 }, glsl: fetches ? `c = fetchInput(${HERE});` : "c = c;" }], {
        glsl: SHOWN,
        uniforms: [{ key: "take", glslType: "float", default: 0 }, { key: "n", glslType: "float", default: 0 }],
      });
    const plain = draw([counted(false)], BIG, W);
    const idle = draw([counted(true)], BIG, W);
    expect({ split: idle.split, pass: idle.pass, textures: idle.textures }).toEqual({
      split: plain.split,
      pass: plain.pass,
      textures: plain.textures,
    });
  });

  it("draws the input once, into a target of its own", () => {
    const read = draw([stage([{ glsl: "c = c;", iterations: 3 }], { glsl: SHOWN })], BIG, W);
    const fetched = draw([stage([later(3)], { glsl: SHOWN })], BIG, W);
    expect({ split: fetched.split, pass: fetched.pass, textures: fetched.textures }).toEqual({
      split: read.split + 1,
      pass: read.pass,
      textures: read.textures + 1,
    });
  });
});

describe("fetchInput for a stage reading the current image", () => {
  const UPSTREAM: ProcessingStageContribution = {
    id: "test.fetch-input-upstream",
    name: "Upstream",
    phase: "decode",
    priority: 10,
    glsl: "lin += vec3(0.25);",
    uniforms: [],
  };
  // Draw 0 keeps its input in rgb, exactly; every draw compares what it
  // fetches with that and with the source plus 0.25, and clears alpha on a
  // difference. The last writes alpha out.
  const CARRIED: StagePass = {
    channels: 4,
    iterations: 7,
    helpers: PATTERN,
    glsl: `vec3 got = fetchInput(${HERE});
  if (uPassIndex == 0) c = vec4(c.rgb, 1.0);
  bool same = all(equal(got, c.rgb)) && all(equal(got, pat(${HERE}) + vec3(0.25)));
  c.a = same ? c.a : 0.0;
  if (uPassIndex == uPassCount - 1) c = vec4(vec3(c.a), 1.0);`,
  };

  it("hands every draw the image up to the stage, after the ping-pong has overwritten it", () => {
    const drawn = draw([UPSTREAM, stage([CARRIED], { reads: "current", priority: 20 })]);
    expect(drawn.split).toBe(1);
    expect(mismatches(drawn.frame)).toBe(0);
  });

  it("draws its split into the input target, at no extra draw", () => {
    const plain = draw([UPSTREAM, stage([{ channels: 4, iterations: 7, glsl: "c = vec4(1.0);" }], { reads: "current", priority: 20 })]);
    const fetching = draw([UPSTREAM, stage([CARRIED], { reads: "current", priority: 20 })]);
    expect({ split: fetching.split, pass: fetching.pass, textures: fetching.textures }).toEqual({
      split: plain.split,
      pass: plain.pass,
      textures: plain.textures + 1,
    });
  });
});

describe("fetchInput without float render targets", () => {
  let floatless: FreshContext | null = null;
  afterAll(() => {
    floatless?.release();
    floatless = null;
  });

  it("reads the source, with a warning, for a stage reading the current image", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    floatless ??= freshContext({ noFloat: true });
    const { canvas, gl } = floatless;
    const s = stage([checking(`fetchInput(${HERE})`, `pat(${HERE})`, 3)], { reads: "current" });
    const px = withRenderer(
      { stages: [s], pipeline: LINEAR_PROBE_PIPELINE },
      (r) => {
        r.setImage(SCENE);
        r.setParams(identityParams({ processVersion: CURRENT_PROCESS_VERSION }));
        r.setContributedParams({ [`${ID}.take`]: 1 });
        r.render();
        const raw = new Uint8Array(gl.drawingBufferWidth * gl.drawingBufferHeight * 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, raw);
        return raw;
      },
      canvas,
    );
    expect(px.length).toBe(W * H * 4);
    let wrong = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i + 1] > 128) wrong++;
    expect(wrong).toBe(0);
    expect(warn.mock.calls.some(([m]) => String(m).includes(`stage '${ID}' reads the current image`))).toBe(true);
  });
});

describe("fetchInput's input target", () => {
  const { gl } = glHarness();
  const FETCHED = "if (take > 0.5) lin = stageResult;";
  /** Fetches on its second pass once n is above 0, so a frame with n = 0 needs no input. */
  const counted = (glsl: string, over: Partial<ProcessingStageContribution> = {}) =>
    stage([{ glsl: "c = c;" }, { iterations: { key: "n", max: 2 }, helpers: PATTERN, glsl }], {
      glsl: FETCHED,
      uniforms: [{ key: "take", glslType: "float", default: 0 }, { key: "n", glslType: "float", default: 0 }],
      ...over,
    });

  /** The frame after a second render whose new targets the GPU refuses. */
  function refused(s: ProcessingStageContribution, image: Parameters<WebGLRenderer["setImage"]>[0], maxEdge?: number) {
    const quarantined: string[] = [];
    const { createFramebuffer, checkFramebufferStatus } = gl;
    const refusing = new Set<WebGLFramebuffer>();
    const frame = withRenderer(
      { stages: [s], pipeline: LINEAR_PROBE_PIPELINE, onStageQuarantined: (q) => quarantined.push(q.stageId) },
      (r) => {
        r.setImage(image, maxEdge);
        r.setParams(identityParams({ processVersion: CURRENT_PROCESS_VERSION }));
        r.setContributedParams({ [`${ID}.take`]: 1, [`${ID}.n`]: 0 });
        r.render();
        r.setContributedParams({ [`${ID}.take`]: 1, [`${ID}.n`]: 1 });
        gl.createFramebuffer = () => {
          const fbo = createFramebuffer.call(gl);
          refusing.add(fbo);
          return fbo;
        };
        gl.checkFramebufferStatus = (target: number) =>
          refusing.has(gl.getParameter(gl.FRAMEBUFFER_BINDING)) ? gl.FRAMEBUFFER_INCOMPLETE_ATTACHMENT : checkFramebufferStatus.call(gl, target);
        try {
          r.render();
        } finally {
          gl.createFramebuffer = createFramebuffer;
          gl.checkFramebufferStatus = checkFramebufferStatus;
        }
        const f = r.captureFloatFrame();
        if (!f) throw new Error("captureFloatFrame returned null");
        return f;
      },
    );
    return { frame, quarantined, refusals: refusing.size };
  }

  const inputWarnings = (warn: { mock: { calls: unknown[][] } }) =>
    warn.mock.calls.filter(([m]) => String(m).includes(`'${ID}'`) && String(m).includes("input")).length;

  it("once refused, leaves a stage reading a larger source on its nearest texel, warning once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const nearest = `toLin(texelFetch(uSourceImage, ${HERE} * 2 + 1, 0).rgb)`;
    const s = counted(`c = vec3(all(equal(fetchInput(${HERE}), ${nearest})) ? 0.2 : 0.7);`);
    const got = refused(s, BIG, W);
    expect(got.refusals).toBeGreaterThan(0);
    expect(got.quarantined).toEqual([]);
    expect(inputWarnings(warn)).toBe(1);
    let wrong = 0;
    for (let i = 0; i < got.frame.data.length; i += 4) if (got.frame.data[i + 1] > 0.45) wrong++;
    expect(wrong).toBe(0);
  });

  it("once refused, leaves a stage reading the current image on the source, as without float targets", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const glsl = `c = fetchInput(${HERE}) * 0.5 + vec3(0.125);`;
    const got = refused(counted(glsl, { reads: "current" }), SCENE);
    expect(got.quarantined).toEqual([]);
    expect(inputWarnings(warn)).toBe(1);
    const source = refused(counted(glsl), SCENE);
    expect(differing(got.frame, source.frame)).toBe(0);
  });

  it("hands the develop program its unit back after a stage's draws", () => {
    const pass: StagePass = {
      iterations: 3,
      uniforms: [{ key: "k", glslType: "float", default: 0.5 }],
      glsl: `c = fetchInput(${HERE}) * k;`,
    };
    const s = stage([pass], { reads: "current", glsl: FETCHED });
    // What unit 4 holds at each draw of the develop program in a rerun, which
    // allocates nothing: its split draw runs before the stage's passes lend
    // the unit, the frame's draw after.
    const seen: unknown[] = [];
    let watching = false;
    const { drawArrays } = gl;
    gl.drawArrays = (...args: Parameters<typeof drawArrays>) => {
      const program: WebGLProgram | null = gl.getParameter(gl.CURRENT_PROGRAM);
      if (watching && program && gl.getUniformLocation(program, "uImage")) {
        const active: number = gl.getParameter(gl.ACTIVE_TEXTURE);
        gl.activeTexture(gl.TEXTURE4);
        seen.push(gl.getParameter(gl.TEXTURE_BINDING_2D));
        gl.activeTexture(active);
      }
      Reflect.apply(drawArrays, gl, args);
    };
    try {
      withRenderer({ stages: [s], pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
        r.setImage(SCENE);
        r.setParams(identityParams({ processVersion: CURRENT_PROCESS_VERSION }));
        r.setContributedParams({ [`${ID}.take`]: 1 });
        r.render();
        watching = true;
        r.setContributedParams({ [`${ID}.take`]: 1, [`${ID}.k`]: 0.25 });
        r.render();
      });
    } finally {
      gl.drawArrays = drawArrays;
    }
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(new Set(seen).size).toBe(1);
  });
});
