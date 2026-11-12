// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Adapter around the bundled `libraw-wasm` build. Decodes a RAW file to a
// full-precision LINEAR float RGBA buffer (sensor data with real highlight
// headroom) using camera white balance, so our shader pipeline owns all the
// tonal/WB work. The wrapper's samples arrive Rec.709-encoded and scaled down
// for its highlight mode; both are undone here. Runs in libraw's Web Worker
// off the main thread.
//
// libraw clips its integer output to the gamut it renders into, which in sRGB
// cuts away every colour outside the sRGB primaries (saturated flowers, LEDs,
// deep cyans) and shifts its hue. So the decode asks for ACES instead, whose
// AP0 primaries enclose every visible colour, and rotates to linear sRGB in
// float, where those colours keep their negative channels. A camera matrix can
// still produce colours outside AP0, and libraw clips those at 0.
//
// libraw's samples are transferred to this page, and from here on to the frame
// worker (frame-bridge.ts), which does every per-pixel step: that conversion, the
// colour sanity check, the turn upright and the cache entry (frame-job.ts). This
// page loops over no pixels and copies no frame.
//
// Requires the page to be cross-origin isolated (COOP/COEP) for libraw's shared
// memory — see vite.config.ts. Without an image it answers why (DecodeFailure)
// and the caller falls back to the in-house decoder / embedded preview. It logs
// the reason so a silent fallback can be diagnosed. A photo it calls
// unsupported is remembered under raw-cache.ts's DECODER_ID: bump that with the
// vendored LibRaw or with any change to what counts as unsupported here.

import { kelvinFromWhiteBalanceGains } from "@/rendering/blackbody";
import type { DecodeFailure, RawFloatImage } from "./decode-result";
import { normalizeRotation } from "@/catalog/orient";
import { finishFrame, isAbandoned } from "./frame-bridge";
import {
  acquireInstance,
  decodePoolFailure,
  discardInstance,
  releaseInstance,
  type DecodeRequest,
  type LibRawInstance,
} from "./decode-pool";

interface Watched {
  /** Awaits a call on the instance; it fails once the time limit is up. */
  call<R>(pending: Promise<R>): Promise<R>;
  /** Lengthens the limit, counted from the start, to `limitMs`; never shortens it. */
  extendTo(limitMs: number): void;
  /** Milliseconds since the instance was lent. */
  elapsed(): number;
  /** Hands the instance back: released if every call answered, else discarded. */
  done(): void;
}

/** A call still out when the decode's time limit ran down. */
class NoAnswer extends Error {}

// Every call awaited on a pooled instance goes through here. One that rejects
// (a trap or an abort leaves the module unusable) or that is still out when
// the limit runs down (the worker will never answer) breaks the instance, and
// the pool replaces it. A late answer to a call given up on goes nowhere.
function watch(raw: LibRawInstance, limitMs: number): Watched {
  const started = Date.now();
  let limit = limitMs;
  let broken = false;
  let expire = (): void => {};
  const expired = new Promise<never>((_, reject) => {
    expire = () => reject(new NoAnswer(`no answer within ${Math.round(limit / 1000)} s`));
  });
  expired.catch(() => {});
  let timer = setTimeout(expire, limit);
  return {
    call<R>(pending: Promise<R>): Promise<R> {
      return Promise.race([pending, expired]).catch((e: unknown) => {
        broken = true;
        throw e;
      });
    },
    extendTo(limitMs: number): void {
      if (limitMs <= limit) return;
      limit = limitMs;
      clearTimeout(timer);
      timer = setTimeout(expire, Math.max(0, started + limit - Date.now()));
    },
    elapsed(): number {
      return Date.now() - started;
    },
    done(): void {
      clearTimeout(timer);
      if (broken) discardInstance(raw);
      else releaseInstance(raw);
    },
  };
}

const num = (v: unknown): number =>
  typeof v === "number" && isFinite(v) ? v : 0;

