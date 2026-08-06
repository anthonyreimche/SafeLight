// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Minimal baseline TIFF writer for export. Browsers can't encode TIFF via
// canvas.toBlob, and UTIF's encoder is 8-bit RGBA only — so this hand-rolls an
// uncompressed, little-endian, top-down RGB TIFF at 8 or 16 bits per sample,
// with an optional embedded ICC profile (tag 34675) and optional export
// metadata (descriptive IFD0 tags plus Exif/GPS sub-IFDs). 16-bit output
// preserves the float develop pipeline's precision that an 8-bit JPEG/PNG
// would crush.
//
// Layout: header(8) → IFD → out-of-line tag values → ICC → metadata → pixel
// strip. Every out-of-line offset is kept even, as the TIFF spec requires.

import type { RawExifEntry } from "@/catalog/exif";
import { serializeSubIfd, type ExportIfds } from "./exif-write";

export interface TiffOptions {
  bitDepth: 8 | 16;
  /** Optional ICC profile bytes to embed (tag 34675). */
  icc?: Uint8Array;
  /** Export metadata to weave into the IFD chain (see exif-write). */
  meta?: ExportIfds;
}

const TYPE_SHORT = 3;
const TYPE_LONG = 4;
const TYPE_RATIONAL = 5;
const TYPE_UNDEFINED = 7;

const SAMPLES = 3; // RGB; alpha is dropped (photographs don't need it).

function shortArray(vals: number[]): Uint8Array {
  const b = new Uint8Array(vals.length * 2);
  const dv = new DataView(b.buffer);
  vals.forEach((v, i) => dv.setUint16(i * 2, v, true));
  return b;
}

function rational(num: number, den: number): Uint8Array {
  const b = new Uint8Array(8);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, num, true);
  dv.setUint32(4, den, true);
  return b;
}

// Pack interleaved RGBA samples into the strip's RGB byte layout. 16-bit
// samples are written little-endian to match the 'II' header.
function packPixels(
  rgba: Uint8Array | Uint8ClampedArray | Uint16Array,
  width: number,
  height: number,
  bitDepth: 8 | 16,
): Uint8Array {
  const out = new Uint8Array(width * height * SAMPLES * (bitDepth >> 3));
  const n = width * height;
  if (bitDepth === 8) {
    let o = 0;
    for (let i = 0; i < n; i++) {
      const s = i * 4;
      out[o++] = rgba[s];
      out[o++] = rgba[s + 1];
      out[o++] = rgba[s + 2];
    }
  } else {
    const dv = new DataView(out.buffer);
    let o = 0;
    for (let i = 0; i < n; i++) {
      const s = i * 4;
      dv.setUint16(o, rgba[s], true); o += 2;
      dv.setUint16(o, rgba[s + 1], true); o += 2;
      dv.setUint16(o, rgba[s + 2], true); o += 2;
    }
  }
  return out;
}

/**
 * Encode top-down RGBA pixel data (Uint8Array for 8-bit, Uint16Array for
 * 16-bit) into an uncompressed baseline RGB TIFF. Returns the file bytes.
 */
// An IFD0 entry value: an inline SHORT/LONG word, or pre-encoded little-endian
// bytes (harvested metadata values of 4 bytes or fewer live inline verbatim).
type Value =
  | { kind: "short"; v: number }
  | { kind: "long"; v: number }
  | { kind: "bytes"; v: Uint8Array };

interface DirEntry {
  tag: number;
  type: number;
  count: number;
  value: Value;
}

const short = (v: number): Value => ({ kind: "short", v });
const long = (v: number): Value => ({ kind: "long", v });

