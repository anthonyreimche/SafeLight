// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The target a version 3 16-bit export is drawn into, and its read-back. The
// RGBA16F target captureFloatFrame draws into keeps 11 bits, so a 16-bit export
// made from it holds at most 1,024 codes in each octave below white. An export
// tries a true 16-bit target first and steps down to what the context renders.
//
// Output sharpening for version 3 runs here too, on the signed colour the
// output stage receives rather than on the 8-bit result, so what the unsharp
// mask pushes past the gamut is mapped by the output stage instead of clipped.

import { OUTPUT_MAP_GLSL } from "../output-map";
import { STAGE_SPACE_GLSL } from "../stage-space";
import { LINEAR_TO_SRGB_GLSL, VERTEX_SHADER } from "./shaders";

/** Where an export frame lands: RGBA16 (EXT_texture_norm16, read as 16-bit
 *  codes), RGBA32F, or RGBA16F, the target versions 1 and 2 export through. */
export type ExportTarget = "norm16" | "float32" | "float16";

export const EXPORT_TARGETS: readonly ExportTarget[] = ["norm16", "float32", "float16"];

/** Output sharpening in CSS blur() terms: an unsharp mask of `amount` percent
 *  over a Gaussian of σ = `radius` px. */
export interface Sharpen {
  amount: number;
  radius: number;
}

export interface ExportPixelsOptions {
  /** Tried in order; default EXPORT_TARGETS. */
  targets?: readonly ExportTarget[];
  /** Applied to the signed colour ahead of the output stage. */
  sharpen?: Sharpen;
}

export interface ExportPixels {
  /** RGBA, top-down, in the target's encoding as codes 0..65535. */
  data: Uint16Array;
  width: number;
  height: number;
  target: ExportTarget;
}

/** An output-encoded sample as a 16-bit code: clipped to [0, 1], rounded to nearest. */
export function quantise16(v: number): number {
  return v <= 0 ? 0 : v >= 1 ? 65535 : Math.round(v * 65535);
}

/** The renderer's scratch unit: no develop frame reads it, so a pass can bind
 *  a texture there without lending a unit and giving it back. */
export const SCRATCH_UNIT = 7;

/** A colour target: a texture made on the scratch unit, attached to its own
 *  framebuffer. */
export interface ColourTarget {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  /** False when the context can't render into it. */
  complete: boolean;
}

/** A w×h RGBA target of `internalFormat`, with no framebuffer left bound.
 *  Release it whether or not it is complete. */
export function allocateTarget(
  gl: WebGL2RenderingContext,
  internalFormat: number,
  type: number,
  w: number,
  h: number,
): ColourTarget {
  const tex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0 + SCRATCH_UNIT);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, gl.RGBA, type, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { tex, fbo, complete };
}

/** Frees a target, leaving no framebuffer bound and TEXTURE0 active. */
export function releaseTarget(gl: WebGL2RenderingContext, target: ColourTarget): void {
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.deleteFramebuffer(target.fbo);
  gl.activeTexture(gl.TEXTURE0 + SCRATCH_UNIT);
  gl.deleteTexture(target.tex);
  gl.activeTexture(gl.TEXTURE0);
}

// An allocation the driver refuses (out of memory, say) raises an error rather
// than leaving the framebuffer incomplete, so the queue is emptied first to
// read only the allocation's, and read even for an incomplete target, which
// would otherwise leave its error for the next reader.
export function allocateChecked(
  gl: WebGL2RenderingContext,
  internalFormat: number,
  type: number,
  w: number,
  h: number,
): { target: ColourTarget; ok: boolean } {
  while (gl.getError() !== gl.NO_ERROR) { /* one flag per error code */ }
  const target = allocateTarget(gl, internalFormat, type, w, h);
  return { target, ok: gl.getError() === gl.NO_ERROR && target.complete };
}

