// Unit tests for the pure RAW-decode modules. Run with:
//   node --experimental-strip-types raw.test.mts
// No browser APIs are touched here (createImageBitmap/ImageData live in the
// orchestrator, which is exercised in-browser), so these run under plain Node.

import {
  TiffReader,
  findRawIfd,
  TIFF_TAG,
  PHOTOMETRIC_CFA,
} from "./src/raw/tiff.ts";
import {
  unpackSamples,
  normalizePlane,
  demosaicBilinear,
  toRGBA8,
  developRawPlane,
} from "./src/raw/pixels.ts";

let passed = 0;
let failed = 0;

function ok(cond: boolean, msg: string): void {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error("  FAIL:", msg);
  }
}

function near(a: number, b: number, eps = 1e-4): boolean {
  return Math.abs(a - b) <= eps;
}

// --- Build a synthetic little-endian TIFF: a small IFD0 (RGB thumbnail) whose
// SubIFDs point at a 4x4 16-bit CFA raw IFD. Exercises SubIFD recursion + the
// raw-IFD selector. ---------------------------------------------------------
function buildTiff(): ArrayBuffer {
  const buf = new ArrayBuffer(184);
  const dv = new DataView(buf);
  const LE = true;
  let p = 0;
  const u16 = (v: number) => {
    dv.setUint16(p, v, LE);
    p += 2;
  };
  const u32 = (v: number) => {
    dv.setUint32(p, v, LE);
    p += 4;
  };
  // entry: tag(2) type(2) count(4) value(4)
  const entry = (tag: number, type: number, count: number, value: number) => {
    u16(tag);
    u16(type);
    u32(count);
    u32(value);
  };
  const entryBytes = (tag: number, type: number, b: number[]) => {
    u16(tag);
    u16(type);
    u32(b.length);
    for (let i = 0; i < 4; i++) dv.setUint8(p + i, b[i] ?? 0);
    p += 4;
  };

  // Header
  dv.setUint8(0, 0x49);
  dv.setUint8(1, 0x49);
  p = 2;
  u16(42);
  u32(8); // IFD0 at offset 8

  // IFD0 @8: PhotometricInterpretation=2 (RGB), SubIFDs->50, ImageWidth=64
  p = 8;
  u16(3); // entry count
  entry(TIFF_TAG.PhotometricInterpretation, 3, 1, 2);
  entry(TIFF_TAG.SubIFDs, 4, 1, 50);
  entry(TIFF_TAG.ImageWidth, 3, 1, 64);
  u32(0); // next IFD = none  (ends at offset 50)

  // raw IFD @50
  p = 50;
  u16(8); // entry count
  entry(TIFF_TAG.ImageWidth, 3, 1, 4);
  entry(TIFF_TAG.ImageLength, 3, 1, 4);
  entry(TIFF_TAG.BitsPerSample, 3, 1, 16);
  entry(TIFF_TAG.Compression, 3, 1, 1);
  entry(TIFF_TAG.PhotometricInterpretation, 3, 1, PHOTOMETRIC_CFA);
  entry(TIFF_TAG.StripOffsets, 4, 1, 152);
  entry(TIFF_TAG.StripByteCounts, 4, 1, 32);
  entryBytes(TIFF_TAG.CFAPattern, 1, [0, 1, 1, 2]); // RGGB
  u32(0); // next IFD = none  (ends at offset 152)

  // strip data @152: 16 uint16 LE samples
  p = 152;
  for (let i = 0; i < 16; i++) u16(1000 + i);

  return buf;
}

console.log("TIFF reader:");
{
  const reader = new TiffReader(buildTiff());
  ok(reader.le === true, "detects little-endian");
  ok(reader.ifds.length === 2, `walks IFD0 + SubIFD (got ${reader.ifds.length})`);

  const info = findRawIfd(reader);
  ok(info !== null, "locates the CFA raw IFD");
  if (info) {
    ok(info.width === 4 && info.height === 4, "raw dimensions 4x4");
    ok(info.bitsPerSample === 16, "bits per sample 16");
    ok(info.compression === 1, "compression none");
    const cfa = reader.values(info.ifd.get(TIFF_TAG.CFAPattern)!);
    ok(
      cfa.length === 4 && cfa[0] === 0 && cfa[1] === 1 && cfa[3] === 2,
      `CFA pattern RGGB (got ${cfa.join(",")})`,
    );
    const offs = reader.values(info.ifd.get(TIFF_TAG.StripOffsets)!);
    const cnts = reader.values(info.ifd.get(TIFF_TAG.StripByteCounts)!);
    ok(offs[0] === 152 && cnts[0] === 32, "strip offset/count");
  }
}

