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
// Requires the page to be cross-origin isolated (COOP/COEP) for libraw's shared
// memory — see vite.config.ts. If anything is unavailable, returns null and the
// caller falls back to the in-house decoder / embedded preview. It logs the
// reason so a silent fallback can be diagnosed.

import { kelvinFromWhiteBalanceGains } from "@/rendering/blackbody";
import type { RawFloatImage } from "./decode";
import { acquireInstance, releaseInstance } from "./decode-pool";

// Why the most recent attempt did (not) use libraw — surfaced in the UI.
export let lastLibRawStatus = "not attempted";

const num = (v: unknown): number =>
  typeof v === "number" && isFinite(v) ? v : 0;

// As-shot Kelvin from libraw's camera WB multipliers (imgdata.color.cam_mul[]).
// This build of libraw-wasm exposes no camera colour matrix (color_data carries
// cam_mul / pre_mul only, no cam_xyz or rgb_cam), so the multipliers can only be
// matched against the blackbody curve — a ratio fit that ignores the camera's
// primaries. DNGs take the exact colour-matrix route in catalog/exif.ts instead.
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

// Under any highlight mode but clip, scale_colors() normalises the multipliers
// to their LARGEST so no channel can exceed 65535 — which parks the least-
// amplified channel's sensor white at 65535 / max(mul): about a stop down, and
// varying with white balance. Auto-bright used to hide that. Undo it here in
// float, where the other channels keep their headroom above 1.0 — the same
// contract toRGBAFloat's in-house path delivers.
function highlightModeScale(colorData: unknown): number {
  const mul = scaleMultipliers(colorData);
  return mul ? Math.max(...mul) / Math.min(...mul) : 1;
}

// dcraw's gamma_curve() for its default transfer (power 0.45, toe slope 4.5:
// Rec.709), inverted and tabulated per 16-bit code. libraw-wasm ignores the
// `gamm` setting — probed 2026-09-20 against native LibRaw: every spelling,
// and none, returned the same Rec.709-encoded samples — so this is the transfer
// its output always carries, and asking it for linear would only invite a
// double decode from a build that starts honouring the setting.
function dcrawInverseTransfer(power: number, toeSlope: number): Float32Array {
  let lo = 0;
  let hi = 1;
  let knee = 0;
  for (let i = 0; i < 48; i++) {
    knee = (lo + hi) / 2;
    if ((Math.pow(knee / toeSlope, -power) - 1) / power - 1 / knee > -1) hi = knee;
    else lo = knee;
  }
  const offset = knee * (1 / power - 1);
  const table = new Float32Array(65536);
  for (let code = 0; code < 65536; code++) {
    const y = code / 65536;
    table[code] = y < knee ? y / toeSlope : Math.pow((y + offset) / (1 + offset), 1 / power);
  }
  return table;
}

const LINEAR_OF_CODE = dcrawInverseTransfer(0.45, 4.5);

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

// Lightweight metadata-only extraction: open the RAW, read its frame size and
// color_data.cam_mul, and close — no pixel decode. Fast enough for import time.
export async function extractRawMetadata(
  buffer: ArrayBuffer,
): Promise<RawMetadata | undefined> {
  if (typeof Worker === "undefined" || typeof SharedArrayBuffer === "undefined") return undefined;
  if (buffer.byteLength < 1024 * 1024) return undefined;

  const raw = await acquireInstance();
  if (!raw) return undefined;

  try {
    // open() transfers the passed buffer to libraw's worker (detaching it), so
    // hand it a copy — the caller keeps its ArrayBuffer for the fallback path.
    await raw.open(new Uint8Array(buffer.slice(0)), { useCameraWb: true });
    const meta = await raw.metadata(true);
    return {
      colorTemperature: kelvinFromCamMul(meta.color_data),
      frame: frameOf(meta),
      rawExposureBias: rawExposureBias(meta) || undefined,
    };
  } catch {
    return undefined;
  } finally {
    releaseInstance(raw);
  }
}

