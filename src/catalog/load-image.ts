// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { CatalogPhoto } from "./types";
import {
  extractRawPreview,
  isRawFile,
  sensorNativeImage,
} from "@/raw/raw-preview";
import { decodeNetpbm, isNetpbmName } from "@/raw/netpbm";
import { decodeTiff, isTiffName } from "@/raw/tiff-image";
import { decodeRawToBitmap, decodeRawToFloat } from "@/raw/decode";
import type { DecodeRequest } from "@/raw/decode-pool";
import { acceptDecode, matchCameraPreview } from "@/raw/accept-decode";
import { halfLumaSamples } from "@/raw/camera-match";
import { baselineExposureFor } from "@/rendering/baseline-tone";
import type { Float16Source, StoredSample } from "@/rendering/source-sample";
import type { CachedPreview } from "@/raw/cache-encode";
import { completeCachedEntry } from "./cache-fill";
import {
  bakeRotation,
  manualRotation,
  normalizeRotation,
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
import { convertInputFrame } from "@/raw/frame-bridge";
import type { CodeDecoder } from "@/raw/profile-frame";
import { hasCameraMatch, learnedMatch, rememberLearned, type DecodeLearned } from "./decode-learned";
import { inputProfileKey, resolveInputTransform } from "./input-profiles";

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
  | {
      kind: "float";
      data: Float32Array;
      width: number;
      height: number;
      isFallbackPreview?: boolean;
      baselineExposure?: number;
      baselineShadows?: number;
    }
  | Float16Source
  | { kind: "bitmap"; bitmap: ImageBitmap; fallback?: Fallback };

/** What the decode of a RAW said, for a fallback served after it. */
type Shortfall = Omit<Fallback, "from" | "offline">;
const NOT_DECODED: Shortfall = { unsupported: false, timedOut: false };

// Stable key for a photo's decoded source pixels, used by the GPU source cache.
// Develop edits are parameters (not pixels), so only identity + baked rotation
// change the decoded buffer. A rotation change re-decodes under a new key; the old
// entry ages out via LRU. A non-RAW photo's pixels also depend on how its input
// profile is read (input-profiles.ts), which a RAW's never do.
export function photoSourceKey(photo: CatalogPhoto): string {
  const key = `${photo.id}:${photo.rotation ?? 0}`;
  return isRawFile({ name: photo.filename } as File) ? key : key + inputProfileKey(photo);
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
  // Ask the RAW cache for the entry's centre sample at native resolution as
  // well, about 8 MB more per hit (source-sample.ts), for
  // api.develop.readSourceSample. Develop's opens set it; thumbnails, headless
  // renders and exports leave it off.
  sample?: boolean;
  // The long edge, in pixels, the caller renders from. A RAW whose half size
  // still reaches it is decoded at half size (see DecodeRequest.targetEdge),
  // and a non-RAW photo read through its input profile is averaged down to it.
  // Default: full size. A load that writes the RAW cache must stay full size:
  // the entry's centre sample is read as native resolution.
  targetEdge?: number;
}

/** What to ask of the decode of `photo`'s RAW: the manual turns baked in, the
 *  cache entry built if this load will write one, and the edge it may stop at.
 *  `cached`: the entry this load found for the photo, if any. */
function decodeRequestFor(
  photo: CatalogPhoto,
  cached: CachedPreview | null,
  opts: LoadImageOptions | undefined,
): DecodeRequest {
  const { rawCacheEnabled, rawCacheMaxEdge } = getSettings();
  const cachedEdge = cached ? Math.max(cached.width, cached.height) : 0;
  const fills = rawCacheEnabled && (cached === null || cached.full === null || cachedEdge < rawCacheMaxEdge);
  const targetEdge = opts?.targetEdge;
  const turn = manualRotation(photo.rotation ?? 0, photo.exif?.orientation);
  return {
    background: opts?.background,
    signal: opts?.signal,
    ...(turn ? { turn } : {}),
    ...(fills ? { cacheEdge: rawCacheMaxEdge } : {}),
    ...(targetEdge ? { targetEdge } : {}),
  };
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

/** What the renderer adds with the camera baseline (baseline-tone.ts): the
 *  photo's camera match once it has one, else its maker's exposure offset. */
function cameraBaseline(photo: CatalogPhoto): { baselineExposure?: number; baselineShadows?: number } {
  const matched = photo.exif?.baselineExposure;
  const ev =
    typeof matched === "number" ? matched : baselineExposureFor(photo.exif?.cameraMake, photo.exif?.cameraModel);
  const shadows = typeof matched === "number" ? (photo.exif?.baselineShadows ?? 0) : 0;
  return { ...(ev ? { baselineExposure: ev } : {}), ...(shadows ? { baselineShadows: shadows } : {}) };
}

/** A cache entry written before its photo learned the camera match: read the
 *  original's preview once and match the entry against it, so this open renders
 *  with it. An original out of reach leaves the maker's offset for now, and a
 *  later open asks again. */
async function learnFromEntry(photo: CatalogPhoto, cached: CachedPreview): Promise<void> {
  if (!photo.fileHandle || !(await verifyPermission(photo.fileHandle))) return;
  try {
    const preview = await extractRawPreview(await photo.fileHandle.getFile());
    const match = preview ? await matchCameraPreview(halfLumaSamples(cached), preview) : undefined;
    rememberLearned(photo, learnedMatch(match));
  } catch {
    // unreadable now: a later open asks again
  }
}

/** The cached entry as the renderer takes it: the decoded size and the sample
 *  only when the entry kept them (3.1.0 and later) and the load asked. */
function float16Of(cached: CachedPreview, photo: CatalogPhoto): Float16Source {
  const image: Float16Source = {
    kind: "float16",
    data: cached.data,
    width: cached.width,
    height: cached.height,
    ...cameraBaseline(photo),
  };
  if (cached.full) {
    image.fullWidth = cached.full.width;
    image.fullHeight = cached.full.height;
  }
  if (cached.sample) image.sample = cached.sample;
  return image;
}

/** Ask for the entry's rewrite unless the decoder already failed on the photo
 *  or doubted it, which would only mark it again. Settles behind the caller. */
function completeUnlessMarked(
  photo: CatalogPhoto,
  cacheKey: string,
  generation: number,
  unsupported: Promise<boolean> = hasDecodeMarker(cacheKey, "unsupported"),
): void {
  void Promise.all([unsupported, hasDecodeMarker(cacheKey, "suspicious")]).then(
    ([isUnsupported, isSuspicious]) => {
      if (!isUnsupported && !isSuspicious) completeCachedEntry(photo, generation);
    },
  );
}

// Prefer a full-precision linear RAW decode (so exposure/highlight recovery work
// on the sensor's real data), and for any other photo its input profile's
// conversion when the resolver gives one; otherwise the 8-bit bitmap path.
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
  // The key comes from the catalogue record alone, so the lookup runs before the
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
  const cached = isRaw ? await readCachedPreview(cacheKey, { sample: opts?.sample }) : null;
  if (cached && Math.max(cached.width, cached.height) >= (opts?.minEdge ?? 0)) {
    // An entry from before 3.1.0 kept neither the decoded size nor the centre
    // sample. It serves as it is, and the photo is decoded again behind the
    // open so a later open has both (cache-fill.ts). A background load
    // (Develop's neighbour prefetch) does not ask: its request would push the
    // open photo's out of the waiting slot, and the neighbour is refreshed when
    // it is shown (refreshStaleSource).
    if (opts?.sample && !opts.background && !cached.full) {
      completeUnlessMarked(photo, cacheKey, cacheGeneration, unsupportedLookup);
    }
    if (!hasCameraMatch(photo)) await learnFromEntry(photo, cached);
    return float16Of(cached, photo);
  }

  const signal = opts?.signal;
  if (signal?.aborted) return null;

  let shortfall = NOT_DECODED;
  // A non-RAW original, read once here for the resolver and kept for the
  // bitmap path below.
  let original: File | null = null;
  if (photo.fileHandle && (await verifyPermission(photo.fileHandle))) {
    try {
      const file = await photo.fileHandle.getFile();
      if (signal?.aborted) return null;
      if (!isRaw) original = file;
      else {
        // Such a RAW goes straight to its camera preview: the decode would only
        // fail again.
        const unsupported = await unsupportedLookup;
        if (unsupported) shortfall = { unsupported: true, timedOut: false };

        // Slow path: full libraw decode. Write result to cache asynchronously
        // so the next open hits the fast path above.
        // Extract the embedded JPEG preview once — used both for the colour
        // validation below and as the fallback if the RAW decode looks wrong.
        // The decode runs alongside the extraction rather than after it. The
        // preview is painted as soon as it's ready, but inside the awaited
        // chain, so it can never land on top of the final image.
        const [preview, f] = await Promise.all([
          extractRawPreview(file).then(async (blob) => {
            if (blob && opts?.onPreview) await paintPreview(blob, photo, opts.onPreview);
            return blob;
          }),
          unsupported
            ? null
            : decodeRawToFloat(file, decodeRequestFor(photo, cached, opts), photo.relPath),
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
          // What the decode learned (as-shot WB, the exposure bias a Fujifilm
          // DR mode left in the raw, the camera match below) goes on the
          // photo's EXIF and is stored, so the cached-preview fast path has it
          // next time.
          const learned: DecodeLearned = {};
          if (f.colorTemperature && !photo.exif.colorTemperature) learned.colorTemperature = f.colorTemperature;
          if (f.rawExposureBias !== undefined && photo.exif.rawExposureBias !== f.rawExposureBias) {
            learned.rawExposureBias = f.rawExposureBias;
          }

          // photo.rotation = EXIF orientation + manual user rotation (from import).
          // When the decoder already oriented the pixels, subtract the EXIF portion
          // so only manual rotation remains — otherwise we'd double-rotate.
          // The decode turned the frame as it was asked to (DecodeRequest.turn),
          // off this thread; only what it left undone is turned here.
          const rotateDeg = normalizeRotation(
            bakeRotation(photo.rotation ?? 0, photo.exif?.orientation, f.oriented ?? false) -
              (f.turned ?? 0),
          );
          const r = rotateFloatRGBA(f.data, f.width, f.height, rotateDeg);

          // Validate the decode's colour against the embedded JPEG preview.
          // An unrecognized camera body (e.g. newer Canon EOS R bodies with
          // LibRaw <0.21) produces grossly wrong R/G and B/G ratios. If either
          // is off by more than 2× vs the preview, reject the decode and fall
          // through to the JPEG-based float path below. The same ruling keeps
          // marginal decodes out of the cache (see accept-decode.ts).
          const { use, cache, match } = await acceptDecode(f, r, preview);
          // A photo keeps the first match it learns, so its look doesn't move
          // between a cached open and a larger export's fresh decode.
          if (use && !hasCameraMatch(photo)) Object.assign(learned, learnedMatch(match));
          rememberLearned(photo, learned);
          if (use) {
            // Write the cache when the photo has no entry yet, upgrade one
            // written under a smaller rawCacheMaxEdge than the current setting
            // allows, and complete one from before 3.1.0, which kept neither the
            // decoded size nor the centre sample. Skip marginal decodes
            // (inferred dimensions).
            const cachedEdge = cached ? Math.max(cached.width, cached.height) : 0;
            const bestEdge = Math.min(getSettings().rawCacheMaxEdge, Math.max(r.width, r.height));
            const incomplete = cached !== null && cached.full === null;
            if (cache && (cachedEdge < bestEdge || incomplete)) {
              writeCachedPreview(cacheKey, r.data, r.width, r.height, cacheGeneration, f.entry);
            }
            if (!cache) remember("suspicious");
            return { kind: "float", data: r.data, width: r.width, height: r.height, ...cameraBaseline(photo) };
          }
          console.warn("[load] RAW colour mismatch vs embedded JPEG — using JPEG fallback");
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
        // against, so colours stay consistent even if resolution falls short.
        if (cached) return float16Of(cached, photo);

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
  if (signal?.aborted) return null;
  if (original) {
    const converted = await convertedImage(photo, original, opts);
    if (converted || signal?.aborted) return converted;
  }
  // The bitmap path reads a RAW's original again and decodes it outside the pool.
  const loaded = await loadBitmap(photo, opts, original);
  if (!loaded) return null;
  const { bitmap, fallback } = loaded;
  return fallback
    ? { kind: "bitmap", bitmap, fallback: { ...fallback, ...shortfall } }
    : { kind: "bitmap", bitmap };
}

/** For a photo Develop holds on the GPU from a RAW cache entry written before
 *  3.1.0: the entry's decoded size and centre sample when it has been
 *  rewritten since (by the cache pass, or a completion that landed while no
 *  view was listening), else null, having asked for the rewrite. Costs one
 *  read of the entry; the preview it carries is dropped. */
export async function refreshStaleSource(
  photo: CatalogPhoto,
): Promise<{ fullWidth: number; fullHeight: number; sample: StoredSample } | null> {
  const cacheKey = rawCacheKey(photo.relPath, photo.fileSize, photo.rotation ?? 0);
  const generation = rawCacheGeneration();
  const cached = await readCachedPreview(cacheKey, { sample: true });
  if (!cached) return null;
  if (cached.full && cached.sample) {
    return { fullWidth: cached.full.width, fullHeight: cached.full.height, sample: cached.sample };
  }
  if (!cached.full) completeUnlessMarked(photo, cacheKey, generation);
  return null;
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

/** Which decoder reads a non-RAW file's own codes (profile-frame.ts). */
function codeDecoderFor(file: File): CodeDecoder {
  if (isNetpbmName(file.name)) return "netpbm";
  return isTiffName(file.name) ? "tiff" : "browser";
}

/** A non-RAW photo read through the input profile resolver's transform, as
 *  display-referred linear halves; null when there is no transform for it, or
 *  when anything after the resolve fails, which leaves the photo to the
 *  browser's decode (and nothing else: the original is still there). */
async function convertedImage(
  photo: CatalogPhoto,
  file: File,
  opts: LoadImageOptions | undefined,
): Promise<Float16Source | null> {
  const transform = await resolveInputTransform(photo, file);
  if (!transform || opts?.signal?.aborted) return null;
  try {
    const decoder = codeDecoderFor(file);
    const frame = await convertInputFrame(
      {
        source: decoder === "browser" ? await sensorNativeImage(file) : file,
        decoder,
        transform,
        turn: photo.rotation ?? 0,
        ...(opts?.targetEdge ? { targetEdge: opts.targetEdge } : {}),
      },
      { background: opts?.background, signal: opts?.signal },
    );
    return {
      kind: "float16",
      data: frame.data,
      width: frame.width,
      height: frame.height,
      fullWidth: frame.fullWidth,
      fullHeight: frame.fullHeight,
      displayReferred: true,
    };
  } catch (e) {
    if (!opts?.signal?.aborted) console.warn("[load] input profile conversion failed; decoding as sRGB:", e);
    return null;
  }
}

/** The photo's original, or null when it can't be read. */
async function readOriginal(photo: CatalogPhoto): Promise<File | null> {
  if (!photo.fileHandle || !(await verifyPermission(photo.fileHandle))) return null;
  try {
    return await photo.fileHandle.getFile();
  } catch {
    return null;
  }
}

/** `held`: the original, already read by the caller. */
async function loadBitmap(
  photo: CatalogPhoto,
  opts?: LoadImageOptions,
  held: File | null = null,
): Promise<LoadedBitmap | null> {
  const file = held ?? (await readOriginal(photo));
  const read = file !== null;
  if (opts?.signal?.aborted) return null;
  if (file) {
    try {
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
          rotateDeg = manualRotation(rotateDeg, photo.exif?.orientation);
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
