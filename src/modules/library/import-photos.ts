// Photo record construction + background RAW pre-decode. Photos enter the
// catalog exclusively through the project scan (see src/project/), which calls
// buildPhoto for each new file it finds.

import type { CatalogPhoto } from "@/catalog/types";
import { parseExif, parseExifDate } from "@/catalog/exif";
import { normalizeRotation, orientationToRotation } from "@/catalog/orient";
import {
  extractRawPreview,
  getExtension,
  isRawFile,
  prefersEmbeddedPreview,
  distrustsEmbeddedPreview,
} from "./raw-preview";
import { decodeNetpbm, isNetpbmName } from "./netpbm";
import { decodeTiff, isTiffName } from "./tiff-image";
import { decodeRawToFloat, decodeRawToBitmap } from "@/raw/decode";
import { extractColorTemperature, lastLibRawStatus } from "@/raw/libraw-wasm-adapter";
import { decodePoolSize } from "@/raw/decode-pool";
import { rotateFloatRGBA } from "@/catalog/orient";
import { cachedKeys, rawCacheKey, writeCachedPreview } from "@/raw/raw-cache";
import { getSettings, type PreviewSource } from "@/state/settings-store";
import { catalogStorage } from "@/catalog/storage";

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
  ".ppm",
  ".pgm",
  ".pbm",
  ".pnm",
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

// Long edge of the stored thumbnail. The caller passes the user's "Thumbnail
// quality" preference (thumbMaxEdge); the 768 fallback keeps thumbnails crisp at
// the largest grid cell (400px square, which crops to cover — so the short edge
// must comfortably exceed it) if no preference is supplied.
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

// Bake a linear Float32 RGBA buffer down to an 8-bit sRGB ImageBitmap. The
// thumbnail fallback when a RAW has no embedded preview AND decodeRawToBitmap
// can't handle its compression (no registered getLibRaw hook): the float path
// (libraw-wasm) still decodes it, so we sRGB-encode that here rather than drop
// the file. HDR values above 1.0 are clamped.
async function floatToBitmap(
  data: Float32Array,
  width: number,
  height: number,
): Promise<ImageBitmap> {
  const out = new ImageData(width, height);
  const px = out.data;
  for (let i = 0, o = 0; i < width * height; i++, o += 4) {
    for (let c = 0; c < 3; c++) {
      let v = data[o + c];
      v = v <= 0 ? 0 : v >= 1 ? 1 : v;
      // Linear → sRGB (IEC 61966-2-1).
      v = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
      px[o + c] = Math.round(v * 255);
    }
    px[o + 3] = 255;
  }
  return createImageBitmap(out);
}

// Heuristic: does a decoded LINEAR float image look like a broken decode —
// essentially black, or a flat constant — rather than a real photograph? Used to
// fall back to the camera's embedded preview when a sensor render comes out
// garbage (libraw mis-decoding an unusual container, e.g. CIFF/Foveon). Safe even
// on a false positive: the embedded preview shows the same scene. Thresholds are
// deliberately conservative so a legitimately dark or low-contrast photo is NOT
// flagged — a real photograph always has at least a few pixels well above black.
function looksDegenerate(data: Float32Array, width: number, height: number): boolean {
  const n = width * height;
  if (n <= 0) return true;
  const toSrgb = (v: number) =>
    v <= 0 ? 0 : v >= 1 ? 1 : v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  const step = Math.max(1, Math.floor(n / 4096)); // sample ~4k pixels
  let maxSrgb = 0;
  let minLum = Infinity;
  let maxLum = -Infinity;
  for (let i = 0; i < n; i += step) {
    const o = i * 4;
    const lum = 0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2];
    if (lum < minLum) minLum = lum;
    if (lum > maxLum) maxLum = lum;
    const s = toSrgb(lum);
    if (s > maxSrgb) maxSrgb = s;
  }
  // Whole frame near-black (brightest sampled pixel < 5% sRGB) — no real photo is.
  if (maxSrgb < 0.05) return true;
  // Perfectly flat (constant) frame — a decode artifact, not a photograph.
  if (maxLum - minLum < 1e-4) return true;
  return false;
}

