// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { CatalogPhoto } from "./types";
import {
  extractRawPreview,
  isRawFile,
  sensorNativeImage,
} from "@/modules/library/raw-preview";
import { decodeNetpbm, isNetpbmName } from "@/modules/library/netpbm";
import { decodeTiff, isTiffName } from "@/modules/library/tiff-image";
import { decodeRawToBitmap, decodeRawToFloat } from "@/raw/decode";
import { acceptDecode } from "@/raw/accept-decode";
import {
  normalizeRotation,
  orientationToRotation,
  previewUprightRotation,
  rotateBitmap,
  rotateFloatRGBA,
} from "./orient";
import { verifyPermission } from "./permissions";
import {
  hasDecodeMarker,
  markDecode,
  rawCacheGeneration,
  rawCacheKey,
  readCachedPreview,
  writeCachedPreview,
  type DecodeMarker,
} from "@/raw/raw-cache";
import { getSettings } from "@/state/settings-store";
import { useCatalogStore } from "@/state/catalog-store";
import { catalogStorage } from "./storage";

/** What a load settled on in place of the photo's own pixels, and why. */
export interface Fallback {
  /** Which preview, when the original couldn't be read or nothing in it decoded:
   *  - "embedded": the camera's preview inside the RAW;
   *  - "stored": the photo's stored preview, rendered with no edit;
   *  - "stored-edited": the stored preview rendered with the edit `photo.previewEdit`
   *    names. It already shows that edit, so it is never a source to render an edit
   *    over: that would apply the edit twice. */
  from: "embedded" | "stored" | "stored-edited";
  /** The original couldn't be read: no handle on it, no access, or the file is gone. */
  offline: boolean;
  /** The RAW is marked unsupported: decoding it again won't help until the decoder
   *  changes. */
  unsupported: boolean;
  /** libraw gave no answer within its time limit. */
  timedOut: boolean;
  /** Why the decode gave no image, in the decoder's words. */
  reason?: string;
}

// A decoded image for the renderer: a linear float buffer (full sensor precision,
// HDR-capable), the cached develop preview (the same linear scene RGBA as
// binary16 bit patterns), or an 8-bit sRGB bitmap (a JPEG, or a fallback).
export type DecodedImage =
  | { kind: "float"; data: Float32Array; width: number; height: number; isFallbackPreview?: boolean }
  | { kind: "float16"; data: Uint16Array; width: number; height: number }
  | { kind: "bitmap"; bitmap: ImageBitmap; cached?: boolean; fallback?: Fallback };

/** What the decode of a RAW said, for a fallback served after it. */
type Shortfall = Omit<Fallback, "from" | "offline">;
const NOT_DECODED: Shortfall = { unsupported: false, timedOut: false };

// Stable key for a photo's decoded source pixels, used by the GPU source cache.
// Develop edits are parameters (not pixels), so only identity + baked rotation
// change the decoded buffer. A rotation change re-decodes under a new key; the old
// entry ages out via LRU.
export function photoSourceKey(photo: CatalogPhoto): string {
  return `${photo.id}:${photo.rotation ?? 0}`;
}

export interface LoadImageOptions {
  // Called with a fast, near-full-res intermediate (the camera's embedded JPEG)
  // as soon as it's available, BEFORE the slow libraw float decode finishes.
  // Lets Develop paint a sharp image in ~1s on a cache miss instead of holding
  // the soft 768px thumbnail for 5-10s while libraw runs. Only fires on the RAW
  // slow path (a cache hit is already fast and skips it).
  onPreview?: (image: DecodedImage) => void;
  // Smallest long edge (px) the caller can accept from the cached develop
  // preview. The cache is downsampled to the rawCacheMaxEdge preference, so an
  // export at a larger size must skip it and re-run the full RAW decode
  // (Infinity = always decode at the largest native size). Default 0: any
  // cached preview qualifies.
  minEdge?: number;
  // Work the user is not waiting on (Develop's neighbour prefetch, edited-
  // thumbnail regeneration): its libraw decode queues behind any photo being
  // opened instead of ahead of it (see decode-pool.ts). A RAW the decoder passes
  // over for it resolves null, not the camera's preview.
  background?: boolean;
  // Abandons the load (the user moved on): it resolves null without reading
  // the original or falling back to a lesser image. A libraw decode that has
  // already started runs to the end and is still cached.
  signal?: AbortSignal;
}

