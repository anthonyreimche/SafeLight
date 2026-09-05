// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// EXIF writer for export. A canvas render strips every metadata segment, so the
// export pipeline harvests the source file's entries (catalog/exif
// readExifEntries), layers catalog-held user edits on top (RAW metadata edits
// live in sidecars/catalog, never in the source bytes), and this module
// serializes the result back into the exported container: a fresh
// little-endian TIFF block carried as a JPEG APP1 segment, a PNG eXIf chunk or
// a WebP EXIF chunk. The TIFF encoder weaves the same entry sets into its own
// IFD chain via serializeSubIfd. Orientation, pixel dimensions, colour space
// and software are rewritten to describe the exported image rather than the
// source; GPS entries are dropped unless the export opts in.

import type { RawExifEntry, RawExifIfds } from "@/catalog/exif";
import type { ExifData } from "@/catalog/types";
import { addWebpChunk, concat, crc32, readU32 } from "@/rendering/color-space";

const TAG = {
  ImageDescription: 0x010e,
  Orientation: 0x0112,
  Software: 0x0131,
  Artist: 0x013b,
  Copyright: 0x8298,
  ExifIFD: 0x8769,
  GPSIFD: 0x8825,
  ColorSpace: 0xa001,
  PixelXDimension: 0xa002,
  PixelYDimension: 0xa003,
} as const;

const GPS_TAG = {
  VersionID: 0x0000,
  LatitudeRef: 0x0001,
  Latitude: 0x0002,
  LongitudeRef: 0x0003,
  Longitude: 0x0004,
} as const;

const SRGB = 1;
const UNCALIBRATED = 0xffff; // the embedded ICC carries the real profile

/** The finalised IFD entry sets an export will carry. */
export interface ExportIfds {
  ifd0: RawExifEntry[];
  exif: RawExifEntry[];
  gps: RawExifEntry[];
}

export interface ExportExifOptions {
  /** Exported pixel dimensions (EXIF PixelXDimension / PixelYDimension). */
  width: number;
  height: number;
  /** True tags the EXIF colour space sRGB; anything wider is Uncalibrated. */
  srgb: boolean;
  includeLocation: boolean;
  /** Catalog-held user edits (EXIF Tools metadata editor and friends). RAW
   *  edits never reach the source file's bytes, so set fields are appended
   *  after the harvested entries and win the last-write dedup. GPS needs both
   *  coordinates and still requires includeLocation. */
  edited?: Pick<
    ExifData,
    "artist" | "copyright" | "imageDescription" | "gpsLatitude" | "gpsLongitude"
  >;
}

export function asciiEntry(tag: number, text: string): RawExifEntry {
  // EXIF ASCII values are byte strings; Latin-1 matches asciiTag's decoding on
  // re-import. Full Unicode belongs to XMP, not this tag type.
  const value = new Uint8Array(text.length + 1);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    value[i] = c <= 0xff ? c : 0x3f; // '?'
  }
  return { tag, type: 2, count: value.length, value };
}

export function shortEntry(tag: number, v: number): RawExifEntry {
  const value = new Uint8Array(2);
  new DataView(value.buffer).setUint16(0, v, true);
  return { tag, type: 3, count: 1, value };
}

export function longEntry(tag: number, v: number): RawExifEntry {
  const value = new Uint8Array(4);
  new DataView(value.buffer).setUint32(0, v, true);
  return { tag, type: 4, count: 1, value };
}

function byteEntry(tag: number, bytes: number[]): RawExifEntry {
  return { tag, type: 1, count: bytes.length, value: Uint8Array.from(bytes) };
}

function rationalEntry(tag: number, pairs: [number, number][]): RawExifEntry {
  const value = new Uint8Array(pairs.length * 8);
  const dv = new DataView(value.buffer);
  pairs.forEach(([num, den], i) => {
    dv.setUint32(i * 8, num, true);
    dv.setUint32(i * 8 + 4, den, true);
  });
  return { tag, type: 5, count: pairs.length, value };
}

// Unsigned D/M/S with 1/10000″ seconds — the three-rational form parseGpsCoord
// (and every mainstream reader) requires. Rounding may tip 60″ over into the
// next minute or degree.
function dmsRationals(coord: number): [number, number][] {
  const abs = Math.abs(coord);
  let deg = Math.trunc(abs);
  let min = Math.trunc((abs - deg) * 60);
  let sec = Math.round(((abs - deg) * 60 - min) * 60 * 10000);
  if (sec === 600000) {
    sec = 0;
    min += 1;
  }
  if (min === 60) {
    min = 0;
    deg += 1;
  }
  return [
    [deg, 1],
    [min, 1],
    [sec, 10000],
  ];
}

function editedIfd0Entries(edited: NonNullable<ExportExifOptions["edited"]>): RawExifEntry[] {
  const out: RawExifEntry[] = [];
  if (edited.imageDescription) out.push(asciiEntry(TAG.ImageDescription, edited.imageDescription));
  if (edited.artist) out.push(asciiEntry(TAG.Artist, edited.artist));
  if (edited.copyright) out.push(asciiEntry(TAG.Copyright, edited.copyright));
  return out;
}

