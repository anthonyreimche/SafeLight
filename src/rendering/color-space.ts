// Output color-space management for export. The develop pipeline renders in
// sRGB (sRGB primaries, sRGB transfer) — that's what the screen shows. For a
// wider-gamut export the WebGL renderer converts the final pixels into the
// chosen space (primary matrix in the shader, see shaders.ts / renderer's
// setOutputColorSpace), and here we build the matching ICC profile and embed it
// into the encoded file so other apps interpret the values correctly.
//
// Matrices and D50-adapted primary XYZ values were computed offline (Bradford
// adaptation; sRGB/P3/Adobe are D65, ProPhoto is D50) and verified to map white
// to white. Each profile is a plain v2 matrix/TRC monitor profile — exactly how
// the canonical sRGB / AdobeRGB / ProPhoto working-space profiles are built.

export type ColorSpaceId = "srgb" | "display-p3" | "adobe-rgb" | "prophoto-rgb";

export const COLOR_SPACES: { value: ColorSpaceId; label: string }[] = [
  { value: "srgb", label: "sRGB" },
  { value: "display-p3", label: "Display P3" },
  { value: "adobe-rgb", label: "Adobe RGB" },
  { value: "prophoto-rgb", label: "ProPhoto RGB" },
];

// Shader output-space codes (uOutSpace uniform). sRGB is the no-op pass-through
// the live develop view always uses; the others trigger the in-shader convert.
export const OUT_SPACE_CODE: Record<ColorSpaceId, number> = {
  srgb: 0,
  "display-p3": 1,
  "adobe-rgb": 2,
  "prophoto-rgb": 3,
};

// sRGB-linear → target-linear, row-major. Identity for sRGB (no conversion).
const MATRIX: Record<ColorSpaceId, number[]> = {
  srgb: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  "display-p3": [
    0.82246197, 0.17753803, 0.0, 0.0331942, 0.9668058, 0.0, 0.01708263,
    0.07239744, 0.91051993,
  ],
  "adobe-rgb": [
    0.71512561, 0.28487439, 0.0, 0.0, 1.0, 0.0, 0.0, 0.04116195, 0.95883805,
  ],
  "prophoto-rgb": [
    0.529293, 0.33011615, 0.14059085, 0.09836009, 0.87346992, 0.02816999,
    0.01687612, 0.11765874, 0.86546514,
  ],
};

// Column-major Float32Array for gl.uniformMatrix3fv(loc, false, …).
export function outMatrixColumnMajor(id: ColorSpaceId): Float32Array {
  const m = MATRIX[id];
  // m is row-major (rows of the 3×3); column-major[col*3+row] = m[row*3+col].
  return new Float32Array([
    m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8],
  ]);
}

// ─── ICC profile construction ────────────────────────────────────────────────

// Per-space D50-adapted primary XYZ (rXYZ/gXYZ/bXYZ tag values) and the encoded
// → linear decode function that the TRC tag tabulates (must invert the shader's
// encode so a round-trip is lossless).
const D50: [number, number, number] = [0.964212, 1.0, 0.825188];

interface SpaceDef {
  name: string;
  r: [number, number, number];
  g: [number, number, number];
  b: [number, number, number];
  /** encoded [0,1] → linear [0,1] (the EOTF the TRC describes). */
  decode: (v: number) => number;
}

const srgbDecode = (v: number) =>
  v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
const adobeDecode = (v: number) => Math.pow(v, 2.19921875);
const rommDecode = (v: number) => (v < 0.03125 ? v / 16 : Math.pow(v, 1.8));

