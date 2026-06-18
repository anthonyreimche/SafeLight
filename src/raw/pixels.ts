// Pure pixel math for RAW development: sample unpacking, Bayer demosaic, and
// the linear -> display color/gamma stage. No DOM or app imports, so each
// function is unit-testable directly under Node's --experimental-strip-types.
//
// CFA color codes follow TIFF CFAPattern: 0 = Red, 1 = Green, 2 = Blue.
export const CFA = { R: 0, G: 1, B: 2 } as const;

// Unpack `count` samples of `bits` bits each from a packed byte stream.
//  - 8/16-bit samples are read whole (16-bit honors file endianness).
//  - 12/14-bit (and other sub-byte widths) are read MSB-first, which is how
//    TIFF packs contiguous samples regardless of the file's byte order.
export function unpackSamples(
  bytes: Uint8Array,
  bits: number,
  count: number,
  littleEndian: boolean,
): Uint16Array {
  const out = new Uint16Array(count);

  if (bits === 8) {
    for (let i = 0; i < count && i < bytes.length; i++) out[i] = bytes[i];
    return out;
  }

  if (bits === 16) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < count && (i + 1) * 2 <= bytes.length; i++) {
      out[i] = dv.getUint16(i * 2, littleEndian);
    }
    return out;
  }

  // Sub-byte widths: MSB-first bit reader.
  let bitBuf = 0;
  let bitCnt = 0;
  let bytePos = 0;
  for (let i = 0; i < count; i++) {
    while (bitCnt < bits) {
      bitBuf = (bitBuf << 8) | (bytePos < bytes.length ? bytes[bytePos++] : 0);
      bitCnt += 8;
    }
    bitCnt -= bits;
    out[i] = (bitBuf >>> bitCnt) & ((1 << bits) - 1);
  }
  return out;
}

// Subtract black level and scale so white maps to 1.0. Values above 1.0 are
// preserved (not clamped) so the shader's channel reconstruction can detect
// which CFA sites hit the sensor ceiling and recover color from unclipped neighbours.
export function normalizePlane(
  raw: Uint16Array,
  black: number,
  white: number,
): Float32Array {
  const out = new Float32Array(raw.length);
  const range = white - black;
  const inv = range > 0 ? 1 / range : 0;
  for (let i = 0; i < raw.length; i++) {
    const v = (raw[i] - black) * inv;
    out[i] = v < 0 ? 0 : v;
  }
  return out;
}

// `cfa` is the 2x2 pattern in row-major order: [topLeft, topRight, bottomLeft,
// bottomRight], each a CFA color code. Returns interleaved RGB (length w*h*3).
//
// Bilinear interpolation: the site's native channel is taken directly; the two
// missing channels are averaged from the matching-color samples in the 3x3
// neighborhood (edges clamp). Pattern-agnostic, correct for any Bayer layout.
export function demosaicBilinear(
  plane: Float32Array,
  width: number,
  height: number,
  cfa: [number, number, number, number],
): Float32Array {
  const rgb = new Float32Array(width * height * 3);
  const colorAt = (x: number, y: number): number => cfa[(y & 1) * 2 + (x & 1)];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const site = colorAt(x, y);
      const acc = [0, 0, 0];
      const cnt = [0, 0, 0];

      // 3x3 neighborhood (including self) with edge clamping.
      for (let dy = -1; dy <= 1; dy++) {
        let ny = y + dy;
        if (ny < 0) ny = 0;
        else if (ny >= height) ny = height - 1;
        for (let dx = -1; dx <= 1; dx++) {
          let nx = x + dx;
          if (nx < 0) nx = 0;
          else if (nx >= width) nx = width - 1;
          const c = colorAt(nx, ny);
          acc[c] += plane[ny * width + nx];
          cnt[c]++;
        }
      }

      const o = idx * 3;
      // Native channel: exact sample. Others: neighborhood average.
      rgb[o] = site === CFA.R ? plane[idx] : cnt[0] ? acc[0] / cnt[0] : 0;
      rgb[o + 1] = site === CFA.G ? plane[idx] : cnt[1] ? acc[1] / cnt[1] : 0;
      rgb[o + 2] = site === CFA.B ? plane[idx] : cnt[2] ? acc[2] / cnt[2] : 0;
    }
  }
  return rgb;
}

