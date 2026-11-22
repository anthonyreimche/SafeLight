// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The in-house decoder for linear DNGs: LinearRaw images, already demosaiced,
// as HDR and panorama merges, denoised exports and "linear DNG" conversions
// write them. Their floating-point samples (16, 24 or 32 bits) come
// Deflate-compressed behind the floating-point predictor, which the bundled
// libraw can't read, so this decoder leads for them; integer ones it reads
// only where libraw fails (decode.ts).
//
// It reads uncompressed and Deflate data, in tiles or strips, with no predictor,
// the horizontal one (integer samples) or the floating-point one, each also in
// DNG's two- and four-sample forms; it scales by BlackLevel and WhiteLevel,
// crops to ActiveArea and DefaultCrop, and brings the samples into linear
// Rec.709 as libraw reads the file's colour tags (dng-colour.ts), balanced for
// the as-shot white, as a libraw decode comes out. Like libraw's, it leaves
// BaselineExposure out of the pixels. Each sample goes straight to its place in
// the frame turned by the file's Orientation, so the frame is the one large
// buffer. Runs in the frame worker, off the main thread (frame-bridge.ts).

import { normalizeRotation, orientationToRotation } from "@/catalog/orient";
import { encodeCacheEntry } from "./cache-encode";
import { MAX_DECODE_PIXELS } from "./decode-limits";
import { dngColour, type DngCalibration, type DngColourTags } from "./dng-colour";
import { placement, type BuiltFrame } from "./frame-job";
import { halfToFloatTable } from "./half-float";
import { COMPRESSION, PHOTOMETRIC_LINEAR_RAW, TIFF_TAG, TiffReader, type Ifd, type TiffEntry } from "./tiff";

export interface LinearDngJob {
  /** The file's bytes. */
  buffer: ArrayBuffer;
  /** Clockwise degrees (a quarter-turn step) to turn on top of the file's Orientation. */
  turn: number;
  /** The long edge the caller renders from: half size will do when half the frame reaches it. */
  targetEdge?: number;
  /** Also build the develop-preview cache entry, with a preview of this long edge. */
  cacheEdge?: number;
  /** The most memory, in bytes, the frame and the file may take together
   *  (MEMORY_BUDGET unless given). */
  memoryBudget?: number;
}

export interface LinearDngFrame extends BuiltFrame {
  colorTemperature?: number;
  asShotMultipliers?: [number, number, number];
  /** Decoded at half size: the frame's size at full resolution, upright. */
  sourceWidth?: number;
  sourceHeight?: number;
}

/** A file that can't be read says why; `tooLarge` when its frame passes the
 *  memory budget even at half size, so reading it again would only do the
 *  same; `transient` when memory ran short under the budget, which may pass. */
export type LinearDngResult = { rejected: string; tooLarge?: boolean; transient?: boolean } | LinearDngFrame;

// The heap libraw's decode is held to (libraw-wasm-adapter.ts HEAP_BUDGET):
// past it at full size the decode goes to half size, as libraw's does.
const MEMORY_BUDGET = 1_950_000_000;
// Four float channels a pixel.
const FRAME_BYTES_PER_PIXEL = 16;
// Tags that are lists of a few values each; a damaged count can't make them more.
const LIST_LIMIT = 65_536;

const SAMPLE_FORMAT_FLOAT = 3;
const CHUNKY = 1;
const SUBFILE_MAIN_IMAGE = 0;

const PREDICTOR = {
  None: 1,
  Horizontal: 2,
  FloatingPoint: 3,
  HorizontalX2: 34892,
  HorizontalX4: 34893,
  FloatingPointX2: 34894,
  FloatingPointX4: 34895,
} as const;

// How far apart, in pixels, each predictor differences its samples.
const INTEGER_PREDICTORS: ReadonlyMap<number, number> = new Map([
  [PREDICTOR.None, 0],
  [PREDICTOR.Horizontal, 1],
  [PREDICTOR.HorizontalX2, 2],
  [PREDICTOR.HorizontalX4, 4],
]);
const FLOAT_PREDICTORS: ReadonlyMap<number, number> = new Map([
  [PREDICTOR.None, 0],
  [PREDICTOR.FloatingPoint, 1],
  [PREDICTOR.FloatingPointX2, 2],
  [PREDICTOR.FloatingPointX4, 4],
]);

