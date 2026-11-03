// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Photo record construction: the supported-format tables, and the import of a
// file into a catalogue record with its grid preview, EXIF and orientation.

import type { CatalogPhoto, ExifData } from "@/catalog/types";
import { parseExif, parseExifDate, parseXmp, type XmpData } from "@/catalog/exif";
import { bakeFor, orientationToRotation } from "@/catalog/orient";
import {
  distrustsEmbeddedPreview,
  getExtension,
  isRawFile,
  previewLongEdge,
} from "@/raw/raw-preview";
import photoTypes from "../../../electron/photo-types.json";
import { isTiffName } from "@/raw/tiff-image";
import type { DecodeFailure } from "@/raw/decode";
import { getSettings } from "@/state/settings-store";
import { readFileSlice, type FileSlice } from "@/project/native-fs";
import { createThumbnail } from "./import-thumb-task";
import {
  catalogSize,
  decodeImportBitmap,
  rawBytesOf,
  readRawMetadata,
  workerThumb,
} from "./import-decode";

const SUPPORTED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/tiff",
]);

const SUPPORTED_EXTENSIONS = new Set(Object.keys(photoTypes.standard));

/** Name-only check used by the project scanner (no File object needed). */
export function isSupportedName(name: string): boolean {
  const ext = getExtension(name);
  return (
    SUPPORTED_EXTENSIONS.has(ext) || isRawFile({ name } as File)
  );
}

function isSupported(file: File): boolean {
  const ext = getExtension(file.name);
  if (isRawFile(file)) return true;
  if (SUPPORTED_EXTENSIONS.has(ext)) return true;
  return SUPPORTED_TYPES.has(file.type);
}

function generateId(): string {
  return crypto.randomUUID();
}

/** Build a grid preview blob for a photo straight from its source file, at the
 *  current Thumbnail quality. Used to rebuild previews on demand when "Store
 *  previews on disk" is off (memory-only mode). Returns null if it can't decode.
 *  Its decode is background work: a photo opened meanwhile goes first. */
export async function buildPreviewBlob(
  photo: CatalogPhoto,
  signal?: AbortSignal,
): Promise<Blob | null> {
  if (!photo.fileHandle) return null;
  try {
    const file = await photo.fileHandle.getFile();
    const decoded = await decodeImportBitmap(
      file,
      photo.exif.orientation,
      { background: true, signal },
      undefined,
      photo.relPath,
    );
    if (!decoded || "failure" in decoded) return null;
    const { bitmap, oriented } = decoded;
    // Bake to the photo's canonical orientation (EXIF + manual). When the decode
    // already oriented the pixels, subtract the EXIF portion so we don't rotate
    // twice — mirrors the load path.
    const { bake } = bakeFor(photo, oriented);
    const blob = await createThumbnail(bitmap, bake, getSettings().thumbMaxEdge);
    bitmap.close();
    return blob;
  } catch {
    return null;
  }
}

// Windows often leaves file.type empty for RAW formats. Map extensions to the
// correct MIME types so the Info panel shows accurate metadata on all platforms.
const RAW_MIME: Record<string, string | null> = photoTypes.raw;

export function mimeTypeFromName(name: string): string {
  return RAW_MIME[getExtension(name)] ?? "";
}

// XMP colour labels are free-text (Adobe/Nikon write capitalized colour names).
// Map the ones SafeLight understands; anything else leaves the label unset.
function mapColorLabel(
  label: string | undefined,
): CatalogPhoto["colorLabel"] | undefined {
  switch (label?.toLowerCase()) {
    case "red":
    case "yellow":
    case "green":
    case "blue":
    case "purple":
      return label!.toLowerCase() as CatalogPhoto["colorLabel"];
    default:
      return undefined;
  }
}

/** One plain sentence on why the decode chain produced no preview, shown after
 *  the file name in the grid's warning tooltip: for a RAW, whether reading it
 *  again could help (its float decode's own words go to the console). */
export function decodeFailureReason(file: File, failure: DecodeFailure | null): string {
  if (isRawFile(file)) {
    return failure?.failure === "unsupported"
      ? "This RAW file can't be decoded."
      : "This RAW file couldn't be read this time.";
  }
  if (isTiffName(file.name)) return "This kind of TIFF file isn't supported.";
  return "No decoder could read this file.";
}

