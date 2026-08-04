// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Shared rig for the *.webgl.test.ts suites: one context per test file, program
// building that reports GLSL logs, and a linear read-back path for pixel
// assertions. Imported only by tests, so it never reaches the app bundle.

import type { DevelopParams } from "@/catalog/types";
import { DEFAULT_DEVELOP_PARAMS } from "@/catalog/types";
import type { ResolvedPipeline } from "@/extensions/pipelines";
import type { ProcessingStageContribution, SafelightAPI } from "@/extensions/types";
import { BUILTIN_EXTENSIONS } from "@/extensions/builtin";
import { WebGLRenderer, type WebGLRendererOpts } from "./renderer";

export interface GlHarness {
  canvas: HTMLCanvasElement;
  gl: WebGL2RenderingContext;
}

let harness: GlHarness | null = null;

/** The one context every test in a file shares. Contexts are a scarce browser
 *  resource — Chromium silently drops the oldest once a page holds ~16 — and a
 *  canvas hands the same context to every getContext call, so renderers built
 *  through `withRenderer` all bind to this one instead of allocating their own. */
export function glHarness(): GlHarness {
  if (harness) return harness;
  const canvas = document.createElement("canvas");
  // Must match WebGLRenderer's own request: getContext ignores the attributes
  // once a context exists for the canvas, so mismatched flags here would
  // silently strip preserveDrawingBuffer from every renderer sharing it.
  const gl = canvas.getContext("webgl2", {
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
  });
  if (!gl) throw new Error("WebGL2 unavailable");
  harness = { canvas, gl };
  return harness;
}

export interface ProgramBuild {
  program: WebGLProgram | null;
  /** The failing stage's info log, or null when the program compiled and
   *  linked. Tests assert on this rather than a boolean so a GLSL break shows
   *  the driver's diagnostic in the failure message. */
  error: string | null;
}

function compile(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader | string {
  const shader = gl.createShader(type);
  if (!shader) return "createShader returned null";
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  const log = gl.getShaderInfoLog(shader) ?? "(no log)";
  gl.deleteShader(shader);
  return log;
}

/** Compile + link one program, pinning the attribute locations the renderer
 *  pins so the link reflects what the app actually builds. */
export function buildProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): ProgramBuild {
  const vs = compile(gl, gl.VERTEX_SHADER, vertexSource);
  if (typeof vs === "string") return { program: null, error: `vertex shader: ${vs}` };
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
  if (typeof fs === "string") {
    gl.deleteShader(vs);
    return { program: null, error: `fragment shader: ${fs}` };
  }
  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.bindAttribLocation(program, 0, "aPos");
  gl.bindAttribLocation(program, 1, "aUv");
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? "(no log)";
    gl.deleteProgram(program);
    return { program: null, error: `link: ${log}` };
  }
  return { program, error: null };
}

export function releaseProgram(gl: WebGL2RenderingContext, build: ProgramBuild): void {
  if (build.program) gl.deleteProgram(build.program);
}

/** Build a renderer on the shared canvas, hand it to `fn`, and dispose it. */
export function withRenderer<T>(
  opts: WebGLRendererOpts | undefined,
  fn: (renderer: WebGLRenderer) => T,
): T {
  const renderer = new WebGLRenderer(glHarness().canvas, opts);
  try {
    return fn(renderer);
  } finally {
    renderer.dispose();
  }
}

/** null when every program these options imply compiled and linked; otherwise
 *  the info log the renderer threw with. */
export function rendererBuildError(opts?: WebGLRendererOpts): string | null {
  try {
    withRenderer(opts, () => undefined);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** The processing stages the shipped app registers (vignette, grain and the
 *  built-in denoiser). They live inside the "core" built-in extension's
 *  activate(), so the only way to reach the real GLSL is to run it against a
 *  recording API — the alternative, a hand-copied duplicate, would drift. */
export function builtinStages(): ProcessingStageContribution[] {
  const core = BUILTIN_EXTENSIONS.find((e) => e.id === "core");
  if (!core) throw new Error("no core built-in extension");
  const stages: ProcessingStageContribution[] = [];
  const recorder = new Proxy({} as SafelightAPI, {
    get: (_target, prop) =>
      prop === "registerProcessingStage"
        ? (stage: ProcessingStageContribution) => void stages.push(stage)
        : () => undefined,
  });
  core.activate(recorder);
  return stages;
}

export function builtinStage(id: string): ProcessingStageContribution {
  const stage = builtinStages().find((s) => s.id === id);
  if (!stage) throw new Error(`no built-in stage ${id}`);
  return stage;
}

export interface FloatImage {
  kind: "float";
  data: Float32Array;
  width: number;
  height: number;
}

/** A scene-linear source in the shape setImage's float (RAW) path takes. `texel`
 *  is called in top-down row order, matching the orientation captureFloatFrame
 *  reads back. */
export function floatImage(
  width: number,
  height: number,
  texel: (x: number, y: number) => readonly [number, number, number],
): FloatImage {
  const data = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = texel(x, y);
      const o = (y * width + x) * 4;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 1;
    }
  }
  return { kind: "float", data, width, height };
}

/** The shipping defaults carry capture sharpening (25) and colour NR (25), so
 *  they are not an identity render. Pixel assertions start from this instead. */
export function identityParams(over: Partial<DevelopParams> = {}): DevelopParams {
  return { ...DEFAULT_DEVELOP_PARAMS, sharpening: 0, colorNR: 0, ...over };
}

