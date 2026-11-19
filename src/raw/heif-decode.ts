// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The pixel work of a HEIF decode, run in heif.worker.ts or, with no Worker,
// inline; libheif is handed in, never imported, so nothing here loads it.
// libheif turns and mirrors the primary image upright (irot, imir, clap) and
// returns its RGB at the file's bit depth, in the file's own primaries and
// transfer; each channel's codes go through the file's decode curve and the
// three through its matrix into linear Rec.709, nothing clamped. The frame is
// averaged down in linear light, turned and kept as half floats, as a non-RAW
// photo read through an input profile is (profile-frame.ts); the thumbnail is
// averaged the same way, then clipped and sRGB-encoded.
//
// An extension decoder's linear or 8-bit sRGB result takes the same path,
// with identity curves (or sRGB's) and matrix.

import { normalizeRotation } from "@/catalog/orient";
import { heifInputColour, SRGB_INPUT, type InputColour } from "@/rendering/input-colour";
import type { LibHeif } from "libheif-js/libheif-wasm/libheif-bundle.mjs";
import { placement } from "./frame-job";
import { halfBits } from "./half-float";
import { readHeifContainer, type HeifContainer } from "./heif-container";
import type { HalfFrame } from "./profile-frame";

/** The largest image decoded, in pixels: past it libheif's RGB alone would
 *  outgrow what a wasm heap can hold beside the coded data. */
export const MAX_HEIF_PIXELS = 100_000_000;

export interface FrameShape {
  /** The long edge to average the frame down to; full size without one. */
  targetEdge?: number;
  /** Clockwise degrees (a quarter-turn step) to bake into the frame. */
  turn?: number;
}

export type HeifFailure = { ok: false; reason: string };

export type HeifFrameDecode =
  | { ok: true; frame: HalfFrame; sourceWidth: number; sourceHeight: number; hdr: boolean }
  | HeifFailure;

export type HeifThumbDecode =
  | {
      ok: true;
      /** RGBA, sRGB-encoded, alpha opaque. */
      data: Uint8ClampedArray<ArrayBuffer>;
      width: number;
      height: number;
      /** The upright image's full size. */
      sourceWidth: number;
      sourceHeight: number;
    }
  | HeifFailure;

/** An extension decoder's pixels, RGBA rows top-down: linear Rec.709 floats
 *  or 8-bit sRGB codes. */
export type PixelImage =
  | { kind: "linear"; data: Float32Array; width: number; height: number }
  | { kind: "rgba8"; data: Uint8ClampedArray | Uint8Array; width: number; height: number };

type Tables = readonly [Float32Array, Float32Array, Float32Array];

/** Samples to average: `channels` to a pixel, `rowStride` to a row, each
 *  channel's codes looked up in `tables`, or, with none, read as linear
 *  values with anything not finite as 0. */
interface Plane {
  data: ArrayLike<number>;
  width: number;
  height: number;
  channels: number;
  rowStride: number;
  tables: Tables | null;
}

type BoxVisitor = (x: number, y: number, r: number, g: number, b: number) => void;

const finite = (v: number): number => (v - v === 0 ? v : 0);

function outputSize(width: number, height: number, edge: number | undefined): [number, number] {
  const scale = edge ? Math.min(1, edge / Math.max(width, height)) : 1;
  return scale < 1
    ? [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))]
    : [width, height];
}

/** Each of the `w` × `h` boxes `plane` divides into, its linear channels averaged. */
function averageBoxes(plane: Plane, w: number, h: number, visit: BoxVisitor): void {
  const { data, width, height, channels, rowStride, tables } = plane;
  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor((y * height) / h);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * height) / h));
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor((x * width) / w);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * width) / w));
      let sr = 0, sg = 0, sb = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        const end = sy * rowStride + sx1 * channels;
        let s = sy * rowStride + sx0 * channels;
        if (tables) {
          const [red, green, blue] = tables;
          for (; s < end; s += channels) {
            sr += red[data[s]];
            sg += green[data[s + 1]];
            sb += blue[data[s + 2]];
          }
        } else {
          for (; s < end; s += channels) {
            sr += finite(data[s]);
            sg += finite(data[s + 1]);
            sb += finite(data[s + 2]);
          }
        }
      }
      const n = (sy1 - sy0) * (sx1 - sx0);
      visit(x, y, sr / n, sg / n, sb / n);
    }
  }
}

