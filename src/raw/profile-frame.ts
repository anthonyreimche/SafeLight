// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A non-RAW photo read through the input profile resolver's transform
// (catalog/input-profiles.ts), off the main thread in frame-worker.ts or, with
// no Worker, inline. The file is decoded without colour management, so its
// 8-bit codes are the file's own; each channel's codes go through its table
// and the three through the matrix into linear Rec.709, with nothing clamped,
// so colour outside sRGB arrives as negative channels as a RAW's does. The
// frame is averaged down to the edge the caller renders from, turned upright
// and kept as half floats, the form a RAW cache entry takes to the renderer.

import { normalizeRotation } from "@/catalog/orient";
import type { InputTransform } from "@/extensions/api/develop";
import { handleFrameRequest, placement, type FrameReply, type FrameRequest } from "./frame-job";
import { halfBits } from "./half-float";
import { decodeNetpbm } from "./netpbm";
import { decodeTiff } from "./tiff-image";

/** Which decoder yields the file's codes: the browser's (JPEG, PNG, WebP, AVIF)
 *  or Safelight's own, which never convert. */
export type CodeDecoder = "browser" | "tiff" | "netpbm";

export interface ProfileJob {
  /** The original; a JPEG with its Exif segment left out (sensorNativeImage),
   *  so its orientation stays the catalogue's to apply. */
  source: Blob;
  decoder: CodeDecoder;
  transform: InputTransform;
  /** Clockwise degrees (a quarter-turn step) to bake into the frame. */
  turn: number;
  /** The long edge to average the frame down to; full size without one. */
  targetEdge?: number;
}

/** RGBA half floats, rows top-down. */
export interface HalfFrame {
  data: Uint16Array<ArrayBuffer>;
  width: number;
  height: number;
  /** The decoded frame's size before it was averaged down, turned as the
   *  frame is: what passes scale source-pixel radii by (uSourceSize). */
  fullWidth: number;
  fullHeight: number;
}

/** A channel's table read at each 8-bit code: the code's place among the
 *  table's even steps, interpolated between the two samples around it. */
function curveOfCodes(table: Float32Array): Float64Array {
  const last = table.length - 1;
  const out = new Float64Array(256);
  for (let code = 0; code < 256; code++) {
    const p = (code / 255) * last;
    const i = Math.min(last - 1, Math.floor(p));
    out[code] = table[i] + (table[i + 1] - table[i]) * (p - i);
  }
  return out;
}

/** `codes` (RGBA8, `width` × `height`, rows top-down) through `transform`,
 *  averaged down so its long edge is at most `targetEdge` (the boxes
 *  capFloatToEdge averages) and turned clockwise by `turn`, as halves. The
 *  matrix is linear, so it is applied once to a box's averaged channels. */