// As-shot Kelvin from libraw's camera WB multipliers (imgdata.color.cam_mul[]).
// This build of libraw-wasm exposes none of libraw's camera colour matrices
// (color_data carries the black and maximum levels, cam_mul / pre_mul and a few
// model and ID fields, but no cam_xyz, rgb_cam, cmatrix or ccm), so the
// multipliers can only be matched against the blackbody curve — a ratio fit that
// ignores the camera's primaries. DNGs take the exact colour-matrix route in
// catalog/exif.ts instead.
function kelvinFromCamMul(colorData: unknown): number | undefined {
  if (typeof colorData !== "object" || colorData === null) return undefined;
  const camMul: unknown = (colorData as Record<string, unknown>).cam_mul;
  if (!Array.isArray(camMul)) return undefined;
  const [r, g, b] = camMul as unknown[];
  if (typeof r !== "number" || typeof g !== "number" || typeof b !== "number") return undefined;
  return kelvinFromWhiteBalanceGains(r, g, b);
}

// The multipliers libraw's scale_colors() divides the frame by: the camera's
// as-shot set when usable, otherwise its daylight set — dcraw's own rule under
// use_camera_wb. A three-colour sensor reports its second green as 0.
function scaleMultipliers(colorData: unknown): number[] | undefined {
  if (typeof colorData !== "object" || colorData === null) return undefined;
  const { cam_mul, pre_mul } = colorData as Record<string, unknown>;
  const positive = (v: unknown): number[] =>
    Array.isArray(v) ? v.filter((m): m is number => typeof m === "number" && m > 0) : [];
  const usable = Array.isArray(cam_mul) && num(cam_mul[0]) > 0 && num(cam_mul[2]) > 0;
  const mul = usable ? positive(cam_mul) : positive(pre_mul);
  return mul.length >= 2 ? mul : undefined;
}

// Under any highlight mode but clip, scale_colors() normalizes the multipliers
// to their LARGEST so no channel can exceed 65535 — which parks the least-
// amplified channel's sensor white at 65535 / max(mul): about a stop down, and
// varying with white balance. Auto-bright used to hide that. Undo it here in
// float, where the other channels keep their headroom above 1.0 — the same
// contract toRGBAFloat's in-house path delivers.
function highlightModeScale(colorData: unknown): number {
  const mul = scaleMultipliers(colorData);
  return mul ? Math.max(...mul) / Math.min(...mul) : 1;
}

// EV by which the sensor was exposed under the tagged ISO, or 0. Fujifilm's DR
// modes buy highlight room that way and let the camera JPEG push it back; the
// RAF records the amount as RawExposureBias (tag 0x9650: -0.72 at DR100, -1.72
// at DR200, -2.72 at DR400), which libraw surfaces as ExpoMidPointShift and
// folds into ExposureCalibrationShift without ever applying it. Bodies that
// predate the tag still record which DR mode they developed.
function rawExposureBias(meta: Record<string, unknown>): number {
  const common = meta.metadata_common as Record<string, unknown> | undefined;
  const fuji = meta.fuji as Record<string, unknown> | undefined;
  const tagged = num(common?.ExposureCalibrationShift) || num(fuji?.ExpoMidPointShift);
  if (tagged) return tagged;
  // An unset DR tag arrives as the 65535 sentinel; only the two real modes count.
  const developed = num(fuji?.DevelopmentDynamicRange);
  const dr = developed === 200 || developed === 400 ? developed : num(fuji?.AutoDynamicRange);
  return dr === 200 || dr === 400 ? -Math.log2(dr / 100) : 0;
}

/** What a metadata-only libraw open yields — headers only, no pixel decode. */
export interface RawMetadata {
  /** As-shot Kelvin from the camera WB multipliers, when libraw exposes them. */
  colorTemperature?: number;
  /** EV the sensor sat below the tagged ISO (Fujifilm DR modes); the float
   *  decode compensates it, so this is informational. */
  rawExposureBias?: number;
  /** The frame this RAW decodes to — imgdata.sizes.width/height, the visible
   *  image without the masked sensor borders. libraw-wasm swaps the two for a
   *  quarter-turn flip, so it arrives already EXIF-upright. */
  frame?: { width: number; height: number };
}

