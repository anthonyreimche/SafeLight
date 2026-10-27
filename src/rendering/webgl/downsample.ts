// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A float capture in the space it asks for and at the size it asks for: the
// full view's frame, each texel converted from the perceptual Rec.709 it is
// drawn in, then averaged down as a smaller view of it shows. Drawn at the
// smaller size instead, tone and colour would match, but the core's detail
// tools sample the source's mips at fixed levels while the frame's own base
// sample moves to a coarser one, so sharpening, noise reduction and texture
// would fade or reverse. Converted after averaging, a linear frame would be
// the decoded mean of encoded values rather than the mean of the light.

import type { StageSpace } from "@/extensions/types";
import { STAGE_SPACE_GLSL } from "../stage-space";
import {
  PASS_PRELUDE,
  SCRATCH_UNIT,
  allocateChecked,
  createProgramPair,
  ranOutOfMemory,
  releaseTarget,
  targetFormat,
  type ColourTarget,
} from "./export-draw";

interface Size {
  w: number;
  h: number;
}

// A texel of the frame in the capture's space, as toSpaceExpr spells the
// display domain's conversion, picked by uniforms so one program serves every
// space. Perceptual Rec.709 is the frame's own, so it is averaged as read: the
// round trip isn't exact far over range.
const IN_SPACE_GLSL = `${STAGE_SPACE_GLSL}uniform bool uWide;
uniform bool uLinear;
vec3 inSpace(vec3 v) {
  if (!uWide && !uLinear) return v;
  vec3 lin = slDecodePerceptual(v);
  if (uWide) lin = SL_REC709_TO_REC2020 * lin;
  return uLinear ? lin : slEncodePerceptual(lin);
}
`;

// Target texel i along `axis` covers source texels [i·n/m, (i+1)·n/m), n the
// source's size and m the target's. Counted in m-ths of a texel every bound is
// an integer, so each texel's weight, the part of it inside, is exact at any
// ratio, whole or not. The loop runs as far as the ratio needs, which the
// canvas's size bounds. The horizontal pass converts each texel before it is
// weighted; the vertical pass reads values already in the space.
function passShader(axis: "x" | "y"): string {
  const converts = axis === "x";
  return `${PASS_PRELUDE}precision highp int;
uniform sampler2D uSrc;
uniform ivec2 uTo;
${converts ? IN_SPACE_GLSL : ""}void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int n = textureSize(uSrc, 0).${axis};
  int m = uTo.${axis};
  int lo = p.${axis} * n;
  int hi = lo + n;
  vec3 sum = vec3(0.0);
  for (int i = lo / m; i * m < hi; i++) {
    ivec2 q = p;
    q.${axis} = i;
    vec3 texel = texelFetch(uSrc, q, 0).rgb;
    sum += float(min(hi, (i + 1) * m) - max(lo, i * m)) * ${converts ? "inSpace(texel)" : "texel"};
  }
  fragColor = vec4(sum / float(n), 1.0);
}
`;
}

type Location = WebGLUniformLocation | null;

interface Pass {
  program: WebGLProgram;
  src: Location;
  to: Location;
}

type ConvertingPass = Pass & { wide: Location; linear: Location };

/** The box filter's two passes: across the frame, converting it, then down it. */
export interface DownsamplePrograms {
  horizontal: ConvertingPass;
  vertical: Pass;
}

/** Builds the passes with `createProgram`, as createProgramPair does. */
export function createDownsamplePrograms(
  gl: WebGL2RenderingContext,
  createProgram: (vertex: string, fragment: string) => WebGLProgram,
): DownsamplePrograms {
  const [horizontal, vertical] = createProgramPair(gl, createProgram, passShader("x"), passShader("y"));
  const pass = (program: WebGLProgram): Pass => ({
    program,
    src: gl.getUniformLocation(program, "uSrc"),
    to: gl.getUniformLocation(program, "uTo"),
  });
  return {
    horizontal: {
      ...pass(horizontal),
      wide: gl.getUniformLocation(horizontal, "uWide"),
      linear: gl.getUniformLocation(horizontal, "uLinear"),
    },
    vertical: pass(vertical),
  };
}

export function deleteDownsamplePrograms(gl: WebGL2RenderingContext, programs: DownsamplePrograms): void {
  gl.deleteProgram(programs.horizontal.program);
  gl.deleteProgram(programs.vertical.program);
}

// The frame is drawn in full float, or in half float where full float can't be had.
const FRAME_TARGETS = ["float32", "float16"] as const;

