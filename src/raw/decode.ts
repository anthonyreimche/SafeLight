// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// RAW decode orchestrator. Decodes a RAW file to a full-precision linear float
// image (decodeRawToFloat) or an 8-bit bitmap (decodeRawToBitmap), choosing the
// best available path:
//
//   1. libraw (handles everything, best color science): the bundled
//      libraw-wasm for the float image, a registered build for the bitmap
//   2. the in-house decoder for uncompressed CFA data (TIFF-based RAW / DNG)
//   3. no image: the float decode says why (DecodeFailure), the bitmap decode
//      answers null, and the caller falls back to the embedded JPEG preview
//
// Compressed sensor data (e.g. Nikon NEF lossless) needs libraw; without it the
// preview is shown, so RAW files always display.

import {
  TiffReader,
  findRawIfd,
  TIFF_TAG,
  COMPRESSION,
  type Ifd,
  type RawIfdInfo,
} from "./tiff";
import {
  developRawPlane,
  developRawPlaneFloat,
  linearizeSamples,
  unpackSamples,
  type DevelopOptions,
} from "./pixels";
import { getLibRaw } from "./libraw";
import { decodeRawFloatViaLibRaw } from "./libraw-wasm-adapter";
import type { DecodeRequest } from "./decode-pool";
import type { DecodeFailure, RawFloatImage } from "./decode-result";

export type { DecodeFailure, RawFloatImage };

const DEFAULT_CFA: [number, number, number, number] = [0, 1, 1, 2]; // RGGB

// A file libraw gave no answer for holds a decoder for the whole time limit,
// so background work (the "Cache all" pass, the preview repair, Develop's
// prefetch) tries it once a session. It also leaves a file alone while a decode
// of it is under way, which fills the cache itself. A photo the user opens is
// always decoded. A file is told apart by its path (its name when the caller
// gives none), size and modification time. Only the latest unanswered files
// are kept; one that later decodes is forgotten.
const UNANSWERED_LIMIT = 256;
const decoding = new Map<string, number>();
const unanswered = new Set<string>();

function fileId(file: Blob, path?: string): string | undefined {
  return file instanceof File
    ? `${path ?? file.name}:${file.size}:${file.lastModified}`
    : undefined;
}

function markUnanswered(id: string): void {
  unanswered.delete(id);
  unanswered.add(id);
  if (unanswered.size > UNANSWERED_LIMIT) {
    const oldest = unanswered.values().next().value;
    if (oldest !== undefined) unanswered.delete(oldest);
  }
}

// Decode to a full-precision LINEAR float image, for the high-bit-depth editing
// pipeline. libraw handles every compression; the in-house fallback only
// uncompressed CFA. When neither yields an image, the caller falls back to the
// camera's embedded preview. `bytes`: the file's, for a caller that goes on
// using them, either read already or read by the function given, which is
// called only once the decode goes ahead; they are left intact.
export async function decodeRawToFloat(
  file: Blob,
  request?: DecodeRequest,
  path?: string,
  bytes?: ArrayBuffer | (() => Promise<ArrayBuffer>),
): Promise<RawFloatImage | DecodeFailure> {
  if (request?.signal?.aborted) return { failure: "aborted" };
  const id = fileId(file, path);
  if (id === undefined) return decodeFloat(file, request, undefined, bytes);
  if (request?.background) {
    const reason = unanswered.has(id)
      ? "no answer earlier this session"
      : decoding.has(id)
        ? "being decoded already"
        : undefined;
    if (reason) return { failure: "transient", reason, passedOver: true };
  }
  decoding.set(id, (decoding.get(id) ?? 0) + 1);
  try {
    return await decodeFloat(file, request, id, bytes);
  } finally {
    const left = (decoding.get(id) ?? 1) - 1;
    if (left > 0) decoding.set(id, left);
    else decoding.delete(id);
  }
}