// RGBA16_EXT where the context renders EXT_texture_norm16's RGBA16 and reads it
// back as 16-bit codes, else 0, by context. The renderer's own norm16 probe
// asks another question (whether the retouch copy can mipmap), and only with
// High bit depth on.
const norm16Formats = new WeakMap<WebGL2RenderingContext, number>();

/** The norm16 export format for this context, or 0 without one. Probed on first use. */
export function exportNorm16Format(gl: WebGL2RenderingContext): number {
  let format = norm16Formats.get(gl);
  if (format === undefined) {
    format = probeNorm16(gl);
    norm16Formats.set(gl, format);
  }
  return format;
}

function probeNorm16(gl: WebGL2RenderingContext): number {
  const ext: EXT_texture_norm16 | null = gl.getExtension("EXT_texture_norm16");
  if (!ext) return 0;
  const { target, ok } = allocateChecked(gl, ext.RGBA16_EXT, gl.UNSIGNED_SHORT, 1, 1);
  try {
    if (!ok) return 0;
    // A normalized target is only guaranteed to read as RGBA/UNSIGNED_BYTE;
    // the 16-bit read is the implementation's to offer.
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    const reads16 =
      gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT) === gl.RGBA &&
      gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE) === gl.UNSIGNED_SHORT;
    return reads16 ? ext.RGBA16_EXT : 0;
  } finally {
    releaseTarget(gl, target);
  }
}

interface TargetFormat {
  internalFormat: number;
  type: number;
  /** The readPixels type. */
  read: number;
}

/** The formats behind an ExportTarget; null for norm16 where the context has none. */
export function targetFormat(gl: WebGL2RenderingContext, target: ExportTarget): TargetFormat | null {
  switch (target) {
    case "norm16": {
      const internalFormat = exportNorm16Format(gl);
      return internalFormat ? { internalFormat, type: gl.UNSIGNED_SHORT, read: gl.UNSIGNED_SHORT } : null;
    }
    case "float32":
      return { internalFormat: gl.RGBA32F, type: gl.FLOAT, read: gl.FLOAT };
    case "float16":
      return { internalFormat: gl.RGBA16F, type: gl.HALF_FLOAT, read: gl.FLOAT };
  }
}

// Rows of a float target read back at a time, so the float copy stays a band
// rather than a second whole frame at twice the codes' size.
const BAND_ROWS = 64;

// The bound w×h target as 16-bit codes, top-down: readPixels hands the rows
// back bottom-up. A float target is quantised with quantise16.
function readCodes(gl: WebGL2RenderingContext, read: number, w: number, h: number): Uint16Array {
  const stride = w * 4;
  const codes = new Uint16Array(stride * h);
  if (read === gl.UNSIGNED_SHORT) {
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_SHORT, codes);
    const row = new Uint16Array(stride);
    for (let top = 0, bottom = h - 1; top < bottom; top++, bottom--) {
      const upper = codes.subarray(top * stride, (top + 1) * stride);
      const lower = codes.subarray(bottom * stride, (bottom + 1) * stride);
      row.set(upper);
      upper.set(lower);
      lower.set(row);
    }
    return codes;
  }
  const band = new Float32Array(Math.min(BAND_ROWS, h) * stride);
  for (let y = 0; y < h; y += BAND_ROWS) {
    const rows = Math.min(BAND_ROWS, h - y);
    gl.readPixels(0, y, w, rows, gl.RGBA, gl.FLOAT, band);
    for (let r = 0; r < rows; r++) {
      const from = r * stride;
      const to = (h - 1 - y - r) * stride;
      for (let i = 0; i < stride; i++) codes[to + i] = quantise16(band[from + i]);
    }
  }
  return codes;
}

// Empties the error queue and says whether it held OUT_OF_MEMORY. Other errors
// a frame raises (a stage's stray uniform call, say) don't stop an export.
export function ranOutOfMemory(gl: WebGL2RenderingContext): boolean {
  let outOfMemory = false;
  for (let error = gl.getError(); error !== gl.NO_ERROR; error = gl.getError()) {
    if (error === gl.OUT_OF_MEMORY) outOfMemory = true;
  }
  return outOfMemory;
}

