// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Frames as floats for extensions (api.develop.captureFloatFrame). The
// renderer draws a frame at a capture point as perceptual Rec.709, the display
// working values, and converts it into the space the extension asked for on
// the GPU, so neither the worker nor the main thread does work per pixel.

import type { StageSpace } from "@/extensions/types";

/** "pre-output": the signed colour every stage has finished with, as the
 *  output stage receives it. "output": what the output stage makes of it in
 *  sRGB, in [0, 1]. "scene": the scene-linear colour the display transform
 *  receives, signed, before any display tool. The core shoulder has already
 *  compressed its highlights wherever it runs: always on version 1, and on
 *  version 2 and later unless the photo's display transform sets
 *  `skipToneShoulder`; elsewhere it is unclamped. */
export type CapturePoint = "pre-output" | "output" | "scene";

export interface FloatCaptureOptions {
  /** Default DEFAULT_CAPTURE_SPACE. */
  space?: StageSpace;
  /** Default "pre-output". */
  point?: CapturePoint;
  /** Merged over the photo's extension-stage params for this capture only. */
  paramBag?: Record<string, unknown>;
}

/** What a live capture (api.develop.captureFloatFrame) takes: the options of
 *  any float frame, and the size it is read at. renderPhotoFloatFrame's
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

/** The long edge a live capture is read at unless asked for another. At fit
 *  the view is the Develop render resolution, 4096 px by default, whose
 *  floats take about 180 MB to read back. */
export const DEFAULT_CAPTURE_MAX_EDGE = 1280;

/** A capture's `maxEdge` as it is read: floored and at least 1, Infinity as
 *  it is, and the default for anything but a positive number, which a
 *  plain-JS extension can pass. */
export function captureMaxEdge(maxEdge: number | undefined): number {
  return typeof maxEdge === "number" && maxEdge > 0 ? Math.max(1, Math.floor(maxEdge)) : DEFAULT_CAPTURE_MAX_EDGE;
}

/** The size a width×height frame is read at for a capture: scaled evenly so
 *  its long edge is at most `maxEdge` (validated by captureMaxEdge), never scaled
 *  up, each side rounded and at least 1 px. */
export function measureSize(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const scale = Math.min(1, captureMaxEdge(maxEdge) / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