const COMPRESSIONS: ReadonlySet<number> = new Set([COMPRESSION.None, COMPRESSION.Deflate, COMPRESSION.DeflateLegacy]);

const isCount = (v: number | undefined): v is number => v !== undefined && Number.isInteger(v) && v >= 1;

/** The main image's layout, as far as this decoder reads it. */
interface Layout {
  ifd: Ifd;
  width: number;
  height: number;
  samples: 1 | 3;
  bytesPerSample: number;
  float: boolean;
  compressed: boolean;
  /** Pixels between the samples the predictor differences; 0 for none. */
  predictorStep: number;
  chunkWidth: number;
  chunkHeight: number;
  /** Chunks across a row of them: 1 for strips. */
  across: number;
  offsets: number[];
  counts: number[];
}

/** Which linear DNGs this decoder reads: a floating-point one it leads for,
 *  an integer one it can stand in for. Anything else is libraw's. */
export function linearDngKind(buffer: ArrayBuffer): "float" | "integer" | null {
  try {
    const layout = layoutOf(new TiffReader(buffer));
    if (layout === null || typeof layout === "string") return null;
    return layout.float ? "float" : "integer";
  } catch {
    return null;
  }
}

// The full-resolution LinearRaw image (NewSubFileType 0), the largest when a
// file has several; a string says why it can't be read, null that there is none.
function layoutOf(reader: TiffReader): Layout | string | null {
  let main: { ifd: Ifd; width: number; height: number } | null = null;
  for (const ifd of reader.ifds) {
    if (reader.first(ifd.get(TIFF_TAG.PhotometricInterpretation)) !== PHOTOMETRIC_LINEAR_RAW) continue;
    if ((reader.first(ifd.get(TIFF_TAG.NewSubFileType)) ?? SUBFILE_MAIN_IMAGE) !== SUBFILE_MAIN_IMAGE) continue;
    const width = reader.first(ifd.get(TIFF_TAG.ImageWidth));
    const height = reader.first(ifd.get(TIFF_TAG.ImageLength));
    if (!isCount(width) || !isCount(height)) continue;
    if (!main || width * height > main.width * main.height) main = { ifd, width, height };
  }
  if (!main) return null;
  const { ifd, width, height } = main;
  const tag = (t: number): number | undefined => reader.first(ifd.get(t));

  const samples = tag(TIFF_TAG.SamplesPerPixel) ?? 1;
  const bits = tag(TIFF_TAG.BitsPerSample) ?? 1;
  const float = tag(TIFF_TAG.SampleFormat) === SAMPLE_FORMAT_FLOAT;
  const compression = tag(TIFF_TAG.Compression) ?? COMPRESSION.None;
  const predictor = tag(TIFF_TAG.Predictor) ?? PREDICTOR.None;
  const predictorStep = (float ? FLOAT_PREDICTORS : INTEGER_PREDICTORS).get(predictor);
  if (samples !== 1 && samples !== 3) return `${samples} samples a pixel`;
  if (!(float ? [16, 24, 32] : [8, 16, 32]).includes(bits)) return `${bits}-bit ${float ? "floating-point" : "integer"} samples`;
  if (!COMPRESSIONS.has(compression)) return `compression ${compression}`;
  if (predictorStep === undefined) return `predictor ${predictor}`;
  if ((tag(TIFF_TAG.PlanarConfiguration) ?? CHUNKY) !== CHUNKY) return "planar samples";

  const tiled = ifd.has(TIFF_TAG.TileOffsets);
  const chunkWidth = tiled ? tag(TIFF_TAG.TileWidth) : width;
  const chunkHeight = tiled ? tag(TIFF_TAG.TileLength) : Math.min(height, tag(TIFF_TAG.RowsPerStrip) ?? height);
  if (!isCount(chunkWidth) || !isCount(chunkHeight)) return "no tile or strip size";
  const across = Math.ceil(width / chunkWidth);
  const chunks = across * Math.ceil(height / chunkHeight);
  const offsetsEntry = ifd.get(tiled ? TIFF_TAG.TileOffsets : TIFF_TAG.StripOffsets);
  const countsEntry = ifd.get(tiled ? TIFF_TAG.TileByteCounts : TIFF_TAG.StripByteCounts);
  if (!offsetsEntry || !countsEntry || offsetsEntry.count < chunks || countsEntry.count < chunks) {
    return `fewer ${tiled ? "tiles" : "strips"} than the image needs`;
  }
  return {
    ifd,
    width,
    height,
    samples,
    bytesPerSample: bits / 8,
    float,
    compressed: compression !== COMPRESSION.None,
    predictorStep,
    chunkWidth,
    chunkHeight,
    across,
    offsets: reader.values(offsetsEntry, chunks),
    counts: reader.values(countsEntry, chunks),
  };
}