// Paint the embedded preview (camera-rendered, decodes in ~1s) so the user sees
// a sharp frame while libraw grinds. The precise float decode swaps in after; a
// slight tonal shift on swap is expected (preview is camera-toned, the float
// decode is linear + base curve).
async function paintPreview(
  preview: Blob,
  photo: CatalogPhoto,
  onPreview: (image: DecodedImage) => void,
): Promise<void> {
  try {
    const bm = await createImageBitmap(preview, { imageOrientation: "none" });
    // Embedded previews are usually sensor-native and carry no orientation
    // tag — orient from the master EXIF, aspect-gated (see orient.ts).
    const deg = previewUprightRotation(
      bm.width, bm.height, photo.rotation ?? 0, photo.exif?.orientation,
    );
    const upright = await rotateBitmap(bm, deg);
    if (upright !== bm) bm.close();
    onPreview({ kind: "bitmap", bitmap: upright });
  } catch { /* preview paint is best-effort */ }
}

// Prefer a full-precision linear RAW decode (so exposure/highlight recovery work
// on the sensor's real data); otherwise fall back to the 8-bit bitmap path.
export async function loadPhotoImage(
  photo: CatalogPhoto,
  opts?: LoadImageOptions,
): Promise<DecodedImage | null> {
  // Fast path: return the cached develop preview (half floats, gzip) from a
  // previous full decode. Skips libraw entirely — ~50ms vs 3-8s. It holds the
  // same scene-linear values the full decode produced, headroom and negatives
  // included, so the renderer takes the same float path and the photo renders
  // as it did on first open.
  //
  // The key comes from the catalog record alone, so the lookup runs before the
  // original is read (in Electron getFile() pulls the whole RAW over IPC), and
  // a hit is served even when the original is offline or its permission was
  // not re-granted: the cache is our own data.
  //
  // The cache is capped at the rawCacheMaxEdge preference; when the caller
  // needs more pixels than it holds (export at "Original"/large sizes), fall
  // through to the full decode below.
  const isRaw = isRawFile({ name: photo.filename } as File);
  const cacheKey = rawCacheKey(photo.relPath, photo.fileSize, photo.rotation ?? 0);
  const cacheGeneration = rawCacheGeneration();
  // Whether the decoder has already failed on this RAW for good. Asked along
  // with the cache read, so a miss doesn't wait on a second round trip.
  const unsupportedLookup = isRaw
    ? hasDecodeMarker(cacheKey, "unsupported")
    : Promise.resolve(false);
  const cached = isRaw ? await readCachedPreview(cacheKey) : null;
  if (cached && Math.max(cached.width, cached.height) >= (opts?.minEdge ?? 0)) {
    return { kind: "float16", data: cached.data, width: cached.width, height: cached.height };
  }

  const signal = opts?.signal;
  if (signal?.aborted) return null;

  let shortfall = NOT_DECODED;
  if (photo.fileHandle && (await verifyPermission(photo.fileHandle))) {
    try {
      const file = await photo.fileHandle.getFile();
      if (signal?.aborted) return null;
      if (isRaw) {
        // Such a RAW goes straight to its camera preview: the decode would only
        // fail again.
        const unsupported = await unsupportedLookup;
        if (unsupported) shortfall = { unsupported: true, timedOut: false };

        // Slow path: full libraw decode. Write result to cache asynchronously
        // so the next open hits the fast path above.
        // Extract the embedded JPEG preview once — used both for the color
        // validation below and as the fallback if the RAW decode looks wrong.
        // The decode runs alongside the extraction rather than after it. The
        // preview is painted as soon as it's ready, but inside the awaited
        // chain, so it can never land on top of the final image.
        const [preview, f] = await Promise.all([
          extractRawPreview(file).then(async (blob) => {
            if (blob && opts?.onPreview) await paintPreview(blob, photo, opts.onPreview);
            return blob;
          }),
          unsupported ? null : decodeRawToFloat(file, { background: opts?.background, signal }),
        ]);
        // Kept for later opens and the background pass; an abandoned open
        // settles nothing about the file.
        const remember = (marker: DecodeMarker) => {
          if (!signal?.aborted) void markDecode(cacheKey, marker, cacheGeneration);
        };
        if (f && "failure" in f) {
          // Passed over (background work only): the file is being decoded for another
          // request, or gave no answer earlier this session. The camera's preview served
          // instead would stand for the photo where the caller keeps what it loads.
          if (f.passedOver) return null;
          if (f.failure === "unsupported") remember("unsupported");
          shortfall = {
            unsupported: f.failure === "unsupported",
            timedOut: f.timedOut ?? false,
            reason: f.reason,
          };
        } else if (f) {
          // Propagate what the decode learned (as-shot WB, the exposure bias a
          // Fujifilm DR mode left in the raw) to the photo's EXIF, and persist
          // it so the cached-preview fast path has it next time.
          const learnedTemperature = !!f.colorTemperature && !photo.exif.colorTemperature;
          const learnedBias =
            f.rawExposureBias !== undefined && photo.exif.rawExposureBias !== f.rawExposureBias;
          if (learnedTemperature) photo.exif.colorTemperature = f.colorTemperature;
          if (learnedBias) photo.exif.rawExposureBias = f.rawExposureBias;
          if (learnedTemperature || learnedBias) {
            // The decode took seconds: store what it learned on the catalog's record
            // as it is now, and nothing for a photo that left the catalog meanwhile.
            const current = useCatalogStore.getState().photos.find((p) => p.id === photo.id);
            if (current) {
              const exif = { ...current.exif };
              if (learnedTemperature) exif.colorTemperature = f.colorTemperature;
              if (learnedBias) exif.rawExposureBias = f.rawExposureBias;
              void catalogStorage().putPhoto({ ...current, exif });
            }
          }

          // photo.rotation = EXIF orientation + manual user rotation (from import).
          // When the decoder already oriented the pixels, subtract the EXIF portion
          // so only manual rotation remains — otherwise we'd double-rotate.
          let rotateDeg = photo.rotation ?? 0;
          if (f.oriented) {
            rotateDeg = normalizeRotation(rotateDeg - orientationToRotation(photo.exif?.orientation));
          }
          const r = rotateFloatRGBA(f.data, f.width, f.height, rotateDeg);

          // Validate the decode's color against the embedded JPEG preview.
          // An unrecognised camera body (e.g. newer Canon EOS R bodies with
          // LibRaw <0.21) produces grossly wrong R/G and B/G ratios. If either
          // is off by more than 2× vs the preview, reject the decode and fall
          // through to the JPEG-based float path below. The same ruling keeps
          // marginal decodes out of the cache (see accept-decode.ts).
          const { use, cache } = await acceptDecode(f, r, preview);
          if (use) {
            // Write the cache when the photo has no entry yet, or upgrade one
            // written under a smaller rawCacheMaxEdge than the current setting
            // allows. Skip marginal decodes (inferred dimensions).
            const cachedEdge = cached ? Math.max(cached.width, cached.height) : 0;
            const bestEdge = Math.min(getSettings().rawCacheMaxEdge, Math.max(r.width, r.height));
            if (cache && cachedEdge < bestEdge) {
              writeCachedPreview(cacheKey, r.data, r.width, r.height, cacheGeneration);
            }
            if (!cache) remember("suspicious");
            return { kind: "float", data: r.data, width: r.width, height: r.height };
          }
          console.warn("[load] RAW color mismatch vs embedded JPEG — using JPEG fallback");
          remember("unsupported");
          shortfall = {
            unsupported: true,
            timedOut: false,
            reason: "its colours don't match the camera's preview",
          };
        }
        if (signal?.aborted) return null;

        // The full decode failed or was rejected, but a cached preview exists
        // (smaller than the caller asked for): prefer it over the embedded
        // JPEG. It is the exact linear source Develop rendered the edit
        // against, so colors stay consistent even if resolution falls short.
        if (cached) {
          return { kind: "float16", data: cached.data, width: cached.width, height: cached.height };
        }

        // libraw failed or produced bad colors: fall back to the embedded JPEG
        // preview as an 8-bit bitmap. We deliberately do NOT route it through
        // accept-decode's WebGL2 readback here — that spins up a second GL
        // context (fragile on old Mesa/Linux GPUs, where readback can silently
        // return all zeros → a black export/preview) and quadruples memory for
        // no gain: the JPEG is already 8-bit sRGB with the camera's tone baked
        // in, so there's no extra dynamic range to recover. The renderer's 8-bit
        // bitmap path handles edits the same way it does for any JPEG.
        if (preview) {
          const bitmap = await createImageBitmap(preview, { imageOrientation: "none" });
          const deg = previewUprightRotation(
            bitmap.width, bitmap.height, photo.rotation ?? 0, photo.exif?.orientation,
          );
          const upright = await rotateBitmap(bitmap, deg);
          if (upright !== bitmap) bitmap.close();
          const fallback: Fallback = { from: "embedded", offline: false, ...shortfall };
          return { kind: "bitmap", bitmap: upright, fallback };
        }
      }
    } catch {
      // fall through to the bitmap path
    }
  }
  // The bitmap path reads the original again and decodes a RAW outside the pool.
  if (signal?.aborted) return null;
  const loaded = await loadBitmap(photo);
  if (!loaded) return null;
  const { bitmap, fallback } = loaded;
  return fallback
    ? { kind: "bitmap", bitmap, fallback: { ...fallback, ...shortfall } }
    : { kind: "bitmap", bitmap };
}