export function encodeTiff(
  rgba: Uint8Array | Uint8ClampedArray | Uint16Array,
  width: number,
  height: number,
  opts: TiffOptions,
): Uint8Array {
  const { bitDepth, icc, meta } = opts;
  const pixelBytes = width * height * SAMPLES * (bitDepth >> 3);

  const metaIfd0 = meta?.ifd0 ?? [];
  const numTags =
    13 +
    (icc ? 1 : 0) +
    metaIfd0.length +
    (meta?.exif.length ? 1 : 0) +
    (meta?.gps.length ? 1 : 0);
  const ifdStart = 8;
  const ifdSize = 2 + 12 * numTags + 4; // count + entries + next-IFD pointer
  const valuesStart = ifdStart + ifdSize;

  // Lay out the out-of-line blocks, recording an even offset for each.
  const blocks: { offset: number; bytes: Uint8Array }[] = [];
  let cursor = valuesStart;
  const place = (bytes: Uint8Array): number => {
    if (cursor & 1) cursor++; // offsets must be even
    const at = cursor;
    blocks.push({ offset: at, bytes });
    cursor += bytes.length;
    return at;
  };
  // Sub-IFDs carry internal offsets, so they serialize against their own
  // final position.
  const placeIfd = (entries: RawExifEntry[]): number => {
    if (cursor & 1) cursor++;
    const at = cursor;
    const bytes = serializeSubIfd(entries, at);
    blocks.push({ offset: at, bytes });
    cursor += bytes.length;
    return at;
  };

  const bpsAt = place(shortArray([bitDepth, bitDepth, bitDepth]));
  const sampleFormatAt = place(shortArray([1, 1, 1])); // 1 = unsigned integer
  const xresAt = place(rational(72, 1));
  const yresAt = place(rational(72, 1));
  const iccAt = icc ? place(icc) : 0;
  const metaAt = new Map<number, number>();
  for (const e of metaIfd0) if (e.value.length > 4) metaAt.set(e.tag, place(e.value));
  const exifAt = meta?.exif.length ? placeIfd(meta.exif) : 0;
  const gpsAt = meta?.gps.length ? placeIfd(meta.gps) : 0;
  const pixelsAt = place(packPixels(rgba, width, height, bitDepth));

  const dir: DirEntry[] = [
    { tag: 256, type: TYPE_LONG, count: 1, value: long(width) }, // ImageWidth
    { tag: 257, type: TYPE_LONG, count: 1, value: long(height) }, // ImageLength
    { tag: 258, type: TYPE_SHORT, count: 3, value: long(bpsAt) }, // BitsPerSample
    { tag: 259, type: TYPE_SHORT, count: 1, value: short(1) }, // Compression = none
    { tag: 262, type: TYPE_SHORT, count: 1, value: short(2) }, // Photometric = RGB
    { tag: 273, type: TYPE_LONG, count: 1, value: long(pixelsAt) }, // StripOffsets
    { tag: 277, type: TYPE_SHORT, count: 1, value: short(SAMPLES) }, // SamplesPerPixel
    { tag: 278, type: TYPE_LONG, count: 1, value: long(height) }, // RowsPerStrip
    { tag: 279, type: TYPE_LONG, count: 1, value: long(pixelBytes) }, // StripByteCounts
    { tag: 282, type: TYPE_RATIONAL, count: 1, value: long(xresAt) }, // XResolution
    { tag: 283, type: TYPE_RATIONAL, count: 1, value: long(yresAt) }, // YResolution
    { tag: 296, type: TYPE_SHORT, count: 1, value: short(2) }, // ResolutionUnit = inch
    { tag: 339, type: TYPE_SHORT, count: 3, value: long(sampleFormatAt) }, // SampleFormat
  ];
  if (icc) dir.push({ tag: 34675, type: TYPE_UNDEFINED, count: icc.length, value: long(iccAt) });
  for (const e of metaIfd0) {
    dir.push({
      tag: e.tag,
      type: e.type,
      count: e.count,
      value: e.value.length <= 4 ? { kind: "bytes", v: e.value } : long(metaAt.get(e.tag)!),
    });
  }
  if (exifAt) dir.push({ tag: 0x8769, type: TYPE_LONG, count: 1, value: long(exifAt) }); // ExifIFD
  if (gpsAt) dir.push({ tag: 0x8825, type: TYPE_LONG, count: 1, value: long(gpsAt) }); // GPSIFD
  dir.sort((a, b) => a.tag - b.tag);

  const total = cursor;
  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);

  // Header: little-endian, magic 42, offset to the first (only) IFD.
  buf[0] = 0x49; // 'I'
  buf[1] = 0x49; // 'I'
  dv.setUint16(2, 42, true);
  dv.setUint32(4, ifdStart, true);

  // IFD entries, written in ascending tag-id order (TIFF requires sorting).
  dv.setUint16(ifdStart, numTags, true);
  let p = ifdStart + 2;
  for (const e of dir) {
    dv.setUint16(p, e.tag, true);
    dv.setUint16(p + 2, e.type, true);
    dv.setUint32(p + 4, e.count, true);
    if (e.value.kind === "short") dv.setUint16(p + 8, e.value.v, true);
    else if (e.value.kind === "long") dv.setUint32(p + 8, e.value.v, true);
    else buf.set(e.value.v, p + 8);
    p += 12;
  }
  dv.setUint32(p, 0, true); // no next IFD

  for (const blk of blocks) buf.set(blk.bytes, blk.offset);
  return buf;
}
