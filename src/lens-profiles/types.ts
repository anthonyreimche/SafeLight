// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { ExifData } from "@/catalog/types";

// ---------------------------------------------------------------------------
// Lensfun database record types (mirrors the JSON converted from Lensfun XML)
// ---------------------------------------------------------------------------

export type DistortionModel = "poly3" | "poly5" | "ptlens";
export type TcaModel = "linear" | "poly3";

export interface DistortionCal {
  focal: number;
  model: DistortionModel;
  /** poly3: [k1], poly5: [k1,k2], ptlens: [a,b,c] */
  k: number[];
}

export interface TcaCal {
  focal: number;
  model: TcaModel;
  /** linear: [kr,kb], poly3: [br,cr,dr, bb,cb,db] */
  k: number[];
}

export interface VignettingCal {
  focal: number;
  aperture: number;
  distance: number;
  k: [number, number, number];
}

export interface LensfunLens {
  id: string;
  maker: string;
  model: string;
  mounts: string[];
  cropFactor: number;
  type: string;
  focalMin: number;
  focalMax: number;
  apertureMin: number;
  apertureMax: number;
  distortion: DistortionCal[];
  tca: TcaCal[];
  vignetting: VignettingCal[];
}

// ---------------------------------------------------------------------------
// Resolved profile — the interpolated coefficients ready for the shader
// ---------------------------------------------------------------------------

export interface ResolvedDistortion {
  model: DistortionModel;
  /** poly3: [k1], poly5: [k1,k2], ptlens: [a,b,c] */
  k: number[];
}

export interface ResolvedTca {
  model: TcaModel;
  /** linear: [kr,kb], poly3: [br,cr,dr, bb,cb,db] */
  k: number[];
}

export interface ResolvedVignetting {
  k: [number, number, number];
}

export interface ResolvedProfile {
  lensId: string;
  lensName: string;
  distortion: ResolvedDistortion | null;
  tca: ResolvedTca | null;
  vignetting: ResolvedVignetting | null;
}

// ---------------------------------------------------------------------------
// Extension API: lens profile contribution
// ---------------------------------------------------------------------------

export interface LensProfileContribution {
  id: string;
  lensMake: string;
  lensModel: string;
  /** >0 overrides Lensfun, <=0 is fallback. Default 0. */
  priority?: number;
  resolve(exif: ExifData): ResolvedProfile | null;
}
