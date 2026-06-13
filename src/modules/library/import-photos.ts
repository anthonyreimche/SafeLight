// Photo record construction + background RAW pre-decode. Photos enter the
// catalog exclusively through the project scan (see src/project/), which calls
// buildPhoto for each new file it finds.

import type { CatalogPhoto } from "@/catalog/types";
import { parseExif, parseExifDate } from "@/catalog/exif";
import { orientationToRotation } from "@/catalog/orient";
import { extractRawPreview, getExtension, isRawFile } from "./raw-preview";
import { decodeRawToFloat } from "@/raw/decode";
import { rotateFloatRGBA } from "@/catalog/orient";
import { readCachedPreview, writeCachedPreview } from "@/raw/raw-cache";

const SUPPORTED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/tiff",
]);

const SUPPORTED_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".avif",
  ".tiff",
  ".tif",
]);

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

// 768px long edge keeps thumbnails crisp even at the largest grid cell (400px
// square, which crops to cover — so the short edge must comfortably exceed it).
async function createThumbnail(
  bitmap: ImageBitmap,
  rotation: number,
  maxSize: number = 768,
): Promise<Blob> {
  // Upright dimensions (swapped for quarter turns), then bake the rotation in so
  // the stored thumbnail is already correctly oriented.
  const swap = rotation === 90 || rotation === 270;
  const srcW = swap ? bitmap.height : bitmap.width;
  const srcH = swap ? bitmap.width : bitmap.height;
  const scale = Math.min(maxSize / srcW, maxSize / srcH, 1);
  const w = Math.round(srcW * scale);
  const h = Math.round(srcH * scale);

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d")!;
  ctx.translate(w / 2, h / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  const drawW = bitmap.width * scale;
  const drawH = bitmap.height * scale;
  ctx.drawImage(bitmap, -drawW / 2, -drawH / 2, drawW, drawH);

  return canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 });
}

// Resolve a decodable image Blob from a file: RAW files yield their embedded
// JPEG preview, everything else decodes directly.
async function getImageSource(file: File): Promise<Blob | null> {
  if (isRawFile(file)) {
    return extractRawPreview(file);
  }
  return file;
}

// Windows often leaves file.type empty for RAW formats. Map extensions to the
// correct MIME types so the Info panel shows accurate metadata on all platforms.
const RAW_MIME: Record<string, string> = {
  ".nef": "image/x-nikon-nef",
  ".nrw": "image/x-nikon-nef",
  ".cr2": "image/x-canon-cr2",
  ".cr3": "image/x-canon-cr3",
  ".arw": "image/x-sony-arw",
  ".sr2": "image/x-sony-sr2",
  ".srw": "image/x-samsung-srw",
  ".dng": "image/x-adobe-dng",
  ".orf": "image/x-olympus-orf",
  ".raf": "image/x-fuji-raf",
  ".pef": "image/x-pentax-pef",
  ".rw2": "image/x-panasonic-rw2",
  ".iiq": "image/x-phaseone-iiq",
  ".3fr": "image/x-hasselblad-3fr",
  ".mos": "image/x-leaf-mos",
  ".mrw": "image/x-minolta-mrw",
  ".erf": "image/x-epson-erf",
  ".x3f": "image/x-sigma-x3f",
  ".kdc": "image/x-kodak-kdc",
};

function mimeTypeFromName(name: string): string {
  return RAW_MIME[getExtension(name)] ?? "";
}

/** Build a catalog record for a file: thumbnail, EXIF, orientation. The caller
 *  fills in relPath/folder (they're project-relative). */
export async function buildPhoto(
  file: File,
  directoryHandle: FileSystemDirectoryHandle | null,
  fileHandle: FileSystemFileHandle | null,
): Promise<CatalogPhoto | null> {
  if (!isSupported(file)) return null;

  const source = await getImageSource(file);
  if (!source) return null;

  // EXIF comes from the original file (the RAW container, not its preview); it
  // gives the orientation we bake into the thumbnail and re-apply at load time.
  const exif = await parseExif(file);
  const rotation = orientationToRotation(exif.orientation);

  let bitmap: ImageBitmap;
  try {
    // Decode raw pixels and apply orientation ourselves, so RAW (whose embedded
    // preview often drops the tag) and JPEG end up identically upright.
    bitmap = await createImageBitmap(source, { imageOrientation: "none" });
  } catch {
    return null;
  }

  const thumb = await createThumbnail(bitmap, rotation);
  const thumbUrl = URL.createObjectURL(thumb);

  const swap = rotation === 90 || rotation === 270;
  const width = swap ? bitmap.height : bitmap.width;
  const height = swap ? bitmap.width : bitmap.height;

  const photo: CatalogPhoto = {
    id: generateId(),
    filename: file.name,
    relPath: "",
    folder: "",
    directoryHandle,
    fileHandle,
    thumbnailBlob: thumb,
    thumbnailUrl: thumbUrl,
    width,
    height,
    fileSize: file.size,
    mimeType: file.type || mimeTypeFromName(file.name),
    rating: 0,
    colorLabel: "none",
    flag: "none",
    rotation,
    keywords: [],
    dateCreated: parseExifDate(exif.dateTimeOriginal) ?? file.lastModified,
    dateImported: Date.now(),
    exif,
  };

  bitmap.close();
  return photo;
}

/**
 * Pre-decode RAW files for newly discovered photos and write them to the
 * develop-preview cache (.safelight/raw/ in the open project) so the first
 * Develop open is instant instead of waiting for libraw.
 *
 * Runs sequentially (one at a time) to keep memory and CPU impact low while
 * the user browses the just-opened project. Already-cached photos are skipped.
 * Fire and forget.
 */
export async function preDecodeRawsForCache(photos: CatalogPhoto[]): Promise<void> {
  const raws = photos.filter((p) => p.fileHandle && isRawFile({ name: p.filename } as File));

  for (const photo of raws) {
    try {
      const file = await photo.fileHandle!.getFile();

      // Skip if already cached (e.g., re-opened the same project).
      const hit = await readCachedPreview(file);
      if (hit) continue; // already cached

      const f = await decodeRawToFloat(file);
      if (!f) continue;

      const r = f.oriented
        ? { data: f.data, width: f.width, height: f.height }
        : rotateFloatRGBA(f.data, f.width, f.height, photo.rotation ?? 0);

      await writeCachedPreview(file, r.data, r.width, r.height);

      // Yield to the event loop between files so the UI stays responsive.
      await new Promise<void>((res) => setTimeout(res, 0));
    } catch {
      // A single decode failure shouldn't stop the rest.
    }
  }
}
