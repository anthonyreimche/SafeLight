// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The renderer's read-backs: the targets a frame is drawn into away from the
// canvas and the pixels read out of them, for the histogram, Upright's
// downscale, float captures, probes and exports. The renderer decides what is
// drawn (the program, its uniforms, the redirect); this draws it into the
// right target and reads it back.

import type { StageSpace } from "@/extensions/types";
import type { HistogramData } from "../histogram";
import {
  createDownsamplePrograms,
  deleteDownsamplePrograms,
  drawDownsampled,
  type DownsamplePrograms,
} from "./downsample";
import {
  createSharpenPrograms,
  deleteSharpenPrograms,
  drawSharpened,
  type ExportFramebuffer,
  type Sharpen,
  type SharpenPrograms,
} from "./export-draw";
import {
  SCRATCH_UNIT,
  allocateChecked,
  allocateTarget,
  drainErrors,
  ranOutOfMemory,
  releaseTarget,
  type ColourTarget,
} from "./gl-resources";

type CreateProgram = (vertex: string, fragment: string) => WebGLProgram;
type UniformLocations = Record<string, WebGLUniformLocation | null>;

/** A window into the image, in setViewport's terms. */
export interface Roi {
  x: number;
  y: number;
  w: number;
  h: number;
}

// The buffer pixels a probe averages along each axis.
export const PROBE_PX = 5;

// The histogram's draws are this many pixels square.
const HIST_SIZE = 128;

// glReadPixels rows come back bottom-up; flips them to top-down image order, in place.
export function topDown<T extends Float32Array | Uint8Array>(px: T, w: number, h: number): T {
  const stride = w * 4;
  const row = px.slice(0, stride);
  for (let top = 0, bottom = h - 1; top < bottom; top++, bottom--) {
    row.set(px.subarray(top * stride, (top + 1) * stride));
    px.copyWithin(top * stride, bottom * stride, (bottom + 1) * stride);
    px.set(row, bottom * stride);
  }
  return px;
}

/** The probe's PROBE_PX-pixel patch around (u, v) of the `live` window, one
 *  target pixel per buffer pixel of a w×h buffer, so its taps and derivatives
 *  see the frame's own pixel spacing. Centred on (u, v), but kept inside the
 *  image: a patch over its edge would average in the margin's colour. */
export function probePatch(live: Roi, u: number, v: number, bufferW: number, bufferH: number): Roi {
  const w = (PROBE_PX / bufferW) * live.w;
  const h = (PROBE_PX / bufferH) * live.h;
  const start = (centre: number, size: number): number =>
    Math.min(Math.max(centre, size / 2), 1 - size / 2) - size / 2;
  return { x: start(live.x + u * live.w, w), y: start(live.y + v * live.h, h), w, h };
}

/** The mean of a probe's patch, each channel of each pixel taken through
 *  `linear` before the average, so the patch is averaged in linear light. */
export function probeMean(raw: Float32Array, linear: (c: number) => number): [number, number, number] {
  const mean = (ch: number): number => {
    let sum = 0;
    for (let i = ch; i < raw.length; i += 4) sum += linear(raw[i]);
    return sum / (PROBE_PX * PROBE_PX);
  };
  return [mean(0), mean(1), mean(2)];
}

/** The size Upright's downscale of an image of `aspect` is drawn at: `size`
 *  along its long edge. */
export function downscaledSize(aspect: number, size: number): { w: number; h: number } {
  return aspect >= 1
    ? { w: size, h: Math.max(1, Math.round(size / aspect)) }
    : { w: Math.max(1, Math.round(size * aspect)), h: size };
}

export function emptyHistogram(): HistogramData {
  return { r: new Uint32Array(256), g: new Uint32Array(256), b: new Uint32Array(256), luma: new Uint32Array(256) };
}

export class Readback {
  private readonly gl: WebGL2RenderingContext;
  private readonly float: boolean;
  private readonly createProgram: CreateProgram;
  // The histogram's targets, made on first use: the display-encoded output as
  // floats, its 8-bit fallback, and the unclamped extended range.
  private histDisplay: ColourTarget | null = null;
  private hist8: ColourTarget | null = null;
  private histExtended: ColourTarget | null = null;
  // Output sharpening's passes (export-draw.ts), built by the first sharpened export.
  private sharpenPrograms: SharpenPrograms | null = null;
  // The box filter's passes (downsample.ts), built by the first float capture
  // that is capped or converted.
  private downsamplePrograms: DownsamplePrograms | null = null;