const HALF_ONE = halfBits(1);

function toHalfFrame(plane: Plane, toRec709: readonly number[], shape: FrameShape): HalfFrame {
  const { width, height } = plane;
  const [w, h] = outputSize(width, height, shape.targetEdge);
  const rotation = normalizeRotation(shape.turn ?? 0);
  const { base, dx, dy } = placement(w, h, rotation);
  const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = toRec709;
  const out = new Uint16Array(w * h * 4);
  averageBoxes(plane, w, h, (x, y, r, g, b) => {
    const o = base + x * dx + y * dy;
    out[o] = halfBits(finite(m0 * r + m1 * g + m2 * b));
    out[o + 1] = halfBits(finite(m3 * r + m4 * g + m5 * b));
    out[o + 2] = halfBits(finite(m6 * r + m7 * g + m8 * b));
    out[o + 3] = HALF_ONE;
  });
  const swap = rotation === 90 || rotation === 270;
  return {
    data: out,
    width: swap ? h : w,
    height: swap ? w : h,
    fullWidth: swap ? height : width,
    fullHeight: swap ? width : height,
  };
}

const srgbEncode = (v: number): number =>
  Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));

function toThumb(
  plane: Plane,
  toRec709: readonly number[],
  maxEdge: number,
): { data: Uint8ClampedArray<ArrayBuffer>; width: number; height: number } {
  const [w, h] = outputSize(plane.width, plane.height, maxEdge);
  const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = toRec709;
  const out = new Uint8ClampedArray(w * h * 4);
  const clip = (v: number) => (v > 0 ? (v < 1 ? v : 1) : 0);
  averageBoxes(plane, w, h, (x, y, r, g, b) => {
    const o = (y * w + x) * 4;
    out[o] = srgbEncode(clip(m0 * r + m1 * g + m2 * b));
    out[o + 1] = srgbEncode(clip(m3 * r + m4 * g + m5 * b));
    out[o + 2] = srgbEncode(clip(m6 * r + m7 * g + m8 * b));
    out[o + 3] = 255;
  });
  return { data: out, width: w, height: h };
}

function codeTables(colour: InputColour, bits: number): Tables {
  const max = (1 << bits) - 1;
  const table = (curve: (v: number) => number) => {
    const out = new Float32Array(max + 1);
    for (let code = 0; code <= max; code++) out[code] = finite(curve(code / max));
    return out;
  };
  const [r, g, b] = colour.curves;
  const red = table(r);
  return [red, g === r ? red : table(g), b === r ? red : table(b)];
}

const tooLarge = (width: number, height: number): HeifFailure => ({
  ok: false,
  reason: `the image is too large to decode (${width} × ${height})`,
});

const isError = (value: object): value is { message: string } => "code" in value && !("channels" in value);

/** The primary image of `bytes` decoded upright to RRGGBB, as a plane through
 *  the file's colour, handed to `use` before libheif's buffers are released. */
