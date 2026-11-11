// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The per-pixel work of a libraw decode, kept apart from the adapter so it can
// run in frame-worker.ts and, where there is no Worker, inline. Every loop over
// a frame's pixels sits here, so the main thread never makes one: libraw's
// samples become the linear sRGB float frame (already turned upright when asked),
// the colour sanity check reads it, and the develop-preview cache entry is built
// from it. Imports nothing that touches the DOM or React.

import { normalizeRotation } from "@/catalog/orient";
import { encodeCacheEntry, type EncodedEntry } from "./cache-encode";
import type { HalfFrame, ProfileJob } from "./profile-frame";

export interface FrameJob {
  /** libraw's processed samples, `stride` to a pixel, row-major. */
  pixels: Uint8Array | Uint16Array;
  width: number;
  height: number;
  stride: number;
  /** Multiplies the converted samples: the white point libraw's highlight mode
   *  lowered, restored, and any exposure bias. */
  gain: number;
  /** Clockwise degrees (a quarter-turn step) to bake into the frame. */
  turn: number;
  /** A Foveon frame is legitimately channel-imbalanced, so its colour check is skipped. */
  foveon: boolean;
  /** Also build the cache entry, with a preview of this long edge. */
  cacheEdge?: number;
}

export type FrameResult =
  | { rejected: string }
  | { data: Float32Array<ArrayBuffer>; width: number; height: number; entry?: EncodedEntry };

/** The requests answered as they arrive; a "profile" one decodes its file
 *  first, so profile-frame.ts answers it. */
export type SyncFrameRequest =
  | { id: number; op: "build"; job: FrameJob }
  | { id: number; op: "srgb8"; data: Float32Array };

export type FrameRequest = SyncFrameRequest | { id: number; op: "profile"; job: ProfileJob };

export type FrameReply =
  | { id: number; op: "build"; result: FrameResult }
  | { id: number; op: "srgb8"; bytes: Uint8ClampedArray<ArrayBuffer> }
  | { id: number; op: "profile"; frame: HalfFrame }
  | { id: number; op: "error"; message: string };

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

let linearTable: Float32Array | null = null;

/** The linear value of each 16-bit code of libraw's Rec.709-encoded samples. */
export function linearOfCode(): Float32Array {
  linearTable ??= dcrawInverseTransfer(0.45, 4.5);
  return linearTable;
}

// Row-major 3×3 inverse by cofactors.
function invert3(m: readonly number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m;
  const c0 = e * i - f * h;
  const c1 = f * g - d * i;
  const c2 = d * h - e * g;
  const s = 1 / (a * c0 + b * c1 + c * c2);
  return [
    c0 * s, (c * h - b * i) * s, (b * f - c * e) * s,
    c1 * s, (a * i - c * g) * s, (c * d - a * f) * s,
    c2 * s, (b * g - a * h) * s, (a * e - b * d) * s,
  ];
}

// Linear sRGB -> ACES AP0 (D65): aces_rgb, LibRaw 0.22 tables/colorconst.cpp.
const ACES_FROM_SRGB = [
  0.43968015, 0.38295299, 0.17736686,
  0.08978964, 0.81343316, 0.09677734,
  0.01754827, 0.11156156, 0.87089017,
];
/** libraw's ACES samples to linear sRGB. */
export const SRGB_FROM_ACES = invert3(ACES_FROM_SRGB);

/** Where a source pixel (x, y) lands in the turned frame, as float offsets:
 *  `base + x * dx + y * dy`. */
export function placement(width: number, height: number, turn: number) {
  switch (turn) {
    case 90: return { base: 4 * (height - 1), dx: 4 * height, dy: -4 };
    case 180: return { base: 4 * (width * height - 1), dx: -4, dy: -4 * width };
    case 270: return { base: 4 * (width - 1) * height, dx: -4 * height, dy: 4 };
    default: return { base: 0, dx: 4, dy: 4 * width };
  }
}