function editedGpsEntries(edited: NonNullable<ExportExifOptions["edited"]>): RawExifEntry[] {
  const { gpsLatitude: lat, gpsLongitude: lon } = edited;
  if (lat === undefined || lon === undefined || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return [];
  }
  return [
    byteEntry(GPS_TAG.VersionID, [2, 3, 0, 0]),
    asciiEntry(GPS_TAG.LatitudeRef, lat < 0 ? "S" : "N"),
    rationalEntry(GPS_TAG.Latitude, dmsRationals(lat)),
    asciiEntry(GPS_TAG.LongitudeRef, lon < 0 ? "W" : "E"),
    rationalEntry(GPS_TAG.Longitude, dmsRationals(lon)),
  ];
}

/** Combine harvested source entries with catalog edits and the export-time
 *  overrides. Later entries win the per-tag dedup, so catalog edits override
 *  the file's own tags. A null source (unreadable file, EXIF-less container)
 *  still yields a valid block carrying the edits. The render bakes the upright
 *  orientation into the pixels, so the tag resets to 1. */
export function buildExportIfds(source: RawExifIfds | null, opts: ExportExifOptions): ExportIfds {
  const edited = opts.edited ?? {};
  return {
    ifd0: [
      ...(source?.ifd0 ?? []),
      ...editedIfd0Entries(edited),
      shortEntry(TAG.Orientation, 1),
      asciiEntry(TAG.Software, `Safelight ${__APP_VERSION__}`),
    ],
    exif: [
      ...(source?.exif ?? []),
      shortEntry(TAG.ColorSpace, opts.srgb ? SRGB : UNCALIBRATED),
      longEntry(TAG.PixelXDimension, opts.width),
      longEntry(TAG.PixelYDimension, opts.height),
    ],
    gps: opts.includeLocation ? [...(source?.gps ?? []), ...editedGpsEntries(edited)] : [],
  };
}

// ─── TIFF serialization ──────────────────────────────────────────────────────

interface IfdLayout {
  /** Deduplicated (last write wins) and sorted ascending by tag, as TIFF requires. */
  entries: RawExifEntry[];
  /** Total byte span: directory, then each out-of-line value at an even offset. */
  size: number;
  /** Per-entry local value offset; 0 when the value fits inline. */
  valueAt: number[];
}

function layoutIfd(entries: RawExifEntry[]): IfdLayout {
  const sorted = [...new Map(entries.map((e) => [e.tag, e])).values()].sort(
    (a, b) => a.tag - b.tag,
  );
  let size = 2 + sorted.length * 12 + 4; // count + entries + next-IFD pointer
  const valueAt = sorted.map((e) => {
    if (e.value.length <= 4) return 0;
    size += size & 1; // offsets must be even
    const at = size;
    size += e.value.length;
    return at;
  });
  size += size & 1; // keep whatever follows this block even-aligned
  return { entries: sorted, size, valueAt };
}

function writeIfd(l: IfdLayout, baseOffset: number): Uint8Array {
  const out = new Uint8Array(l.size);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, l.entries.length, true);
  let p = 2;
  l.entries.forEach((e, i) => {
    dv.setUint16(p, e.tag, true);
    dv.setUint16(p + 2, e.type, true);
    dv.setUint32(p + 4, e.count, true);
    if (l.valueAt[i] === 0) {
      out.set(e.value, p + 8); // inline, left-justified; the rest stays zero
    } else {
      dv.setUint32(p + 8, baseOffset + l.valueAt[i], true);
      out.set(e.value, l.valueAt[i]);
    }
    p += 12;
  });
  dv.setUint32(p, 0, true); // no next IFD
  return out;
}

/** Serialize one IFD (directory + values) as a self-contained block whose
 *  internal offsets assume the block starts at `baseOffset` in the final file.
 *  Used by the TIFF encoder to weave Exif/GPS sub-IFDs into its own chain. */
export function serializeSubIfd(entries: RawExifEntry[], baseOffset: number): Uint8Array {
  return writeIfd(layoutIfd(entries), baseOffset);
}

/** Serialize the complete EXIF TIFF block (IFD0 with Exif/GPS sub-IFD
 *  pointers) that JPEG APP1, PNG eXIf and WebP EXIF all carry verbatim. */