function withDecodedPlane<T>(
  lib: LibHeif,
  bytes: Uint8Array,
  container: HeifContainer | null,
  use: (plane: Plane, colour: InputColour) => T,
): T | HeifFailure {
  if (container && container.width * container.height > MAX_HEIF_PIXELS) {
    return tooLarge(container.width, container.height);
  }
  const context = lib.heif_context_alloc();
  try {
    const read = lib.heif_context_read_from_memory(context, bytes);
    if (read.code.value !== 0) return { ok: false, reason: read.message || "libheif could not read the file" };
    const handle = lib.heif_js_context_get_primary_image_handle(context);
    if (isError(handle)) return { ok: false, reason: handle.message || "the file has no primary image" };
    try {
      const width = lib.heif_image_handle_get_width(handle);
      const height = lib.heif_image_handle_get_height(handle);
      if (width * height > MAX_HEIF_PIXELS) return tooLarge(width, height);
      const decoded = lib.heif_js_decode_image2(
        handle,
        lib.heif_colorspace.heif_colorspace_RGB,
        lib.heif_chroma.heif_chroma_interleaved_RRGGBB_LE,
      );
      if (isError(decoded)) return { ok: false, reason: decoded.message || "libheif could not decode the image" };
      try {
        const channel = decoded.channels[0];
        if (!channel || channel.width * channel.height === 0) return { ok: false, reason: "libheif returned no pixels" };
        const declared = channel.bits_per_pixel;
        const bits = declared >= 1 && declared <= 16 ? declared : 16;
        const { data } = channel;
        const samples =
          data.byteOffset % 2 === 0
            ? new Uint16Array(data.buffer, data.byteOffset, data.byteLength >> 1)
            : new Uint16Array(data.slice().buffer);
        const colour = container ? heifInputColour(container) : SRGB_INPUT;
        const plane: Plane = {
          data: samples,
          width: channel.width,
          height: channel.height,
          channels: 3,
          rowStride: channel.stride >> 1,
          tables: codeTables(colour, bits),
        };
        return use(plane, colour);
      } finally {
        lib.heif_image_release(decoded.image);
      }
    } finally {
      lib.heif_image_handle_release(handle);
    }
  } finally {
    lib.heif_context_free(context);
  }
}

/** The primary image of the HEIF `bytes` as a linear Rec.709 frame. */
export function decodeHeifFrameBytes(
  lib: LibHeif,
  bytes: Uint8Array,
  container: HeifContainer | null,
  shape: FrameShape,
): HeifFrameDecode {
  return withDecodedPlane(lib, bytes, container, (plane, colour) => ({
    ok: true as const,
    frame: toHalfFrame(plane, colour.toRec709, shape),
    sourceWidth: plane.width,
    sourceHeight: plane.height,
    hdr: colour.hdr,
  }));
}

/** The primary image of the HEIF `bytes` as an sRGB thumbnail no longer
 *  than `maxEdge`. */
export function decodeHeifThumbBytes(
  lib: LibHeif,
  bytes: Uint8Array,
  container: HeifContainer | null,
  maxEdge: number,
): HeifThumbDecode {
  return withDecodedPlane(lib, bytes, container, (plane, colour) => ({
    ok: true as const,
    ...toThumb(plane, colour.toRec709, maxEdge),
    sourceWidth: plane.width,
    sourceHeight: plane.height,
  }));
}

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function pixelPlane(image: PixelImage): Plane {
  const { data, width, height } = image;
  if (!(width > 0 && height > 0) || data.length < width * height * 4) {
    throw new Error(`the pixels don't fill ${width} × ${height}`);
  }
  let tables: Tables | null = null;
  if (image.kind === "rgba8") {
    const srgb = codeTables(SRGB_INPUT, 8)[0];
    tables = [srgb, srgb, srgb];
  }
  return { data, width, height, channels: 4, rowStride: width * 4, tables };
}

/** An extension decoder's linear Rec.709 RGBA as the frame a HEIF decode
 *  gives: averaged down, turned, anything not finite as 0. */
export function linearToHalfFrame(data: Float32Array, width: number, height: number, shape: FrameShape): HalfFrame {
  return toHalfFrame(pixelPlane({ kind: "linear", data, width, height }), IDENTITY, shape);
}

/** An extension decoder's pixels as an sRGB thumbnail no longer than `maxEdge`. */
export function pixelsToThumb(
  image: PixelImage,
  maxEdge: number,
): { data: Uint8ClampedArray<ArrayBuffer>; width: number; height: number } {
  return toThumb(pixelPlane(image), IDENTITY, maxEdge);
}

export type HeifRequest =
  | { id: number; op: "frame"; file: Blob; targetEdge?: number; turn: number }
  | { id: number; op: "thumb"; file: Blob; maxEdge: number }
  | { id: number; op: "linear-frame"; data: Float32Array; width: number; height: number; targetEdge?: number; turn: number }
  | { id: number; op: "pixels-thumb"; image: PixelImage; maxEdge: number };