  /** `float` says whether float targets render; `createProgram` builds a pass
   *  program with the renderer's pinned attribute locations. */
  constructor(gl: WebGL2RenderingContext, float: boolean, createProgram: CreateProgram) {
    this.gl = gl;
    this.float = float;
    this.createProgram = createProgram;
  }

  /** What `draw` draws into a w×h float target, RGBA16F unless `format` is
   *  RGBA32F, read back bottom-up. Null when the target can't be allocated or
   *  completed, or the driver runs out of memory drawing into it, which some
   *  report only at the first draw and which leaves the pixels undefined. */
  floatPixels(w: number, h: number, format: number, draw: (fbo: WebGLFramebuffer) => void): Float32Array | null {
    const gl = this.gl;
    const { target, ok } = allocateChecked(gl, format, format === gl.RGBA32F ? gl.FLOAT : gl.HALF_FLOAT, w, h);
    try {
      if (!ok) {
        drainErrors(gl);
        return null;
      }
      draw(target.fbo);
      const raw = new Float32Array(w * h * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, raw);
      return ranOutOfMemory(gl) ? null : raw;
    } finally {
      releaseTarget(gl, target);
    }
  }

  /** The `full` frame `draw` draws, converted to `space` and averaged down to
   *  `size` on the GPU (downsample.ts). */
  downsampled(
    full: { w: number; h: number },
    size: { w: number; h: number },
    space: StageSpace,
    draw: (fbo: WebGLFramebuffer) => void,
  ): Float32Array | null {
    this.downsamplePrograms ??= createDownsamplePrograms(this.gl, this.createProgram);
    return drawDownsampled(this.gl, this.downsamplePrograms, full, size, space, draw);
  }

  /** drawSharpened, with its programs built on first use. */
  sharpened(
    frame: { w: number; h: number; sharpen: Sharpen; target: ExportFramebuffer | null },
    drawC: (fbo: WebGLFramebuffer) => void,
    bindOutput: (uniforms: UniformLocations) => void,
  ): boolean {
    this.sharpenPrograms ??= createSharpenPrograms(this.gl, this.createProgram);
    return drawSharpened(this.gl, this.sharpenPrograms, frame, drawC, bindOutput);
  }

  /** What the bound program draws, as 8-bit RGBA w×h, top-down. Leaves no
   *  framebuffer bound and TEXTURE0 active. */
  downscaled(w: number, h: number): Uint8Array {
    const gl = this.gl;
    const target = allocateTarget(gl, gl.RGBA, gl.UNSIGNED_BYTE, w, h);
    const data = new Uint8Array(w * h * 4);
    try {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.viewport(0, 0, w, h);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
    } finally {
      releaseTarget(gl, target);
    }
    return topDown(data, w, h);
  }