export function buildFrame(job: FrameJob): FrameResult {
  const { pixels, width, height, stride, gain } = job;
  const turn = normalizeRotation(job.turn);
  const n = width * height;
  const table = linearOfCode();
  // 8-bit codes index the 16-bit table at its matching level (255 -> 65535).
  const step = pixels instanceof Uint16Array ? 1 : 257;
  const [m0, m1, m2, m3, m4, m5, m6, m7, m8] = SRGB_FROM_ACES;
  const { base, dx, dy } = placement(width, height, turn);
  const data = new Float32Array(n * 4);
  if (stride >= 3) {
    for (let y = 0, s = 0; y < height; y++) {
      let o = base + y * dy;
      for (let x = 0; x < width; x++, o += dx, s += stride) {
        const r = table[pixels[s] * step];
        const g = table[pixels[s + 1] * step];
        const b = table[pixels[s + 2] * step];
        data[o] = (m0 * r + m1 * g + m2 * b) * gain;
        data[o + 1] = (m3 * r + m4 * g + m5 * b) * gain;
        data[o + 2] = (m6 * r + m7 * g + m8 * b) * gain;
        data[o + 3] = 1;
      }
    }
  } else {
    for (let y = 0, s = 0; y < height; y++) {
      let o = base + y * dy;
      for (let x = 0; x < width; x++, o += dx, s += stride) {
        data[o] = data[o + 1] = data[o + 2] = table[pixels[s] * step] * gain;
        data[o + 3] = 1;
      }
    }
  }

  // Sanity-check: reject a decode where all channels are simultaneously
  // near-clipped AND strongly colour-imbalanced — the hallmark of a bad
  // WB/colour-matrix for an unrecognized camera, not a legitimately bright
  // scene (which would have balanced channels near 1.0). It samples the source
  // frame's pixels, wherever the turn put them.
  let sumR = 0, sumG = 0, sumB = 0;
  const every = Math.max(1, Math.floor(n / 10000));
  let samples = 0;
  for (let p = 0; p < n; p += every) {
    const o = base + (p % width) * dx + Math.floor(p / width) * dy;
    sumR += data[o]; sumG += data[o + 1]; sumB += data[o + 2];
    samples++;
  }
  const mR = sumR / samples, mG = sumG / samples, mB = sumB / samples;
  const meanLum = (mR + mG + mB) / 3;
  const maxCh = Math.max(mR, mG, mB);
  const minCh = Math.min(mR, mG, mB);
  // Blown + colour imbalance > 0.3 across channels = bad decode.
  if (!job.foveon && meanLum > 0.80 && (maxCh - minCh) > 0.30) {
    return { rejected: `rejected: blown+imbalanced R=${mR.toFixed(2)} G=${mG.toFixed(2)} B=${mB.toFixed(2)}` };
  }

  const swap = turn === 90 || turn === 270;
  const outWidth = swap ? height : width;
  const outHeight = swap ? width : height;
  const entry = job.cacheEdge ? encodeCacheEntry(data, outWidth, outHeight, job.cacheEdge) : undefined;
  return { data, width: outWidth, height: outHeight, ...(entry ? { entry } : {}) };
}

/** Linear floats as 8-bit sRGB RGBA, clamped to [0, 1] first, for a thumbnail. */
export function toSrgb8(data: Float32Array): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(data.length);
  for (let o = 0; o < data.length; o += 4) {
    for (let c = 0; c < 3; c++) {
      let v = data[o + c];
      v = v <= 0 ? 0 : v >= 1 ? 1 : v;
      v = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
      out[o + c] = Math.round(v * 255);
    }
    out[o + 3] = 255;
  }
  return out;
}

/** One message of the frame worker: its reply, and the buffers that go with it. */
export function handleFrameRequest(req: SyncFrameRequest): { reply: FrameReply; transfer: Transferable[] } {
  try {
    if (req.op === "srgb8") {
      const bytes = toSrgb8(req.data);
      return { reply: { id: req.id, op: "srgb8", bytes }, transfer: [bytes.buffer] };
    }
    const result = buildFrame(req.job);
    const transfer: Transferable[] = [];
    if (!("rejected" in result)) {
      transfer.push(result.data.buffer);
      if (result.entry) transfer.push(result.entry.preview.data.buffer, result.entry.sample.data.buffer);
    }
    return { reply: { id: req.id, op: "build", result }, transfer };
  } catch (e) {
    return {
      reply: { id: req.id, op: "error", message: e instanceof Error ? e.message : String(e) },
      transfer: [],
    };
  }
}