const SPACE_DEF: Record<ColorSpaceId, SpaceDef> = {
  srgb: {
    name: "sRGB",
    r: [0.436026, 0.222478, 0.013926],
    g: [0.385098, 0.716899, 0.097091],
    b: [0.143088, 0.060623, 0.714172],
    decode: srgbDecode,
  },
  "display-p3": {
    name: "Display P3",
    r: [0.5151, 0.241181, -0.001049],
    g: [0.291962, 0.692238, 0.041882],
    b: [0.157149, 0.066581, 0.784356],
    decode: srgbDecode,
  },
  "adobe-rgb": {
    name: "Adobe RGB (1998) compatible",
    r: [0.60972, 0.311103, 0.019473],
    g: [0.205262, 0.625671, 0.060884],
    b: [0.14923, 0.063226, 0.74483],
    decode: adobeDecode,
  },
  "prophoto-rgb": {
    name: "ProPhoto RGB compatible",
    r: [0.797667, 0.288037, 0.0],
    g: [0.135192, 0.711877, 0.0],
    b: [0.031353, 0.000086, 0.825188],
    decode: rommDecode,
  },
};

const s15f16 = (x: number) => Math.round(x * 65536); // signed 15.16 fixed
const align4 = (n: number) => (n + 3) & ~3;

function xyzTag(xyz: [number, number, number]): Uint8Array {
  const b = new Uint8Array(20);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, 0x58595a20); // 'XYZ '
  dv.setInt32(8, s15f16(xyz[0]));
  dv.setInt32(12, s15f16(xyz[1]));
  dv.setInt32(16, s15f16(xyz[2]));
  return b;
}

// Sampled 'curv' tag: a 1024-point table of the EOTF, universally supported.
function curveTag(decode: (v: number) => number): Uint8Array {
  const N = 1024;
  const b = new Uint8Array(12 + N * 2);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, 0x63757276); // 'curv'
  dv.setUint32(8, N); // entry count
  for (let i = 0; i < N; i++) {
    const lin = Math.min(1, Math.max(0, decode(i / (N - 1))));
    dv.setUint16(12 + i * 2, Math.round(lin * 65535));
  }
  return b;
}

function textDescTag(text: string): Uint8Array {
  // v2 'desc' (textDescriptionType): ASCII section + zeroed Unicode/ScriptCode.
  const ascii = text + "\0";
  const len = 8 + 4 + ascii.length + 4 + 4 + 2 + 1 + 67;
  const b = new Uint8Array(len);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, 0x64657363); // 'desc'
  dv.setUint32(8, ascii.length); // ASCII count (incl null)
  for (let i = 0; i < ascii.length; i++) b[12 + i] = ascii.charCodeAt(i) & 0x7f;
  // remaining Unicode/ScriptCode fields stay zero
  return b;
}

function textTag(text: string): Uint8Array {
  const ascii = text + "\0";
  const b = new Uint8Array(8 + ascii.length);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, 0x74657874); // 'text'
  for (let i = 0; i < ascii.length; i++) b[8 + i] = ascii.charCodeAt(i) & 0x7f;
  return b;
}

const iccCache = new Map<ColorSpaceId, Uint8Array>();