// Decode a file to an ImageBitmap for thumbnailing, robustly — a supported file
// must never be silently dropped from the catalog. The `source` preference
// (Preferences ▸ Previews) steers the RAW path:
//
//  - "embedded": use the camera's embedded JPEG (fast). Falls back to a full
//    decode only when the file has no decodable embedded preview.
//  - "rendered": always decode the RAW sensor (neutral/accurate). Falls back to
//    the embedded JPEG only if every decode fails, rather than dropping the file.
//  - "auto" (default): use the embedded JPEG when it's already at least the
//    thumbnail resolution, otherwise render the sensor for a sharper preview.
//
// The decode chain is decodeRawToBitmap (registered getLibRaw / in-house
// uncompressed CFA) then the float decode (libraw-wasm, every compression) baked
// to sRGB. `oriented` is true when the decoder already applied EXIF orientation,
// so the caller must NOT rotate again. Non-RAW files decode directly.
//
// Returns null only when the pixels are genuinely undecodable.
async function decodeImportBitmap(
  file: File,
  source: PreviewSource = getSettings().previewSource,
): Promise<{ bitmap: ImageBitmap; oriented: boolean; colorTemperature?: number } | null> {
  if (isRawFile(file)) {
    // CRW & friends: the JPEG byte-scan can't find their real thumbnail and
    // returns a gray-noise false match, but libraw decodes them correctly — so
    // ignore the embedded preview entirely and render (as if "rendered" mode).
    const renderOnly = distrustsEmbeddedPreview(file);
    const effectiveSource: PreviewSource = renderOnly ? "rendered" : source;

    // Embedded camera JPEG: accepted outright in "embedded" mode, and in "auto"
    // when it's already big enough for the grid. Otherwise kept as a last-resort
    // fallback so a "rendered" decode that fails never drops the file.
    let embedded: ImageBitmap | null = null;
    if (effectiveSource !== "rendered") {
      const preview = await extractRawPreview(file);
      if (preview) {
        try {
          const bitmap = await createImageBitmap(preview, { imageOrientation: "none" });
          const longEdge = Math.max(bitmap.width, bitmap.height);
          // Use the embedded preview outright in "embedded" mode, when it's
          // already grid-sized, or for formats whose sensor render is unreliable
          // (X3F/Foveon) — a small camera preview beats a broken libraw decode.
          if (
            effectiveSource === "embedded" ||
            longEdge >= getSettings().thumbMaxEdge ||
            prefersEmbeddedPreview(file)
          ) {
            return { bitmap, oriented: false };
          }
          embedded = bitmap; // too small for "auto" — render instead, keep as fallback
        } catch {
          /* preview wasn't decodable after all — fall through to a full decode */
        }
      }
    }

    const bitmapResult = await decodeRawToBitmap(file);
    if (bitmapResult) {
      embedded?.close();
      return { bitmap: bitmapResult.bitmap, oriented: bitmapResult.oriented };
    }

    // The bitmap decoder couldn't handle this RAW's compression. The float decode
    // (libraw-wasm) handles every compression, so generate the thumbnail from it —
    // unless the render looks degenerate (near-black/flat) and we still hold a
    // camera preview, in which case that trustworthy preview wins.
    const f = await decodeRawToFloat(file);
    if (f && !(embedded && looksDegenerate(f.data, f.width, f.height))) {
      embedded?.close();
      const bm = await floatToBitmap(f.data, f.width, f.height);
      return { bitmap: bm, oriented: f.oriented ?? false, colorTemperature: f.colorTemperature };
    }

    // Every decode failed. Fall back to the embedded JPEG (the one we set aside in
    // "auto", or a fresh extract in "rendered") rather than drop the file. Skip
    // this for renderOnly formats (CRW) — their byte-scan preview is gray noise,
    // so a ⚠ "no preview" tile is more honest than a garbage thumbnail.
    if (embedded) return { bitmap: embedded, oriented: false };
    if (effectiveSource === "rendered" && !renderOnly) {
      const preview = await extractRawPreview(file);
      if (preview) {
        try {
          const bitmap = await createImageBitmap(preview, { imageOrientation: "none" });
          return { bitmap, oriented: false };
        } catch {
          /* genuinely undecodable */
        }
      }
    }
    return null;
  }
  if (isNetpbmName(file.name)) {
    const bitmap = await decodeNetpbm(file);
    return bitmap ? { bitmap, oriented: false } : null;
  }
  // TIFF: createImageBitmap can't decode it, so route through UTIF. Pixels come
  // back sensor-native (oriented: false), so the caller bakes EXIF orientation.
  if (isTiffName(file.name)) {
    const bitmap = await decodeTiff(file);
    return bitmap ? { bitmap, oriented: false } : null;
  }
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "none" });
    return { bitmap, oriented: false };
  } catch {
    return null;
  }
}