/** The linear DNG in `job.buffer` as a linear Rec.709 RGBA frame, turned
 *  upright, or why it can't be read. */
export async function decodeLinearDng(job: LinearDngJob): Promise<LinearDngResult> {
  let reader: TiffReader;
  try {
    reader = new TiffReader(job.buffer);
  } catch (e) {
    return { rejected: `not a readable DNG (${describe(e)})` };
  }
  const layout = layoutOf(reader);
  if (layout === null) return { rejected: "no linear DNG image in the file" };
  if (typeof layout === "string") return { rejected: `linear DNG with ${layout}` };

  const crop = cropOf(reader, layout);
  if (!(crop.width >= 1 && crop.height >= 1)) return { rejected: "the DNG's crop leaves no image" };
  const tooLarge = { rejected: `too large to decode (${crop.width}×${crop.height})`, tooLarge: true };
  if (crop.width * crop.height > MAX_DECODE_PIXELS) return tooLarge;
  const budget = job.memoryBudget ?? MEMORY_BUDGET;
  const fits = (half: boolean): boolean =>
    sizeOf(crop, half).pixels * FRAME_BYTES_PER_PIXEL + job.buffer.byteLength <= budget;
  const halvable = Math.min(crop.width, crop.height) >= 2;
  const wanted = halvable && !!job.targetEdge && Math.floor(Math.max(crop.width, crop.height) / 2) >= job.targetEdge;
  if (!fits(halvable)) return tooLarge;
  const shortOfMemory = { rejected: `out of memory for ${crop.width}×${crop.height} now`, transient: true };

  const ifd0 = reader.ifds[0];
  const upright = orientationToRotation(reader.first(ifd0.get(TIFF_TAG.Orientation)));
  const turn = normalizeRotation(upright + job.turn);
  let half = wanted || !fits(false);
  let data: Float32Array<ArrayBuffer>;
  try {
    data = await readFrame(new Uint8Array(job.buffer), reader, layout, crop, half, turn);
  } catch (e) {
    // Short of memory at full size: half size needs a quarter of it. Short of
    // it within the budget is the machine's state, not the file's.
    if (!(e instanceof RangeError)) return unreadable(e);
    if (half || !halvable) return shortOfMemory;
    half = true;
    try {
      data = await readFrame(new Uint8Array(job.buffer), reader, layout, crop, half, turn);
    } catch (again) {
      return again instanceof RangeError ? shortOfMemory : unreadable(again);
    }
  }

  const colour = dngColour(colourTags(reader, ifd0, layout));
  toRec709(data, layout.samples === 3 ? colour.cameraToSrgb : [1, 0, 0, 0, 1, 0, 0, 0, 1]);

  const { width, height } = sizeOf(crop, half);
  const quarter = turn === 90 || turn === 270;
  const outWidth = quarter ? height : width;
  const outHeight = quarter ? width : height;
  const entry = job.cacheEdge ? encodeCacheEntry(data, outWidth, outHeight, job.cacheEdge) : undefined;
  // The source size is upright as the file's Orientation stands it, as libraw reports it.
  const uprightQuarter = upright === 90 || upright === 270;
  return {
    data,
    width: outWidth,
    height: outHeight,
    ...(entry ? { entry } : {}),
    ...(layout.samples === 3 && colour.colorTemperature ? { colorTemperature: colour.colorTemperature } : {}),
    ...(layout.samples === 3 && colour.asShotMultipliers ? { asShotMultipliers: colour.asShotMultipliers } : {}),
    ...(half
      ? {
          sourceWidth: uprightQuarter ? crop.height : crop.width,
          sourceHeight: uprightQuarter ? crop.width : crop.height,
        }
      : {}),
  };
}