export function serializeExifTiff(ifds: ExportIfds): Uint8Array {
  const exifPtr = ifds.exif.length ? longEntry(TAG.ExifIFD, 0) : null;
  const gpsPtr = ifds.gps.length ? longEntry(TAG.GPSIFD, 0) : null;
  const ifd0 = layoutIfd([
    ...ifds.ifd0,
    ...(exifPtr ? [exifPtr] : []),
    ...(gpsPtr ? [gpsPtr] : []),
  ]);
  const exif = exifPtr ? layoutIfd(ifds.exif) : null;
  const gps = gpsPtr ? layoutIfd(ifds.gps) : null;

  // Pointer values are patched once the sub-IFD offsets are known; the
  // pointer entries are already part of the IFD0 layout, so its size is final.
  const HEADER = 8;
  let cursor = HEADER + ifd0.size;
  if (exifPtr && exif) {
    new DataView(exifPtr.value.buffer).setUint32(0, cursor, true);
    cursor += exif.size;
  }
  if (gpsPtr && gps) {
    new DataView(gpsPtr.value.buffer).setUint32(0, cursor, true);
    cursor += gps.size;
  }

  const out = new Uint8Array(cursor);
  const dv = new DataView(out.buffer);
  out[0] = 0x49; // 'I'
  out[1] = 0x49; // 'I' — little-endian, matching the harvested value bytes
  dv.setUint16(2, 42, true);
  dv.setUint32(4, HEADER, true);
  let at = HEADER;
  out.set(writeIfd(ifd0, at), at);
  at += ifd0.size;
  if (exif) {
    out.set(writeIfd(exif, at), at);
    at += exif.size;
  }
  if (gps) out.set(writeIfd(gps, at), at);
  return out;
}

// ─── Embedding into encoded image bytes ──────────────────────────────────────

/**
 * Return a new Blob with the EXIF TIFF block embedded in the container's
 * native form. Falls back to the original blob for any container that can't
 * be safely rewritten — an untagged export beats a corrupt one.
 */
export async function embedExif(blob: Blob, exifTiff: Uint8Array): Promise<Blob> {
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (blob.type === "image/jpeg") {
      return new Blob([jpegWithExif(bytes, exifTiff) as BlobPart], { type: "image/jpeg" });
    }
    if (blob.type === "image/png") {
      return new Blob([pngWithExif(bytes, exifTiff) as BlobPart], { type: "image/png" });
    }
    if (blob.type === "image/webp") {
      return new Blob([addWebpChunk(bytes, "EXIF", exifTiff) as BlobPart], { type: "image/webp" });
    }
  } catch {
    // Unexpected container layout or an oversized block: ship untagged.
  }
  return blob;
}

const EXIF_SIG = [0x45, 0x78, 0x69, 0x66, 0, 0]; // "Exif\0\0"

// JPEG: an Exif APP1 segment at the front of the header run, after any JFIF
// APP0 (which its spec pins to SOI). Any pre-existing Exif APP1 is dropped.
function jpegWithExif(src: Uint8Array, tiff: Uint8Array): Uint8Array {
  if (src[0] !== 0xff || src[1] !== 0xd8) throw new Error("not jpeg");
  const payload = 2 + EXIF_SIG.length + tiff.length; // length field + sig + block
  if (payload > 0xffff) throw new Error("exif exceeds APP1 capacity");

  const kept: Uint8Array[] = [];
  let i = 2;
  while (i + 4 <= src.length && src[i] === 0xff) {
    const marker = src[i + 1];
    if (marker === 0xda) break; // SOS → start of scan, stop scanning headers
    const len = (src[i + 2] << 8) | src[i + 3];
    const seg = src.subarray(i, i + 2 + len);
    const isExif =
      marker === 0xe1 && len >= 2 + EXIF_SIG.length && EXIF_SIG.every((b, k) => seg[4 + k] === b);
    if (!isExif) kept.push(seg);
    i += 2 + len;
  }

  const app1 = new Uint8Array(2 + payload);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1[2] = payload >> 8;
  app1[3] = payload & 0xff;
  app1.set(EXIF_SIG, 4);
  app1.set(tiff, 4 + EXIF_SIG.length);

  let lead = 0;
  while (lead < kept.length && kept[lead][1] === 0xe0) lead++;
  return concat([src.subarray(0, 2), ...kept.slice(0, lead), app1, ...kept.slice(lead), src.subarray(i)]);
}

// PNG: an eXIf chunk (raw TIFF block, no "Exif\0\0" prefix) before the first
// IDAT, replacing any eXIf already present.
function pngWithExif(src: Uint8Array, tiff: Uint8Array): Uint8Array {
  const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let k = 0; k < 8; k++) if (src[k] !== SIG[k]) throw new Error("not png");

  const chunk = new Uint8Array(12 + tiff.length);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, tiff.length);
  chunk[4] = 0x65; chunk[5] = 0x58; chunk[6] = 0x49; chunk[7] = 0x66; // 'eXIf'
  chunk.set(tiff, 8);
  dv.setUint32(8 + tiff.length, crc32(chunk.subarray(4, 8 + tiff.length)));

  const out: Uint8Array[] = [src.subarray(0, 8)];
  let i = 8;
  let inserted = false;
  while (i + 8 <= src.length) {
    const len = readU32(src, i);
    const type = String.fromCharCode(src[i + 4], src[i + 5], src[i + 6], src[i + 7]);
    const c = src.subarray(i, i + 12 + len);
    if (type === "IDAT" && !inserted) {
      out.push(chunk);
      inserted = true;
    }
    if (type !== "eXIf") out.push(c);
    i += 12 + len;
    if (type === "IEND") break;
  }
  return concat(out);
}
