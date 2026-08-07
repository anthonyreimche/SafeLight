// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// RAW files (Nikon NEF, etc.) are TIFF-based containers that embed one or more
// JPEG previews. Until full RAW decoding lands (libraw/WASM, Phase 3), we
// extract the largest *decodable* embedded JPEG so RAW files import and display.

const RAW_EXTENSIONS = new Set([
  ".nef",
  ".cr2",
  ".cr3",
  ".arw",
  ".dng",
  ".orf",
  ".raf",
  ".pef",
  ".srw",
  ".rw2",
  ".iiq",
  ".3fr",
  ".nrw",
  ".kdc",
  ".mos",
  ".mrw",
  ".erf",
  ".sr2",
  ".x3f",
  ".srf",
  ".dcr",
  ".rwl",
  ".fff",
  ".gpr",
  ".mef",
  ".crw",
  ".raw", // generic/Panasonic/Leica sensor dump — libraw decodes it
  ".mdc", // Minolta RD175 — libraw decodes it
]);

export function getExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot).toLowerCase();
}

export function isRawFile(file: File): boolean {
  return RAW_EXTENSIONS.has(getExtension(file.name));
}

// Formats whose full sensor decode is unreliable, so the camera's embedded JPEG
// is the trustworthy grid thumbnail (used even below the render threshold in
// "auto" mode). Sigma X3F is Foveon, which libraw frequently mis-decodes into a
// near-black/garbage frame — its embedded JPEG preview is sound, so prefer it.
const EMBEDDED_PREFERRED = new Set([".x3f"]);

export function prefersEmbeddedPreview(file: File): boolean {
  return EMBEDDED_PREFERRED.has(getExtension(file.name));
}

// The mirror case: formats whose embedded preview can't be located by the JPEG
// byte-scan (it returns a gray-noise false match) but whose libraw decode is
// sound. Canon CRW is CIFF — not a clean JPEG container — so its real thumbnail
// lives in a CIFF record the byte-scan misses; render it instead of trusting the
// bogus preview.
const RENDER_ONLY = new Set([".crw"]);

export function distrustsEmbeddedPreview(file: File): boolean {
  return RENDER_ONLY.has(getExtension(file.name));
}

interface JpegRange {
  start: number;
  end: number;
}

// Find the end offset (exclusive) of the JPEG starting at `start` (an SOI), by
// walking marker segments rather than scanning for the first `FF D9`. Camera
// preview JPEGs embed an EXIF thumbnail — its own SOI…EOI inside the APP1
// segment — so a naive `FF D9` search stops at the INNER thumbnail's EOI and
// yields a truncated, undecodable preview. Skipping each segment by its declared
// length walks past the thumbnail to the OUTER EOI. Returns -1 if malformed.
// Exported for unit testing.
export function findJpegEnd(buf: Uint8Array, start: number): number {
  const n = buf.length;
  let p = start + 2; // past SOI (FF D8)
  while (p + 1 < n) {
    if (buf[p] !== 0xff) {
      p++; // resync to the next marker prefix
      continue;
    }
    // Collapse any run of 0xFF fill bytes onto the marker code.
    let marker = buf[p + 1];
    while (marker === 0xff && p + 2 < n) {
      p++;
      marker = buf[p + 1];
    }
    if (marker === 0xd9) return p + 2; // EOI
    // Standalone markers (TEM, RSTn) carry no length payload.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      p += 2;
      continue;
    }
    // Every other marker has a 2-byte big-endian segment length.
    if (p + 4 > n) return -1;
    const len = (buf[p + 2] << 8) | buf[p + 3];
    if (len < 2) return -1;
    if (marker === 0xda) {
      // Start of scan: entropy-coded data follows. Find the next real marker
      // (the EOI, or a later scan in progressive JPEGs), skipping stuffed FF00
      // and restart markers FF D0–D7.
      let q = p + 2 + len;
      while (q + 1 < n) {
        if (buf[q] === 0xff) {
          const m = buf[q + 1];
          if (m === 0xd9) return q + 2;
          if (m === 0x00 || (m >= 0xd0 && m <= 0xd7)) {
            q += 2;
            continue;
          }
          break; // another segment marker — resume the outer walk
        }
        q++;
      }
      if (q + 1 >= n) return -1;
      p = q;
      continue;
    }
    p += 2 + len;
  }
  return -1;
}

// Collect every embedded JPEG's byte range, sorted largest-first. Each range is
// the FULL outer JPEG (findJpegEnd skips nested EXIF thumbnails), and the cursor
// jumps past it so the inner thumbnail is never collected as a separate, broken
// candidate.
function collectJpegs(buf: Uint8Array): JpegRange[] {
  const found: JpegRange[] = [];
  const n = buf.length;
  let i = 0;

  // Hop between FF bytes with the native indexOf instead of walking every byte
  // in JS — RAW files are tens of MB, and this scan dominated extraction time.
  while (i < n - 2) {
    const ff = buf.indexOf(0xff, i);
    if (ff === -1 || ff >= n - 2) break;
    if (buf[ff + 1] === 0xd8 && buf[ff + 2] === 0xff) {
      const end = findJpegEnd(buf, ff);
      if (end === -1) {
        // Truncated segment or a stray FF D8 FF match (common in CRW/CIFF and
        // other odd containers). Skip past it and keep scanning rather than
        // abandoning the rest of the file.
        i = ff + 3;
        continue;
      }
      found.push({ start: ff, end });
      i = end;
    } else {
      i = ff + 1;
    }
  }

  return found.sort((a, b) => b.end - b.start - (a.end - a.start));
}

export interface DecodedRawPreview {
  blob: Blob;
  /** Decoded with imageOrientation:"none" (sensor-native pixels) — orientation
   *  is the caller's job, from the master RAW's EXIF. */
  bitmap: ImageBitmap;
}

// Return the largest embedded JPEG that the browser can actually decode, WITH
// the bitmap that proved it. The largest segment is sometimes the lossless-
// compressed raw sensor data (SOF3), which browsers can't decode — so we test
// candidates and fall back to the next. Handing the winning bitmap out lets the
// import path decode each preview exactly once instead of once to test and
// again to use.
export async function extractRawPreviewDecoded(
  file: File,
): Promise<DecodedRawPreview | null> {
  const arrayBuffer = await file.arrayBuffer();
  const candidates = collectJpegs(new Uint8Array(arrayBuffer));

  for (const { start, end } of candidates) {
    const blob = new Blob([arrayBuffer.slice(start, end)], {
      type: "image/jpeg",
    });
    try {
      const bitmap = await createImageBitmap(blob, { imageOrientation: "none" });
      return { blob, bitmap };
    } catch {
      // Not a decodable baseline JPEG — try the next candidate.
    }
  }

  return null;
}

/** Blob-only variant for callers that decode later themselves (load-image). */
export async function extractRawPreview(file: File): Promise<Blob | null> {
  const decoded = await extractRawPreviewDecoded(file);
  if (!decoded) return null;
  decoded.bitmap.close();
  return decoded.blob;
}
