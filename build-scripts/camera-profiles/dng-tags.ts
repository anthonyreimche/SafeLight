// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The facts the build tool needs from a DNG written by Adobe's DNG Converter
// (the camera's BaselineExposure, which no profile file holds, and the EXIF
// names that tie it to a photo), and a RAW header's Make and Model, so a
// camera already measured isn't converted again.

import { readHeader, readIfd, type TagValue } from "./tiff.ts";

export interface DngFacts {
  /** Adobe's name for the camera. */
  uniqueCameraModel: string;
  /** EV Adobe adds for this camera before any profile offset. */
  baselineExposure: number;
  make: string;
  model: string;
  iso: number | null;
}

const TIFF = 42;
// Panasonic's RW2 ("IIU"), Olympus's ORF ("IIRO", "IIRS") are TIFF underneath.
const RAW_MAGICS = [TIFF, 0x55, 0x4f52, 0x5352];

const str = (tags: Map<number, TagValue>, tag: number): string => {
  const v = tags.get(tag);
  return typeof v === "string" ? v.trim() : "";
};
const num = (tags: Map<number, TagValue>, tag: number): number | undefined => {
  const v = tags.get(tag);
  return Array.isArray(v) && v.length > 0 ? v[0] : undefined;
};

/** The camera facts in a DNG, or null for a file that isn't a camera's DNG. */
export function readDngFacts(bytes: Uint8Array): DngFacts | null {
  try {
    const head = readHeader(bytes, TIFF);
    if (!head) return null;
    const ifd0 = readIfd(bytes, head.ifd, head.littleEndian);
    const uniqueCameraModel = str(ifd0, 0xc614);
    if (!uniqueCameraModel) return null;
    const exifAt = num(ifd0, 0x8769);
    const exif = exifAt !== undefined ? readIfd(bytes, exifAt, head.littleEndian) : new Map<number, TagValue>();
    return {
      uniqueCameraModel,
      baselineExposure: num(ifd0, 0xc62a) ?? 0,
      make: str(ifd0, 0x010f),
      model: str(ifd0, 0x0110),
      iso: num(exif, 0x8827) ?? num(exif, 0x8832) ?? null,
    };
  } catch {
    // Reads stay strict: the converter writes whole files, so a value that runs
    // off the end means a broken DNG, not one to read partly.
    return null;
  }
}

/** IFD0 Make and Model of a TIFF-based RAW (NEF, CR2, ARW, PEF, DNG, RW2,
 *  ORF…); null for other formats (CR3, RAF, X3F), and for a header or IFD0
 *  cut short. */
export function readMakeModel(bytes: Uint8Array): { make: string; model: string } | null {
  try {
    for (const magic of RAW_MAGICS) {
      const head = readHeader(bytes, magic);
      if (!head) continue;
      // Read from the first megabyte only: an RW2's IFD0 points at a multi-megabyte
      // embedded JPEG past that cut, and skipping it keeps Make and Model.
      const ifd0 = readIfd(bytes, head.ifd, head.littleEndian, { skipTruncated: true });
      const model = str(ifd0, 0x0110);
      return model ? { make: str(ifd0, 0x010f), model } : null;
    }
    return null;
  } catch {
    // The IFD0 entry table itself is cut off, so there is nothing to read.
    return null;
  }
}