/** Build (and cache) a v2 matrix/TRC ICC profile for the given space. */
export function buildIccProfile(id: ColorSpaceId): Uint8Array {
  const cached = iccCache.get(id);
  if (cached) return cached;

  const def = SPACE_DEF[id];
  const trc = curveTag(def.decode);
  // desc/wtpt/rXYZ/gXYZ/bXYZ/rTRC/gTRC/bTRC/cprt. The three TRCs share one blob.
  const tags: { sig: number; data: Uint8Array }[] = [
    { sig: 0x64657363, data: textDescTag(def.name) }, // 'desc'
    { sig: 0x77747074, data: xyzTag(D50) }, // 'wtpt'
    { sig: 0x7258595a, data: xyzTag(def.r) }, // 'rXYZ'
    { sig: 0x6758595a, data: xyzTag(def.g) }, // 'gXYZ'
    { sig: 0x6258595a, data: xyzTag(def.b) }, // 'bXYZ'
    { sig: 0x72545243, data: trc }, // 'rTRC'
    { sig: 0x67545243, data: trc }, // 'gTRC' (shared)
    { sig: 0x62545243, data: trc }, // 'bTRC' (shared)
    { sig: 0x63707274, data: textTag("Generated by Safelight") }, // 'cprt'
  ];

  const headerSize = 128;
  const tableSize = 4 + tags.length * 12;
  // Lay out unique data blocks (shared TRC stored once).
  const blocks: { data: Uint8Array; offset: number }[] = [];
  let cursor = headerSize + tableSize;
  const offsetFor = new Map<Uint8Array, number>();
  for (const t of tags) {
    let off = offsetFor.get(t.data);
    if (off === undefined) {
      off = cursor;
      offsetFor.set(t.data, off);
      blocks.push({ data: t.data, offset: off });
      cursor = align4(cursor + t.data.length);
    }
  }
  const total = cursor;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);

  // Header
  dv.setUint32(0, total); // profile size
  dv.setUint32(12, 0x6d6e7472); // 'mntr'
  dv.setUint32(16, 0x52474220); // 'RGB '
  dv.setUint32(20, 0x58595a20); // 'XYZ '
  dv.setUint32(36, 0x61637370); // 'acsp'
  dv.setUint32(8, 0x02400000); // version 2.4
  // PCS illuminant = D50
  dv.setInt32(68, s15f16(D50[0]));
  dv.setInt32(72, s15f16(D50[1]));
  dv.setInt32(76, s15f16(D50[2]));

  // Tag table
  dv.setUint32(headerSize, tags.length);
  let p = headerSize + 4;
  for (const t of tags) {
    dv.setUint32(p, t.sig);
    dv.setUint32(p + 4, offsetFor.get(t.data)!);
    dv.setUint32(p + 8, t.data.length);
    p += 12;
  }
  // Tag data
  for (const blk of blocks) out.set(blk.data, blk.offset);

  iccCache.set(id, out);
  return out;
}

// ─── Embedding the profile into encoded image bytes ──────────────────────────

/**
 * Return a new Blob with the ICC profile for `id` embedded. sRGB is the assumed
 * default and is returned unchanged. Falls back to the original blob for any
 * container we can't safely rewrite.
 */
export async function embedColorProfile(
  blob: Blob,
  id: ColorSpaceId,
): Promise<Blob> {
  if (id === "srgb") return blob;
  const icc = buildIccProfile(id);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  try {
    if (blob.type === "image/jpeg") {
      return new Blob([embedJpeg(bytes, icc) as BlobPart], { type: "image/jpeg" });
    }
    if (blob.type === "image/png") {
      return new Blob([embedPng(bytes, icc) as BlobPart], { type: "image/png" });
    }
    if (blob.type === "image/webp") {
      return new Blob([embedWebp(bytes, icc) as BlobPart], { type: "image/webp" });
    }
  } catch {
    // If anything about the container is unexpected, ship the untagged file
    // rather than a corrupt one.
  }
  return blob;
}

// JPEG: insert ICC_PROFILE APP2 marker(s) right after SOI, chunked to ≤65519
// payload bytes. Strip any pre-existing ICC APP2 the encoder may have written.
function embedJpeg(src: Uint8Array, icc: Uint8Array): Uint8Array {
  if (src[0] !== 0xff || src[1] !== 0xd8) throw new Error("not jpeg");
  // Drop existing ICC_PROFILE APP2 segments.
  const ICC_SIG = "ICC_PROFILE\0";
  const kept: Uint8Array[] = [];
  let i = 2;
  while (i + 4 <= src.length && src[i] === 0xff) {
    const marker = src[i + 1];
    if (marker === 0xda) break; // SOS → start of scan, stop scanning headers
    const len = (src[i + 2] << 8) | src[i + 3];
    const seg = src.subarray(i, i + 2 + len);
    const isIcc =
      marker === 0xe2 &&
      len >= 2 + ICC_SIG.length &&
      String.fromCharCode(...seg.subarray(4, 4 + ICC_SIG.length)) === ICC_SIG;
    if (!isIcc) kept.push(seg);
    i += 2 + len;
  }
  const rest = src.subarray(i); // SOS + compressed data + EOI

  const MAX = 65519; // 65535 - 2(len) - 12(sig) - 2(seq/total)
  const count = Math.ceil(icc.length / MAX);
  const segs: Uint8Array[] = [];
  for (let n = 0; n < count; n++) {
    const part = icc.subarray(n * MAX, (n + 1) * MAX);
    const payload = 12 + 2 + part.length;
    const seg = new Uint8Array(2 + 2 + payload);
    const dv = new DataView(seg.buffer);
    seg[0] = 0xff;
    seg[1] = 0xe2;
    dv.setUint16(2, payload + 2);
    for (let k = 0; k < 12; k++) seg[4 + k] = ICC_SIG.charCodeAt(k);
    seg[16] = n + 1;
    seg[17] = count;
    seg.set(part, 18);
    segs.push(seg);
  }

  return concat([src.subarray(0, 2), ...segs, ...kept, rest]);
}