/** A thumbnail as an ImageBitmap where the thread can make one, else its RGBA. */
export type ThumbImage =
  | { kind: "bitmap"; bitmap: ImageBitmap }
  | { kind: "rgba8"; data: Uint8ClampedArray<ArrayBuffer> };

export type HeifReply =
  | { id: number; op: "frame"; frame: HalfFrame; sourceWidth: number; sourceHeight: number; hdr: boolean }
  | { id: number; op: "thumb"; image: ThumbImage; width: number; height: number; sourceWidth: number; sourceHeight: number }
  | { id: number; op: "linear-frame"; frame: HalfFrame }
  | { id: number; op: "pixels-thumb"; image: ThumbImage; width: number; height: number }
  | { id: number; op: "error"; message: string; fatal: boolean };

export interface HeifAnswer {
  reply: HeifReply;
  transfer: Transferable[];
}

async function thumbImage(
  data: Uint8ClampedArray<ArrayBuffer>,
  width: number,
  height: number,
): Promise<{ image: ThumbImage; transfer: Transferable[] }> {
  if (typeof createImageBitmap !== "function" || typeof ImageData !== "function") {
    return { image: { kind: "rgba8", data }, transfer: [data.buffer] };
  }
  const bitmap = await createImageBitmap(new ImageData(data, width, height));
  return { image: { kind: "bitmap", bitmap }, transfer: [bitmap] };
}

/** The HEIF `file`'s container and bytes, unless its declared size is past the cap. */
async function readHeif(file: Blob): Promise<{ bytes: Uint8Array; container: HeifContainer | null } | HeifFailure> {
  const container = await readHeifContainer(file);
  if (container && container.width * container.height > MAX_HEIF_PIXELS) {
    return tooLarge(container.width, container.height);
  }
  return { bytes: new Uint8Array(await file.arrayBuffer()), container };
}

async function answer(loadLib: () => Promise<LibHeif>, req: HeifRequest): Promise<HeifAnswer> {
  const { id } = req;
  const failed = (reason: string): HeifAnswer => ({ reply: { id, op: "error", message: reason, fatal: false }, transfer: [] });
  switch (req.op) {
    case "frame": {
      const read = await readHeif(req.file);
      if ("ok" in read) return failed(read.reason);
      const result = decodeHeifFrameBytes(await loadLib(), read.bytes, read.container, req);
      if (!result.ok) return failed(result.reason);
      const { frame, sourceWidth, sourceHeight, hdr } = result;
      return { reply: { id, op: "frame", frame, sourceWidth, sourceHeight, hdr }, transfer: [frame.data.buffer] };
    }
    case "thumb": {
      const read = await readHeif(req.file);
      if ("ok" in read) return failed(read.reason);
      const result = decodeHeifThumbBytes(await loadLib(), read.bytes, read.container, req.maxEdge);
      if (!result.ok) return failed(result.reason);
      const { width, height, sourceWidth, sourceHeight } = result;
      const { image, transfer } = await thumbImage(result.data, width, height);
      return { reply: { id, op: "thumb", image, width, height, sourceWidth, sourceHeight }, transfer };
    }
    case "linear-frame": {
      const frame = linearToHalfFrame(req.data, req.width, req.height, req);
      return { reply: { id, op: "linear-frame", frame }, transfer: [frame.data.buffer] };
    }
    case "pixels-thumb": {
      const { data, width, height } = pixelsToThumb(req.image, req.maxEdge);
      const { image, transfer } = await thumbImage(data, width, height);
      return { reply: { id, op: "pixels-thumb", image, width, height }, transfer };
    }
  }
}

/** One request of the HEIF worker: its reply and the buffers that go with it.
 *  Never rejects; an error reply is `fatal` when libheif's wasm trapped, after
 *  which its module can't be used again. */
export async function answerHeifRequest(loadLib: () => Promise<LibHeif>, req: HeifRequest): Promise<HeifAnswer> {
  try {
    return await answer(loadLib, req);
  } catch (e) {
    return {
      reply: {
        id: req.id,
        op: "error",
        message: e instanceof Error ? e.message : String(e),
        fatal: e instanceof WebAssembly.RuntimeError,
      },
      transfer: [],
    };
  }
}
