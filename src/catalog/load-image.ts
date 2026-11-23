// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { CatalogPhoto } from "./types";
import {
  extractRawPreview,
  extractRawPreviewDecoded,
  isRawFile,
  sensorNativeImage,
} from "@/raw/raw-preview";
import { decodeNetpbm } from "@/raw/netpbm";
import { decodeTiff } from "@/raw/tiff-image";
import { decodeRawToBitmap, decodeRawToFloat, type RawDecodeRequest } from "@/raw/decode";
import { acceptDecode, matchCameraPreview } from "@/raw/accept-decode";
import { samplePreview, type PreviewSample } from "@/raw/preview-sample";
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
  decoderMarkerId,
  hasDecodeMarker,
  markDecode,
  rawCacheGeneration,
  readCachedPreview,
  writeCachedPreview,
  type DecodeMarker,
} from "@/raw/raw-cache";
import { getSettings } from "@/state/settings-store";
import { convertInputFrame } from "@/raw/frame-bridge";
import type { CodeDecoder } from "@/raw/profile-frame";
import { hasCameraMatch, learnedMatch, rememberLearned, rememberSourceFrame, type DecodeLearned } from "./decode-learned";
import { inputProfileKey, resolveInputTransform } from "./input-profiles";
import { isSourceFile, sourceOriginalHeld } from "@/project/library-sources";
import {
  photoCacheKey,
  photoMarkerKey,
  rawDecoders,
  rawSignature,
  recallDecoderVerdicts,
  settleDecoderVerdicts,
} from "@/raw/photo-cache-key";
import {
  chainSignature,
  decoderChain,
  formatOf,
  isExtensionEntry,
  runExtensionDecoder,
  UNNAMED_FORMAT_DECODER,
  type ChainEntry,
} from "./image-decoders";
import { convertLinearFrame, decodeHeifFrame } from "@/raw/heif-bridge";
import type { HalfFrame } from "@/raw/profile-frame";

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
// profile is read (input-profiles.ts), which a RAW's never do. A RAW's depend on
// the decoders that read it once an extension's leads them (rawSignature).
export function photoSourceKey(photo: CatalogPhoto): string {
  const key = `${photo.id}:${photo.rotation ?? 0}`;
  if (isRawFile({ name: photo.filename } as File)) {
    const signature = rawSignature(photo);
    return signature ? `${key}:d${signature}` : key;
  }
  const format = formatOf(photo.filename);
  const signature = format ? chainSignature(format.id) : "";
  const decoded = signature ? `${key}:d${signature}` : key;
  const readsCodes = format === null || decoderChain(format.id).some((entry) => isCodeDecoder(entry.id));
  return readsCodes ? decoded + inputProfileKey(photo) : decoded;
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
 *  cache entry built if this load will write one, the edge it may stop at, the
 *  photo's orientation and white balance when known, and the decoders to pass by.
 *  `cached`: the entry this load found for the photo, if any. */
function decodeRequestFor(
  photo: CatalogPhoto,
  cached: CachedPreview | null,
  opts: LoadImageOptions | undefined,
  ruledOut: ReadonlySet<string> | undefined,
): RawDecodeRequest {
  const { rawCacheEnabled, rawCacheMaxEdge } = getSettings();
  const cachedEdge = cached ? Math.max(cached.width, cached.height) : 0;
  const fills = rawCacheEnabled && (cached === null || cached.full === null || cachedEdge < rawCacheMaxEdge);
  const targetEdge = opts?.targetEdge;
  const orientation = photo.exif?.orientation;
  const turn = manualRotation(photo.rotation ?? 0, orientation);
  const asShotMultipliers = photo.exif?.asShotMultipliers;
  return {
    background: opts?.background,
    signal: opts?.signal,
    ...(turn ? { turn } : {}),
    ...(fills ? { cacheEdge: rawCacheMaxEdge } : {}),
    ...(targetEdge ? { targetEdge } : {}),
    ...(orientation !== undefined ? { orientation } : {}),
    ...(asShotMultipliers ? { asShotMultipliers } : {}),
    ...(ruledOut ? { ruledOut } : {}),
  };
}

/** What earlier sessions settled about the photo's RAW decoders. */
interface Verdicts {
  /** Every one has failed on the photo for good. */
  unsupported: boolean;
  /** Those that have, by marker id, once an extension's decoder is among them. */
  ruledOut?: ReadonlySet<string>;
}

const NO_VERDICTS: Verdicts = { unsupported: false };

/** The photo's decoders' final "unsupported" markers, kept under `markerKey`.
 *  libraw's alone is asked as it always was. */
async function verdictsOn(markerKey: string, decoders: readonly ChainEntry[]): Promise<Verdicts> {
  if (!decoders.some((entry) => "decoder" in entry)) {
    return { unsupported: await hasDecodeMarker(markerKey, "unsupported") };
  }
  const ids = decoders.map(decoderMarkerId);
  const marked = await Promise.all(ids.map((id) => hasDecodeMarker(markerKey, "unsupported", id)));
  const ruledOut = new Set(ids.filter((_, i) => marked[i]));
  return { unsupported: ruledOut.size === ids.length, ruledOut };
}

// Paint the embedded preview (camera-rendered, decodes in ~1s) so the user sees
// a sharp frame while libraw grinds. The precise float decode swaps in after; a
// slight tonal shift on swap is expected (preview is camera-toned, the float
// decode is linear + base curve). `bm` is the preview as its search decoded it,
// sensor-native, and is the painter's from here on.
async function paintPreview(
  bm: ImageBitmap,
  photo: CatalogPhoto,
  onPreview: (image: DecodedImage) => void,
): Promise<void> {
  try {
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

interface CameraPreview {
  blob: Blob;
  /** Its sample for the colour check on the decode, begun as the preview was
   *  found so that it is read while libraw works, not after. */
  sample?: PreviewSample;
}

/** The RAW's camera preview, painted through `onPreview` when one is given, from
 *  the decode that found it rather than a second one of the same bytes.
 *  `sampleAhead`: an opened photo's decode is under way, which the preview will
 *  check. Background work reads the sample only once it has a decode to check:
 *  the decoder may pass its request over, and then nothing reads the preview. */
async function cameraPreview(
  file: File,
  photo: CatalogPhoto,
  onPreview: ((image: DecodedImage) => void) | undefined,
  sampleAhead: boolean,
): Promise<CameraPreview | null> {
  const found = (blob: Blob): CameraPreview =>
    sampleAhead ? { blob, sample: samplePreview(blob) } : { blob };
  if (!onPreview) {
    const blob = await extractRawPreview(file);
    return blob && found(blob);
  }
  const decoded = await extractRawPreviewDecoded(file);
  if (!decoded) return null;
  const preview = found(decoded.blob);
  await paintPreview(decoded.bitmap, photo, onPreview);
  return preview;
}

/** What the renderer adds with the camera baseline (baseline-tone.ts): the
 *  photo's camera match once it has one learned from the decoders `signature`
 *  names, else its maker's exposure offset. */
function cameraBaseline(
  photo: CatalogPhoto,
  signature: string,
): { baselineExposure?: number; baselineShadows?: number } {
  const learned = (photo.exif?.cameraMatchDecoders ?? "") === signature;
  const matched = learned ? photo.exif?.baselineExposure : undefined;
  const ev =
    typeof matched === "number" ? matched : baselineExposureFor(photo.exif?.cameraMake, photo.exif?.cameraModel);
  const shadows = typeof matched === "number" ? (photo.exif?.baselineShadows ?? 0) : 0;
  return { ...(ev ? { baselineExposure: ev } : {}), ...(shadows ? { baselineShadows: shadows } : {}) };
}

/** A cache entry written before its photo learned the camera match: read the
 *  original's preview once and match the entry against it, so this open renders
 *  with it. An original out of reach leaves the maker's offset for now, and a
 *  later open asks again. */
async function learnFromEntry(photo: CatalogPhoto, cached: CachedPreview, signature: string): Promise<void> {
  if (!photo.fileHandle || !(await verifyPermission(photo.fileHandle))) return;
  try {
    const preview = await extractRawPreview(await photo.fileHandle.getFile());
    const match = preview ? await matchCameraPreview(halfLumaSamples(cached), preview) : undefined;
    rememberLearned(photo, learnedMatch(match, photo, signature));
  } catch {
    // unreadable now: a later open asks again
  }
}

/** The cached entry as the renderer takes it: the decoded size and the sample
 *  only when the entry kept them (3.1.0 and later) and the load asked.
 *  `signature`: what made the entry (rawSignature). */
function float16Of(cached: CachedPreview, photo: CatalogPhoto, signature: string): Float16Source {
  const image: Float16Source = {
    kind: "float16",
    data: cached.data,
    width: cached.width,
    height: cached.height,
    ...cameraBaseline(photo, signature),
  };
  if (cached.full) {
    image.fullWidth = cached.full.width;
    image.fullHeight = cached.full.height;
  }
  if (cached.sample) image.sample = cached.sample;
  return image;
}

/** Ask for the entry's rewrite unless the decoder already failed on the photo
 *  or doubted it, which would only mark it again. Settles behind the caller.
 *  An entry old enough to need it was written while libraw led, so libraw's
 *  markers (under `markerKey`) are the ones asked. */
function completeUnlessMarked(
  photo: CatalogPhoto,
  markerKey: string,
  generation: number,
  unsupported: Promise<boolean> = hasDecodeMarker(markerKey, "unsupported"),
): void {
  void Promise.all([unsupported, hasDecodeMarker(markerKey, "suspicious")]).then(
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
  // A leading decoder that checks files first keys the photo by its answer,
  // which an earlier session may have kept.
  const cacheGeneration = rawCacheGeneration();
  const recalling = isRaw ? recallDecoderVerdicts(photo) : null;
  if (recalling) await recalling;
  let cacheKey = photoCacheKey(photo);
  const markerKey = photoMarkerKey(photo);
  let signature = isRaw ? rawSignature(photo) : "";
  // Which of its decoders have already failed on this RAW for good. Asked along
  // with the cache read, so a miss doesn't wait on a second round trip.
  let verdicts = isRaw ? verdictsOn(markerKey, rawDecoders(photo)) : Promise.resolve(NO_VERDICTS);
  let unsupportedLookup = verdicts.then((v) => v.unsupported);
  // The entry, when it holds as many pixels as the caller needs.
  const servable = (entry: CachedPreview | null): CachedPreview | null =>
    entry && Math.max(entry.width, entry.height) >= (opts?.minEdge ?? 0) ? entry : null;
  const serve = async (entry: CachedPreview): Promise<Float16Source> => {
    // An entry from before 3.1.0 kept neither the decoded size nor the centre
    // sample. It serves as it is, and the photo is decoded again behind the
    // open so a later open has both (cache-fill.ts). A background load
    // (Develop's neighbour prefetch) does not ask: its request would push the
    // open photo's out of the waiting slot, and the neighbour is refreshed when
    // it is shown (refreshStaleSource).
    if (opts?.sample && !opts.background && !entry.full) {
      completeUnlessMarked(photo, markerKey, cacheGeneration, unsupportedLookup);
    }
    if (!hasCameraMatch(photo, signature)) await learnFromEntry(photo, entry, signature);
    return float16Of(entry, photo, signature);
  };
  let cached = isRaw ? await readCachedPreview(cacheKey, { sample: opts?.sample }) : null;
  const hit = servable(cached);
  if (hit) return serve(hit);

  const signal = opts?.signal;
  if (signal?.aborted) return null;
  // A library source's original comes over the network: only a load someone
  // waits on fetches it.
  if (opts?.background && isSourceFile(photo.fileHandle) && !(await sourceOriginalHeld(photo.fileHandle)))
    return null;

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
        // A leading decoder that checks files first and declines the photo
        // leaves it keyed as libraw alone keys it, so libraw's entry may serve.
        const settling = settleDecoderVerdicts(photo, file, cacheGeneration);
        if (settling && (await settling)) {
          cacheKey = photoCacheKey(photo);
          signature = rawSignature(photo);
          verdicts = verdictsOn(markerKey, rawDecoders(photo));
          unsupportedLookup = verdicts.then((v) => v.unsupported);
          cached = await readCachedPreview(cacheKey, { sample: opts?.sample });
          const settledHit = servable(cached);
          if (settledHit) return serve(settledHit);
          if (signal?.aborted) return null;
        }
        // Such a RAW goes straight to its camera preview: the decode would only
        // fail again.
        const { unsupported, ruledOut } = await verdicts;
        if (unsupported) shortfall = { unsupported: true, timedOut: false };

        // Slow path: full libraw decode. Write result to cache asynchronously
        // so the next open hits the fast path above.
        // Extract the embedded JPEG preview once — used both for the colour
        // validation below and as the fallback if the RAW decode looks wrong.
        // The decode runs alongside the extraction rather than after it. The
        // preview is painted as soon as it's ready, but inside the awaited
        // chain, so it can never land on top of the final image.
        const [camera, f] = await Promise.all([
          cameraPreview(file, photo, opts?.onPreview, !unsupported && !opts?.background),
          unsupported
            ? null
            : decodeRawToFloat(file, decodeRequestFor(photo, cached, opts, ruledOut), photo.relPath),
        ]);
        const preview = camera?.blob ?? null;
        // Kept for later opens and the background pass, by the decoder they
        // are about (libraw's when the decode names none); an abandoned open
        // settles nothing about the file.
        const remember = (marker: DecodeMarker, decoder?: string) => {
          if (!signal?.aborted) void markDecode(markerKey, marker, cacheGeneration, decoder);
        };
        for (const decoder of f?.unsupportedBy ?? []) remember("unsupported", decoder);
        if (f && "failure" in f) {
          // Passed over (background work only): the file is being decoded for another
          // request, or gave no answer earlier this session. The camera's preview served
          // instead would stand for the photo where the caller keeps what it loads.
          if (f.passedOver) return null;
          if (f.failure === "unsupported" && !f.unsupportedBy) remember("unsupported");
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
          if (f.asShotMultipliers && !photo.exif.asShotMultipliers) learned.asShotMultipliers = f.asShotMultipliers;
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
          const { use, cache, match } = await acceptDecode(f, r, preview, camera?.sample);
          // Decoders that changed while the decode was asked for made a frame
          // that is shown but kept under neither their key nor these.
          const keyed = (f.signature ?? "") === signature;
          // A photo keeps the first match it learns, so its look doesn't move
          // between a cached open and a larger export's fresh decode.
          if (use && keyed && !hasCameraMatch(photo, signature)) {
            Object.assign(learned, learnedMatch(match, photo, signature));
          }
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
            if (cache && keyed && (cachedEdge < bestEdge || incomplete)) {
              const verdicts = f.decoder === undefined ? undefined : { markerKey, decoder: f.decoder };
              writeCachedPreview(cacheKey, r.data, r.width, r.height, cacheGeneration, f.entry, verdicts);
            }
            if (!cache) remember("suspicious", f.decoder);
            const full = fullFrame(f, r);
            rememberSourceFrame(photo, full.width, full.height);
            return { kind: "float", data: r.data, width: r.width, height: r.height, ...cameraBaseline(photo, signature) };
          }
          console.warn("[load] RAW colour mismatch vs embedded JPEG — using JPEG fallback");
          remember("unsupported", f.decoder);
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
        if (cached) return float16Of(cached, photo, signature);

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
    const own = await decodeNonRaw(photo, original, opts);
    if (own?.kind === "float16") rememberSourceFrame(photo, own.fullWidth ?? own.width, own.fullHeight ?? own.height);
    else if (own?.kind === "bitmap") rememberSourceFrame(photo, own.bitmap.width, own.bitmap.height);
    if (own || signal?.aborted) return own;
  }
  // The bitmap path reads a RAW's original again and decodes it outside the
  // pool; for any other photo it is left with the stored preview.
  const loaded = await loadBitmap(photo, opts, original);
  if (!loaded) return null;
  const { bitmap, fallback } = loaded;
  // A RAW's bitmap may be a reduced decode: it says nothing of the frame's size.
  if (!fallback && !isRaw) rememberSourceFrame(photo, bitmap.width, bitmap.height);
  return fallback
    ? { kind: "bitmap", bitmap, fallback: { ...fallback, ...shortfall } }
    : { kind: "bitmap", bitmap };
}

/** The full frame a float decode stands for, turned as `upright` is: a decode
 *  made at half size stands for its source's frame. */
function fullFrame(
  decode: { width: number; height: number; halfSize?: boolean; sourceWidth?: number; sourceHeight?: number },
  upright: { width: number; height: number },
): { width: number; height: number } {
  const { halfSize, sourceWidth, sourceHeight } = decode;
  if (!halfSize || !sourceWidth || !sourceHeight) return upright;
  const long = Math.max(sourceWidth, sourceHeight);
  const short = Math.min(sourceWidth, sourceHeight);
  return upright.width >= upright.height ? { width: long, height: short } : { width: short, height: long };
}

/** For a photo Develop holds on the GPU from a RAW cache entry written before
 *  3.1.0: the entry's decoded size and centre sample when it has been
 *  rewritten since (by the cache pass, or a completion that landed while no
 *  view was listening), else null, having asked for the rewrite. Costs one
 *  read of the entry; the preview it carries is dropped. */
export async function refreshStaleSource(
  photo: CatalogPhoto,
): Promise<{ fullWidth: number; fullHeight: number; sample: StoredSample } | null> {
  const cacheKey = photoCacheKey(photo);
  const generation = rawCacheGeneration();
  const cached = await readCachedPreview(cacheKey, { sample: true });
  if (!cached) return null;
  if (cached.full && cached.sample) {
    return { fullWidth: cached.full.width, fullHeight: cached.full.height, sample: cached.sample };
  }
  if (!cached.full) completeUnlessMarked(photo, photoMarkerKey(photo), generation);
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

/** Core's decoders that read a non-RAW file's own 8-bit codes, which an input
 *  profile can read instead (profile-frame.ts). */
const CODE_DECODERS: ReadonlySet<string> = new Set<CodeDecoder>(["browser", "tiff", "netpbm"]);

const isCodeDecoder = (id: string): id is CodeDecoder => CODE_DECODERS.has(id);


/** A non-RAW photo's own pixels from the first of its format's decoders, in
 *  the person's order, that reads `file`; null when none does. */
async function decodeNonRaw(
  photo: CatalogPhoto,
  file: File,
  opts: LoadImageOptions | undefined,
): Promise<DecodedImage | null> {
  const format = formatOf(file.name);
  for (const entry of format ? decoderChain(format.id) : [UNNAMED_FORMAT_DECODER]) {
    if (opts?.signal?.aborted) return null;
    const decoded = await decodeNonRawWith(entry, photo, file, opts);
    if (decoded) return decoded;
  }
  return null;
}

function displayReferred(frame: HalfFrame): Float16Source {
  return {
    kind: "float16",
    data: frame.data,
    width: frame.width,
    height: frame.height,
    fullWidth: frame.fullWidth,
    fullHeight: frame.fullHeight,
    displayReferred: true,
  };
}

async function decodeNonRawWith(
  entry: ChainEntry,
  photo: CatalogPhoto,
  file: File,
  opts: LoadImageOptions | undefined,
): Promise<DecodedImage | null> {
  const background = opts?.background ?? false;
  const signal = opts?.signal;
  const rotation = photo.rotation ?? 0;
  const targetEdge = opts?.targetEdge;
  if (isExtensionEntry(entry)) {
    const outcome = await runExtensionDecoder(entry, file, {
      name: file.name,
      ...(targetEdge ? { targetEdge } : {}),
      fullSize: false,
      background,
      ...(signal ? { signal } : {}),
    });
    if (!outcome.ok) return null;
    const image = outcome.image;
    const turn = image.oriented ? manualRotation(rotation, photo.exif?.orientation) : rotation;
    if (image.kind === "linear") {
      const converted = await convertLinearFrame(image.data, image.width, image.height, {
        ...(targetEdge ? { targetEdge } : {}),
        turn,
        background,
        ...(signal ? { signal } : {}),
      });
      if (!converted.ok) return null;
      const frame = displayReferred(converted.frame);
      const full = fullFrame(
        { ...image, halfSize: (image.sourceWidth ?? 0) > image.width },
        { width: frame.width, height: frame.height },
      );
      return frame.fullWidth && full.width > frame.fullWidth
        ? { ...frame, fullWidth: full.width, fullHeight: full.height }
        : frame;
    }
    try {
      const raw = await createImageBitmap(new ImageData(image.data, image.width, image.height));
      const upright = await rotateBitmap(raw, turn);
      if (upright !== raw) raw.close();
      return { kind: "bitmap", bitmap: upright };
    } catch {
      return null;
    }
  }
  if (entry.id === "heif") {
    const decoded = await decodeHeifFrame(file, {
      ...(targetEdge ? { targetEdge } : {}),
      turn: manualRotation(rotation, photo.exif?.orientation),
      background,
      ...(signal ? { signal } : {}),
    });
    if (!decoded.ok) return null;
    return decoded.hdr ? { ...displayReferred(decoded.frame), hdrShownAsSdr: true } : displayReferred(decoded.frame);
  }
  if (!isCodeDecoder(entry.id)) return null;
  const converted = await convertedImage(photo, file, entry.id, opts);
  if (converted || signal?.aborted) return converted;
  try {
    const raw =
      entry.id === "netpbm"
        ? await decodeNetpbm(file)
        : entry.id === "tiff"
          ? await decodeTiff(file)
          : await createImageBitmap(await sensorNativeImage(file), { imageOrientation: "none" });
    if (!raw) return null;
    const upright = await rotateBitmap(raw, rotation);
    if (upright !== raw) raw.close();
    return { kind: "bitmap", bitmap: upright };
  } catch {
    return null;
  }
}

/** A non-RAW photo read through the input profile resolver's transform, as
 *  display-referred linear halves; null when there is no transform for it, or
 *  when anything after the resolve fails, which leaves the photo to the
 *  browser's decode (and nothing else: the original is still there). */
async function convertedImage(
  photo: CatalogPhoto,
  file: File,
  decoder: CodeDecoder,
  opts: LoadImageOptions | undefined,
): Promise<Float16Source | null> {
  const transform = await resolveInputTransform(photo, file);
  if (!transform || opts?.signal?.aborted) return null;
  try {
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

/** A RAW's bitmap decode, or the stored preview of any photo. `held`: the
 *  original, already read by the caller. A non-RAW photo's own decoders have
 *  run by now (decodeNonRaw). */
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