/** A w×h frame drawn by `drawFrame` into the first of `targets` the context
 *  can allocate and render, read back. `drawFrame` is given the target's
 *  framebuffer and which target it is, and returns false when it can't draw
 *  into it, which steps down to the next. Null when none of them can be drawn,
 *  or when the frame is too large to read back. */
export function drawExport(
  gl: WebGL2RenderingContext,
  w: number,
  h: number,
  targets: readonly ExportTarget[],
  drawFrame: (fbo: WebGLFramebuffer, target: ExportTarget) => boolean,
): ExportPixels | null {
  for (const target of targets) {
    const format = targetFormat(gl, target);
    if (!format) continue;
    const allocated = allocateChecked(gl, format.internalFormat, format.type, w, h);
    try {
      if (!allocated.ok || !drawFrame(allocated.target.fbo, target)) continue;
      gl.bindFramebuffer(gl.FRAMEBUFFER, allocated.target.fbo);
      let data: Uint16Array;
      try {
        data = readCodes(gl, format.read, w, h);
      } catch (err) {
        // Every target reads back into one 8 B/px array, so a frame too large
        // for it is too large for them all.
        if (err instanceof RangeError) return null;
        throw err;
      }
      // Some drivers report the memory only at the first draw into a target,
      // and what that draw left is undefined.
      if (ranOutOfMemory(gl)) continue;
      return { data, width: w, height: h, target };
    } finally {
      releaseTarget(gl, allocated.target);
    }
  }
  return null;
}

// The top of the Export panel's radius slider. The slider also takes a larger
// typed radius, which version 3 holds to σ = 3. That Gaussian reaches
// ceil(3σ) = 9 px each side, and the passes always loop that far, a smaller
// radius's taps past its reach at zero, so no loop bound depends on data.
const MAX_RADIUS = 3;
const MAX_REACH = Math.ceil(3 * MAX_RADIUS);

// σ = `radius` px, capped at MAX_RADIUS: the centre tap, then one per pixel out
// to ceil(3σ), normalised, then zeros to MAX_REACH. CSS blur() takes its radius
// as σ the same way. A radius of 0 or less blurs nothing.
function gaussianTaps(radius: number): Float32Array {
  const taps = new Float32Array(MAX_REACH + 1);
  const sigma = Math.min(radius, MAX_RADIUS);
  if (!(sigma > 0)) {
    taps[0] = 1;
    return taps;
  }
  const reach = Math.ceil(3 * sigma);
  let sum = 0;
  for (let i = 0; i <= reach; i++) {
    taps[i] = Math.exp(-(i * i) / (2 * sigma * sigma));
    sum += i === 0 ? taps[i] : 2 * taps[i];
  }
  for (let i = 0; i <= reach; i++) taps[i] /= sum;
  return taps;
}

// The uniforms OUTPUT_MAP_GLSL reads, with their types. The renderer binds them
// on the output pass as on the develop program, and an export binds no proof.
const OUTPUT_UNIFORMS: Readonly<Record<string, string>> = {
  uOutSpace: "int",
  uOutMatrix: "mat3",
  uOutToLms: "mat3",
  uLmsToOut: "mat3",
  uProof: "bool",
  uProofFits: "bool",
  uProofMatrix: "mat3",
  uProofToLms: "mat3",
  uLmsToProof: "mat3",
  uProofToOut: "mat3",
};