function frameOf(meta: Record<string, unknown>): RawMetadata["frame"] {
  const width = num(meta.width);
  const height = num(meta.height);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

/**
 * How long libraw may take over one file before its instance counts as hung: a
 * minute, plus 20 s for every 25 MB. A full decode takes 3–10 s here (see the
 * develop-preview cache's figures); unpacking and demosaicing scale with the
 * file, and three decodes may share a slow CPU. The limit is several times the
 * worst of that, so only a worker that will never answer reaches it.
 */
export function decodeTimeLimit(byteLength: number): number {
  return 60_000 + 20_000 * (byteLength / 25_000_000);
}

/**
 * The same limit by the frame metadata() reports: a minute, plus 2 s per
 * megapixel, so a 61 MP frame gets three. Demosaicing scales with pixels, and a
 * lossy file can be small for its pixel count. open() only reads the header and
 * the unpack waits for imageData(), so this can still lengthen the limit for
 * the heavy part; it never shortens it. It stops at five minutes: the frame is
 * the header's word, and a broken one can claim any size.
 */
export function decodeTimeLimitForFrame(width: number, height: number): number {
  return Math.min(300_000, 60_000 + 2_000 * ((width * height) / 1_000_000));
}

/**
 * The most of libraw's heap a full-size decode may need, with room left under
 * the 2 GiB the build can grow to (32768 pages). A full-size decode holds the
 * sensor readout (2 bytes a pixel), LibRaw's working image (8) and its output
 * (6) at once, besides the file. Past the budget it decodes at half size
 * (LibRaw's half_size), which shrinks the last two to a quarter.
 */
const HEAP_BUDGET = 1_950_000_000;
const FULL_SIZE_BYTES_PER_PIXEL = 16;

function pastHeapBudget(frame: RawMetadata["frame"], byteLength: number): boolean {
  return !!frame && frame.width * frame.height * FULL_SIZE_BYTES_PER_PIXEL + byteLength > HEAP_BUDGET;
}

/** Whether half the frame's long edge, rounded down, still reaches the edge the
 *  caller renders from (DecodeRequest.targetEdge). */
function halfReachesTarget(frame: RawMetadata["frame"], targetEdge: number | undefined): boolean {
  return !!frame && !!targetEdge && Math.floor(Math.max(frame.width, frame.height) / 2) >= targetEdge;
}

// How running out of memory surfaces: a RangeError on this page (the copy or
// the float frame), an abort from libraw's worker once its heap can't grow.
function outOfMemory(e: unknown, message: string): boolean {
  return e instanceof RangeError ||
    /out of memory|\bOOM\b|bad_alloc|allocation failed|enlarge memory|Aborted\(/i.test(message);
}

// open() transfers the buffer it is passed to libraw's worker, detaching it. A
// caller that keeps its ArrayBuffer (for a fallback, say) gets it copied; one
// that is done with it (`transfer`) hands it over as it is.
function forLibRaw(buffer: ArrayBuffer, transfer: boolean): Uint8Array {
  return new Uint8Array(transfer ? buffer : buffer.slice(0));
}

// Lightweight metadata-only extraction: open the RAW, read its frame size and
// color_data.cam_mul, and close — no pixel decode. Fast enough for import time.
export async function extractRawMetadata(
  buffer: ArrayBuffer,
  request?: DecodeRequest,
  transfer = false,
): Promise<RawMetadata | undefined> {
  if (typeof Worker === "undefined" || typeof SharedArrayBuffer === "undefined") return undefined;
  if (buffer.byteLength < 1024 * 1024) return undefined;

  const raw = await acquireInstance(request);
  if (!raw) return undefined;

  const watched = watch(raw, decodeTimeLimit(buffer.byteLength));
  try {
    await watched.call(raw.open(forLibRaw(buffer, transfer), { useCameraWb: true }));
    const meta = await watched.call(raw.metadata(true));
    if (!meta) return undefined;
    return {
      colorTemperature: kelvinFromCamMul(meta.color_data),
      frame: frameOf(meta),
      rawExposureBias: rawExposureBias(meta) || undefined,
    };
  } catch {
    return undefined;
  } finally {
    watched.done();
  }
}

export async function decodeRawFloatViaLibRaw(
  buffer: ArrayBuffer,
  request?: DecodeRequest,
  transfer = false,
  reread?: () => Promise<ArrayBuffer>,
): Promise<RawFloatImage | DecodeFailure> {
  if (typeof Worker === "undefined") {
    const reason = "no Worker support";
    console.warn("[libraw]", reason);
    return { failure: "transient", reason };
  }
  // What libraw actually needs is SharedArrayBuffer. On http(s) that means
  // cross-origin isolation (COOP/COEP); in Electron the app:// scheme can't
  // become crossOriginIsolated, so SAB is re-enabled via a feature flag
  // instead and crossOriginIsolated stays false. Gate on SAB itself.
  if (typeof SharedArrayBuffer === "undefined") {
    const reason = globalThis.crossOriginIsolated
      ? "no SharedArrayBuffer support"
      : "no SharedArrayBuffer (not cross-origin isolated — restart dev server for COOP/COEP)";
    console.warn("[libraw]", reason);
    return { failure: "transient", reason };
  }
  
  // Sanity floor only — reject obviously-truncated/empty files, but keep small
  // legacy RAWs (old Canon CRW, Kodak KDC, some Hasselblad 3FR) which are well
  // under 1 MB yet decode fine. A 64 KB floor still catches corrupt stubs.
  if (buffer.byteLength < 64 * 1024) {
    const reason = `file too small (${buffer.byteLength} bytes)`;
    console.warn("[libraw]", reason);
    return { failure: "unsupported", reason };
  }

  const raw = await acquireInstance(request);
  if (!raw) {
    // An abandoned request is no failure: nobody is waiting to learn why.
    if (request?.signal?.aborted) return { failure: "aborted" };
    const cause = decodePoolFailure();
    return {
      failure: "transient",
      reason: cause ? `decode pool unavailable (${cause})` : "decode pool unavailable",
    };
  }

  const fileBytes = buffer.byteLength;
  const watched = watch(raw, decodeTimeLimit(fileBytes));
  // A transferred buffer is gone after the first open; a frame that goes to
  // half size needs the file's bytes again for the reopen, so it asks `reread`.
  const reopenable = !transfer || !!reread;
  let frame: RawMetadata["frame"];
  let halfSize = false;
  // The instance goes back to the pool as soon as its samples are ours, so the
  // next decode runs while the frame worker converts these.
  let handedBack = false;
  const handBack = (): void => {
    if (handedBack) return;
    handedBack = true;
    watched.done();
  };
  try {
    const settings = {
      outputBps: 16,
      useCameraWb: true,
      // ACES (LibRaw -o 6), not sRGB: libraw clips its output at 0, and the
      // ACES primaries enclose every visible colour (see the header).
      // SRGB_FROM_ACES (frame-job.ts) rotates the samples to linear sRGB.
      outputColor: 6,
      // No `gamm`: the wrapper ignores it and always encodes Rec.709 (see
      // LINEAR_OF_CODE in frame-job.ts), which is linearized there.
      // No content-driven auto-brighten: it scaled each image so ~1% of pixels
      // clipped to white, destroying exactly the data Highlights recovery needs
      // (and made baseline brightness vary per image). LR uses a fixed baseline.
      noAutoBright: true,
      userQual: 3,
      // Blend-reconstruct clipped highlights from the unclipped channels (dcraw
      // mode 2) instead of clipping to flat white — closest to LR's recovery of
      // near-blown detail. Modes 3+ (rebuild) can paint magenta; 2 is safe.
      // Any mode but 0 also lowers the white point (see highlightModeScale).
      highlight: 2,
      noAutoScale: false,
    };
    await watched.call(raw.open(forLibRaw(buffer, transfer), settings));
    const meta = (await watched.call(raw.metadata(true))) ?? {};
    frame = frameOf(meta);
    if (frame) watched.extendTo(decodeTimeLimitForFrame(frame.width, frame.height));
    // open() reads only the header, so the frame is known before the unpack.
    // Half size is a must past the heap budget; short of it, it is taken when
    // the caller needs no more, and a file that can't be read again just stays
    // at full size.
    const mustHalve = reopenable && pastHeapBudget(frame, fileBytes);
    if (mustHalve || (reopenable && halfReachesTarget(frame, request?.targetEdge))) {
      const again = transfer && reread
        ? await reread().catch((e: unknown) => {
            if (mustHalve) throw e;
            return undefined;
          })
        : buffer;
      if (again) {
        halfSize = true;
        await watched.call(raw.open(forLibRaw(again, transfer), { ...settings, halfSize }));
      }
    }
    const px: unknown = await watched.call(raw.imageData());
    handBack();

    // imageData() may return undefined on WASM errors even if metadata succeeded
    if (!px) {
      const reason = "imageData returned undefined (WASM error)";
      console.warn("[libraw]", reason, "metadata =", meta);
      return { failure: "unsupported", reason };
    }

    // imageData may be a bare typed array of pixels or an object carrying dims.
    let pixels: Uint8Array | Uint16Array;
    let width = 0;
    let height = 0;
    const obj = px as { data?: unknown; width?: unknown; height?: unknown };
    if (obj && obj.data && (obj.width || obj.height)) {
      pixels = obj.data as Uint8Array | Uint16Array;
      width = num(obj.width);
      height = num(obj.height);
    } else {
      pixels = px as Uint8Array | Uint16Array;
      // libraw-wasm ≥1.3 exposes the processed output size as `cwidth`/`cheight`
      // (C++ libraw_image_sizes_t.width/.height, renamed to avoid JS conflicts).
      // Older field names `width`/`iwidth` are also tried for compatibility.
      // raw_width/raw_height is the full sensor readout including optical-black
      // borders — larger than the pixel data — so using it as the stride shifts
      // the image down-right. Only fall back to it if nothing else resolves.
      width  = num((meta as Record<string, unknown>).cwidth)
            || num(meta.width) || num(meta.iwidth) || num(meta.raw_width);
      height = num((meta as Record<string, unknown>).cheight)
            || num(meta.height) || num(meta.iheight) || num(meta.raw_height);
    }

    if (width < 2 || height < 2 || !pixels || !("length" in pixels)) {
      const reason = "decoded but missing dimensions";
      console.warn("[libraw] missing dims; metadata =", meta, "px =", px);
      return { failure: "unsupported", reason };
    }

    // Detect the per-pixel channel stride before the pixel-count check so we
    // can validate the data length against the correct (channels * pixels) size.
    // LibRaw may return 3-channel (RGB) or 4-channel (RGBX) data.
    const strideGuess = pixels.length >= width * height * 4 ? 4
                      : pixels.length >= width * height * 3 ? 3
                      : pixels.length >= width * height     ? 1
                      : 0;

    // If the guessed dimensions don't fit the data, the width from metadata is
    // still wrong (e.g. cwidth not present and raw_width used as fallback).
    // Recover by computing output width from pixel count + sensor aspect ratio.
    let stride = strideGuess;
    let inferredDims = false;
    if (stride === 0 && num(meta.raw_width) > 0 && num(meta.raw_height) > 0) {
      const rawW = num(meta.raw_width);
      const rawH = num(meta.raw_height);
      for (const ch of [4, 3, 1]) {
        const totalPx = pixels.length / ch;
        const aspect = rawW / rawH;
        const w = Math.round(Math.sqrt(totalPx * aspect));
        // floor so w*h never exceeds the available pixels (an over-estimated h
        // would make the copy loop read past the array, writing NaN rows).
        const h = Math.floor(totalPx / w);
        if (w > 2 && h > 2 && totalPx - w * h < w) {
          width = w; height = h; stride = ch; inferredDims = true;
          console.warn(`[libraw] inferred dims ${w}×${h} ch=${ch} from pixel count — cwidth/cheight missing`);
          break;
        }
      }
    }
    if (stride === 0) {
      const reason = `pixel/size mismatch (${pixels.length} for ${width}x${height})`;
      console.warn("[libraw]", reason);
      return { failure: "unsupported", reason };
    }

    const scale = highlightModeScale(meta.color_data);
    const bias = rawExposureBias(meta);
    const bits = pixels instanceof Uint16Array ? 16 : 8;
    const turn = request?.turn ? normalizeRotation(request.turn) : 0;
    // Abandoned while libraw ran: the frame is built only for a caller that
    // took the decode over, and as that caller's, an opened photo's.
    let waiting: DecodeRequest | undefined = request;
    if (request?.signal?.aborted) {
      const heir = request.heir?.();
      if (!heir || heir.signal?.aborted) return { failure: "aborted" };
      waiting = { ...request, signal: heir.signal, background: false };
    }
    // Sigma Foveon (X3F) stacks three photodiodes per pixel, so its linear
    // pre-matrix output is legitimately channel-imbalanced — the frame worker's
    // Bayer-tuned colour check would false-reject valid X3F decodes.
    const built = await finishFrame(
      {
        pixels,
        width,
        height,
        stride,
        gain: scale * 2 ** -bias,
        turn,
        foveon: num((meta as Record<string, unknown>).is_foveon) > 0,
        cacheEdge: request?.cacheEdge,
      },
      waiting,
    );
    if ("rejected" in built) {
      console.warn("[libraw]", built.rejected);
      return { failure: "unsupported", reason: built.rejected };
    }

    // Libraw ignores half_size for a sensor with no mosaic to bin (Foveon), and
    // hands back the whole frame.
    const reduced = halfSize && !!frame && 2 * width <= frame.width + 2;
    const colorTemperature = kelvinFromCamMul(meta.color_data);

    const status =
      `libraw ${bits}-bit ${stride}ch ${width}×${height}` +
      ` ×${scale.toFixed(2)} white point` +
      (bias ? `, ${(-bias).toFixed(2)} EV exposure bias` : "") +
      (reduced ? ", half size" : "");
    const seconds = (watched.elapsed() / 1000).toFixed(1);
    console.log("[libraw] decoded", status, `in ${seconds} s`);
    return {
      data: built.data,
      width: built.width,
      height: built.height,
      suspicious: inferredDims,
      colorTemperature,
      rawExposureBias: bias || undefined,
      ...(reduced ? { halfSize: true, sourceWidth: frame?.width, sourceHeight: frame?.height } : {}),
      ...(turn ? { turned: turn } : {}),
      ...(built.entry ? { entry: built.entry } : {}),
    };
  } catch (e) {
    if (isAbandoned(e)) return { failure: "aborted" };
    const message = e instanceof Error ? e.message : String(e);
    console.warn("[libraw] decode failed", e);
    // A frame past the heap budget that runs out of memory at half size would
    // only run out again, so it is the file's size to blame. Without a half-size
    // try there is no such verdict.
    if (halfSize && frame && pastHeapBudget(frame, fileBytes) && outOfMemory(e, message)) {
      const reason = `too large to decode (${frame.width}×${frame.height}): ${message}`;
      return { failure: "unsupported", tooLarge: true, reason };
    }
    // Otherwise nothing here blames the file. LibRaw's own errors come back as
    // an undefined image (above). What throws is a worker error with a message
    // (a trap or an abort, possibly a one-off), a call that outlived the time
    // limit, or this page running out of memory for the copy or the float frame.
    const failure: DecodeFailure = { failure: "transient", reason: `decode error: ${message}` };
    if (e instanceof NoAnswer) failure.timedOut = true;
    return failure;
  } finally {
    handBack();
  }
}
