// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The Library histogram and export draw on the window's thread, where building
// the develop program at the first frame held the window still for up to a
// second. prepareProgramAsync has the driver build it while the thread goes on;
// prepareProgram and the frame after it then find it built, or meet its failure
// as they always have.

import { describe, expect, it } from "vitest";
import type { ProcessingStageContribution } from "@/extensions/types";
import { WebGLRenderer, type QuarantinedStage, type WebGLRendererOpts } from "./renderer";
import {
  LINEAR_PROBE_PIPELINE,
  deriveWithoutSettings,
  differing,
  floatImage,
  glHarness,
  identityParams,
  liveFrame,
} from "./webgl.test-support";

const SOURCE = floatImage(8, 8, (x, y) => [x / 8, y / 8, 0.3]);
const PARAMS = identityParams();
const COMPLETION_STATUS_KHR = 0x91b1;

const stage = (id: string, glsl: string): ProcessingStageContribution => ({
  id,
  name: id,
  phase: "scene-linear",
  glsl,
  uniforms: [],
});
const DOUBLE_RED = stage("acme.red", "lin.r *= 2.0;");
const BROKEN = stage("acme.broken", "lin = lin *;");

/** withRenderer for a test that awaits: the renderer outlives `fn`'s promise. */
async function withAsyncRenderer<T>(opts: WebGLRendererOpts, fn: (r: WebGLRenderer) => Promise<T>): Promise<T> {
  const renderer = new WebGLRenderer(glHarness().canvas, { derive: deriveWithoutSettings, ...opts });
  try {
    return await fn(renderer);
  } finally {
    renderer.dispose();
  }
}

/** `fn` on a driver that builds in parallel (KHR_parallel_shader_compile) and
 *  says each program is unfinished `busyPolls` times before it is done.
 *  SwiftShader has no such extension, so a stand-in answers for it. `log`
 *  holds each answer, "busy" or "done", and each COMPILE_STATUS and
 *  LINK_STATUS read, which waits for the driver, in order. */
async function onParallelDriver<T>(busyPolls: number, fn: (log: string[]) => Promise<T>): Promise<T> {
  const { gl } = glHarness();
  const { getExtension, getProgramParameter, getShaderParameter } = gl;
  const extension = getExtension.bind(gl);
  const log: string[] = [];
  const polls = new Map<WebGLProgram, number>();
  gl.getExtension = ((name: string) =>
    name === "KHR_parallel_shader_compile" ? { COMPLETION_STATUS_KHR } : extension(name)) as typeof gl.getExtension;
  gl.getProgramParameter = (program: WebGLProgram, pname: number): unknown => {
    if (pname === COMPLETION_STATUS_KHR) {
      const n = (polls.get(program) ?? 0) + 1;
      polls.set(program, n);
      log.push(n > busyPolls ? "done" : "busy");
      return n > busyPolls;
    }
    if (pname === gl.LINK_STATUS) log.push("LINK_STATUS");
    return getProgramParameter.call(gl, program, pname);
  };
  gl.getShaderParameter = (shader: WebGLShader, pname: number): unknown => {
    if (pname === gl.COMPILE_STATUS) log.push("COMPILE_STATUS");
    return getShaderParameter.call(gl, shader, pname);
  };
  try {
    return await fn(log);
  } finally {
    gl.getExtension = getExtension;
    gl.getProgramParameter = getProgramParameter;
    gl.getShaderParameter = getShaderParameter;
  }
}

/** How many shaders `fn` compiles. */
function compiles(fn: () => void): number {
  const { gl } = glHarness();
  const { compileShader } = gl;
  let n = 0;
  gl.compileShader = (shader: WebGLShader): void => {
    n++;
    compileShader.call(gl, shader);
  };
  try {
    fn();
  } finally {
    gl.compileShader = compileShader;
  }
  return n;
}

describe("prepareProgramAsync", () => {
  it("waits on no build status until the driver is done, and leaves the frame nothing to build", async () => {
    await onParallelDriver(3, (log) =>
      withAsyncRenderer({ stages: [DOUBLE_RED], pipeline: LINEAR_PROBE_PIPELINE }, async (renderer) => {
        renderer.setImage(SOURCE);
        renderer.setParams(PARAMS);
        await renderer.prepareProgramAsync(PARAMS.processVersion);
        expect(log).toEqual(["busy", "busy", "busy", "done", "COMPILE_STATUS", "COMPILE_STATUS", "LINK_STATUS"]);
        expect(
          compiles(() => {
            renderer.prepareProgram(PARAMS.processVersion);
            renderer.render();
          }),
        ).toBe(0);
      }),
    );
  });

  it("draws the frame a program built at the frame draws", async () => {
    const opts = { stages: [DOUBLE_RED], pipeline: LINEAR_PROBE_PIPELINE };
    const prepared = await onParallelDriver(1, () =>
      withAsyncRenderer(opts, async (renderer) => {
        renderer.setImage(SOURCE);
        renderer.setParams(PARAMS);
        await renderer.prepareProgramAsync(PARAMS.processVersion);
        return liveFrame(renderer);
      }),
    );
    const atFrame = await withAsyncRenderer(opts, async (renderer) => {
      renderer.setImage(SOURCE);
      renderer.setParams(PARAMS);
      return liveFrame(renderer);
    });
    expect(differing(prepared, atFrame)).toBe(0);
  });

  it("leaves a stage that can't build to prepareProgram, which draws without it", async () => {
    const reported: QuarantinedStage[] = [];
    const opts = {
      stages: [DOUBLE_RED, BROKEN],
      pipeline: LINEAR_PROBE_PIPELINE,
      onStageQuarantined: (q: QuarantinedStage) => reported.push(q),
    };
    const logError = console.error;
    console.error = () => {};
    try {
      await onParallelDriver(1, () =>
        withAsyncRenderer(opts, async (renderer) => {
          renderer.setImage(SOURCE);
          renderer.setParams(PARAMS);
          await expect(renderer.prepareProgramAsync(PARAMS.processVersion)).resolves.toBeUndefined();
          expect(reported).toEqual([]);
          renderer.prepareProgram(PARAMS.processVersion);
          expect(reported.map((q) => q.stageId)).toEqual(["acme.broken"]);
        }),
      );
    } finally {
      console.error = logError;
    }
  });

  // Where a build can't be asked about, it is left to prepareProgram as before.
  it("builds nothing on a driver that can't say when a build is done", async () => {
    const { gl } = glHarness();
    const { getExtension } = gl;
    const extension = getExtension.bind(gl);
    gl.getExtension = ((name: string) =>
      name === "KHR_parallel_shader_compile" ? null : extension(name)) as typeof gl.getExtension;
    try {
      await withAsyncRenderer({ stages: [DOUBLE_RED], pipeline: LINEAR_PROBE_PIPELINE }, async (renderer) => {
        renderer.setParams(PARAMS);
        let prepared: Promise<void> | null = null;
        expect(compiles(() => (prepared = renderer.prepareProgramAsync(PARAMS.processVersion)))).toBe(0);
        await prepared;
      });
    } finally {
      gl.getExtension = getExtension;
    }
  });
});