// The Gaussian along `dir` through texel `p`. texelFetch ignores wrap modes, so
// the border texel stands in past the edge as CLAMP_TO_EDGE would have it.
const GAUSSIAN_GLSL = `uniform float uTaps[${MAX_REACH + 1}];
vec3 slGaussian(sampler2D src, ivec2 p, ivec2 dir) {
  ivec2 last = textureSize(src, 0) - 1;
  vec3 sum = uTaps[0] * texelFetch(src, p, 0).rgb;
  for (int i = 1; i <= ${MAX_REACH}; i++) {
    sum += uTaps[i] * (texelFetch(src, clamp(p - dir * i, ivec2(0), last), 0).rgb +
                       texelFetch(src, clamp(p + dir * i, ivec2(0), last), 0).rgb);
  }
  return sum;
}
`;

// These passes and downsample.ts's read float textures texel for texel, and a
// sampler is lowp unless declared otherwise.
export const PASS_PRELUDE = `#version 300 es
precision highp float;
precision highp sampler2D;
out vec4 fragColor;
`;

const HORIZONTAL_SHADER = `${PASS_PRELUDE}uniform sampler2D uSrc;
${GAUSSIAN_GLSL}void main() {
  fragColor = vec4(slGaussian(uSrc, ivec2(gl_FragCoord.xy), ivec2(1, 0)), 1.0);
}
`;

// The vertical pass reads the horizontal one's result here, in the pass that
// needs it, so the blur takes one float texture of the frame's size, not two.
const OUTPUT_SHADER = `${PASS_PRELUDE}uniform sampler2D uC;
uniform sampler2D uHorizontal;
uniform float uAmount;
${Object.entries(OUTPUT_UNIFORMS).map(([name, type]) => `uniform ${type} ${name};`).join("\n")}
${STAGE_SPACE_GLSL}${LINEAR_TO_SRGB_GLSL}
${OUTPUT_MAP_GLSL}${GAUSSIAN_GLSL}void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 c = texelFetch(uC, p, 0).rgb;
  fragColor = vec4(slOutput(c + uAmount * (c - slGaussian(uHorizontal, p, ivec2(0, 1)))), 1.0);
}
`;

type UniformLocations = Record<string, WebGLUniformLocation | null>;

/** The sharpening passes' programs and their uniforms by name, the output
 *  pass's OUTPUT_UNIFORMS among them. */
export interface SharpenPrograms {
  horizontal: WebGLProgram;
  output: WebGLProgram;
  horizontalUniforms: UniformLocations;
  outputUniforms: UniformLocations;
}

/** Two full-frame passes' programs from their fragment sources, built with
 *  `createProgram`, which must pin aPos to the location the caller's quad
 *  feeds. The first is freed when the second fails to build. */
export function createProgramPair(
  gl: WebGL2RenderingContext,
  createProgram: (vertex: string, fragment: string) => WebGLProgram,
  first: string,
  second: string,
): [WebGLProgram, WebGLProgram] {
  const built = createProgram(VERTEX_SHADER, first);
  try {
    return [built, createProgram(VERTEX_SHADER, second)];
  } catch (err) {
    gl.deleteProgram(built);
    throw err;
  }
}

/** Builds the passes with `createProgram`, as createProgramPair does. */
export function createSharpenPrograms(
  gl: WebGL2RenderingContext,
  createProgram: (vertex: string, fragment: string) => WebGLProgram,
): SharpenPrograms {
  const [horizontal, output] = createProgramPair(gl, createProgram, HORIZONTAL_SHADER, OUTPUT_SHADER);
  const locate = (program: WebGLProgram, names: readonly string[]): UniformLocations =>
    Object.fromEntries(names.map((name) => [name, gl.getUniformLocation(program, name)]));
  return {
    horizontal,
    output,
    horizontalUniforms: locate(horizontal, ["uSrc", "uTaps"]),
    outputUniforms: locate(output, ["uC", "uHorizontal", "uAmount", "uTaps", ...Object.keys(OUTPUT_UNIFORMS)]),
  };
}

export function deleteSharpenPrograms(gl: WebGL2RenderingContext, programs: SharpenPrograms): void {
  gl.deleteProgram(programs.horizontal);
  gl.deleteProgram(programs.output);
}