/** A file's EXIF and XMP, both read from its first MiB. EXIF is independent of
 *  the pixel decode, so even a file that can't be decoded yet gets its date and
 *  orientation. XMP carries the camera/editor-written star rating, colour label,
 *  keywords and title (Nikon stores the in-camera rating here, not in an EXIF tag
 *  — it's what Windows Explorer surfaces). These seed the catalogue's editable
 *  fields; a SafeLight sidecar, if present, overrides them on import (see
 *  project-storage). */
async function readTags(file: Blob): Promise<{ exif: ExifData; xmp: XmpData }> {
  const exif = await parseExif(file);
  const xmp = await parseXmp(file);
  if (!exif.imageDescription && xmp.title) exif.imageDescription = xmp.title;
  return { exif, xmp };
}

/** The fields a new record starts with, whatever built its preview. A supported
 *  file is ALWAYS recorded so it imports exactly once and is never re-scanned as
 *  "new" on later opens — the id stays stable (edits/ratings stick to it) and the
 *  catalogue count is honest. `size` is the whole file's. */
function newRecord(
  file: { name: string; type: string; lastModified: number },
  size: number,
  { exif, xmp }: { exif: ExifData; xmp: XmpData },
  directoryHandle: FileSystemDirectoryHandle | null,
  fileHandle: FileSystemFileHandle | null,
) {
  return {
    id: generateId(),
    filename: file.name,
    relPath: "",
    folder: "",
    directoryHandle,
    fileHandle,
    fileSize: size,
    mimeType: file.type || mimeTypeFromName(file.name),
    rating: xmp.rating ?? 0,
    colorLabel: mapColorLabel(xmp.colorLabel) ?? ("none" as const),
    flag: "none" as const,
    keywords: xmp.keywords ?? [],
    dateCreated: parseExifDate(exif.dateTimeOriginal) ?? file.lastModified,
    dateImported: Date.now(),
    exif,
  };
}

/** How far into a RAW the import reads for a camera preview the grid can use:
 *  its head first (EXIF and XMP lie in the first MiB), then twice as far each
 *  time, before it gives up on a preview and reads the rest. Cameras put their
 *  previews ahead of the sensor data, within the first few MB. */
const PREVIEW_READS = [1, 2, 4, 8, 16].map((mib) => mib * 2 ** 20);

/** The start of a RAW, read on until it holds a complete camera preview whose
 *  long edge reaches `minLongEdge`, or else the whole file. */
async function readPreviewPrefix(
  handle: FileSystemFileHandle,
  minLongEdge: number,
): Promise<FileSlice> {
  const head = await readFileSlice(handle, 0, PREVIEW_READS[0]);
  let data = head.data;
  for (const end of [...PREVIEW_READS.slice(1), head.size]) {
    if (data.length >= head.size || previewLongEdge(data) >= minLongEdge) break;
    const more = await readFileSlice(handle, data.length, end);
    const joined = new Uint8Array(data.length + more.data.length);
    joined.set(data);
    joined.set(more.data, data.length);
    data = joined;
  }
  return { ...head, data };
}

/** Import a file the project scan found, reading as little of it as its grid
 *  preview needs. A RAW is read only as far as a camera preview the grid can use
 *  (a 25 MB RAW off a spinning disk takes ten times as long to read whole) and is
 *  recorded with its libraw metadata pending, for readPendingMetadata to read
 *  from the whole file once the import is done. Any other file, and a RAW whose
 *  preview won't do, is read whole and built by buildPhoto. The caller fills in
 *  relPath/folder. */
export async function importPhoto(
  fileHandle: FileSystemFileHandle,
  directoryHandle: FileSystemDirectoryHandle | null,
): Promise<CatalogPhoto | null> {
  const whole = async () => buildPhoto(await fileHandle.getFile(), directoryHandle, fileHandle);
  const named = { name: fileHandle.name } as File;
  const { previewSource, thumbMaxEdge } = getSettings();
  if (!isRawFile(named) || previewSource === "rendered" || distrustsEmbeddedPreview(named))
    return whole();

  const prefix = await readPreviewPrefix(fileHandle, thumbMaxEdge);
  const file = new File([prefix.data], fileHandle.name, {
    type: prefix.type,
    lastModified: prefix.lastModified,
  });
  if (prefix.data.length >= prefix.size) return buildPhoto(file, directoryHandle, fileHandle);

  const tags = await readTags(file);
  const pix = await workerThumb(file, tags.exif.orientation);
  if (!pix) return whole();
  return {
    ...newRecord(file, prefix.size, tags, directoryHandle, fileHandle),
    thumbnailBlob: pix.thumb,
    thumbnailUrl: URL.createObjectURL(pix.thumb),
    width: pix.width,
    height: pix.height,
    rotation: orientationToRotation(tags.exif.orientation),
    metadataPending: true,
  };
}

