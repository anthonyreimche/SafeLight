// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Ordinary (non-RAW) TIFF decoder. Chromium's createImageBitmap rejects TIFF
// and libraw only handles sensor/CFA data, so plain RGB/CMYK/grayscale TIFFs —
// scans, exports, multi-page — had no decode path at all. UTIF handles the TIFF
// container (uncompressed, LZW, PackBits, deflate, old-style JPEG) and any
// bit-depth/photometric, returning 8-bit RGBA we hand back as an ImageBitmap
// that flows through the normal JPEG-like path. Pure JS, no DOM, so it runs on
// the main thread or in a worker.

import * as UTIF from "utif2";
import { MAX_DECODE_PIXELS } from "./decode-limits";
import { getExtension } from "./raw-preview";

const TIFF_EXTENSIONS = new Set([".tif", ".tiff"]);

/** Name-only check, mirroring isRawFile/isNetpbmName (no File needed). */
export function isTiffName(name: string): boolean {
  return TIFF_EXTENSIONS.has(getExtension(name));
}

// IFD dimensions come from tags (t256=ImageWidth, t257=ImageLength) and are
// readable before decodeImage. Pick the largest page so a leading thumbnail IFD
// never wins over the full image.
function ifdArea(ifd: UTIF.IFD): number {
  const w = Number((ifd["t256"] as number[] | undefined)?.[0] ?? ifd.width ?? 0);
  const h = Number((ifd["t257"] as number[] | undefined)?.[0] ?? ifd.height ?? 0);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Decode a TIFF file to an ImageBitmap, or null if it isn't a parseable TIFF.
 * Best-effort: malformed/unsupported files return null so the caller can fall
 * back rather than throw.
 */
export async function decodeTiff(file: Blob): Promise<ImageBitmap | null> {
  let buffer: ArrayBuffer;
  try {
    buffer = await file.arrayBuffer();
  } catch {
    return null;
  }

  try {
    const ifds = UTIF.decode(buffer);
    if (!ifds.length) return null;

    // Largest page (falls back to the first when no IFD carries dimensions).
    let page = ifds[0];
    let best = ifdArea(page);
    for (const ifd of ifds) {
      const area = ifdArea(ifd);
      if (area > best) {
        best = area;
        page = ifd;
      }
    }

    // Reject absurd dimensions from the IFD tags before decodeImage allocates.
    if (best > MAX_DECODE_PIXELS) return null;

    UTIF.decodeImage(buffer, page);
    const width = page.width;
    const height = page.height;
    if (!width || !height) return null;

    // toRGBA8 normalises any bit-depth/photometric (incl. 16-bit, CMYK, YCbCr)
    // down to 8-bit RGBA, ready for ImageData.
    const rgba = UTIF.toRGBA8(page);
    const expected = width * height * 4;
    if (rgba.length < expected) return null;

    // Copy into a fresh, exactly-sized clamped array (ImageData wants its own
    // ArrayBuffer-backed buffer, not a view that might be SharedArrayBuffer-backed).
    const out = new Uint8ClampedArray(expected);
    out.set(rgba.subarray(0, expected));
    return await createImageBitmap(new ImageData(out, width, height));
  } catch {
    return null;
  }
}