/** The frame `drawFrame` draws at `full`'s size into the framebuffer it is
 *  given, in `space` and at `to`'s size, read back, RGBA, bottom-up. Each of
 *  the frame's texels is converted from perceptual Rec.709 into `space`
 *  before any averaging, so each pixel is the mean, in `space`, of the texels
 *  its footprint covers: at `full`'s own size, its texel converted. The frame
 *  is drawn in full float, or in half float when full float is refused or
 *  runs out of memory, its own target or the first pass's beside it; null
 *  when neither can be had, or the second pass's target can't. No framebuffer
 *  is left bound, TEXTURE0 is active and the viewport is as it was; the
 *  program in use may be a pass's or drawFrame's, so the caller restores its
 *  own. */
export function drawDownsampled(
  gl: WebGL2RenderingContext,
  programs: DownsamplePrograms,
  full: Size,
  to: Size,
  space: StageSpace,
  drawFrame: (fbo: WebGLFramebuffer) => void,
): Float32Array | null {
  const viewport: Int32Array = gl.getParameter(gl.VIEWPORT);
  try {
    for (const name of FRAME_TARGETS) {
      const across = drawAcross(gl, programs.horizontal, name, full, to.w, space, drawFrame);
      if (!across) continue;
      try {
        // As tall as the frame, it needs no vertical pass: that would copy it.
        return to.h === full.h ? readBack(gl, across, to) : drawDown(gl, programs.vertical, across, to);
      } finally {
        releaseTarget(gl, across);
      }
    }
    return null;
  } finally {
    gl.viewport(viewport[0], viewport[1], viewport[2], viewport[3]);
  }
}

// The frame drawn into a target of `name`, then converted and averaged across
// into a full-float target `w` wide and the frame's height, which the caller
// releases. The frame's target is freed here, before the vertical pass takes
// one of its own, so no more than two targets are held at once. Null, holding
// nothing, when the frame's target or this pass's is refused or runs out of
// memory.
function drawAcross(
  gl: WebGL2RenderingContext,
  pass: ConvertingPass,
  name: (typeof FRAME_TARGETS)[number],
  full: Size,
  w: number,
  space: StageSpace,
  drawFrame: (fbo: WebGLFramebuffer) => void,
): ColourTarget | null {
  const format = targetFormat(gl, name);
  if (!format) return null;
  const frame = allocateChecked(gl, format.internalFormat, format.type, full.w, full.h);
  let across: ColourTarget | null = null;
  try {
    if (!frame.ok) return null;
    drawFrame(frame.target.fbo);
    // A driver can report the memory only at the first draw into a target,
    // and what that draw left is undefined.
    if (ranOutOfMemory(gl)) return null;
    const allocated = allocateChecked(gl, gl.RGBA32F, gl.FLOAT, w, full.h);
    across = allocated.target;
    if (!allocated.ok) return null;
    gl.useProgram(pass.program);
    gl.uniform1i(pass.wide, space.primaries === "rec2020" ? 1 : 0);
    gl.uniform1i(pass.linear, space.encoding === "linear" ? 1 : 0);
    drawPass(gl, pass, frame.target.tex, across.fbo, { w, h: full.h });
    if (ranOutOfMemory(gl)) return null;
    const drawn = across;
    across = null;
    return drawn;
  } finally {
    if (across) releaseTarget(gl, across);
    releaseTarget(gl, frame.target);
  }
}

// `across` averaged down into a full-float target of `to`'s size, read back.
function drawDown(gl: WebGL2RenderingContext, pass: Pass, across: ColourTarget, to: Size): Float32Array | null {
  const down = allocateChecked(gl, gl.RGBA32F, gl.FLOAT, to.w, to.h);
  try {
    if (!down.ok) return null;
    gl.useProgram(pass.program);
    drawPass(gl, pass, across.tex, down.target.fbo, to);
    return readBack(gl, down.target, to);
  } finally {
    releaseTarget(gl, down.target);
  }
}

// A pass's target read back. As for the frame, the driver may report the
// target's memory only now.
function readBack(gl: WebGL2RenderingContext, target: ColourTarget, size: Size): Float32Array | null {
  const raw = new Float32Array(size.w * size.h * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
  gl.readPixels(0, 0, size.w, size.h, gl.RGBA, gl.FLOAT, raw);
  return ranOutOfMemory(gl) ? null : raw;
}

// One pass, its program in use, over `src` into `fbo`, which is left bound, at
// the target's size. Both passes' targets are full float, so the means keep
// more than the frame's own precision.
function drawPass(gl: WebGL2RenderingContext, pass: Pass, src: WebGLTexture, fbo: WebGLFramebuffer, size: Size): void {
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.viewport(0, 0, size.w, size.h);
  gl.activeTexture(gl.TEXTURE0 + SCRATCH_UNIT);
  gl.bindTexture(gl.TEXTURE_2D, src);
  gl.uniform1i(pass.src, SCRATCH_UNIT);
  gl.uniform2i(pass.to, size.w, size.h);
  gl.drawArrays(gl.TRIANGLES, 0, 6);
}