async function decodeFloat(
  file: Blob,
  request?: DecodeRequest,
  id?: string,
  bytes?: ArrayBuffer | (() => Promise<ArrayBuffer>),
): Promise<RawFloatImage | DecodeFailure> {
  let buffer: ArrayBuffer;
  try {
    buffer = typeof bytes === "function" ? await bytes() : (bytes ?? (await file.arrayBuffer()));
  } catch (e) {
    return { failure: "transient", reason: `couldn't read the file (${describeError(e)})` };
  }

  // Prefer libraw: it decodes every compression (incl. Nikon NEF), applies
  // camera WB and orientation, and outputs full-precision linear data. Only
  // the in-house fallback reads the buffer after it, and only a TIFF stream,
  // so libraw takes any other buffer read here without a copy.
  const transfer = !bytes && !isTiffStream(buffer);
  const viaLib = await decodeRawFloatViaLibRaw(buffer, request, transfer, () => file.arrayBuffer());
  if (!("failure" in viaLib)) {
    if (id !== undefined) unanswered.delete(id);
    return { ...viaLib, oriented: true };
  }
  if (viaLib.timedOut && id !== undefined) markUnanswered(id);
  if (request?.signal?.aborted) return { failure: "aborted" };

  // In-house fallback handles only uncompressed CFA (sensor-native orientation).
  // A file it can't take either keeps libraw's verdict.
  if (transfer) return viaLib;
  try {
    const reader = new TiffReader(buffer);
    const info = findRawIfd(reader);
    if (!info || info.compression !== COMPRESSION.None) return viaLib;
    const plane = readSensorPlane(reader, info);
    if (!plane) return viaLib;
    const data = developRawPlaneFloat(plane.samples, plane.options);
    return { data, width: info.width, height: info.height, oriented: false };
  } catch (e) {
    return { ...viaLib, reason: `${viaLib.reason ?? "no decoder took the file"} (in-house decode: ${describeError(e)})` };
  }
}

const describeError = (e: unknown): string =>
  e instanceof Error ? `${e.name}: ${e.message}` : String(e);

/** Whether `buffer` opens as TiffReader reads it: a byte-order mark, then 42. */
function isTiffStream(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 8) return false;
  const view = new DataView(buffer);
  const order = view.getUint16(0, false);
  if (order !== 0x4949 && order !== 0x4d4d) return false;
  return view.getUint16(2, order === 0x4949) === 42;
}

/** `bytes`: the file's, read already by the caller, as decodeRawToFloat takes them. */
export async function decodeRawToBitmap(
  file: Blob,
  bytes?: ArrayBuffer,
): Promise<{ bitmap: ImageBitmap; oriented: boolean } | null> {
  let buffer: ArrayBuffer;
  try {
    buffer = bytes ?? (await file.arrayBuffer());
  } catch {
    return null;
  }

  // 1. Prefer a real libraw build if one is registered.
  const lib = await getLibRaw();
  if (lib) {
    try {
      const d = await lib.decode(buffer);
      if (d && d.rgba.length >= d.width * d.height * 4) {
        const bitmap = await rgbaToBitmap(d.rgba, d.width, d.height);
        return { bitmap, oriented: true };
      }
    } catch {
      // fall through to the in-house path
    }
  }

  // 2. In-house decode of uncompressed CFA data (sensor-native orientation).
  try {
    const reader = new TiffReader(buffer);
    const info = findRawIfd(reader);
    if (info && info.compression === COMPRESSION.None) {
      const bitmap = await developUncompressed(reader, info);
      if (bitmap) return { bitmap, oriented: false };
    }
  } catch {
    // not a TIFF stream we understand
  }

  // 3. Let the caller fall back to the embedded preview.
  return null;
}

async function developUncompressed(
  reader: TiffReader,
  info: RawIfdInfo,
): Promise<ImageBitmap | null> {
  const plane = readSensorPlane(reader, info);
  if (!plane) return null;
  const rgba = developRawPlane(plane.samples, plane.options);
  return rgbaToBitmap(rgba, info.width, info.height);
}

interface SensorPlane {
  samples: Uint16Array;
  options: DevelopOptions;
}

// The raw IFD's samples in linear sensor units, with the levels and colour
// data that develop them. A DNG may store its samples through a
// LinearizationTable — the stored code indexes the table, and BlackLevel and
// WhiteLevel are given in the table's output units. The Leica M8 keeps 8-bit
// codes for a 14-bit sensor this way; scaling the codes themselves against
// WhiteLevel leaves every sample within 2% of black.
function readSensorPlane(reader: TiffReader, info: RawIfdInfo): SensorPlane | null {
  const { ifd, width, height, bitsPerSample } = info;
  const strips = readStrips(reader, ifd);
  if (!strips) return null;
  const samples = unpackPlane(strips, bitsPerSample, width, height, reader.le);
  if (samples.length < width * height) return null;

  const table = readLinearizationTable(reader, ifd);
  if (table) linearizeSamples(samples, table);
  // Without a WhiteLevel, white is the top of whatever space the samples are
  // in: the table's last entry, else the full code range.
  const defaultWhite = table ? table[table.length - 1] : (1 << bitsPerSample) - 1;
  const { black, white } = readLevels(reader, ifd, defaultWhite);
  return {
    samples,
    options: {
      width,
      height,
      black,
      white,
      cfa: readCFA(reader, ifd),
      wb: readWhiteBalance(reader),
    },
  };
}