/** An export target's framebuffer, and which target it is. */
export interface ExportFramebuffer {
  fbo: WebGLFramebuffer;
  kind: ExportTarget;
}

// The formats `c` is drawn in under `target` (null for the canvas), best
// first: full float, or half float when full float can't be had, because the
// context lacks it or runs out of memory for it. `c` never holds less than the
// target keeps, so a norm16 or float32 export fails rather than sharpen 11-bit
// `c`, and steps down to a float16 export, which says what it holds.
function preOutputFormats(target: ExportFramebuffer | null): readonly ExportTarget[] {
  return target?.kind === "norm16" || target?.kind === "float32" ? ["float32"] : ["float32", "float16"];
}

// The output pass reads two textures. One goes on the scratch unit; the other
// borrows TEXTURE6 and gives back what was there, since computeHistogram
// redraws the develop program with its units as the last frame left them.
const LENT_UNIT = 6;

/** A w×h frame sharpened into `target` (null for the canvas). `drawC` draws
 *  the signed colour `c` the output stage receives into the framebuffer it is
 *  given; it is blurred along x, then along y in the output pass, which adds
 *  amount × (c − blur) to `c` and applies the output stage, with `bindOutput`
 *  binding the output space on that pass. False, with nothing drawn into
 *  `target`, when no float texture as precise as `target` can hold `c`. The
 *  current program is the output pass's afterwards. */
export function drawSharpened(
  gl: WebGL2RenderingContext,
  programs: SharpenPrograms,
  frame: { w: number; h: number; sharpen: Sharpen; target: ExportFramebuffer | null },
  drawC: (fbo: WebGLFramebuffer) => void,
  bindOutput: (uniforms: UniformLocations) => void,
): boolean {
  const { w, h, sharpen, target } = frame;
  for (const name of preOutputFormats(target)) {
    const format = targetFormat(gl, name);
    if (!format) continue;
    const c = allocateChecked(gl, format.internalFormat, format.type, w, h);
    const horizontal = c.ok ? allocateChecked(gl, format.internalFormat, format.type, w, h) : null;
    try {
      if (!horizontal?.ok) continue;
      drawC(c.target.fbo);
      const taps = gaussianTaps(sharpen.radius);

      gl.useProgram(programs.horizontal);
      gl.bindFramebuffer(gl.FRAMEBUFFER, horizontal.target.fbo);
      gl.viewport(0, 0, w, h);
      gl.activeTexture(gl.TEXTURE0 + SCRATCH_UNIT);
      gl.bindTexture(gl.TEXTURE_2D, c.target.tex);
      gl.uniform1i(programs.horizontalUniforms.uSrc, SCRATCH_UNIT);
      gl.uniform1fv(programs.horizontalUniforms.uTaps, taps);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      // As for an export target, a driver can report the memory only at the
      // first draw into `c` or its blur, which leaves them undefined.
      if (ranOutOfMemory(gl)) continue;

      const u = programs.outputUniforms;
      gl.useProgram(programs.output);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target?.fbo ?? null);
      gl.uniform1i(u.uC, SCRATCH_UNIT);
      gl.uniform1i(u.uHorizontal, LENT_UNIT);
      gl.uniform1f(u.uAmount, sharpen.amount / 100);
      gl.uniform1fv(u.uTaps, taps);
      bindOutput(u);
      gl.activeTexture(gl.TEXTURE0 + LENT_UNIT);
      const lent: WebGLTexture | null = gl.getParameter(gl.TEXTURE_BINDING_2D);
      gl.bindTexture(gl.TEXTURE_2D, horizontal.target.tex);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.bindTexture(gl.TEXTURE_2D, lent);
      return true;
    } finally {
      if (horizontal) releaseTarget(gl, horizontal.target);
      releaseTarget(gl, c.target);
    }
  }
  return false;
}
