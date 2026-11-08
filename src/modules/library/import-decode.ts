// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The decode stage of an import: a file to a bitmap for thumbnailing, through
// the fallback chain, and the size and metadata reads that share its bytes.

import { decodeRawToFloat, decodeRawToBitmap, type DecodeFailure } from "@/raw/decode";
import { extractRawMetadata, type RawMetadata } from "@/raw/libraw-wasm-adapter";
import type { DecodeRequest } from "@/raw/decode-pool";
import { encodeSrgb8 } from "@/raw/frame-bridge";
import {
  distrustsEmbeddedPreview,
  extractRawPreviewDecoded,
  isRawFile,
  prefersEmbeddedPreview,
  sensorNativeImage,
} from "@/raw/raw-preview";
import { decodeNetpbm, isNetpbmName } from "@/raw/netpbm";
import { decodeTiff, isTiffName } from "@/raw/tiff-image";
import { orientationToRotation, previewUprightRotation, rotateBitmap } from "@/catalog/orient";
import { getSettings, type PreviewSource } from "@/state/settings-store";
import type { ThumbTaskResult } from "./import-thumb-task";
import { processThumb } from "./import-thumb-pool";

// Bake a linear Float32 RGBA buffer down to an 8-bit sRGB ImageBitmap. The
// thumbnail fallback when a RAW has no embedded preview AND decodeRawToBitmap
// can't handle its compression (no registered getLibRaw hook): the float path
// (libraw-wasm) still decodes it, so we sRGB-encode that here rather than drop
// the file. HDR values above 1.0 are clamped. The encode runs in the frame
// worker, which takes the buffer.
async function floatToBitmap(
  data: Float32Array,
  width: number,
  height: number,
  request?: DecodeRequest,
): Promise<ImageBitmap> {
  return createImageBitmap(new ImageData(await encodeSrgb8(data, request), width, height));
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
// must never be silently dropped from the catalogue. The `source` preference
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
// to sRGB. `oriented` is true when the returned pixels are already EXIF-upright,
// so the caller must NOT rotate again. Camera embedded previews are oriented HERE
// from the master RAW's EXIF Orientation (decoded sensor-native, then rotated via
// previewUprightRotation) rather than trusting the preview's own EXIF tag — many
// cameras embed a sensor-native preview with NO orientation tag, so "from-image"
// would leave it sideways. Non-RAW files decode directly, a JPEG with its Exif
// segment left out (sensorNativeImage) so the decoder can't orient it first.
//
// It gives no image only when the pixels are genuinely undecodable: for a RAW,
// what its float decode answered, otherwise null.
export interface DecodedImport {
  bitmap: ImageBitmap;
  oriented: boolean;
  /** The camera's preview, standing in for a RAW decode that background work
   *  passed over (see decode.ts): fine to show, not worth storing. */
  passedOver?: boolean;
  colorTemperature?: number;
  /** True pixel size the bitmap stands for, in the bitmap's orientation — set
   *  when the embedded preview was decoded downscaled to thumbnail size. */
  sourceWidth?: number;
  sourceHeight?: number;
}

export interface Size {
  width: number;
  height: number;
}

/** A size after a rotation: the sides trade places on a quarter turn. */
export function turned({ width, height }: Size, deg: number): Size {
  return deg === 90 || deg === 270 ? { width: height, height: width } : { width, height };
}

/** Catalogue width/height for a decode: the true frame size (not a downscaled
 *  preview bitmap's), swapped when the bake is a quarter turn. */
function uprightSize(decoded: DecodedImport, bakeRotation: number): Size {
  return turned(
    {
      width: decoded.sourceWidth ?? decoded.bitmap.width,
      height: decoded.sourceHeight ?? decoded.bitmap.height,
    },
    bakeRotation,
  );
}

// A big non-RAW image (a 16-bit TIFF scan, a large Netpbm) is read whole and
// held several times over while it decodes, so only two such decodes run at
// once, however many files the import reads together.
const LARGE_IMAGE_BYTES = 32 * 2 ** 20;
const LARGE_DECODES = 2;
let largeDecodes = 0;
const waitingLarge: (() => void)[] = [];

async function largeDecodeSlot<T>(file: File, decode: () => Promise<T>): Promise<T> {
  if (isRawFile(file) || file.size < LARGE_IMAGE_BYTES) return decode();
  if (largeDecodes < LARGE_DECODES) largeDecodes++;
  else await new Promise<void>((resolve) => waitingLarge.push(resolve));
  try {
    return await decode();
  } finally {
    // A waiting decode takes the slot over; otherwise it frees up.
    const next = waitingLarge.shift();
    if (next) next();
    else largeDecodes--;
  }
}

/** A RAW's bytes, read once for every step of its decode chain to share (in
 *  Electron each read copies the whole file, in the browser it goes back to the
 *  disk). Undefined for any other file, whose decoder reads it itself, and for
 *  a RAW that can't be read now: each step then reads it, and fails, as before. */
export async function rawBytesOf(file: File): Promise<ArrayBuffer | undefined> {
  return isRawFile(file) ? file.arrayBuffer().catch(() => undefined) : undefined;
}

/** Frame size and as-shot WB of a RAW from a metadata-only libraw open —
 *  undefined for any other file, and for a RAW libraw can't read. `bytes`: the
 *  file's, from rawBytesOf. */
export async function readRawMetadata(
  file: File,
  request?: DecodeRequest,
  bytes?: ArrayBuffer,
): Promise<RawMetadata | undefined> {
  if (!isRawFile(file)) return undefined;
  try {
    if (bytes) return await extractRawMetadata(bytes, request);
    // Read for libraw alone, so it takes them without a copy.
    return await extractRawMetadata(await file.arrayBuffer(), request, true);
  } catch {
    return undefined;
  }
}

/** Catalogue width/height. A RAW records the frame libraw decodes, not the size
 *  of whatever built its thumbnail: the camera's embedded JPEG can be smaller
 *  (Fujifilm previews are) or cropped to another aspect. libraw reports that
 *  frame already EXIF-upright, so only a manual turn is left to apply; anything
 *  else records the decode's own source size, turned by what the bake still
 *  applied. */
export function catalogSize(
  frame: Size | undefined,
  manualRotation: number,
  decoded: DecodedImport,
  bakeRotation: number,
): Size {
  return frame ? turned(frame, manualRotation) : uprightSize(decoded, bakeRotation);
}

export async function decodeImportBitmap(
  file: File,
  orientation: number | undefined,
  request?: DecodeRequest,
  source: PreviewSource = getSettings().previewSource,
  relPath?: string,
  bytes?: ArrayBuffer,
): Promise<DecodedImport | DecodeFailure | null> {
  // Bring an embedded camera preview (already decoded sensor-native by
  // extractRawPreviewDecoded) upright using the master RAW's EXIF orientation —
  // the preview's own tag is unreliable, often absent. Returns an already-
  // upright bitmap plus the rotation applied, so the caller can swap the true
  // frame size the same way.
  const orientPreview = async (
    bm: ImageBitmap,
  ): Promise<{ bitmap: ImageBitmap; deg: number }> => {
    const deg = previewUprightRotation(
      bm.width,
      bm.height,
      orientationToRotation(orientation),
      orientation,
    );
    const upright = await rotateBitmap(bm, deg);
    if (upright !== bm) bm.close();
    return { bitmap: upright, deg };
  };
  if (isRawFile(file)) {
    const whole = bytes ?? (await rawBytesOf(file));
    // CRW & friends: the JPEG byte-scan can't find their real thumbnail and
    // returns a grey-noise false match, but libraw decodes them correctly — so
    // ignore the embedded preview entirely and render (as if "rendered" mode).
    const renderOnly = distrustsEmbeddedPreview(file);
    const effectiveSource: PreviewSource = renderOnly ? "rendered" : source;

    // Embedded camera JPEG: accepted outright in "embedded" mode, and in "auto"
    // when it's already big enough for the grid. Otherwise kept as a last-resort
    // fallback so a "rendered" decode that fails never drops the file.
    let embedded: DecodedImport | null = null;
    if (effectiveSource !== "rendered") {
      const preview = await extractRawPreviewDecoded(
        file,
        { targetLongEdge: getSettings().thumbMaxEdge },
        whole,
      );
      if (preview) {
        try {
          // Orient from the master RAW EXIF (see orientPreview). The result is
          // already upright, so oriented:true tells buildPhoto/load-image not to
          // rotate on top. The bitmap may be decoded at thumbnail scale; the
          // true frame size travels alongside it, swapped with the same turn.
          const { bitmap, deg } = await orientPreview(preview.bitmap);
          const swap = deg === 90 || deg === 270;
          const candidate: DecodedImport = {
            bitmap,
            oriented: true,
            sourceWidth: swap ? preview.height : preview.width,
            sourceHeight: swap ? preview.width : preview.height,
          };
          const longEdge = Math.max(preview.width, preview.height);
          // Use the embedded preview outright in "embedded" mode, when it's
          // already grid-sized, or for formats whose sensor render is unreliable
          // (X3F/Foveon) — a small camera preview beats a broken libraw decode.
          if (
            effectiveSource === "embedded" ||
            longEdge >= getSettings().thumbMaxEdge ||
            prefersEmbeddedPreview(file)
          ) {
            return candidate;
          }
          embedded = candidate; // too small for "auto" — render instead, keep as fallback
        } catch {
          /* rotation failed — fall through to a full decode */
        }
      }
    }

    const bitmapResult = await decodeRawToBitmap(file, whole);
    if (bitmapResult) {
      embedded?.bitmap.close();
      return { bitmap: bitmapResult.bitmap, oriented: bitmapResult.oriented };
    }

    // The bitmap decoder couldn't handle this RAW's compression. The float decode
    // (libraw-wasm) handles every compression, so generate the thumbnail from it —
    // unless the render looks degenerate (near-black/flat) and we still hold a
    // camera preview, in which case that trustworthy preview wins.
    // The thumbnail needs no more than its own edge, so the decode may stop at
    // half size.
    const f = await decodeRawToFloat(file, { ...request, targetEdge: getSettings().thumbMaxEdge }, relPath, whole);
    if (!("failure" in f) && !(embedded && looksDegenerate(f.data, f.width, f.height))) {
      embedded?.bitmap.close();
      const bm = await floatToBitmap(f.data, f.width, f.height, request);
      return {
        bitmap: bm,
        oriented: f.oriented ?? false,
        colorTemperature: f.colorTemperature,
        // The catalogue records the frame the bitmap stands for, not its half.
        ...(f.halfSize && f.sourceWidth && f.sourceHeight
          ? { sourceWidth: f.sourceWidth, sourceHeight: f.sourceHeight }
          : {}),
      };
    }

    // Every decode failed. Fall back to the embedded JPEG (the one we set aside in
    // "auto", or a fresh extract in "rendered") rather than drop the file. Skip
    // this for renderOnly formats (CRW) — their byte-scan preview is grey noise,
    // so a ⚠ "no preview" tile is more honest than a garbage thumbnail.
    const passedOver = "failure" in f && f.passedOver === true;
    if (embedded) return { ...embedded, passedOver };
    if (effectiveSource === "rendered" && !renderOnly) {
      const preview = await extractRawPreviewDecoded(
        file,
        { targetLongEdge: getSettings().thumbMaxEdge },
        whole,
      );
      if (preview) {
        try {
          // Orient from the master RAW EXIF (see orientPreview).
          const { bitmap, deg } = await orientPreview(preview.bitmap);
          const swap = deg === 90 || deg === 270;
          return {
            bitmap,
            oriented: true,
            sourceWidth: swap ? preview.height : preview.width,
            sourceHeight: swap ? preview.width : preview.height,
            passedOver,
          };
        } catch {
          /* genuinely undecodable */
        }
      }
    }
    return "failure" in f ? f : null;
  }
  return largeDecodeSlot(file, () => decodeImageBitmap(file));
}

async function decodeImageBitmap(file: File): Promise<DecodedImport | null> {
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
    const bitmap = await createImageBitmap(await sensorNativeImage(file), {
      imageOrientation: "none",
    });
    return { bitmap, oriented: false };
  } catch {
    return null;
  }
}