export async function decodeRawFloatViaLibRaw(
  buffer: ArrayBuffer,
): Promise<RawFloatImage | null> {
  if (typeof Worker === "undefined") {
    lastLibRawStatus = "no Worker support";
    console.warn("[libraw]", lastLibRawStatus);
    return null;
  }
  // What libraw actually needs is SharedArrayBuffer. On http(s) that means
  // cross-origin isolation (COOP/COEP); in Electron the app:// scheme can't
  // become crossOriginIsolated, so SAB is re-enabled via a feature flag
  // instead and crossOriginIsolated stays false. Gate on SAB itself.
  if (typeof SharedArrayBuffer === "undefined") {
    lastLibRawStatus = globalThis.crossOriginIsolated
      ? "no SharedArrayBuffer support"
      : "no SharedArrayBuffer (not cross-origin isolated — restart dev server for COOP/COEP)";
    console.warn("[libraw]", lastLibRawStatus);
    return null;
  }
  
  // Sanity floor only — reject obviously-truncated/empty files, but keep small
  // legacy RAWs (old Canon CRW, Kodak KDC, some Hasselblad 3FR) which are well
  // under 1 MB yet decode fine. A 64 KB floor still catches corrupt stubs.
  if (buffer.byteLength < 64 * 1024) {
    lastLibRawStatus = `file too small (${buffer.byteLength} bytes)`;
    console.warn("[libraw]", lastLibRawStatus);
    return null;
  }
  
  const raw = await acquireInstance();
  if (!raw) {
    lastLibRawStatus = "decode pool unavailable";
    return null;
  }

  try {
    // open() transfers the passed buffer to libraw's worker (detaching it), so
    // hand it a copy — the caller keeps its ArrayBuffer for the fallback path.
    await raw.open(new Uint8Array(buffer.slice(0)), {
      outputBps: 16,
      useCameraWb: true,
      outputColor: 1,
      // No `gamm`: the wrapper ignores it and always encodes Rec.709 (see
      // LINEAR_OF_CODE), which is linearised below.
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
    });
    const meta = await raw.metadata(true);
    const px: unknown = await raw.imageData();

    // imageData() may return undefined on WASM errors even if metadata succeeded
    if (!px) {
      lastLibRawStatus = "imageData returned undefined (WASM error)";
      console.warn("[libraw]", lastLibRawStatus, "metadata =", meta);
      return null;
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
      lastLibRawStatus = "decoded but missing dimensions";
      console.warn("[libraw] missing dims; metadata =", meta, "px =", px);
      return null;
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
      lastLibRawStatus = `pixel/size mismatch (${pixels.length} for ${width}x${height})`;
      console.warn("[libraw]", lastLibRawStatus);
      return null;
    }

    const n = width * height;
    const scale = highlightModeScale(meta.color_data);
    const bias = rawExposureBias(meta);
    const gain = scale * 2 ** -bias;
    // 8-bit codes index the 16-bit table at its matching level (255 -> 65535).
    const step = pixels instanceof Uint16Array ? 1 : 257;
    const data = new Float32Array(n * 4);
    for (let i = 0, o = 0, s = 0; i < n; i++, o += 4, s += stride) {
      const r = LINEAR_OF_CODE[pixels[s] * step] * gain;
      const g = stride >= 3 ? LINEAR_OF_CODE[pixels[s + 1] * step] * gain : r;
      const b = stride >= 3 ? LINEAR_OF_CODE[pixels[s + 2] * step] * gain : r;
      data[o] = r;
      data[o + 1] = g;
      data[o + 2] = b;
      data[o + 3] = 1;
    }

    // Sanity-check: reject a decode where all channels are simultaneously
    // near-clipped AND strongly colour-imbalanced — the hallmark of a bad
    // WB/colour-matrix for an unrecognised camera, not a legitimately bright
    // scene (which would have balanced channels near 1.0).
    {
      let sumR = 0, sumG = 0, sumB = 0;
      const step = Math.max(1, Math.floor(n / 10000));
      let samples = 0;
      for (let i = 0; i < n * 4; i += 4 * step) {
        sumR += data[i]; sumG += data[i + 1]; sumB += data[i + 2];
        samples++;
      }
      const mR = sumR / samples, mG = sumG / samples, mB = sumB / samples;
      const meanLum = (mR + mG + mB) / 3;
      const maxCh = Math.max(mR, mG, mB);
      const minCh = Math.min(mR, mG, mB);
      // Sigma Foveon (X3F) stacks three photodiodes per pixel, so its linear
      // pre-matrix output is legitimately channel-imbalanced — this Bayer-tuned
      // WB heuristic would false-reject valid X3F decodes, so skip it for Foveon.
      const isFoveon = num((meta as Record<string, unknown>).is_foveon) > 0;
      // Blown + colour imbalance > 0.3 across channels = bad decode.
      if (!isFoveon && meanLum > 0.80 && (maxCh - minCh) > 0.30) {
        lastLibRawStatus = `rejected: blown+imbalanced R=${mR.toFixed(2)} G=${mG.toFixed(2)} B=${mB.toFixed(2)}`;
        console.warn("[libraw]", lastLibRawStatus);
        return null;
      }
    }

    const colorTemperature = kelvinFromCamMul(meta.color_data);

    lastLibRawStatus =
      `libraw ${pixels instanceof Uint16Array ? 16 : 8}-bit ${stride}ch ${width}×${height}` +
      ` ×${scale.toFixed(2)} white point` +
      (bias ? `, ${(-bias).toFixed(2)} EV exposure bias` : "");
    console.log("[libraw] decoded", lastLibRawStatus);
    return {
      data,
      width,
      height,
      suspicious: inferredDims,
      colorTemperature,
      rawExposureBias: bias || undefined,
    };
  } catch (e) {
    lastLibRawStatus = `decode error: ${e instanceof Error ? e.message : String(e)}`;
    console.warn("[libraw] decode failed", e);
    return null;
  } finally {
    releaseInstance(raw);
  }
}