console.log("unpackSamples:");
{
  // 12-bit MSB-first: 0xAB 0xCD 0xEF -> 0xABC, 0xDEF
  const s12 = unpackSamples(new Uint8Array([0xab, 0xcd, 0xef]), 12, 2, false);
  ok(s12[0] === 0xabc && s12[1] === 0xdef, `12-bit unpack (got ${s12[0]},${s12[1]})`);

  // 16-bit little-endian
  const s16le = unpackSamples(
    new Uint8Array([0x34, 0x12, 0xcd, 0xab]),
    16,
    2,
    true,
  );
  ok(s16le[0] === 0x1234 && s16le[1] === 0xabcd, "16-bit LE unpack");

  // 16-bit big-endian
  const s16be = unpackSamples(
    new Uint8Array([0x12, 0x34, 0xab, 0xcd]),
    16,
    2,
    false,
  );
  ok(s16be[0] === 0x1234 && s16be[1] === 0xabcd, "16-bit BE unpack");

  // 8-bit passthrough
  const s8 = unpackSamples(new Uint8Array([10, 20, 30]), 8, 3, false);
  ok(s8[0] === 10 && s8[2] === 30, "8-bit passthrough");
}

console.log("normalizePlane:");
{
  const n = normalizePlane(new Uint16Array([0, 50, 100, 200]), 50, 150);
  ok(n[0] === 0, "clamps below black to 0");
  ok(near(n[1], 0), "black maps to 0");
  ok(near(n[2], 0.5), "midpoint maps to 0.5");
  ok(n[3] === 1, "clamps above white to 1");
}

console.log("demosaicBilinear:");
{
  // Native channel is preserved exactly at each site (2x2 RGGB).
  const plane = new Float32Array([0.1, 0.2, 0.3, 0.4]);
  const cfa: [number, number, number, number] = [0, 1, 1, 2];
  const rgb = demosaicBilinear(plane, 2, 2, cfa);
  ok(near(rgb[0], 0.1), "R site keeps red exactly");
  // bottom-right (1,1) is B site -> its blue channel index = (1*2+1)*3 + 2
  const brB = (1 * 2 + 1) * 3 + 2;
  ok(near(rgb[brB], 0.4), "B site keeps blue exactly");

  // Constant plane -> constant output on every channel.
  const flat = new Float32Array(16).fill(0.5);
  const out = demosaicBilinear(flat, 4, 4, cfa);
  let allHalf = true;
  for (let i = 0; i < out.length; i++) if (!near(out[i], 0.5)) allHalf = false;
  ok(allHalf, "constant plane demosaics to constant RGB");
}

console.log("toRGBA8:");
{
  // 3 px: black, white, mid-grey (linear 0.5 -> sRGB ~0.735 -> ~188)
  const rgb = new Float32Array([0, 0, 0, 1, 1, 1, 0.5, 0.5, 0.5]);
  const out = toRGBA8(rgb, 3, 1, [1, 1, 1]);
  ok(out[0] === 0 && out[3] === 255, "black -> 0, alpha 255");
  ok(out[4] === 255, "white -> 255");
  ok(Math.abs(out[8] - 188) <= 1, `mid-grey sRGB ~188 (got ${out[8]})`);

  // White-balance gain: red x2 on a 0.25 input -> 0.5 linear -> ~188
  const wb = toRGBA8(new Float32Array([0.25, 0.5, 0.5]), 1, 1, [2, 1, 1]);
  ok(Math.abs(wb[0] - 188) <= 1, `WB red gain applied (got ${wb[0]})`);
}

console.log("developRawPlane (integration):");
{
  const raw = new Uint16Array(16).fill(32768); // ~mid on 16-bit
  const rgba = developRawPlane(raw, {
    width: 4,
    height: 4,
    black: 0,
    white: 65535,
    cfa: [0, 1, 1, 2],
  });
  ok(rgba.length === 4 * 4 * 4, "RGBA buffer sized w*h*4");
  ok(rgba[3] === 255, "alpha opaque");
  // uniform input -> uniform output across pixels
  ok(rgba[0] === rgba[4] && rgba[4] === rgba[8], "uniform input -> uniform output");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
