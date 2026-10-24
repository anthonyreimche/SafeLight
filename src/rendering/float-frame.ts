// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Frames as floats for extensions (api.develop.captureFloatFrame). The
// renderer reads a frame at a capture point as perceptual Rec.709, the display
// working values, and the worker converts it into the space the extension
// asked for before transferring it, so the main thread does no work on it.

import type { StageSpace } from "@/extensions/types";
import { REC709_TO_REC2020, decodePerceptual, encodePerceptual, isIdentitySpace } from "./stage-space";

/** "pre-output": the signed colour every stage has finished with, as the
 *  output stage receives it. "output": what the output stage makes of it in
 *  sRGB, in [0, 1]. */
export type CapturePoint = "pre-output" | "output";

export interface FloatCaptureOptions {
  /** Default DEFAULT_CAPTURE_SPACE. */
  space?: StageSpace;
  /** Default "pre-output". */
  point?: CapturePoint;
  /** Merged over the photo's extension-stage params for this capture only. */
  paramBag?: Record<string, unknown>;
}

/** What a live capture (api.develop.captureFloatFrame) takes: the options of
 *  any float frame, and the size it is drawn at. renderPhotoFloatFrame's
 *  thumbnail frames take no edge, so they stay FloatCaptureOptions. */
export type LiveFloatCaptureOptions = FloatCaptureOptions & {
  /** The frame's long edge in pixels, as captureMaxEdge reads it. */
  maxEdge?: number;
};

/** A frame as floats: RGBA, top-down, in `space`. Alpha is 1. */
export interface FloatFrame {
  data: Float32Array;
  width: number;
  height: number;
  space: StageSpace;
  point: CapturePoint;
}

export const DEFAULT_CAPTURE_SPACE: StageSpace = { encoding: "linear", primaries: "rec709" };

/** The long edge a live capture is drawn at unless asked for another. At fit
 *  the view is the Develop render resolution, 4096 px by default, whose
 *  floats take about 180 MB and a second of the worker's time to convert. */
export const DEFAULT_CAPTURE_MAX_EDGE = 1280;

/** A capture's `maxEdge` as it is drawn: floored and at least 1, Infinity as
 *  it is, and the default for anything but a positive number, which a
 *  plain-JS extension can pass. */
export function captureMaxEdge(maxEdge: number | undefined): number {
  return typeof maxEdge === "number" && maxEdge > 0 ? Math.max(1, Math.floor(maxEdge)) : DEFAULT_CAPTURE_MAX_EDGE;
}

/** The size a width×height frame is drawn at for a capture: scaled evenly so
 *  its long edge is at most `maxEdge` (validated by captureMaxEdge), never scaled
 *  up, each side rounded and at least 1 px. */
export function measureSize(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const scale = Math.min(1, captureMaxEdge(maxEdge) / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** Converts top-down RGBA in perceptual Rec.709 (the display working values) into
 *  `space`, in place, and wraps it. Each pixel comes out as toStageSpace(rgb,
 *  space, "display") would make it, written out here so a frame of millions of
 *  pixels allocates nothing per pixel. */
export function toFloatFrame(
  data: Float32Array, width: number, height: number, space: StageSpace, point: CapturePoint,
): FloatFrame {
  const convert = !isIdentitySpace(space, "display");
  const wide = space.primaries === "rec2020";
  const encode = space.encoding !== "linear";
  const m = REC709_TO_REC2020;
  for (let i = 0; i < data.length; i += 4) {
    data[i + 3] = 1;
    if (!convert) continue;
    const r = decodePerceptual(data[i]);
    const g = decodePerceptual(data[i + 1]);
    const b = decodePerceptual(data[i + 2]);
    const x = wide ? m[0] * r + m[1] * g + m[2] * b : r;
    const y = wide ? m[3] * r + m[4] * g + m[5] * b : g;
    const z = wide ? m[6] * r + m[7] * g + m[8] * b : b;
    data[i] = encode ? encodePerceptual(x) : x;
    data[i + 1] = encode ? encodePerceptual(y) : y;
    data[i + 2] = encode ? encodePerceptual(z) : z;
  }
  return { data, width, height, space, point };
}
