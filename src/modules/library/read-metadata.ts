// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A file's metadata before it is imported: what an ingest names and sorts it
// by. It is the EXIF and XMP import reads, from as little of the file as import
// reads them.

import type { ExifData } from "@/catalog/types";
import { parseExif, parseExifDate, parseXmp, type XmpData } from "@/catalog/exif";
import { isSupportedName } from "@/catalog/photo-names";
import { isHeifHead } from "@/raw/heif-container";
import { readFileSlice } from "@/project/native-fs";

/** How much of a file is read for its metadata: EXIF and XMP lie in the first
 *  MiB of every format Safelight imports but HEIF. */
export const METADATA_HEAD_BYTES = 2 ** 20;

/** How much of a file handle is read first: enough for the EXIF of nearly
 *  every camera file. */
export const METADATA_FIRST_BYTES = 256 * 2 ** 10;

export interface FileMetadata {
  exif: ExifData;
  /** The capture time in ms, else the file's modification time. */
  dateCreated: number | undefined;
  /** The XMP star rating the camera wrote, if any. */
  rating?: number;
  keywords: string[];
  /** The whole file's size in bytes. */
  size: number;
}

/** A file's EXIF and XMP, both read from its first MiB. EXIF is independent of
 *  the pixel decode, so even a file that can't be decoded yet gets its date and
 *  orientation. XMP carries the camera/editor-written star rating, colour label,
 *  keywords and title (Nikon stores the in-camera rating here, not in an EXIF tag
 *  — it's what Windows Explorer surfaces). These seed the catalogue's editable
 *  fields; a SafeLight sidecar, if present, overrides them on import (see
 *  project-storage). */
export async function readTags(file: Blob): Promise<{ exif: ExifData; xmp: XmpData }> {
  const exif = await parseExif(file);
  const xmp = await parseXmp(file);
  if (!exif.imageDescription && xmp.title) exif.imageDescription = xmp.title;
  return { exif, xmp };
}

function isFileHandle(file: unknown): file is FileSystemFileHandle {
  return (
    typeof file === "object" &&
    file !== null &&
    (file as FileSystemFileHandle).kind === "file" &&
    typeof (file as FileSystemFileHandle).getFile === "function"
  );
}

interface Read {
  tags: { exif: ExifData; xmp: XmpData };
  size: number;
  lastModified?: number;
}

async function readBlob(file: Blob): Promise<Read> {
  const lastModified = file instanceof File ? file.lastModified : undefined;
  const head = file.slice(0, METADATA_HEAD_BYTES);
  const whole = isHeifHead(new Uint8Array(await head.slice(0, 4096).arrayBuffer()));
  return { tags: await readTags(whole ? file : head), size: file.size, lastModified };
}

/** A file handle's tags from its first part, read on to the first MiB when no
 *  capture time turned up there, or from the whole file for HEIF, which keeps
 *  its EXIF in an item anywhere. A card of thousands of photos is planned from
 *  a quarter of what reading each one's first MiB would take. */
async function readHandle(file: FileSystemFileHandle): Promise<Read> {
  const head = await readFileSlice(file, 0, METADATA_FIRST_BYTES);
  const { size, lastModified } = head;
  if (head.data.length < size && isHeifHead(head.data)) {
    const whole = await file.getFile();
    return { tags: await readTags(whole), size: whole.size, lastModified: whole.lastModified };
  }
  const tags = await readTags(new Blob([head.data]));
  if (tags.exif.dateTimeOriginal || head.data.length >= size) return { tags, size, lastModified };
  const rest = await readFileSlice(file, head.data.length, METADATA_HEAD_BYTES);
  return { tags: await readTags(new Blob([head.data, rest.data])), size, lastModified };
}

/** The EXIF and XMP Safelight reads when it imports `file`, read now, before
 *  it is imported: a desktop file handle reads only as much of the file's first
 *  MiB as its capture time needs (a HEIF file is read whole). Null for a file of a type Safelight doesn't import
 *  (by its name; a Blob without one is read), or one that can't be read. */
export async function readMetadata(file: FileSystemFileHandle | Blob): Promise<FileMetadata | null> {
  const name = isFileHandle(file) ? file.name : file instanceof File ? file.name : undefined;
  if (!isFileHandle(file) && !(file instanceof Blob)) return null;
  if (name !== undefined && !isSupportedName(name)) return null;
  try {
    const { tags, size, lastModified } = isFileHandle(file) ? await readHandle(file) : await readBlob(file);
    const { exif, xmp } = tags;
    return {
      exif,
      dateCreated: parseExifDate(exif.dateTimeOriginal) ?? lastModified,
      ...(xmp.rating !== undefined ? { rating: xmp.rating } : {}),
      keywords: xmp.keywords ?? [],
      size,
    };
  } catch {
    return null;
  }
}