// PNG: insert an iCCP chunk before the first IDAT and drop any colour-intent
// chunks (sRGB/gAMA/cHRM/iCCP) that would conflict with it.
function embedPng(src: Uint8Array, icc: Uint8Array): Uint8Array {
  const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let k = 0; k < 8; k++) if (src[k] !== SIG[k]) throw new Error("not png");
  const dropped = new Set(["sRGB", "gAMA", "cHRM", "iCCP"]);
  const out: Uint8Array[] = [src.subarray(0, 8)];
  let i = 8;
  let inserted = false;
  const iccp = iccpChunk(icc);
  while (i + 8 <= src.length) {
    const len = readU32(src, i);
    const type = String.fromCharCode(src[i + 4], src[i + 5], src[i + 6], src[i + 7]);
    const chunk = src.subarray(i, i + 12 + len);
    if (type === "IDAT" && !inserted) {
      out.push(iccp);
      inserted = true;
    }
    if (!dropped.has(type)) out.push(chunk);
    i += 12 + len;
    if (type === "IEND") break;
  }
  return concat(out);
}

function iccpChunk(icc: Uint8Array): Uint8Array {
  const name = "ICC Profile\0";
  const compressed = zlibDeflate(icc);
  const body = new Uint8Array(name.length + 1 + compressed.length);
  for (let k = 0; k < name.length; k++) body[k] = name.charCodeAt(k);
  body[name.length] = 0; // compression method: 0 (deflate)
  body.set(compressed, name.length + 1);
  // length + 'iCCP' + body + CRC
  const chunk = new Uint8Array(12 + body.length);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, body.length);
  chunk[4] = 0x69; chunk[5] = 0x43; chunk[6] = 0x43; chunk[7] = 0x50; // 'iCCP'
  chunk.set(body, 8);
  dv.setUint32(8 + body.length, crc32(chunk.subarray(4, 8 + body.length)));
  return chunk;
}

// WebP: wrap the simple VP8/VP8L stream in an extended (VP8X) container with an
// ICCP chunk. Chrome's canvas WebP is the simple form; if it already has VP8X
// we just splice ICCP in and set the flag.
function embedWebp(src: Uint8Array, icc: Uint8Array): Uint8Array {
  if (
    String.fromCharCode(src[0], src[1], src[2], src[3]) !== "RIFF" ||
    String.fromCharCode(src[8], src[9], src[10], src[11]) !== "WEBP"
  )
    throw new Error("not webp");

  // Parse the first chunk after the 12-byte RIFF header.
  const fourcc = String.fromCharCode(src[12], src[13], src[14], src[15]);
  let width = 0;
  let height = 0;
  if (fourcc === "VP8 ") {
    // Lossy: dimensions in the frame header after the 3-byte start code.
    const o = 20 + 3 + 3; // chunk header(8)+frametag(3)+startcode(3) → key frame
    width = (((src[o + 1] << 8) | src[o]) & 0x3fff);
    height = (((src[o + 3] << 8) | src[o + 2]) & 0x3fff);
  } else if (fourcc === "VP8L") {
    const o = 21; // 12 RIFF + 8 chunk header + 1 signature byte
    const b0 = src[o], b1 = src[o + 1], b2 = src[o + 2], b3 = src[o + 3];
    width = ((b1 & 0x3f) << 8 | b0) + 1;
    height = ((b3 & 0x0f) << 10 | b2 << 2 | (b1 & 0xc0) >> 6) + 1;
  } else if (fourcc === "VP8X") {
    return webpInsertIccpIntoVp8x(src, icc);
  } else {
    throw new Error("unknown webp");
  }

  const vp8xChunk = rebuildVp8x(width, height);
  const iccp = riffChunk("ICCP", icc);
  const body = src.subarray(12); // existing image chunk(s)
  return assembleWebp([vp8xChunk, iccp, body]);
}

