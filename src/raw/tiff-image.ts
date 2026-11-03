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

const tagValue = (ifd: UTIF.IFD, tag: string): number =>
  Number((ifd[tag] as number[] | undefined)?.[0] ?? 0);

// IFD dimensions come from tags (t256=ImageWidth, t257=ImageLength) and are
// readable before decodeImage. Pick the largest page so a leading thumbnail IFD
// never wins over the full image.
function ifdSize(ifd: UTIF.IFD): { width: number; height: number } {
  const width = tagValue(ifd, "t256") || Number(ifd.width ?? 0);
  const height = tagValue(ifd, "t257") || Number(ifd.height ?? 0);
  return width > 0 && height > 0 ? { width, height } : { width: 0, height: 0 };
}

const ifdArea = (ifd: UTIF.IFD): number => {
  const { width, height } = ifdSize(ifd);
  return width * height;
};

// NewSubfileType (t254) bit 0 flags a reduced-resolution copy of another image.
const isReduced = (ifd: UTIF.IFD): boolean => (tagValue(ifd, "t254") & 1) === 1;

/** The smallest reduced-resolution copy of `full` (a later page or a SubIFD)
 *  whose long edge still reaches `minLongEdge`, with the same shape. */
function reducedPage(ifds: UTIF.IFD[], full: UTIF.IFD, minLongEdge: number): UTIF.IFD | undefined {
  const { width, height } = ifdSize(full);
  const subIfds = ifds.flatMap((ifd) => (ifd.subIFD as unknown as UTIF.IFD[] | undefined) ?? []);
  let best: UTIF.IFD | undefined;
  for (const ifd of [...ifds, ...subIfds]) {
    if (ifd === full || !isReduced(ifd)) continue;
    const size = ifdSize(ifd);
    const sameShape = Math.abs(size.width * height - size.height * width) <= 0.01 * width * height;
    if (!sameShape || Math.max(size.width, size.height) < minLongEdge) continue;
    if (size.width >= width || (best && ifdArea(ifd) >= ifdArea(best))) continue;
    best = ifd;
  }
  return best;
}

async function pageBitmap(buffer: ArrayBuffer, page: UTIF.IFD): Promise<ImageBitmap | null> {
  UTIF.decodeImage(buffer, page);
  const width = page.width;
  const height = page.height;
  if (!width || !height) return null;

  // toRGBA8 normalizes any bit-depth/photometric (incl. 16-bit, CMYK, YCbCr)
  // down to 8-bit RGBA, ready for ImageData.
  const rgba = UTIF.toRGBA8(page);
  const expected = width * height * 4;
  if (rgba.length < expected) return null;

  // Copy into a fresh, exactly-sized clamped array (ImageData wants its own
  // ArrayBuffer-backed buffer, not a view that might be SharedArrayBuffer-backed).
  const out = new Uint8ClampedArray(expected);
  out.set(rgba.subarray(0, expected));
  return createImageBitmap(new ImageData(out, width, height));
}

/** A TIFF's bitmap, and the size of its full image, which a bitmap decoded
 *  from a reduced-resolution copy is smaller than. */
export interface DecodedTiff {
  bitmap: ImageBitmap;
  width: number;
  height: number;
}

/**
 * Decode a TIFF to a bitmap, or null if it isn't a parseable TIFF. Given a
 * `minLongEdge` (a thumbnail's), it decodes the smallest reduced-resolution
 * copy the file carries that still reaches it, when there is one, instead of
 * the full image. Best-effort: malformed/unsupported files return null so the
 * caller can fall back rather than throw.
 */
export async function decodeTiffBuffer(
  buffer: ArrayBuffer,
  minLongEdge?: number,
): Promise<DecodedTiff | null> {
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

    const reduced = minLongEdge === undefined ? undefined : reducedPage(ifds, page, minLongEdge);
    if (reduced) {
      try {
        const bitmap = await pageBitmap(buffer, reduced);
        if (bitmap) return { bitmap, ...ifdSize(page) };
      } catch {
        // an undecodable copy: the full image below
      }
    }
    const bitmap = await pageBitmap(buffer, page);
    return bitmap ? { bitmap, width: bitmap.width, height: bitmap.height } : null;
  } catch {
    return null;
  }
}

/** Decode a TIFF file's full image (see decodeTiffBuffer). */
export async function decodeTiff(file: Blob): Promise<ImageBitmap | null> {
  let buffer: ArrayBuffer;
  try {
    buffer = await file.arrayBuffer();
  } catch {
    return null;
  }
  return (await decodeTiffBuffer(buffer))?.bitmap ?? null;
}
