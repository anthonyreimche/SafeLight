// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Shared rig for the *.webgl.test.ts suites: one context per test file, program
// building that reports GLSL logs, and a linear read-back path for pixel
// assertions. Imported only by tests, so it never reaches the app bundle.

import { afterEach, expect } from "vitest";
import type { DevelopParams } from "@/catalog/types";
import {
  CURRENT_PROCESS_VERSION,
  DEFAULT_DEVELOP_PARAMS,
  LEGACY_PROCESS_VERSION,
} from "@/catalog/types";
import type { ResolvedPipeline } from "@/extensions/pipelines";
import type { ProcessingStageContribution, SafelightAPI } from "@/extensions/types";
import { BUILTIN_EXTENSIONS } from "@/extensions/builtin";
import { CORE_EXTENSION_ID } from "@/extensions/core-extension";
import { useRegistry } from "@/extensions/registry";
import { buildIccProfile } from "@/rendering/color-space";
import { parseDisplayProfile, type MonitorTransform } from "@/rendering/display-profile";
import type { Vec3 } from "@/rendering/stage-space";
import { WebGLRenderer, type WebGLRendererOpts } from "./renderer";
import { V2_VARIANT } from "./shaders";
import { PASS_VERTEX_SHADER, buildStageInjection } from "./stage-injection";

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

/** Compile every pass of every prepass stage these options imply, on the shared
 *  context. The stages are the ones the renderer resolves for the options. Pass
 *  programs don't depend on the process version, so one injection stands for
 *  both. Throws with the info log of the first pass that fails. */
function compilePassPrograms(opts: WebGLRendererOpts | undefined): void {
  const { gl } = glHarness();
  const stages = opts?.stages ?? Object.values(useRegistry.getState().processingStages);
  for (const stage of buildStageInjection(stages, V2_VARIANT).prepass) {
    stage.passes.forEach((pass, index) => {
      const build = buildProgram(gl, PASS_VERTEX_SHADER, pass.fragmentSource);
      releaseProgram(gl, build);
      if (build.error) throw new Error(`${stage.stageId} pass ${index}: ${build.error}`);
    });
  }
}

/** null when every program these options imply compiles and links, for every
 *  process version the options allow; otherwise the info log the failing build
 *  threw with. The renderer compiles nothing ahead of a frame, so one frame per
 *  version builds the develop programs; a frame with an empty param bag runs no
 *  prepass, so the pass programs are compiled directly. */
