// RAW decode orchestrator. Produces a full-resolution ImageBitmap from a RAW
// file, choosing the best available path:
//
//   1. a registered libraw WASM build (handles everything, best color science)
//   2. the in-house decoder for uncompressed CFA data (TIFF-based RAW / DNG)
//   3. null  -> caller falls back to the embedded JPEG preview
//
// Compressed sensor data (e.g. Nikon NEF lossless) needs the WASM path; without
// it we return null and the preview is shown, so RAW files always display.

import {
  TiffReader,
  findRawIfd,
  TIFF_TAG,
  COMPRESSION,
  type Ifd,
  type RawIfdInfo,
} from "./tiff";
import { developRawPlane, unpackSamples } from "./pixels";
import { getLibRaw } from "./libraw";

const DEFAULT_CFA: [number, number, number, number] = [0, 1, 1, 2]; // RGGB

export async function decodeRawToBitmap(file: Blob): Promise<ImageBitmap | null> {
  let buffer: ArrayBuffer;
  try {
    buffer = await file.arrayBuffer();
  } catch {
    return null;
  }

  // 1. Prefer a real libraw build if one is registered.
  const lib = await getLibRaw();
  if (lib) {
    try {
      const d = await lib.decode(buffer);
      if (d && d.rgba.length >= d.width * d.height * 4) {
        return rgbaToBitmap(d.rgba, d.width, d.height);
      }
    } catch {
      // fall through to the in-house path
    }
  }

  // 2. In-house decode of uncompressed CFA data.
  try {
    const reader = new TiffReader(buffer);
    const info = findRawIfd(reader);
    if (info && info.compression === COMPRESSION.None) {
      const bitmap = await developUncompressed(reader, info);
      if (bitmap) return bitmap;
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
  const { ifd, width, height, bitsPerSample } = info;
  const strips = readStrips(reader, ifd);
  if (!strips) return null;

  const samples = unpackPlane(strips, bitsPerSample, width, height, reader.le);
  if (samples.length < width * height) return null;

  const { black, white } = readLevels(reader, ifd, bitsPerSample);
  const rgba = developRawPlane(samples, {
    width,
    height,
    black,
    white,
    cfa: readCFA(reader, ifd),
    wb: readWhiteBalance(reader),
  });
  return rgbaToBitmap(rgba, width, height);
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
  bits: number,
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
  if (!white) white = (1 << bits) - 1;
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
