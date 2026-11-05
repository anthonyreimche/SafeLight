// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { CropRect } from "@/catalog/types";
import type { ImageSpaceMatrix, ProcessingStageContribution } from "@/extensions/types";
import { mat3Invert, mat3Mul, type Mat3 } from "./transform";

// The photo's geometry, as the geometry stage (Crop & Straighten's) derives
// it: the region of the transformed image a frame shows, and the matrix from
// the transformed image to the source. Core sizes frames from the region and
// maps canvas points through both. The matrix's aspect-dependent part is
// finished here, where the image's aspect is known: in the worker for every
// frame, on the main thread for the live photo.

const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export const WHOLE_IMAGE: CropRect = { x: 0, y: 0, width: 1, height: 1 };

const isMat3 = (v: unknown): v is Mat3 =>
  Array.isArray(v) && v.length === 9 && v.every((n) => typeof n === "number" && Number.isFinite(n));

export function isImageSpaceMatrix(v: unknown): v is ImageSpaceMatrix {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const m = v as Partial<ImageSpaceMatrix>;
  return isMat3(m.square) && isMat3(m.normalized);
}

/** Image coordinates to square space and back, for an image of `aspect`. */
export function squareBasis(aspect: number): [Mat3, Mat3] {
  const A: Mat3 = [aspect, 0, -0.5 * aspect, 0, 1, -0.5, 0, 0, 1];
  const Ainv: Mat3 = [1 / aspect, 0, 0.5, 0, 1, 0.5, 0, 0, 1];
  return [A, Ainv];
}

/** `m` as one matrix on image coordinates of an image of `aspect`. */
export function imageSpaceMatrix(m: ImageSpaceMatrix, aspect: number): Mat3 {
  const [A, Ainv] = squareBasis(aspect);
  return mat3Mul(Ainv, mat3Mul(m.square as Mat3, mat3Mul(A, m.normalized as Mat3)));
}

/** The size of a frame of `region` of a `width`×`height` source: the
 *  region's own pixels, scaled down so the long edge is at most `maxEdge`,
 *  and never below one pixel. */
export function regionOutputSize(
  width: number,
  height: number,
  region: CropRect,
  maxEdge: number,
): { width: number; height: number } {
  const cw = width * region.width;
  const ch = height * region.height;
  const longEdge = Math.max(cw, ch);
  const scale = longEdge > 0 ? Math.min(1, maxEdge / longEdge) : 1;
  return {
    width: Math.max(1, Math.round(cw * scale)),
    height: Math.max(1, Math.round(ch * scale)),
  };
}

/** The bag keys of the geometry stage's region and matrix. */
export interface GeometryKeys {
  region: string;
  inverse: string;
}

/** The geometry stage's keys among `stages`, or null when none declares it. */
export function geometryKeys(stages: readonly ProcessingStageContribution[]): GeometryKeys | null {
  const stage = stages.find((s) => s.geometry);
  if (!stage?.geometry) return null;
  return {
    region: `${stage.id}.${stage.geometry.region}`,
    inverse: `${stage.id}.${stage.geometry.inverse}`,
  };
}

export interface ImageGeometry {
  /** The region of the transformed image a frame shows. */
  region: CropRect;
  /** Transformed image to source, and back, in image coordinates. */
  inverse: Mat3;
  forward: Mat3;
}

const regionOf = (v: unknown): CropRect | null =>
  Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === "number" && Number.isFinite(n))
    ? { x: v[0], y: v[1], width: v[2], height: v[3] }
    : null;

/** The geometry `bag` holds for an image of `aspect`: the whole image,
 *  unchanged, without a geometry stage or its values. */
export function imageGeometry(
  bag: Readonly<Record<string, unknown>>,
  keys: GeometryKeys | null,
  aspect: number,
): ImageGeometry {
  const region = (keys && regionOf(bag[keys.region])) ?? WHOLE_IMAGE;
  const held = keys ? bag[keys.inverse] : undefined;
  const inverse = isImageSpaceMatrix(held) ? imageSpaceMatrix(held, aspect) : IDENTITY;
  return { region, inverse, forward: mat3Invert(inverse) };
}