/** A display transform that hands the scene-linear working colour straight to
 *  the framebuffer and owns the baseline, so neither the RAW base curve nor the
 *  Adobe Color LUT is composed in. Everything between `lin` and the output is
 *  then identity at default params, which makes a read-back pixel the linear
 *  value the tone chain produced — the only way to assert on linear-light
 *  behaviour (exposure in stops) without inverting a tone curve in the test. */
export const LINEAR_PROBE_PIPELINE: ResolvedPipeline = {
  id: "test.linear-probe",
  glsl: "vec3 pipelineToDisplay(vec3 lin) { return lin; }",
  skipBaseCurve: true,
  sig: "test.linear-probe",
};

export interface Frame {
  data: Float32Array;
  width: number;
  height: number;
}

/** RGB of one top-down pixel of a captureFloatFrame result. */
export function pixelAt(frame: Frame, x: number, y: number): [number, number, number] {
  const o = (y * frame.width + x) * 4;
  return [frame.data[o], frame.data[o + 1], frame.data[o + 2]];
}

/** Read-back tolerance. The tone-curve LUT is a 256-entry 8-bit texture sampled
 *  with LINEAR filtering, so even an identity curve round-trips with ~1/512 of
 *  error, and the RGBA16F capture target adds half-float quantisation on top. */
export const PIXEL_TOLERANCE = 0.005;

export interface GlObjectCounts {
  texture: number;
  framebuffer: number;
  buffer: number;
  program: number;
  shader: number;
  vertexArray: number;
}

export interface GlObjectTally {
  /** Objects created but not yet deleted, per family. */
  live: GlObjectCounts;
  restore(): void;
}

/** Count GL object allocations against frees so a suite can assert that a
 *  renderer's dispose() gives everything back. A leaked context-level object
 *  outlives the renderer and the browser's object budget is finite, so this is
 *  the failure mode a `gl.getError()` check cannot see. */
export function trackGlObjects(gl: WebGL2RenderingContext): GlObjectTally {
  const live: GlObjectCounts = {
    texture: 0,
    framebuffer: 0,
    buffer: 0,
    program: 0,
    shader: 0,
    vertexArray: 0,
  };
  const original = {
    createTexture: gl.createTexture,
    deleteTexture: gl.deleteTexture,
    createFramebuffer: gl.createFramebuffer,
    deleteFramebuffer: gl.deleteFramebuffer,
    createBuffer: gl.createBuffer,
    deleteBuffer: gl.deleteBuffer,
    createProgram: gl.createProgram,
    deleteProgram: gl.deleteProgram,
    createShader: gl.createShader,
    deleteShader: gl.deleteShader,
    createVertexArray: gl.createVertexArray,
    deleteVertexArray: gl.deleteVertexArray,
  };

  // Wrap each create/delete pair so the count follows the object's lifetime.
  // Deleting null is a legal no-op in GL, so it must not decrement.
  function counted<T extends object>(
    create: () => T,
    destroy: (object: T | null) => void,
    family: keyof GlObjectCounts,
  ): { create: () => T; destroy: (object: T | null) => void } {
    return {
      create: () => {
        live[family]++;
        return create();
      },
      destroy: (object) => {
        if (object) live[family]--;
        destroy(object);
      },
    };
  }

  const textures = counted(
    () => original.createTexture.call(gl),
    (t: WebGLTexture | null) => original.deleteTexture.call(gl, t),
    "texture",
  );
  gl.createTexture = textures.create;
  gl.deleteTexture = textures.destroy;

  const framebuffers = counted(
    () => original.createFramebuffer.call(gl),
    (f: WebGLFramebuffer | null) => original.deleteFramebuffer.call(gl, f),
    "framebuffer",
  );
  gl.createFramebuffer = framebuffers.create;
  gl.deleteFramebuffer = framebuffers.destroy;

  const buffers = counted(
    () => original.createBuffer.call(gl),
    (b: WebGLBuffer | null) => original.deleteBuffer.call(gl, b),
    "buffer",
  );
  gl.createBuffer = buffers.create;
  gl.deleteBuffer = buffers.destroy;

  const programs = counted(
    () => original.createProgram.call(gl),
    (p: WebGLProgram | null) => original.deleteProgram.call(gl, p),
    "program",
  );
  gl.createProgram = programs.create;
  gl.deleteProgram = programs.destroy;

  const arrays = counted(
    () => original.createVertexArray.call(gl),
    (v: WebGLVertexArrayObject | null) => original.deleteVertexArray.call(gl, v),
    "vertexArray",
  );
  gl.createVertexArray = arrays.create;
  gl.deleteVertexArray = arrays.destroy;

  // createShader takes the shader type, so it doesn't fit the pair above.
  gl.createShader = (type: number) => {
    live.shader++;
    return original.createShader.call(gl, type);
  };
  gl.deleteShader = (shader: WebGLShader | null) => {
    if (shader) live.shader--;
    original.deleteShader.call(gl, shader);
  };

  return {
    live,
    restore() {
      Object.assign(gl, original);
    },
  };
}

/** Clear any error left over from an earlier test so the next getError reads
 *  only what the code under test raised. */
export function drainGlErrors(gl: WebGL2RenderingContext): void {
  while (gl.getError() !== gl.NO_ERROR) {
    /* GL keeps one flag per error code; loop until the queue is empty. */
  }
}
