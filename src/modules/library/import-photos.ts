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

async function buildPhoto(
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
    directoryHandle,
    fileHandle,
    thumbnailBlob: thumb,
    thumbnailUrl: thumbUrl,
    width,
    height,
    fileSize: file.size,
    mimeType: file.type || (isRawFile(file) ? "image/x-nikon-nef" : ""),
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

async function buildMany(
  files: File[],
  directoryHandle: FileSystemDirectoryHandle | null,
  fileHandles: (FileSystemFileHandle | null)[] | null,
): Promise<CatalogPhoto[]> {
  const results = await Promise.all(
    files.map((file, i) =>
      buildPhoto(file, directoryHandle, fileHandles?.[i] ?? null),
    ),
  );
  return results.filter((p): p is CatalogPhoto => p !== null);
}

/**
 * Pre-decode RAW files for imported photos and write them to the develop-preview
 * cache so the first Develop open is instant instead of waiting for libraw.
 *
 * Runs sequentially (one at a time) to keep memory and CPU impact low while
 * the user browses the just-imported library. Already-cached photos are skipped.
 * Call this after saving imported photos to the catalog — fire and forget.
 */
export async function preDecodeRawsForCache(photos: CatalogPhoto[]): Promise<void> {
  const raws = photos.filter((p) => p.fileHandle && isRawFile({ name: p.filename } as File));

  for (const photo of raws) {
    try {
      const file = await photo.fileHandle!.getFile();

      // Skip if already cached (e.g., re-imported the same folder).
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

export async function importFiles(): Promise<CatalogPhoto[]> {
  if (!("showOpenFilePicker" in window)) {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = "image/*,.nef,.cr2,.cr3,.arw,.dng,.orf,.raf,.pef,.srw,.rw2,.iiq,.3fr,.nrw,.kdc,.mos,.mrw,.erf,.sr2,.x3f";

    return new Promise((resolve) => {
      input.onchange = async () => {
        if (!input.files) return resolve([]);
        resolve(await buildMany(Array.from(input.files), null, null));
      };
      input.click();
    });
  }

  const handles = await window.showOpenFilePicker({
    multiple: true,
    types: [
      {
        description: "Images & RAW",
        accept: {
          "image/*": [
            ".jpg",
            ".jpeg",
            ".png",
            ".webp",
            ".avif",
            ".tiff",
            ".tif",
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
          ],
        },
      },
    ],
  });

  const photos: CatalogPhoto[] = [];
  for (const handle of handles) {
    const file = await handle.getFile();
    const photo = await buildPhoto(file, null, handle);
    if (photo) photos.push(photo);
  }
  return photos;
}

export async function importDirectory(): Promise<{
  photos: CatalogPhoto[];
  name: string;
}> {
  if (!("showDirectoryPicker" in window)) {
    return { photos: [], name: "" };
  }

  const dirHandle = await window.showDirectoryPicker();
  const photos: CatalogPhoto[] = [];

  for await (const entry of dirHandle.values()) {
    if (entry.kind === "file") {
      const file = await entry.getFile();
      const photo = await buildPhoto(file, dirHandle, entry);
      if (photo) photos.push(photo);
    }
  }

  return { photos, name: dirHandle.name };
}