/** Build a grid preview blob for a photo straight from its source file, at the
 *  current Thumbnail quality. Used to rebuild previews on demand when "Store
 *  previews on disk" is off (memory-only mode). Returns null if it can't decode. */
export async function buildPreviewBlob(photo: CatalogPhoto): Promise<Blob | null> {
  if (!photo.fileHandle) return null;
  try {
    const file = await photo.fileHandle.getFile();
    const decoded = await decodeImportBitmap(file);
    if (!decoded) return null;
    const { bitmap, oriented } = decoded;
    // Bake to the photo's canonical orientation (EXIF + manual). When the decode
    // already oriented the pixels, subtract the EXIF portion so we don't rotate
    // twice — mirrors the load path.
    const rotation = photo.rotation ?? orientationToRotation(photo.exif.orientation);
    const bakeRotation = oriented
      ? normalizeRotation(rotation - orientationToRotation(photo.exif.orientation))
      : rotation;
    const blob = await createThumbnail(bitmap, bakeRotation, getSettings().thumbMaxEdge);
    bitmap.close();
    return blob;
  } catch {
    return null;
  }
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
  ".srf": "image/x-sony-srf",
  ".dcr": "image/x-kodak-dcr",
  ".rwl": "image/x-leica-rwl",
  ".fff": "image/x-hasselblad-fff",
  ".gpr": "image/x-gopro-gpr",
  ".mef": "image/x-mamiya-mef",
  ".crw": "image/x-canon-crw",
};

function mimeTypeFromName(name: string): string {
  return RAW_MIME[getExtension(name)] ?? "";
}

/** Human-readable reason the decode chain produced no preview, for the grid's
 *  warning tooltip. RAW failures surface libraw's last status (the chain ends at
 *  libraw); TIFF/other report the format generically. */
function decodeFailureReason(file: File): string {
  if (isRawFile(file)) return `RAW decode failed — ${lastLibRawStatus}`;
  if (isTiffName(file.name)) return "TIFF decode failed (unsupported variant)";
  return "no decoder could read this file";
}

/** Build a catalog record for a file: thumbnail, EXIF, orientation. The caller
 *  fills in relPath/folder (they're project-relative). */
