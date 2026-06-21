// Minimal baseline TIFF writer for export. Browsers can't encode TIFF via
// canvas.toBlob, and UTIF's encoder is 8-bit RGBA only — so this hand-rolls an
// uncompressed, little-endian, top-down RGB TIFF at 8 or 16 bits per sample,
// with an optional embedded ICC profile (tag 34675). 16-bit output preserves
// the float develop pipeline's precision that an 8-bit JPEG/PNG would crush.
//
// Layout: header(8) → IFD → out-of-line tag values → ICC → pixel strip. Every
// out-of-line offset is kept even, as the TIFF spec requires.

export interface TiffOptions {
  bitDepth: 8 | 16;
  /** Optional ICC profile bytes to embed (tag 34675). */
  icc?: Uint8Array;
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
export function encodeTiff(
  rgba: Uint8Array | Uint8ClampedArray | Uint16Array,
  width: number,
  height: number,
  opts: TiffOptions,
): Uint8Array {
  const { bitDepth, icc } = opts;
  const pixelBytes = width * height * SAMPLES * (bitDepth >> 3);

  const numTags = icc ? 14 : 13;
  const ifdStart = 8;
  const ifdSize = 2 + 12 * numTags + 4; // count + entries + next-IFD pointer
  const valuesStart = ifdStart + ifdSize;

  // Lay out the out-of-line blocks, recording an even offset for each.
  const blocks: { offset: number; bytes: Uint8Array }[] = [];
  const offsets: Record<string, number> = {};
  let cursor = valuesStart;
  const place = (key: string, bytes: Uint8Array): void => {
    if (cursor & 1) cursor++; // offsets must be even
    offsets[key] = cursor;
    blocks.push({ offset: cursor, bytes });
    cursor += bytes.length;
  };

  place("bps", shortArray([bitDepth, bitDepth, bitDepth]));
  place("sampleFormat", shortArray([1, 1, 1])); // 1 = unsigned integer
  place("xres", rational(72, 1));
  place("yres", rational(72, 1));
  if (icc) place("icc", icc);
  place("pixels", packPixels(rgba, width, height, bitDepth));

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
  const entry = (id: number, type: number, count: number, writeVal: (o: number) => void): void => {
    dv.setUint16(p, id, true);
    dv.setUint16(p + 2, type, true);
    dv.setUint32(p + 4, count, true);
    writeVal(p + 8);
    p += 12;
  };
  const asLong = (o: number, v: number) => dv.setUint32(o, v, true);
  const asShort = (o: number, v: number) => dv.setUint16(o, v, true);

  entry(256, TYPE_LONG, 1, (o) => asLong(o, width)); // ImageWidth
  entry(257, TYPE_LONG, 1, (o) => asLong(o, height)); // ImageLength
  entry(258, TYPE_SHORT, 3, (o) => asLong(o, offsets.bps)); // BitsPerSample
  entry(259, TYPE_SHORT, 1, (o) => asShort(o, 1)); // Compression = none
  entry(262, TYPE_SHORT, 1, (o) => asShort(o, 2)); // Photometric = RGB
  entry(273, TYPE_LONG, 1, (o) => asLong(o, offsets.pixels)); // StripOffsets
  entry(277, TYPE_SHORT, 1, (o) => asShort(o, SAMPLES)); // SamplesPerPixel
  entry(278, TYPE_LONG, 1, (o) => asLong(o, height)); // RowsPerStrip
  entry(279, TYPE_LONG, 1, (o) => asLong(o, pixelBytes)); // StripByteCounts
  entry(282, TYPE_RATIONAL, 1, (o) => asLong(o, offsets.xres)); // XResolution
  entry(283, TYPE_RATIONAL, 1, (o) => asLong(o, offsets.yres)); // YResolution
  entry(296, TYPE_SHORT, 1, (o) => asShort(o, 2)); // ResolutionUnit = inch
  entry(339, TYPE_SHORT, 3, (o) => asLong(o, offsets.sampleFormat)); // SampleFormat
  if (icc) entry(34675, TYPE_UNDEFINED, icc.length, (o) => asLong(o, offsets.icc));
  dv.setUint32(p, 0, true); // no next IFD

  for (const blk of blocks) buf.set(blk.bytes, blk.offset);
  return buf;
}