export function rendererBuildError(opts?: WebGLRendererOpts): string | null {
  try {
    withRenderer(opts, (renderer) => {
      renderer.setImage(floatImage(1, 1, () => [0.18, 0.18, 0.18]));
      // The newest version first, version 2 unless the options raise the cap:
      // with the stock transform and no stages, a fresh renderer's signatures
      // already match a version 2 frame.
      const newest = opts?.processVersionCap ?? CURRENT_PROCESS_VERSION;
      for (const processVersion of new Set([newest, CURRENT_PROCESS_VERSION, LEGACY_PROCESS_VERSION])) {
        renderer.setParams(identityParams({ processVersion }));
        renderer.render();
      }
    });
    compilePassPrograms(opts);
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
  const core = BUILTIN_EXTENSIONS.find((e) => e.id === CORE_EXTENSION_ID);
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
 *  they are not an identity render. Pixel assertions start from this instead.
 *  Pinned to process version 1: the suites written before process versions
 *  describe version 1, and version 2 behaviour is asserted explicitly. */
export function identityParams(over: Partial<DevelopParams> = {}): DevelopParams {
  return {
    ...DEFAULT_DEVELOP_PARAMS,
    sharpening: 0,
    colorNR: 0,
    processVersion: LEGACY_PROCESS_VERSION,
    ...over,
  };
}

/** A prepass stage whose result is (i + 1) / 64 everywhere, exact in half float,
 *  and whose inline glsl adds `step` to lin only when it reads that value back,
 *  so a frame counts the stages that read their own result. `step` must print
 *  with a decimal point (GLSL ES has no int→float). The ids keep distinct
 *  4-char hash prefixes up to i = 29; `test.marker-${i}` would not, since the
 *  prefix is the hash's high digits. */
export function markerStage(i: number, step: number): ProcessingStageContribution {
  const mark = `${i + 1}.0 / 64.0`;
  return {
    id: `marker-${i}.test`,
    name: `Marker ${i}`,
    phase: "scene-linear",
    priority: 10 + i,
    glsl: `if (take > 0.5 && abs(stageResult.r - ${mark}) < 0.001) lin += vec3(${step});`,
    uniforms: [{ key: "take", glslType: "float", default: 0 }],
    passes: [{ glsl: `c = vec3(${mark});` }],
  };
}

/** The bag that turns `stages` on: each holds a non-zero key, so its prepass runs. */
export function takingStages(
  stages: readonly ProcessingStageContribution[],
): Record<string, number> {
  return Object.fromEntries(stages.map((s) => [`${s.id}.take`, 1]));
}

/** A display transform that hands the scene-linear working colour straight to
 *  the framebuffer and owns the baseline, so the RAW baseline tone is not
 *  applied. Everything between `lin` and the output is
 *  then identity at default params, which makes a read-back pixel the linear
 *  value the tone chain produced — the only way to assert on linear-light
 *  behaviour (exposure in stops) without inverting a tone curve in the test. */
export const LINEAR_PROBE_PIPELINE: ResolvedPipeline = {
  id: "test.linear-probe",
  glsl: "vec3 pipelineToDisplay(vec3 lin) { return lin; }",
  skipBaseCurve: true,
  skipToneShoulder: false,
  sig: "test.linear-probe",
};

/** LINEAR_PROBE_PIPELINE without the core shoulder, so `c` at version 3's
 *  output stage is the scene as the RGBA16F source holds it, over-range and
 *  negative values included. */
export const OPEN_PROBE: ResolvedPipeline = {
  ...LINEAR_PROBE_PIPELINE,
  id: "test.open-probe",
  skipToneShoulder: true,
  sig: "test.open-probe",
};

/** The value an RGBA16F texel holds for x: 11 significant bits, round to nearest. */
export function toHalf(x: number): number {
  if (x === 0) return 0;
  const q = 2 ** (Math.max(Math.floor(Math.log2(Math.abs(x))), -14) - 10);
  return Math.round(x / q) * q;
}

/** A Linux monitor profile for an Adobe RGB display, wide enough that the
 *  conversion visibly moves every colour. */
export function adobeDisplay(): MonitorTransform {
  const parsed = parseDisplayProfile(buildIccProfile("adobe-rgb"));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.profile.transform;
}

/** A display transform that keeps the RAW baseline and hands the working
 *  colour back negated, so a channel below black survives the display clamp
 *  and reads back as a positive value. */
export const NEGATING_PIPELINE: ResolvedPipeline = {
  id: "test.negate",
  glsl: "vec3 pipelineToDisplay(vec3 lin) { return -lin; }",
  skipBaseCurve: false,
  skipToneShoulder: false,
  sig: "test.negate",
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

/** RGB of patch `index` in a scene of 4 px patches side by side: a middle
 *  pixel, two rows down, inside it whichever way up the frame reads. */
export const patchPixel = (frame: Frame, index: number): Vec3 => pixelAt(frame, index * 4 + 1, 2);

export const each = (v: Vec3, f: (x: number) => number): Vec3 => [f(v[0]), f(v[1]), f(v[2])];

export function expectColour(got: Vec3, want: Vec3, label: string, tolerance = 2e-3): void {
  for (let ch = 0; ch < 3; ch++) expect(Math.abs(got[ch] - want[ch]), `${label} ch ${ch}`).toBeLessThan(tolerance);
}

/** The largest difference in any channel between two frames of one size, over every
 *  pixel `skip` doesn't name (by top-down x and y). A NaN anywhere makes it NaN, so an
 *  assertion against a tolerance fails instead of passing. */
export function worstDifference(
  a: Frame,
  b: Frame,
  skip?: (x: number, y: number) => boolean,
): number {
  if (a.width !== b.width || a.height !== b.height) {
    throw new Error(`frames differ in size: ${a.width}x${a.height} against ${b.width}x${b.height}`);
  }
  let worst = 0;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      if (skip?.(x, y)) continue;
      const first = (y * a.width + x) * 4;
      for (let channel = 0; channel < 4; channel++) {
        worst = Math.max(worst, Math.abs(a.data[first + channel] - b.data[first + channel]));
      }
    }
  }
  return worst;
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
  /** Objects created since tracking began, per family. A cache that deletes
   *  what it rebuilds keeps `live` flat, so only this count shows the churn. */
  created: GlObjectCounts;
  restore(): void;
}

/** Count GL object allocations against frees so a suite can assert that a
 *  renderer's dispose() gives everything back. A leaked context-level object
 *  outlives the renderer and the browser's object budget is finite, so this is
 *  the failure mode a `gl.getError()` check cannot see. */
export function trackGlObjects(gl: WebGL2RenderingContext): GlObjectTally {
  const none = (): GlObjectCounts => ({
    texture: 0,
    framebuffer: 0,
    buffer: 0,
    program: 0,
    shader: 0,
    vertexArray: 0,
  });
  const live = none();
  const created = none();
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
        created[family]++;
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
    created.shader++;
    return original.createShader.call(gl, type);
  };
  gl.deleteShader = (shader: WebGLShader | null) => {
    if (shader) live.shader--;
    original.deleteShader.call(gl, shader);
  };

  return {
    live,
    created,
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

/** How many entries of two frames differ: a count, since a diff of 120,000
 *  entries takes the test runner minutes to print. */
export function differing(a: ArrayLike<number>, b: ArrayLike<number>): number {
  expect(a.length).toBe(b.length);
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
}

/** The canvas, RGBA, top-down. */
export function canvasPixels(): Uint8Array {
  const { gl } = glHarness();
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const raw = new Uint8Array(w * h * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, raw);
  const px = new Uint8Array(raw.length);
  for (let y = 0; y < h; y++) px.set(raw.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
  return px;
}

/** The canvas after a live render(), cleared to magenta first so a frame that
 *  missed it shows. */
export function liveFrame(r: WebGLRenderer): Uint8Array {
  const { gl } = glHarness();
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.clearColor(1, 0, 1, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  r.render();
  return canvasPixels();
}

/** Every GL error raised while `fn` runs, whoever reads it: an export reads the
 *  queue itself, so its errors never reach a getError after it. */
export function glErrorsDuring(gl: WebGL2RenderingContext, fn: () => void): number[] {
  drainGlErrors(gl);
  const getError = gl.getError;
  const seen: number[] = [];
  gl.getError = () => {
    const error = getError.call(gl);
    if (error !== gl.NO_ERROR) seen.push(error);
    return error;
  };
  try {
    fn();
  } finally {
    gl.getError = getError;
  }
  for (let error = gl.getError(); error !== gl.NO_ERROR; error = gl.getError()) seen.push(error);
  return seen;
}

/** `fn` on a driver that runs out of memory at the first draw into framebuffers
 *  made meanwhile, and says so only at the next getError, as one that allocates
 *  lazily does. Of those first draws, in the order they happen, it passes over
 *  `passOver` and runs out of memory at the next `textures`. */
export function outOfMemoryAtFirstDraw<T>(
  gl: WebGL2RenderingContext,
  { passOver = 0, textures }: { passOver?: number; textures: number },
  fn: () => T,
): T {
  const { createFramebuffer, drawArrays, getError } = gl;
  const undrawn = new Set<WebGLFramebuffer>();
  let firstDraws = 0;
  let outOfMemory = false;
  gl.createFramebuffer = (): WebGLFramebuffer => {
    const fbo = createFramebuffer.call(gl);
    undrawn.add(fbo);
    return fbo;
  };
  gl.drawArrays = (...args: unknown[]): void => {
    if (undrawn.delete(gl.getParameter(gl.FRAMEBUFFER_BINDING))) {
      const n = firstDraws++;
      if (n >= passOver && n < passOver + textures) outOfMemory = true;
    }
    Reflect.apply(drawArrays, gl, args);
  };
  gl.getError = (): number => {
    if (!outOfMemory) return getError.call(gl);
    outOfMemory = false;
    return gl.OUT_OF_MEMORY;
  };
  try {
    return fn();
  } finally {
    gl.createFramebuffer = createFramebuffer;
    gl.drawArrays = drawArrays;
    gl.getError = getError;
  }
}

/** What the next draw inherits: program, framebuffer, viewport, active unit,
 *  and the texture on each of the develop program's units 0 to 6. Unit 7 is
 *  the renderer's scratch unit, which no frame reads. */
export function glState(gl: WebGL2RenderingContext): [string, unknown][] {
  const active: number = gl.getParameter(gl.ACTIVE_TEXTURE);
  const units = Array.from({ length: 7 }, (_, unit): [string, unknown] => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    return [`unit ${unit}`, gl.getParameter(gl.TEXTURE_BINDING_2D)];
  });
  gl.activeTexture(active);
  return [
    ["program", gl.getParameter(gl.CURRENT_PROGRAM)],
    ["framebuffer", gl.getParameter(gl.FRAMEBUFFER_BINDING)],
    ["viewport", `${gl.getParameter(gl.VIEWPORT)}`],
    ["active unit", active],
    ...units,
  ];
}

/** The entries of two glState snapshots that aren't the same object or value. */
export const changedState = (before: [string, unknown][], after: [string, unknown][]): string[] =>
  before.filter(([, value], i) => !Object.is(value, after[i][1])).map(([name]) => name);

/** What the live view may show and a measurement frame (an export's, a float
 *  capture's) must not, by label: each changes the live canvas. The proof is
 *  Adobe RGB because an sRGB proof of an sRGB frame changes nothing. Call
 *  inside a describe: the views retag the shared canvas, which outlives each
 *  renderer, so it is set back to sRGB after each test. */
export function measurementViews(): [string, (r: WebGLRenderer) => void][] {
  afterEach(() => {
    glHarness().gl.drawingBufferColorSpace = "srgb";
  });
  return [
    ["the clipping and gamut warnings", (r) => r.setShowClipping(7)],
    ["the sharpening preview", (r) => r.setSharpenViz(1)],
    ["a Display P3 screen", (r) => r.setDisplaySpace("display-p3")],
    ["a monitor profile", (r) => r.setMonitorTransform(adobeDisplay())],
    ["a soft proof on a Display P3 screen", (r) => {
      r.setDisplaySpace("display-p3");
      r.setProofSpace("adobe-rgb");
    }],
  ];
}