function rebuildVp8x(width: number, height: number): Uint8Array {
  const c = new Uint8Array(18);
  const dv = new DataView(c.buffer);
  c[0] = 0x56; c[1] = 0x50; c[2] = 0x38; c[3] = 0x58; // 'VP8X'
  dv.setUint32(4, 10, true); // payload size
  c[8] = 0x20; // ICC present
  const w = width - 1, h = height - 1;
  c[12] = w & 0xff; c[13] = (w >> 8) & 0xff; c[14] = (w >> 16) & 0xff;
  c[15] = h & 0xff; c[16] = (h >> 8) & 0xff; c[17] = (h >> 16) & 0xff;
  return c;
}

function webpInsertIccpIntoVp8x(src: Uint8Array, icc: Uint8Array): Uint8Array {
  const head = src.subarray(12, 30); // RIFF body start: VP8X chunk (8+10)
  const vp8x = new Uint8Array(head);
  vp8x[8] |= 0x20; // set ICC flag
  const iccp = riffChunk("ICCP", icc);
  const rest = src.subarray(30);
  return assembleWebp([vp8x, iccp, rest]);
}

function riffChunk(fourcc: string, data: Uint8Array): Uint8Array {
  const pad = data.length & 1;
  const c = new Uint8Array(8 + data.length + pad);
  const dv = new DataView(c.buffer);
  for (let k = 0; k < 4; k++) c[k] = fourcc.charCodeAt(k);
  dv.setUint32(4, data.length, true);
  c.set(data, 8);
  return c;
}

function assembleWebp(chunks: Uint8Array[]): Uint8Array {
  const bodyLen = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(12 + bodyLen);
  const dv = new DataView(out.buffer);
  out[0] = 0x52; out[1] = 0x49; out[2] = 0x46; out[3] = 0x46; // 'RIFF'
  dv.setUint32(4, 4 + bodyLen, true);
  out[8] = 0x57; out[9] = 0x45; out[10] = 0x42; out[11] = 0x50; // 'WEBP'
  let p = 12;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

// ─── byte helpers ────────────────────────────────────────────────────────────

function concat(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let p = 0;
  for (const part of parts) { out.set(part, p); p += part.length; }
  return out;
}

function readU32(b: Uint8Array, i: number): number {
  return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
}

// CRC-32 (PNG polynomial) for chunk integrity.
let CRC_TABLE: Uint32Array | null = null;
function crc32(buf: Uint8Array): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Minimal zlib stream using stored (uncompressed) DEFLATE blocks. Avoids a
// compression dependency; the ICC profile is a few KB so the size cost is moot,
// and every PNG reader inflates stored blocks.
function zlibDeflate(data: Uint8Array): Uint8Array {
  const blocks: Uint8Array[] = [];
  const MAX = 65535;
  for (let off = 0; off < data.length || off === 0; off += MAX) {
    const part = data.subarray(off, off + MAX);
    const last = off + MAX >= data.length ? 1 : 0;
    const hdr = new Uint8Array(5);
    hdr[0] = last; // BFINAL, BTYPE=00 (stored)
    hdr[1] = part.length & 0xff;
    hdr[2] = (part.length >> 8) & 0xff;
    hdr[3] = ~part.length & 0xff;
    hdr[4] = (~part.length >> 8) & 0xff;
    blocks.push(hdr, part);
    if (part.length < MAX) break;
  }
  const deflate = concat(blocks);
  const out = new Uint8Array(2 + deflate.length + 4);
  out[0] = 0x78; // zlib CMF
  out[1] = 0x01; // FLG (no dict, fastest)
  out.set(deflate, 2);
  const a = adler32(data);
  const dv = new DataView(out.buffer);
  dv.setUint32(2 + deflate.length, a);
  return out;
}

function adler32(data: Uint8Array): number {
  let a = 1, b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}