export function linearizeCodes(
  codes: Uint8ClampedArray | Uint8Array,
  width: number,
  height: number,
  transform: InputTransform,
  turn: number,
  targetEdge?: number,
): HalfFrame {
  const [red, green, blue] = transform.trc.map(curveOfCodes);
  const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = transform.toRec709;
  const scale = targetEdge ? Math.min(1, targetEdge / Math.max(width, height)) : 1;
  const w = scale < 1 ? Math.max(1, Math.round(width * scale)) : width;
  const h = scale < 1 ? Math.max(1, Math.round(height * scale)) : height;
  const rotation = normalizeRotation(turn);
  const { base, dx, dy } = placement(w, h, rotation);
  const out = new Uint16Array(w * h * 4);

  if (w === width && h === height) {
    for (let y = 0, s = 0; y < h; y++) {
      let o = base + y * dy;
      for (let x = 0; x < w; x++, o += dx, s += 4) {
        const r = red[codes[s]];
        const g = green[codes[s + 1]];
        const b = blue[codes[s + 2]];
        out[o] = halfBits(m0 * r + m1 * g + m2 * b);
        out[o + 1] = halfBits(m3 * r + m4 * g + m5 * b);
        out[o + 2] = halfBits(m6 * r + m7 * g + m8 * b);
        out[o + 3] = halfBits(codes[s + 3] / 255);
      }
    }
  } else {
    for (let y = 0; y < h; y++) {
      const sy0 = Math.floor((y * height) / h);
      const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * height) / h));
      for (let x = 0; x < w; x++) {
        const sx0 = Math.floor((x * width) / w);
        const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * width) / w));
        let sr = 0, sg = 0, sb = 0, sa = 0;
        for (let sy = sy0; sy < sy1; sy++) {
          for (let sx = sx0, s = (sy * width + sx0) * 4; sx < sx1; sx++, s += 4) {
            sr += red[codes[s]];
            sg += green[codes[s + 1]];
            sb += blue[codes[s + 2]];
            sa += codes[s + 3];
          }
        }
        const n = (sy1 - sy0) * (sx1 - sx0);
        const r = sr / n;
        const g = sg / n;
        const b = sb / n;
        const o = base + x * dx + y * dy;
        out[o] = halfBits(m0 * r + m1 * g + m2 * b);
        out[o + 1] = halfBits(m3 * r + m4 * g + m5 * b);
        out[o + 2] = halfBits(m6 * r + m7 * g + m8 * b);
        out[o + 3] = halfBits(sa / n / 255);
      }
    }
  }

  const swap = rotation === 90 || rotation === 270;
  return {
    data: out,
    width: swap ? h : w,
    height: swap ? w : h,
    fullWidth: swap ? height : width,
    fullHeight: swap ? width : height,
  };
}

function decodeBitmap(source: Blob, decoder: CodeDecoder): Promise<ImageBitmap | null> {
  if (decoder === "tiff") return decodeTiff(source);
  if (decoder === "netpbm") return decodeNetpbm(source);
  // "none" leaves the codes as the file holds them: the transform is the
  // profile, so the browser's own conversion to sRGB would apply it twice.
  return createImageBitmap(source, { colorSpaceConversion: "none", imageOrientation: "none" });
}

/** The file's 8-bit RGBA codes, unconverted: drawn into an sRGB canvas, which
 *  takes an unmanaged bitmap's codes as they are. */
export async function readCodes(
  source: Blob,
  decoder: CodeDecoder,
): Promise<{ codes: Uint8ClampedArray; width: number; height: number }> {
  const bitmap = await decodeBitmap(source, decoder);
  if (!bitmap) throw new Error("the file could not be decoded");
  const { width, height } = bitmap;
  let ctx: OffscreenCanvasRenderingContext2D | null;
  // Closed once drawn, before the codes are copied out: a full-size export
  // would otherwise hold the bitmap, the canvas and the copy at once.
  try {
    ctx = new OffscreenCanvas(width, height).getContext("2d", {
      colorSpace: "srgb",
      willReadFrequently: true,
    });
    if (!ctx) throw new Error("no 2D context to read the file's codes");
    ctx.drawImage(bitmap, 0, 0);
  } finally {
    bitmap.close();
  }
  return { codes: ctx.getImageData(0, 0, width, height).data, width, height };
}

export async function buildProfileFrame(job: ProfileJob): Promise<HalfFrame> {
  const { codes, width, height } = await readCodes(job.source, job.decoder);
  return linearizeCodes(codes, width, height, job.transform, job.turn, job.targetEdge);
}

/** One message of the frame worker, whatever its op: the reply, and the
 *  buffers that go with it. Never rejects. */
export async function answerFrameRequest(
  req: FrameRequest,
): Promise<{ reply: FrameReply; transfer: Transferable[] }> {
  if (req.op !== "profile") return handleFrameRequest(req);
  try {
    const frame = await buildProfileFrame(req.job);
    return { reply: { id: req.id, op: "profile", frame }, transfer: [frame.data.buffer] };
  } catch (e) {
    return {
      reply: { id: req.id, op: "error", message: e instanceof Error ? e.message : String(e) },
      transfer: [],
    };
  }
}
