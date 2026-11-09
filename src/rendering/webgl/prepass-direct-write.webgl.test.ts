// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A stage's last draw renders straight into its result: its own target on the
// unit path, its layer of the shared array on the layered one. Copying the
// ping-pong result across cost a full-size blit every time a prepass reran,
// which is every tick of a prepass-driven slider.

import { afterEach, describe, expect, it } from "vitest";
import { CURRENT_PROCESS_VERSION, type DevelopParams } from "@/catalog/types";
import type { ProcessingStageContribution } from "@/extensions/types";
import type { WebGLRenderer } from "./renderer";
import {
  LINEAR_PROBE_PIPELINE,
  floatImage,
  glHarness,
  identityParams,
  pixelAt,
  withRenderer,
} from "./webgl.test-support";

const STEP = 0.02;
const BASE = 0.1;
const SOURCE = floatImage(8, 8, () => [BASE, BASE, BASE]);
const V1 = identityParams();
const V2 = identityParams({ processVersion: CURRENT_PROCESS_VERSION });
// Two samplers past the develop shader's six: three stages take the shared array.
const FEW_SAMPLERS = 8;

type Shape = "single" | "chain";

// Every value is a dyadic fraction, so the half-float result is exact and a
// stage can test for it: it adds STEP to the frame only when its result reads
// `want`. `single` draws once; `chain` draws `base`, then adds 1/16 three times.
function stage(i: number, shape: Shape): ProcessingStageContribution {
  const single = { glsl: "c = vec3(base);", uniforms: [{ key: "base", glslType: "float" as const, default: 0.125 }] };
  const chain = [
    single,
    { glsl: "c = readPrev(vUv) + vec3(0.0625);", iterations: 3 },
  ];
  return {
    id: `direct-${i}.test`,
    name: `Direct ${i}`,
    phase: "scene-linear",
    priority: 10 + i,
    glsl: "if (take > 0.5 && abs(stageResult.r - want) < 0.001) lin += vec3(0.02);",
    uniforms: [
      { key: "take", glslType: "float", default: 0 },
      { key: "want", glslType: "float", default: 0 },
    ],
    passes: shape === "single" ? [single] : chain,
  };
}

const bag = (i: number, base: number, shape: Shape): Record<string, number> => ({
  [`direct-${i}.test.take`]: 1,
  [`direct-${i}.test.base`]: base,
  [`direct-${i}.test.want`]: shape === "single" ? base : base + 0.1875,
});

function counting(gl: WebGL2RenderingContext) {
  const original = gl.blitFramebuffer;
  const count = { blits: 0 };
  gl.blitFramebuffer = (...args: Parameters<typeof original>) => {
    count.blits++;
    Reflect.apply(original, gl, args);
  };
  return {
    count,
    restore() {
      gl.blitFramebuffer = original;
    },
  };
}

/** Flags any draw into a texture one of the program's samplers is bound to. */
function watchFeedback(gl: WebGL2RenderingContext) {
  const original = gl.drawArrays;
  const watch = { draws: 0, loops: [] as string[] };
  gl.drawArrays = (...args: Parameters<typeof original>) => {
    if (gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING) !== null) {
      watch.draws++;
      const written: unknown = gl.getFramebufferAttachmentParameter(
        gl.DRAW_FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.FRAMEBUFFER_ATTACHMENT_OBJECT_NAME,
      );
      const program: WebGLProgram = gl.getParameter(gl.CURRENT_PROGRAM);
      const active: number = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
      const unit: number = gl.getParameter(gl.ACTIVE_TEXTURE);
      for (let u = 0; u < active; u++) {
        const info = gl.getActiveUniform(program, u);
        const loc = info && gl.getUniformLocation(program, info.name);
        if (!info || !loc) continue;
        const array = info.type === gl.SAMPLER_2D_ARRAY;
        if (info.type !== gl.SAMPLER_2D && !array) continue;
        gl.activeTexture(gl.TEXTURE0 + (gl.getUniform(program, loc) as number));
        const bound: unknown = gl.getParameter(array ? gl.TEXTURE_BINDING_2D_ARRAY : gl.TEXTURE_BINDING_2D);
        if (written !== null && bound === written) watch.loops.push(info.name);
      }
      gl.activeTexture(unit);
    }
    Reflect.apply(original, gl, args);
  };
  return {
    watch,
    restore() {
      gl.drawArrays = original;
    },
  };
}

const level = (r: WebGLRenderer): number => pixelAt(r.captureFloatFrame()!, 4, 4)[1];
const steps = (idle: number, lit: number): number => Math.round((lit - idle) / STEP);

function onRenderer<T>(stages: ProcessingStageContribution[], params: DevelopParams, fn: (r: WebGLRenderer) => T): T {
  return withRenderer({ stages, pipeline: LINEAR_PROBE_PIPELINE }, (r) => {
    r.setImage(SOURCE);
    r.setParams(params);
    return fn(r);
  });
}

describe.each([
  ["unit target", V1, 1, false],
  ["array layer", V2, 3, true],
] as const)("a stage's last draw on the %s", (_name, params, stageCount, layered) => {
  let restore: (() => void)[] = [];

  afterEach(() => {
    for (const r of restore.reverse()) r();
    restore = [];
  });

  function setup(): { stages: ProcessingStageContribution[]; shape: (s: Shape) => ProcessingStageContribution[] } {
    if (layered) {
      const { gl } = glHarness();
      const original = gl.getParameter;
      gl.getParameter = (pname: number) =>
        pname === gl.MAX_TEXTURE_IMAGE_UNITS ? FEW_SAMPLERS : Reflect.apply(original, gl, [pname]);
      restore.push(() => {
        gl.getParameter = original;
      });
    }
    const shape = (s: Shape) => Array.from({ length: stageCount }, (_, i) => stage(i, s));
    return { stages: shape("single"), shape };
  }

  for (const shape of ["single", "chain"] as const) {
    it(`copies nothing and keeps the result exact for a ${shape} stage`, () => {
      const { shape: make } = setup();
      const { gl } = glHarness();
      onRenderer(make(shape), params, (r) => {
        const idle = level(r);
        const blits = counting(gl);
        restore.push(blits.restore);
        r.setContributedParams(bag(0, 0.125, shape));
        expect(steps(idle, level(r))).toBe(1);
        // A rerun with a different value: the dragged-slider case.
        r.setContributedParams(bag(0, 0.25, shape));
        expect(steps(idle, level(r))).toBe(1);
        expect(blits.count.blits).toBe(0);
      });
    });
  }

  it("never samples the texture it writes", () => {
    const { shape: make } = setup();
    const { gl } = glHarness();
    onRenderer(make("chain"), params, (r) => {
      level(r);
      const feedback = watchFeedback(gl);
      restore.push(feedback.restore);
      r.setContributedParams(bag(0, 0.5, "chain"));
      expect(steps(0, level(r))).toBeGreaterThanOrEqual(0);
      expect(feedback.watch.draws).toBeGreaterThanOrEqual(4);
      expect(feedback.watch.loops).toEqual([]);
    });
  });

  it("redraws nothing once the result is cached", () => {
    const { shape: make } = setup();
    onRenderer(make("chain"), params, (r) => {
      r.setContributedParams(bag(0, 0.125, "chain"));
      level(r);
      const before = r.renderDrawCounts.pass;
      level(r);
      expect(r.renderDrawCounts.pass).toBe(before);
    });
  });
});