function linearToSrgb(c: number): number {
  if (c <= 0) return 0;
  if (c >= 1) return 1;
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

// Apply per-channel white-balance gain (normalized so green stays ~1.0) and
// encode linear -> sRGB into an 8-bit RGBA buffer ready for ImageData.
export function toRGBA8(
  rgb: Float32Array,
  width: number,
  height: number,
  wb: [number, number, number] = [1, 1, 1],
): Uint8ClampedArray {
  const g = wb[1] || 1;
  const mr = wb[0] / g;
  const mg = 1;
  const mb = wb[2] / g;

  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, o = 0; i < rgb.length; i += 3, o += 4) {
    out[o] = linearToSrgb(rgb[i] * mr) * 255;
    out[o + 1] = linearToSrgb(rgb[i + 1] * mg) * 255;
    out[o + 2] = linearToSrgb(rgb[i + 2] * mb) * 255;
    out[o + 3] = 255;
  }
  return out;
}

// Apply white-balance gain and pack into a LINEAR float RGBA buffer (no sRGB
// encode, no clip at 1.0), preserving the sensor's full precision and highlight
// headroom for editing. Alpha is 1.0.
export function toRGBAFloat(
  rgb: Float32Array,
  width: number,
  height: number,
  wb: [number, number, number] = [1, 1, 1],
): Float32Array {
  const g = wb[1] || 1;
  const mr = wb[0] / g;
  const mb = wb[2] / g;
  const out = new Float32Array(width * height * 4);
  // Sensor-clip handling: normalizePlane clamps clipped channels at 1.0, and a
  // clipped channel's TRUE value is unknown (>= its WB gain). Multiplying the
  // clamp by the gain paints blown areas the WB colour (red gain ~2x -> magenta
  // highlights that luminance-keyed recovery then preserves). Reconstruct
  // dcraw-"blend" style: raise each clipped channel to the pixel's brightest
  // channel, so fully blown pixels come out neutral and recover to white.
  const CLIP = 0.9995;
  for (let i = 0, o = 0; i < rgb.length; i += 3, o += 4) {
    const cr = rgb[i] >= CLIP;
    const cg = rgb[i + 1] >= CLIP;
    const cb = rgb[i + 2] >= CLIP;
    let r = Math.max(0, rgb[i] * mr);
    let gg = Math.max(0, rgb[i + 1]);
    let b = Math.max(0, rgb[i + 2] * mb);
    if (cr || cg || cb) {
      const m = Math.max(r, gg, b);
      if (cr) r = m;
      if (cg) gg = m;
      if (cb) b = m;
    }
    out[o] = r;
    out[o + 1] = gg;
    out[o + 2] = b;
    out[o + 3] = 1;
  }
  return out;
}

// One-shot helper used by the decoder: raw plane -> display RGBA.
export interface DevelopOptions {
  width: number;
  height: number;
  black: number;
  white: number;
  cfa: [number, number, number, number];
  wb?: [number, number, number];
}

export function developRawPlane(
  raw: Uint16Array,
  opts: DevelopOptions,
): Uint8ClampedArray {
  const norm = normalizePlane(raw, opts.black, opts.white);
  const rgb = demosaicBilinear(norm, opts.width, opts.height, opts.cfa);
  return toRGBA8(rgb, opts.width, opts.height, opts.wb);
}

// Like developRawPlane but returns linear float RGBA for a high-bit-depth
// (HDR-capable) texture instead of an 8-bit display buffer.
export function developRawPlaneFloat(
  raw: Uint16Array,
  opts: DevelopOptions,
): Float32Array {
  const norm = normalizePlane(raw, opts.black, opts.white);
  const rgb = demosaicBilinear(norm, opts.width, opts.height, opts.cfa);
  return toRGBAFloat(rgb, opts.width, opts.height, opts.wb);
}