function readLinearizationTable(reader: TiffReader, ifd: Ifd): number[] | undefined {
  const e = ifd.get(TIFF_TAG.LinearizationTable);
  if (!e) return undefined;
  const table = reader.values(e);
  return table.length ? table : undefined;
}

// Concatenate all strips of an IFD into one contiguous byte buffer.
function readStrips(reader: TiffReader, ifd: Ifd): Uint8Array | null {
  const offsetsEntry = ifd.get(TIFF_TAG.StripOffsets);
  const countsEntry = ifd.get(TIFF_TAG.StripByteCounts);
  if (!offsetsEntry || !countsEntry) return null;

  const offsets = reader.values(offsetsEntry);
  const counts = reader.values(countsEntry);
  const buf = reader.view.buffer;
  const total = counts.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;

  const out = new Uint8Array(total);
  let pos = 0;
  for (let i = 0; i < offsets.length; i++) {
    const start = reader.base + offsets[i];
    const len = counts[i] ?? 0;
    if (start < 0 || start + len > buf.byteLength) return null;
    out.set(new Uint8Array(buf, start, len), pos);
    pos += len;
  }
  return out;
}

// Unpack the sensor plane. 8/16-bit samples read straight through; sub-byte
// widths are unpacked per row, since TIFF pads each row to a byte boundary.
function unpackPlane(
  strips: Uint8Array,
  bits: number,
  width: number,
  height: number,
  le: boolean,
): Uint16Array {
  if (bits === 8 || bits === 16) {
    return unpackSamples(strips, bits, width * height, le);
  }
  const out = new Uint16Array(width * height);
  const rowBytes = Math.ceil((width * bits) / 8);
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowBytes;
    if (rowStart >= strips.length) break;
    const row = strips.subarray(rowStart, rowStart + rowBytes);
    out.set(unpackSamples(row, bits, width, le), y * width);
  }
  return out;
}

function readCFA(
  reader: TiffReader,
  ifd: Ifd,
): [number, number, number, number] {
  const e = ifd.get(TIFF_TAG.CFAPattern);
  if (e) {
    const v = reader.values(e);
    if (v.length >= 4) return [v[0], v[1], v[2], v[3]];
  }
  return DEFAULT_CFA;
}

function readLevels(
  reader: TiffReader,
  ifd: Ifd,
  defaultWhite: number,
): { black: number; white: number } {
  let black = 0;
  const blackE = ifd.get(TIFF_TAG.BlackLevel);
  if (blackE) {
    const v = reader.values(blackE);
    if (v.length) black = v.reduce((a, b) => a + b, 0) / v.length;
  }
  let white = 0;
  const whiteE = ifd.get(TIFF_TAG.WhiteLevel);
  if (whiteE) white = reader.values(whiteE)[0] ?? 0;
  if (!white) white = defaultWhite;
  return { black, white };
}

// AsShotNeutral (DNG) gives the camera-neutral per channel; the WB gain is its
// reciprocal. Searches all IFDs since it usually sits in IFD0, not the raw one.
function readWhiteBalance(reader: TiffReader): [number, number, number] {
  for (const ifd of reader.ifds) {
    const e = ifd.get(TIFF_TAG.AsShotNeutral);
    if (!e) continue;
    const v = reader.values(e);
    if (v.length >= 3 && v[0] && v[1] && v[2]) {
      return [1 / v[0], 1 / v[1], 1 / v[2]];
    }
  }
  return [1, 1, 1];
}

async function rgbaToBitmap(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Promise<ImageBitmap> {
  // Allocate an ArrayBuffer-backed ImageData and copy in, so any source buffer
  // type (in-house result, or a libraw view into WASM memory) is accepted.
  const image = new ImageData(width, height);
  image.data.set(rgba.subarray(0, image.data.length));
  return createImageBitmap(image);
}