export async function buildPhoto(
  file: File,
  directoryHandle: FileSystemDirectoryHandle | null,
  fileHandle: FileSystemFileHandle | null,
): Promise<CatalogPhoto | null> {
  if (!isSupported(file)) return null;

  // EXIF first — it's independent of pixel decode, so even a file we can't
  // decode yet still gets correct date/orientation metadata.
  const exif = await parseExif(file);

  // For RAW files, extract the as-shot WB temperature from libraw's cam_mul
  // (lightweight metadata-only — no pixel decode). parseExif covers DNG files
  // via AsShotNeutral; this covers all other RAW formats.
  if (isRawFile(file) && !exif.colorTemperature) {
    try {
      const buf = await file.arrayBuffer();
      const kelvin = await extractColorTemperature(buf);
      if (kelvin) exif.colorTemperature = kelvin;
    } catch { /* non-critical */ }
  }

  // Fields common to both outcomes. A supported file is ALWAYS recorded so it
  // imports exactly once and is never re-scanned as "new" on later opens — the
  // id stays stable (edits/ratings stick to it) and the catalog count is honest.
  const base = {
    id: generateId(),
    filename: file.name,
    relPath: "",
    folder: "",
    directoryHandle,
    fileHandle,
    fileSize: file.size,
    mimeType: file.type || mimeTypeFromName(file.name),
    rating: 0,
    colorLabel: "none" as const,
    flag: "none" as const,
    keywords: [],
    dateCreated: parseExifDate(exif.dateTimeOriginal) ?? file.lastModified,
    dateImported: Date.now(),
    exif,
  };

  const decoded = await decodeImportBitmap(file).catch(() => null);
  if (!decoded) {
    // Couldn't build a preview right now (e.g. a file briefly locked, or a format
    // libraw can't yet read). Record it anyway with width 0 as the "preview not
    // built" marker; repairMissingPreviews (and the next open) will retry — the
    // photo is never re-imported, just updated in place later.
    console.warn(`[import] preview deferred (decode failed for now): ${file.name}`);
    return {
      ...base,
      thumbnailBlob: null,
      thumbnailUrl: null,
      width: 0,
      height: 0,
      rotation: orientationToRotation(exif.orientation),
      decodeError: decodeFailureReason(file),
    };
  }

  const { bitmap, oriented, colorTemperature } = decoded;
  if (colorTemperature && !exif.colorTemperature) {
    exif.colorTemperature = colorTemperature;
  }
  // Rotation needed to bake THIS decode upright for the stored thumbnail: 0 when
  // the decoder already oriented the pixels (libraw), else the EXIF orientation.
  const bakeRotation = oriented ? 0 : orientationToRotation(exif.orientation);

  const thumb = await createThumbnail(bitmap, bakeRotation, getSettings().thumbMaxEdge);
  const thumbUrl = URL.createObjectURL(thumb);

  const swap = bakeRotation === 90 || bakeRotation === 270;
  const width = swap ? bitmap.height : bitmap.width;
  const height = swap ? bitmap.width : bitmap.height;

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

/**
 * Retry building previews for records imported without one (width 0). Updates
 * each in place — same id, so ratings/edits are untouched — writes its grid
 * preview, persists, and notifies via `onRepaired` so the live grid refreshes.
 * Records that still can't decode are left as-is and retried on a later open.
 * Sequential + fire-and-forget, like the RAW pre-decode.
 */
export async function repairMissingPreviews(
  photos: CatalogPhoto[],
  onRepaired?: (photo: CatalogPhoto) => void,
): Promise<void> {
  const todo = photos.filter((p) => p.fileHandle && p.width === 0);
  for (const photo of todo) {
    try {
      const file = await photo.fileHandle!.getFile();
      const decoded = await decodeImportBitmap(file);
      if (!decoded) continue; // still can't — try again next open

      const { bitmap, oriented } = decoded;
      // Keep the photo's canonical rotation (EXIF + manual). The thumbnail only
      // needs to bake whatever this decode hasn't already applied: when the
      // decoder pre-oriented the pixels, subtract the EXIF portion so only the
      // manual rotation is baked.
      const rotation = photo.rotation ?? orientationToRotation(photo.exif.orientation);
      const bakeRotation = oriented
        ? normalizeRotation(rotation - orientationToRotation(photo.exif.orientation))
        : rotation;
      const thumb = await createThumbnail(bitmap, bakeRotation, getSettings().thumbMaxEdge);
      const swap = bakeRotation === 90 || bakeRotation === 270;
      const width = swap ? bitmap.height : bitmap.width;
      const height = swap ? bitmap.width : bitmap.height;
      bitmap.close();

      const updated: CatalogPhoto = {
        ...photo,
        thumbnailBlob: thumb,
        thumbnailUrl: URL.createObjectURL(thumb),
        width,
        height,
        rotation,
        decodeError: undefined, // a preview built this time — clear the marker
      };
      await catalogStorage().putPhoto(updated); // writes the preview + persists
      onRepaired?.(updated);

      await new Promise<void>((res) => setTimeout(res, 0));
    } catch {
      // One failure shouldn't stop the rest.
    }
  }
}

/**
 * Re-decode every catalog photo and regenerate its grid preview at the current
 * "Thumbnail quality" (thumbMaxEdge). Unlike repairMissingPreviews this rebuilds
 * ALL previews, not just missing ones — it's the way a changed thumbMaxEdge takes
 * effect on an existing library, since known photos are otherwise never re-decoded
 * on open. Updates each photo in place (same id) and rewrites its disk preview.
 * Reports progress so a Preferences button can show "12 / 340". Sequential to keep
 * memory sane; one failure doesn't stop the rest.
 */
export async function rebuildThumbnails(
  photos: CatalogPhoto[],
  onProgress?: (done: number, total: number) => void,
  onRebuilt?: (photo: CatalogPhoto) => void,
): Promise<void> {
  const todo = photos.filter((p) => p.fileHandle);
  let done = 0;
  onProgress?.(0, todo.length);
  for (const photo of todo) {
    try {
      const file = await photo.fileHandle!.getFile();
      const decoded = await decodeImportBitmap(file);
      if (decoded) {
        const { bitmap, oriented } = decoded;
        // Preserve the photo's canonical rotation (EXIF + any manual rotation);
        // a rebuild changes pixels, not orientation. Bake only what this decode
        // hasn't already applied — subtract the EXIF portion when pre-oriented.
        const rotation = photo.rotation ?? orientationToRotation(photo.exif.orientation);
        const bakeRotation = oriented
          ? normalizeRotation(rotation - orientationToRotation(photo.exif.orientation))
          : rotation;
        const thumb = await createThumbnail(bitmap, bakeRotation, getSettings().thumbMaxEdge);
        const swap = bakeRotation === 90 || bakeRotation === 270;
        const width = swap ? bitmap.height : bitmap.width;
        const height = swap ? bitmap.width : bitmap.height;
        bitmap.close();

        const updated: CatalogPhoto = {
          ...photo,
          thumbnailBlob: thumb,
          thumbnailUrl: URL.createObjectURL(thumb),
          width,
          height,
          rotation,
        };
        await catalogStorage().putPhoto(updated); // writes the preview + persists
        onRebuilt?.(updated);
      }
    } catch {
      // One failure shouldn't stop the rest.
    }
    onProgress?.(++done, todo.length);
    await new Promise<void>((res) => setTimeout(res, 0));
  }
}

/**
 * Pre-decode RAW files and write them to the develop-preview cache
 * (.safelight/raw/ in the open project) so the first Develop open is instant
 * instead of waiting for libraw.
 *
 * Decode-once, cheaply: the cache directory is listed ONCE up front, and any
 * photo whose cache key is already present is skipped without touching its file.
 * The key is derived from the catalog record (relPath + fileSize), so deciding
 * what to skip needs no getFile — which matters because in Electron getFile()
 * reads the whole RAW off disk. So reopening a fully-cached project (this session
 * or a future one) reads one directory listing and decodes nothing. Only files
 * missing from the cache are opened and decoded, and each write lands in the same
 * directory, so an interrupted run just resumes with the remainder next time.
 *
 * Runs as a small bounded pool (a few files at once) so the cache fills several
 * times faster than the old one-at-a-time loop — which is what makes the FIRST
 * Develop open hit a warm cache instead of racing a slow sequential walk. Each
 * libraw decode runs in its own Web Worker, so concurrency genuinely uses extra
 * cores; the pool is capped to keep memory/CPU sane while the user browses.
 * Fire and forget.
 */
export async function preDecodeRawsForCache(
  photos: CatalogPhoto[],
  opts?: { force?: boolean; onProgress?: (done: number, total: number) => void },
): Promise<void> {
  const s = getSettings();
  // Master switch off → never write the cache, even for a forced "Cache all now".
  if (!s.rawCacheEnabled) return;
  // "As needed" mode skips the background pass (only opened photos get cached),
  // unless the user explicitly asked to cache everything now.
  if (!opts?.force && !s.rawCachePrefetch) return;

  const present = await cachedKeys(); // one directory listing
  const todo = photos.filter(
    (p) =>
      p.fileHandle &&
      isRawFile({ name: p.filename } as File) &&
      !present.has(rawCacheKey(p.relPath, p.fileSize, p.rotation ?? 0)),
  );
  opts?.onProgress?.(0, todo.length);
  if (todo.length === 0) return;
  let done = 0;

  const decodeOne = async (photo: CatalogPhoto): Promise<void> => {
    try {
      const file = await photo.fileHandle!.getFile();
      const f = await decodeRawToFloat(file);
      if (!f) return; // failed decode is retried on a later open

      let rotateDeg = photo.rotation ?? 0;
      if (f.oriented) {
        rotateDeg = normalizeRotation(rotateDeg - orientationToRotation(photo.exif?.orientation));
      }
      const r = rotateFloatRGBA(f.data, f.width, f.height, rotateDeg);

      await writeCachedPreview(
        rawCacheKey(photo.relPath, photo.fileSize, photo.rotation ?? 0),
        r.data,
        r.width,
        r.height,
      );
    } catch {
      // A single decode failure shouldn't stop the rest.
    } finally {
      opts?.onProgress?.(++done, todo.length);
    }
  };

  // Bounded concurrency: match the persistent decode pool size (default 3).
  // Each full-res float decode holds ~380 MB, but the pool caps total instances
  // so memory stays bounded. Workers yield between files for the UI thread.
  const limit = Math.min(decodePoolSize() || 2, todo.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < todo.length) {
      const photo = todo[next++];
      await decodeOne(photo);
      await new Promise<void>((res) => setTimeout(res, 0)); // yield to UI
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, todo.length) }, () => worker()),
  );
}