/** Build a catalogue record for a file: thumbnail, EXIF, orientation. The caller
 *  fills in relPath/folder (they're project-relative). */
export async function buildPhoto(
  file: File,
  directoryHandle: FileSystemDirectoryHandle | null,
  fileHandle: FileSystemFileHandle | null,
): Promise<CatalogPhoto | null> {
  if (!isSupported(file)) return null;

  const tags = await readTags(file);
  const { exif } = tags;
  const bytes = await rawBytesOf(file);

  // The metadata-only libraw pass (frame size, plus as-shot WB from cam_mul —
  // parseExif already covers DNG via AsShotNeutral) and the pixel stage run
  // concurrently: the pass needs a libraw slot on the main side while the
  // worker pool decodes/orients/encodes off-thread.
  const [rawMeta, pix] = await Promise.all([
    readRawMetadata(file, undefined, bytes),
    workerThumb(file, exif.orientation, bytes),
  ]);
  if (rawMeta?.colorTemperature && !exif.colorTemperature) {
    exif.colorTemperature = rawMeta.colorTemperature;
  }
  if (rawMeta?.rawExposureBias !== undefined) exif.rawExposureBias = rawMeta.rawExposureBias;

  const base = newRecord(file, file.size, tags, directoryHandle, fileHandle);

  if (pix) {
    // The worker sized the record by what it thumbnailed — see catalogSize.
    const { width, height } = rawMeta?.frame ?? pix;
    return {
      ...base,
      thumbnailBlob: pix.thumb,
      thumbnailUrl: URL.createObjectURL(pix.thumb),
      width,
      height,
      rotation: orientationToRotation(exif.orientation),
    };
  }

  const decoded = await decodeImportBitmap(
    file,
    exif.orientation,
    undefined,
    undefined,
    undefined,
    bytes,
  ).catch(() => null);
  if (!decoded || "failure" in decoded) {
    // Couldn't build a preview right now (e.g. a file briefly locked, or a format
    // libraw can't yet read). Record it anyway with width 0 as the "preview not
    // built" marker; repairMissingPreviews (and the next open) will retry — the
    // photo is never re-imported, just updated in place later.
    console.warn(
      `[import] preview deferred (decode failed for now): ${file.name}`,
      decoded?.reason ?? "no decoder could read it",
    );
    return {
      ...base,
      thumbnailBlob: null,
      thumbnailUrl: null,
      width: 0,
      height: 0,
      rotation: orientationToRotation(exif.orientation),
      decodeError: decodeFailureReason(file, decoded),
    };
  }

  const { bitmap, oriented, colorTemperature } = decoded;
  if (colorTemperature && !exif.colorTemperature) {
    exif.colorTemperature = colorTemperature;
  }
  // Rotation needed to bake THIS decode upright for the stored thumbnail: 0 when
  // the decoder already oriented the pixels (libraw), else the EXIF orientation.
  const bake = oriented ? 0 : orientationToRotation(exif.orientation);

  const thumb = await createThumbnail(bitmap, bake, getSettings().thumbMaxEdge);
  const thumbUrl = URL.createObjectURL(thumb);

  // Nothing manual has been applied at import.
  const { width, height } = catalogSize(rawMeta?.frame, 0, decoded, bake);

  bitmap.close();
  return {
    ...base,
    thumbnailBlob: thumb,
    thumbnailUrl: thumbUrl,
    width,
    height,
    // Canonical: the total rotation that brings SENSOR-NATIVE pixels upright,
    // always including the EXIF orientation — independent of which decoder
    // oriented the thumbnail above. Load-time decoders that pre-orient subtract
    // this EXIF portion (load-image.ts); storing 0 here would make them
    // over-rotate, so the develop view wouldn't match this thumbnail.
    rotation: orientationToRotation(exif.orientation),
  };
}
