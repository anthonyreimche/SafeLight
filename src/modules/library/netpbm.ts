// Netpbm (PPM/PGM/PBM/PNM) decoder. These plain bitmap formats are decoded by
// neither libraw nor the browser's createImageBitmap, so we parse them here and
// hand back an ImageBitmap that flows through the normal 8-bit (JPEG-like) path.
//
// Supported magics: P1/P4 (bitmap), P2/P5 (grayscale), P3/P6 (RGB). 16-bit
// samples (maxval > 255) are scaled down to 8-bit for display. ImageData and
// createImageBitmap are available on both the main thread and in workers, so
// this needs no DOM.

import { getExtension } from "./raw-preview";

const NETPBM_EXTENSIONS = new Set([".ppm", ".pgm", ".pbm", ".pnm"]);

/** Name-only check, mirroring isRawFile/isSupportedName (no File needed). */
export function isNetpbmName(name: string): boolean {
  return NETPBM_EXTENSIONS.has(getExtension(name));
}

function isWhitespace(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12;
}

// Reads header tokens, skipping ASCII whitespace and `#` comments (to end of
// line). Returns the token and the index just past it (NOT past the terminating
// whitespace — binary data relies on consuming exactly one whitespace byte).
function readToken(buf: Uint8Array, start: number): { token: string; pos: number } {
  let pos = start;
  for (;;) {
    if (pos >= buf.length) return { token: "", pos };
    const c = buf[pos];
    if (isWhitespace(c)) {
      pos++;
    } else if (c === 35 /* # */) {
      while (pos < buf.length && buf[pos] !== 10) pos++;
    } else {
      break;
    }
  }
  let token = "";
  while (pos < buf.length && !isWhitespace(buf[pos]) && buf[pos] !== 35) {
    token += String.fromCharCode(buf[pos]);
    pos++;
  }
  return { token, pos };
}

/**
 * Decode a Netpbm file to an ImageBitmap, or null if it isn't a parseable
 * Netpbm image. Best-effort: malformed/truncated files return null so the
 * caller can fall back rather than throw.
 */
export async function decodeNetpbm(file: Blob): Promise<ImageBitmap | null> {
  let buf: Uint8Array;
  try {
    buf = new Uint8Array(await file.arrayBuffer());
  } catch {
    return null;
  }
  if (buf.length < 2 || buf[0] !== 80 /* P */) return null;

  const magicR = readToken(buf, 0);
  const magic = magicR.token;
  if (!/^P[1-6]$/.test(magic)) return null;
  const type = Number(magic[1]);
  const isBitmap = type === 1 || type === 4; // P1/P4 have no maxval, 1 bit/sample
  const channels = type === 3 || type === 6 ? 3 : 1;

  let pos = magicR.pos;
  const wR = readToken(buf, pos); pos = wR.pos;
  const hR = readToken(buf, pos); pos = hR.pos;
  const width = Number(wR.token);
  const height = Number(hR.token);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    return null;
  }
  // Guard against absurd dimensions (corrupt header) blowing up memory.
  if (width * height > 268_435_456) return null;

  let maxval = 1;
  if (!isBitmap) {
    const mR = readToken(buf, pos); pos = mR.pos;
    maxval = Number(mR.token);
    if (!Number.isInteger(maxval) || maxval < 1 || maxval > 65535) return null;
  }

  const out = new Uint8ClampedArray(width * height * 4);
  const scale = (v: number): number => Math.round((v / maxval) * 255);
  const binary = type === 4 || type === 5 || type === 6;
  const twoBytes = maxval > 255;

  if (binary) {
    let p = pos + 1; // skip the single whitespace byte separating header from data
    if (type === 4) {
      // Packed bits, MSB first, one row padded to a whole byte. 1 = black.
      const rowBytes = Math.ceil(width / 8);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const byte = buf[p + y * rowBytes + (x >> 3)];
          if (byte === undefined) return null;
          const bit = (byte >> (7 - (x & 7))) & 1;
          const v = bit ? 0 : 255;
          const i = (y * width + x) * 4;
          out[i] = out[i + 1] = out[i + 2] = v;
          out[i + 3] = 255;
        }
      }
    } else {
      const step = twoBytes ? 2 : 1;
      const readSample = (): number => {
        const v = twoBytes ? (buf[p] << 8) | buf[p + 1] : buf[p];
        p += step;
        return v;
      };
      const need = width * height * channels * step;
      if (p + need > buf.length) return null;
      for (let px = 0; px < width * height; px++) {
        const i = px * 4;
        if (channels === 1) {
          const v = scale(readSample());
          out[i] = out[i + 1] = out[i + 2] = v;
        } else {
          out[i] = scale(readSample());
          out[i + 1] = scale(readSample());
          out[i + 2] = scale(readSample());
        }
        out[i + 3] = 255;
      }
    }
  } else {
    // ASCII (P1/P2/P3): whitespace-separated decimal samples.
    for (let px = 0; px < width * height; px++) {
      const i = px * 4;
      if (type === 1) {
        const t = readToken(buf, pos); pos = t.pos;
        if (t.token === "") return null;
        const v = t.token === "1" ? 0 : 255; // 1 = black
        out[i] = out[i + 1] = out[i + 2] = v;
      } else if (channels === 1) {
        const t = readToken(buf, pos); pos = t.pos;
        if (t.token === "") return null;
        const v = scale(Number(t.token));
        out[i] = out[i + 1] = out[i + 2] = v;
      } else {
        for (let c = 0; c < 3; c++) {
          const t = readToken(buf, pos); pos = t.pos;
          if (t.token === "") return null;
          out[i + c] = scale(Number(t.token));
        }
      }
      out[i + 3] = 255;
    }
  }

  try {
    return await createImageBitmap(new ImageData(out, width, height));
  } catch {
    return null;
  }
}