  /** The histogram of what the bound program draws, at HIST_SIZE square, with
   *  the extended range when asked and float targets render. `rawHistogram`
   *  is the program's uRawHistogram, which the extended draw turns on and
   *  leaves for the caller to turn off with the viewport. Leaves no framebuffer
   *  bound and TEXTURE0 active. */
  histogram(extended: boolean, rawHistogram: WebGLUniformLocation | null): HistogramData {
    const gl = this.gl;
    // The targets are made on the scratch unit, not unit 0. Making one binds
    // it to the active unit, and unit 0 is uImage — so the first histogram of
    // a session sampled its own render target (a GL feedback loop,
    // INVALID_OPERATION) and read back an all-black frame. Sampling is driven
    // by the sampler uniforms, so moving the active unit doesn't affect the draws.
    gl.activeTexture(gl.TEXTURE0 + SCRATCH_UNIT);
    // A driver can list float render targets and still not complete one; a
    // read from it is all zeros, every pixel in bin 0.
    if (this.float) this.histDisplay ??= allocateTarget(gl, gl.RGBA16F, gl.HALF_FLOAT, HIST_SIZE, HIST_SIZE);
    const result = this.histDisplay?.complete ? this.displayHistogram(this.histDisplay) : this.histogram8();
    if (extended && this.float) {
      this.histExtended ??= allocateTarget(gl, gl.RGBA16F, gl.HALF_FLOAT, HIST_SIZE, HIST_SIZE);
      if (this.histExtended.complete) {
        gl.uniform1i(rawHistogram, 1);
        const pxF = this.drawHistogram(this.histExtended, new Float32Array(HIST_SIZE * HIST_SIZE * 4));
        result.extended = extendedBins(pxF);
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(gl.TEXTURE0);
    return result;
  }

  // Preferred path: the display-encoded output in an RGBA16F target, read back
  // as float. The values are still display-space in [0,1] (same axis and
  // colour space as the 8-bit path, so the tonal zones line up), but continuous
  // rather than quantized to 256 codes. This removes the comb / banding the
  // 8-bit readback shows after any tonal stretch (curves, exposure,
  // per-channel white-balance gains spread the 256 codes apart).
  private displayHistogram(target: ColourTarget): HistogramData {
    const pxD = this.drawHistogram(target, new Float32Array(HIST_SIZE * HIST_SIZE * 4));
    const result = emptyHistogram();
    const { r, g, b, luma } = result;
    for (let i = 0; i < pxD.length; i += 4) {
      // Display output is clamped to [0,1] in the shader; clamp defensively and
      // scale to the 0..255 bin index used by the rest of the histogram code.
      const R = Math.min(255, Math.max(0, pxD[i] * 255));
      const G = Math.min(255, Math.max(0, pxD[i + 1] * 255));
      const B = Math.min(255, Math.max(0, pxD[i + 2] * 255));
      r[R | 0]++; g[G | 0]++; b[B | 0]++;
      luma[(0.2126 * R + 0.7152 * G + 0.0722 * B) | 0]++;
    }
    return result;
  }

  // Fallback when float colour buffers aren't renderable: RGBA8 readback.
  // 256 source codes into 256 bins, so a tonal stretch will comb — but this
  // only runs on GPUs without EXT_color_buffer_float.
  private histogram8(): HistogramData {
    const gl = this.gl;
    this.hist8 ??= allocateTarget(gl, gl.RGBA, gl.UNSIGNED_BYTE, HIST_SIZE, HIST_SIZE);
    const px8 = this.drawHistogram(this.hist8, new Uint8Array(HIST_SIZE * HIST_SIZE * 4));
    const result = emptyHistogram();
    const { r, g, b, luma } = result;
    for (let i = 0; i < px8.length; i += 4) {
      const R = px8[i], G = px8[i + 1], B = px8[i + 2];
      r[R]++; g[G]++; b[B]++;
      luma[(0.2126 * R + 0.7152 * G + 0.0722 * B) | 0]++;
    }
    return result;
  }

  private drawHistogram<T extends Float32Array | Uint8Array>(target: ColourTarget, px: T): T {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, HIST_SIZE, HIST_SIZE);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.readPixels(0, 0, HIST_SIZE, HIST_SIZE, gl.RGBA, px instanceof Uint8Array ? gl.UNSIGNED_BYTE : gl.FLOAT, px);
    return px;
  }

  dispose(): void {
    const gl = this.gl;
    for (const t of [this.histDisplay, this.hist8, this.histExtended]) if (t) releaseTarget(gl, t);
    this.histDisplay = this.hist8 = this.histExtended = null;
    if (this.sharpenPrograms) deleteSharpenPrograms(gl, this.sharpenPrograms);
    this.sharpenPrograms = null;
    if (this.downsamplePrograms) deleteDownsamplePrograms(gl, this.downsamplePrograms);
    this.downsamplePrograms = null;
  }
}

// The extended histogram: the unclamped float output over [-0.25, 1.5].
function extendedBins(pxF: Float32Array): NonNullable<HistogramData["extended"]> {
  const RMIN = -0.25, RMAX = 1.5, BINS = 256;
  const range = RMAX - RMIN;
  const er = new Uint32Array(BINS);
  const eg = new Uint32Array(BINS);
  const eb = new Uint32Array(BINS);
  const el = new Uint32Array(BINS);
  let clipLow = 0, clipHigh = 0;
  const total = HIST_SIZE * HIST_SIZE;
  for (let i = 0; i < pxF.length; i += 4) {
    const R = pxF[i], G = pxF[i + 1], B = pxF[i + 2];
    const L = 0.2126 * R + 0.7152 * G + 0.0722 * B;
    if (R <= 0 && G <= 0 && B <= 0) clipLow++;
    if (R >= 1 || G >= 1 || B >= 1) clipHigh++;
    const binR = Math.max(0, Math.min(BINS - 1, ((R - RMIN) / range * BINS) | 0));
    const binG = Math.max(0, Math.min(BINS - 1, ((G - RMIN) / range * BINS) | 0));
    const binB = Math.max(0, Math.min(BINS - 1, ((B - RMIN) / range * BINS) | 0));
    const binL = Math.max(0, Math.min(BINS - 1, ((L - RMIN) / range * BINS) | 0));
    er[binR]++; eg[binG]++; eb[binB]++; el[binL]++;
  }
  return {
    r: er, g: eg, b: eb, luma: el,
    rangeMin: RMIN, rangeMax: RMAX,
    clipLow: clipLow / total,
    clipHigh: clipHigh / total,
  };
}