interface LoadedBitmap {
  bitmap: ImageBitmap;
  /** Set when it is a preview in place of the original's own pixels. */
  fallback?: Pick<Fallback, "from" | "offline">;
}

// Decode a photo to a full(er)-resolution bitmap for editing/preview. Prefers
// the original file via its handle; for RAW it attempts a true sensor decode and
// falls back to the embedded JPEG preview, then to the stored thumbnail when the
// handle is gone or permission was not re-granted.
//
// We decode raw pixels — a JPEG with its Exif segment left out, since the
// decoder would otherwise apply the tag itself (sensorNativeImage) — and apply
// the photo's baked rotation ourselves, so orientation is consistent across JPEG
// and RAW. The stored thumbnail is already upright, so it is used as-is.
export async function loadPhotoBitmap(
  photo: CatalogPhoto,
): Promise<ImageBitmap | null> {
  return (await loadBitmap(photo))?.bitmap ?? null;
}

async function loadBitmap(photo: CatalogPhoto): Promise<LoadedBitmap | null> {
  let read = false;
  if (photo.fileHandle && (await verifyPermission(photo.fileHandle))) {
    try {
      const file = await photo.fileHandle.getFile();
      read = true;
      let raw: ImageBitmap | null = null;
      let decoderOriented = false;
      // True when `raw` is an embedded camera preview (sensor-native, no own
      // orientation tag): orient it from the master EXIF, aspect-gated, rather
      // than blindly applying photo.rotation as if it were already correct.
      let fromPreview = false;

      if (isRawFile(file)) {
        const result = await decodeRawToBitmap(file);
        if (result) {
          raw = result.bitmap;
          decoderOriented = result.oriented;
        } else {
          const preview = await extractRawPreview(file);
          raw = preview
            ? await createImageBitmap(preview, { imageOrientation: "none" })
            : null;
          fromPreview = raw !== null;
        }
      } else if (isNetpbmName(file.name)) {
        raw = await decodeNetpbm(file);
      } else if (isTiffName(file.name)) {
        raw = await decodeTiff(file);
      } else {
        raw = await createImageBitmap(await sensorNativeImage(file), {
          imageOrientation: "none",
        });
      }

      if (raw) {
        let rotateDeg = photo.rotation ?? 0;
        if (decoderOriented) {
          rotateDeg = normalizeRotation(rotateDeg - orientationToRotation(photo.exif?.orientation));
        } else if (fromPreview) {
          rotateDeg = previewUprightRotation(
            raw.width, raw.height, rotateDeg, photo.exif?.orientation,
          );
        }
        const upright = await rotateBitmap(raw, rotateDeg);
        if (upright !== raw) raw.close();
        return fromPreview
          ? { bitmap: upright, fallback: { from: "embedded", offline: false } }
          : { bitmap: upright };
      }
    } catch {
      // fall through to the stored thumbnail
    }
  }

  // Fallback: the stored thumbnail is already baked upright. An edited photo's is
  // rendered with the edit previewEdit names.
  if (photo.thumbnailBlob) {
    try {
      const bitmap = await createImageBitmap(photo.thumbnailBlob, {
        imageOrientation: "none",
      });
      const from = photo.previewEdit === undefined ? "stored" : "stored-edited";
      return { bitmap, fallback: { from, offline: !read } };
    } catch {
      return null;
    }
  }
  return null;
}