const describe = (e: unknown): string => (e instanceof Error ? e.message : String(e));

const unreadable = (e: unknown): LinearDngResult => ({ rejected: `the linear DNG's data can't be read (${describe(e)})` });

interface Crop {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The frame decoded from `crop`: the crop itself, or half of it. */
function sizeOf(crop: Crop, half: boolean): { width: number; height: number; pixels: number } {
  const width = half ? crop.width >> 1 : crop.width;
  const height = half ? crop.height >> 1 : crop.height;
  return { width, height, pixels: width * height };
}

/** The area kept, in the image's pixels: DefaultCrop within ActiveArea. A value
 *  that isn't a number leaves its default. */
function cropOf(reader: TiffReader, { ifd, width, height }: Layout): Crop {
  const list = (tag: number, defaults: number[]): number[] => {
    const e = ifd.get(tag);
    const values = e ? reader.values(e, defaults.length) : [];
    return defaults.map((d, i) => (Number.isFinite(values[i]) ? values[i] : d));
  };
  const [top, left, bottom, right] = list(TIFF_TAG.ActiveArea, [0, 0, height, width]);
  const [originX, originY] = list(TIFF_TAG.DefaultCropOrigin, [0, 0]);
  const [sizeX, sizeY] = list(TIFF_TAG.DefaultCropSize, [right - left, bottom - top]);
  const x = Math.max(0, Math.min(width, Math.round(left + originX)));
  const y = Math.max(0, Math.min(height, Math.round(top + originY)));
  return {
    x,
    y,
    width: Math.max(0, Math.min(width - x, Math.round(sizeX))),
    height: Math.max(0, Math.min(height - y, Math.round(sizeY))),
  };
}

interface Levels {
  black: number[];
  /** 1 / (white - black), per sample. */
  scale: number[];
  /** An integer file's LinearizationTable. */
  table?: number[];
}

function levelsOf(reader: TiffReader, { ifd, samples, float, bytesPerSample }: Layout): Levels {
  const list = (tag: number): number[] => {
    const e = ifd.get(tag);
    return e ? reader.values(e, LIST_LIMIT).filter(Number.isFinite) : [];
  };
  const table = float ? [] : list(TIFF_TAG.LinearizationTable);
  const blacks = list(TIFF_TAG.BlackLevel);
  const whites = list(TIFF_TAG.WhiteLevel);
  const defaultWhite = float ? 1 : table.length ? table[table.length - 1] : 2 ** (8 * bytesPerSample) - 1;
  // A black level that repeats over a pattern of pixels gives one value per
  // sample per pixel of it: each sample takes the mean of its own.
  const black = Array.from({ length: samples }, (_, c) => {
    const own = blacks.filter((_, i) => i % samples === c);
    return own.length ? own.reduce((a, b) => a + b, 0) / own.length : (blacks[0] ?? 0);
  });
  const scale = black.map((b, c) => {
    const white = whites[c] ?? whites[0] ?? defaultWhite;
    return white > b ? 1 / (white - b) : 1;
  });
  return { black, scale, ...(table.length ? { table } : {}) };
}

/** Where samples go: the crop (halved or not), turned. */
interface Placement {
  crop: Crop;
  half: boolean;
  /** The decoded frame's size before the turn. */
  width: number;
  height: number;
  /** Float offset of frame pixel (x, y): base + x * dx + y * dy. */
  base: number;
  dx: number;
  dy: number;
}

/** Concurrent inflates: enough to keep the browser's zlib busy, few enough
 *  that their output stays small. */
const INFLATE_BATCH = 8;

/** The frame's camera samples, scaled 0 to 1, each at its place in the turned
 *  frame. A frame too big for memory throws a RangeError. */
async function readFrame(
  file: Uint8Array<ArrayBuffer>,
  reader: TiffReader,
  layout: Layout,
  crop: Crop,
  half: boolean,
  turn: number,
): Promise<Float32Array<ArrayBuffer>> {
  const { width, height, pixels } = sizeOf(crop, half);
  const data = new Float32Array(pixels * 4);
  const at: Placement = { crop, half, width, height, ...placement(width, height, turn) };
  const levels = levelsOf(reader, layout);
  const { chunkWidth, chunkHeight, across, offsets, counts } = layout;
  const wanted: number[] = [];
  for (let i = 0; i < offsets.length; i++) {
    const top = Math.floor(i / across) * chunkHeight;
    const left = (i % across) * chunkWidth;
    const meets = top < crop.y + crop.height && top + chunkHeight > crop.y && left < crop.x + crop.width && left + chunkWidth > crop.x;
    if (meets && top < layout.height) wanted.push(i);
  }
  for (let start = 0; start < wanted.length; start += INFLATE_BATCH) {
    const batch = wanted.slice(start, start + INFLATE_BATCH);
    const stored = batch.map((i) => {
      const from = reader.base + offsets[i];
      const to = from + counts[i];
      if (!(counts[i] >= 1) || !(to <= file.length)) throw new Error(`${chunkName(layout)} ${i} runs past the end of the file`);
      return file.subarray(from, to);
    });
    const chunks = layout.compressed
      ? await Promise.all(stored.map((s, k) => inflate(s, chunkBytes(layout, batch[k]))))
      : stored;
    batch.forEach((i, k) => readChunk(layout, levels, i, chunks[k], reader.le, at, data));
  }
  return data;
}

const chunkName = (layout: Layout): string => (layout.across > 1 || layout.chunkWidth < layout.width ? "tile" : "strip");

/** The bytes tile or strip `index` holds: a tile is stored whole, the last
 *  strip only as far as the image goes. */
function chunkBytes(layout: Layout, index: number): number {
  const top = Math.floor(index / layout.across) * layout.chunkHeight;
  const rows = Math.min(layout.chunkHeight, layout.height - top);
  return rows * layout.chunkWidth * layout.samples * layout.bytesPerSample;
}

// Stops once `needed` bytes are out, so a stream that inflates past its chunk
// (or ends in padding) costs no more than the chunk.
async function inflate(bytes: Uint8Array<ArrayBuffer>, needed: number): Promise<Uint8Array<ArrayBuffer>> {
  const source = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const reader = source.pipeThrough(new DecompressionStream("deflate")).getReader();
  const out = new Uint8Array(needed);
  let filled = 0;
  try {
    while (filled < needed) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = Math.min(value.length, needed - filled);
      out.set(value.subarray(0, take), filled);
      filled += take;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return filled < needed ? out.subarray(0, filled) : out;
}

function codesFor(size: number, n: number): Uint8Array | Uint16Array | Uint32Array {
  return size === 1 ? new Uint8Array(n) : size === 2 ? new Uint16Array(n) : new Uint32Array(n);
}

// One tile or strip: each row's samples restored from the predictor, read as
// numbers, scaled between black and white, and laid into the frame (or added,
// a quarter each, into its half-size pixel).
function readChunk(
  layout: Layout,
  levels: Levels,
  index: number,
  bytes: Uint8Array,
  littleEndian: boolean,
  at: Placement,
  data: Float32Array,
): void {
  const { chunkWidth, chunkHeight, across, samples, bytesPerSample, width, height } = layout;
  const top = Math.floor(index / across) * chunkHeight;
  const left = (index % across) * chunkWidth;
  const rows = Math.min(chunkHeight, height - top);
  const rowValues = chunkWidth * samples;
  const rowBytes = rowValues * bytesPerSample;
  const needed = rows * rowBytes;
  if (bytes.length < needed) throw new Error(`${chunkName(layout)} ${index} holds ${bytes.length} bytes of ${needed}`);

  const scratch: RowScratch = {
    values: new Float32Array(rowValues),
    deltas: new Uint8Array(rowBytes),
    bytes: new Uint8Array(rowBytes),
    codes: codesFor(bytesPerSample, rowValues),
  };
  const { values } = scratch;
  const { black, scale, table } = levels;
  const { crop, half, base, dx, dy } = at;
  const firstX = Math.max(left, crop.x);
  const lastX = Math.min(left + chunkWidth, width, crop.x + crop.width);
  const weight = half ? 0.25 : 1;
  for (let r = 0; r < rows; r++) {
    const cy = top + r - crop.y;
    if (cy < 0 || cy >= crop.height) continue;
    const oy = half ? cy >> 1 : cy;
    if (oy >= at.height) continue;
    readRow(layout, bytes.subarray(r * rowBytes, (r + 1) * rowBytes), littleEndian, scratch);
    for (let x = firstX; x < lastX; x++) {
      const cx = x - crop.x;
      const ox = half ? cx >> 1 : cx;
      if (ox >= at.width) continue;
      const o = base + ox * dx + oy * dy;
      const s = (x - left) * samples;
      for (let c = 0; c < samples; c++) {
        let v = values[s + c];
        if (table) v = table[Math.max(0, Math.min(table.length - 1, v))];
        v = (v - black[c]) * scale[c];
        if (v - v !== 0) v = 0;
        if (samples === 1) {
          data[o] += v * weight;
          data[o + 1] += v * weight;
          data[o + 2] += v * weight;
        } else {
          data[o + c] += v * weight;
        }
      }
    }
  }
}

/** A chunk's working rows, made once per chunk. */
interface RowScratch {
  values: Float32Array;
  /** The floating-point predictor's bytes, undone. */
  deltas: Uint8Array;
  /** Those bytes put back in sample order. */
  bytes: Uint8Array;
  /** Integer samples, at their own width. */
  codes: Uint8Array | Uint16Array | Uint32Array;
}

// One row's samples as numbers into `scratch.values`; `row` is left as it is.
// The floating-point predictor differences the row's bytes after splitting each
// sample's bytes into planes, most significant first, whatever the file's byte
// order; the horizontal one differences integer samples. Either differences
// `predictorStep` pixels apart.
function readRow(layout: Layout, row: Uint8Array, littleEndian: boolean, scratch: RowScratch): void {
  const { samples, bytesPerSample, float, predictorStep } = layout;
  const { values, deltas, bytes } = scratch;
  const n = values.length;
  const step = predictorStep * samples;
  if (float && step > 0) {
    deltas.set(row);
    for (let i = step; i < deltas.length; i++) deltas[i] = (deltas[i] + deltas[i - step]) & 0xff;
    for (let s = 0; s < n; s++) {
      for (let k = 0; k < bytesPerSample; k++) bytes[s * bytesPerSample + k] = deltas[k * n + s];
    }
    readFloats(bytes, bytesPerSample, false, values);
  } else if (float) {
    readFloats(row, bytesPerSample, littleEndian, values);
  } else {
    readIntegers(row, littleEndian, step, scratch);
  }
}

function readFloats(bytes: Uint8Array, size: number, littleEndian: boolean, values: Float32Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = values.length;
  if (size === 4) {
    for (let i = 0; i < n; i++) values[i] = view.getFloat32(4 * i, littleEndian);
  } else if (size === 2) {
    const half = halfToFloatTable();
    for (let i = 0; i < n; i++) values[i] = half[view.getUint16(2 * i, littleEndian)];
  } else {
    for (let i = 0, p = 0; i < n; i++, p += 3) {
      values[i] = littleEndian ? float24(bytes[p + 2], bytes[p + 1], bytes[p]) : float24(bytes[p], bytes[p + 1], bytes[p + 2]);
    }
  }
}

function readIntegers(bytes: Uint8Array, littleEndian: boolean, step: number, { values, codes }: RowScratch): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = values.length;
  const size = codes.BYTES_PER_ELEMENT;
  for (let i = 0; i < n; i++) {
    codes[i] = size === 1 ? bytes[i] : size === 2 ? view.getUint16(2 * i, littleEndian) : view.getUint32(4 * i, littleEndian);
  }
  // The typed array wraps each sum at the sample's width, as the predictor does.
  if (step > 0) for (let i = step; i < n; i++) codes[i] += codes[i - step];
  for (let i = 0; i < n; i++) values[i] = codes[i];
}

const FLOAT24_POWERS = Float64Array.from({ length: 128 }, (_, e) => 2 ** (e - 63));

/** DNG's 24-bit float from its bytes, most significant first: a sign bit, a
 *  7-bit exponent biased by 63 and a 16-bit mantissa. */
export function float24(b0: number, b1: number, b2: number): number {
  const sign = b0 & 0x80 ? -1 : 1;
  const exponent = b0 & 0x7f;
  const mantissa = (b1 << 8) | b2;
  if (exponent === 0x7f) return mantissa ? NaN : sign * Infinity;
  if (exponent === 0) return sign * mantissa * 2 ** -78;
  return sign * (1 + mantissa / 65536) * FLOAT24_POWERS[exponent];
}

// Camera samples to linear Rec.709 in place; a channel the matrix carries past
// what a float holds becomes 0, which the renderer and the cache can take.
function toRec709(data: Float32Array, matrix: readonly number[]): void {
  const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = matrix;
  for (let o = 0; o < data.length; o += 4) {
    const r = data[o];
    const g = data[o + 1];
    const b = data[o + 2];
    const R = m0 * r + m1 * g + m2 * b;
    const G = m3 * r + m4 * g + m5 * b;
    const B = m6 * r + m7 * g + m8 * b;
    data[o] = R - R === 0 ? R : 0;
    data[o + 1] = G - G === 0 ? G : 0;
    data[o + 2] = B - B === 0 ? B : 0;
    data[o + 3] = 1;
  }
}

// ─── Colour tags ─────────────────────────────────────────────────────────────

function colourTags(reader: TiffReader, ifd0: Ifd, { ifd }: Layout): DngColourTags {
  const entry = (tag: number): TiffEntry | undefined => ifd.get(tag) ?? ifd0.get(tag);
  // A tag of exactly `count` numbers, or none: a 4-colour camera's matrices
  // and neutral don't fit a 3-colour frame.
  const list = (tag: number, count: number): number[] | undefined => {
    const e = entry(tag);
    if (e?.count !== count) return undefined;
    const values = reader.values(e);
    return values.length === count && values.every(Number.isFinite) ? values : undefined;
  };
  const triple = (tag: number): [number, number, number] | undefined => {
    const v = list(tag, 3);
    return v && [v[0], v[1], v[2]];
  };
  // CameraCalibration was measured against one profile: a file that names it
  // applies it only to that profile; one that names none, to any.
  const cameraSignature = text(reader, entry(TIFF_TAG.CameraCalibrationSignature));
  const calibrated = cameraSignature === "" || cameraSignature === text(reader, entry(TIFF_TAG.ProfileCalibrationSignature));
  const calibrations: DngCalibration[] = [];
  const sets = [
    [TIFF_TAG.ColorMatrix1, TIFF_TAG.CalibrationIlluminant1, TIFF_TAG.CameraCalibration1],
    [TIFF_TAG.ColorMatrix2, TIFF_TAG.CalibrationIlluminant2, TIFF_TAG.CameraCalibration2],
  ] as const;
  for (const [colorTag, illuminantTag, calibrationTag] of sets) {
    const colorMatrix = list(colorTag, 9);
    if (!colorMatrix) break;
    const cameraCalibration = calibrated ? list(calibrationTag, 9) : undefined;
    calibrations.push({
      illuminant: list(illuminantTag, 1)?.[0] ?? 0,
      colorMatrix,
      ...(cameraCalibration ? { cameraCalibration } : {}),
    });
  }
  const whiteXY = list(TIFF_TAG.AsShotWhiteXY, 2);
  const analogBalance = triple(TIFF_TAG.AnalogBalance);
  const asShotNeutral = triple(TIFF_TAG.AsShotNeutral);
  return {
    calibrations,
    ...(analogBalance ? { analogBalance } : {}),
    ...(asShotNeutral ? { asShotNeutral } : {}),
    ...(whiteXY ? { asShotWhiteXY: [whiteXY[0], whiteXY[1]] as const } : {}),
  };
}

// A signature tag's text, which DNG allows as ASCII or BYTE.
function text(reader: TiffReader, e: TiffEntry | undefined): string {
  if (!e) return "";
  return String.fromCharCode(...reader.values(e, 256).filter((c) => c !== 0)).trim();
}