/** What a pass that stores previews keeps of a decode: nothing for a camera
 *  preview standing in for a decode that was passed over, since the decode
 *  under way will give the photo its own. */
export function storable(decoded: DecodedImport | DecodeFailure | null): DecodedImport | null {
  if (!decoded || "failure" in decoded) return null;
  if (!decoded.passedOver) return decoded;
  decoded.bitmap.close();
  return null;
}

// Fast path: hand the pixel stage (decode → orient → thumbnail encode) to the
// import worker pool so files import in parallel across cores. Formats the
// task doesn't cover answer null and take the inline decode chain instead — a
// worker-level failure degrades the same way, never dropping a file.
export async function workerThumb(
  file: File,
  orientation: number | undefined,
  bytes?: ArrayBuffer,
): Promise<Extract<ThumbTaskResult, { ok: true }> | null> {
  const { previewSource, thumbMaxEdge } = getSettings();
  if (
    isRawFile(file) &&
    (previewSource === "rendered" || distrustsEmbeddedPreview(file))
  )
    return null;
  try {
    const result = await largeDecodeSlot(file, async () =>
      processThumb({
        // The pool transfers the buffer to its worker: the caller's bytes go as a copy.
        buffer: bytes ? bytes.slice(0) : await file.arrayBuffer(),
        name: file.name,
        type: file.type,
        lastModified: file.lastModified,
        orientation,
        previewSource,
        thumbMaxEdge,
      }),
    );
    return result.ok ? result : null;
  } catch {
    return null;
  }
}
