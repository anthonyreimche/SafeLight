// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The native-resolution centre of a decoded source, for extensions that
// measure the sensor's own pixels (a capture-sharpening radius, noise). The
// live RAW decode is box-averaged down to the Develop render resolution before
// it reaches the GPU and is gone once uploaded, so the renderer cuts this
// square first and keeps it as half floats: 8 MB at 1024², against 16 MB as
// floats, with 11 bits of precision, enough for ratios between neighbours.

import { encodeHalf, halfToFloat32 } from "@/raw/half-float";

export const SOURCE_SAMPLE_EDGE = 1024;

export interface SourceSample {
  /** RGBA, rows top-down, linear Rec.709 as decoded: white balance applied,
   *  before the baseline tone and before any edit. Alpha is 1. */
  data: Float32Array;
  width: number;
  height: number;
  /** Where the sample sits in the decoded frame, in that frame's pixels. */
  x: number;
  y: number;
  /** The decoded frame's size. */
  sourceWidth: number;
  sourceHeight: number;
}

/** A SourceSample as the renderer keeps it: the same record over half floats. */
export type StoredSample = Omit<SourceSample, "data"> & { data: Uint16Array };

/** A cached develop preview as the renderer takes it: the stored half floats,
 *  the decoded frame's size when the entry kept it (3.1.0 and later), its
 *  centre sample when the load asked for it (load-image.ts `sample`), and the
 *  camera baseline's exposure and shadows lift when it has them (the photo's
 *  camera match, else its maker's offset: baselineExposureFor). */
export interface Float16Source {
  kind: "float16";
  data: Uint16Array;
  width: number;
  height: number;
  fullWidth?: number;
  fullHeight?: number;
  sample?: StoredSample;
  baselineExposure?: number;
  baselineShadows?: number;
}

/** The centre of the frame, up to SOURCE_SAMPLE_EDGE on each side (a side
 *  shorter than that is kept whole), with the odd pixel rounded down. */
export function sampleRect(width: number, height: number): { x: number; y: number; w: number; h: number } {
  const w = Math.min(SOURCE_SAMPLE_EDGE, width);
  const h = Math.min(SOURCE_SAMPLE_EDGE, height);
  return { x: Math.floor((width - w) / 2), y: Math.floor((height - h) / 2), w, h };
}

/** Cut the sample out of an RGBA float frame of `width` × `height`. */
export function cutSourceSample(data: Float32Array, width: number, height: number): StoredSample {
  const { x, y, w, h } = sampleRect(width, height);
  const out = new Float32Array(w * h * 4);
  for (let row = 0; row < h; row++) {
    const from = ((y + row) * width + x) * 4;
    out.set(data.subarray(from, from + w * 4), row * w * 4);
  }
  return { data: encodeHalf(out), width: w, height: h, x, y, sourceWidth: width, sourceHeight: height };
}

export function unpackSourceSample(stored: StoredSample): SourceSample {
  return { ...stored, data: halfToFloat32(stored.data) };
}
