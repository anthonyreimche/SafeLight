// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type {
  DistortionCal,
  LensfunLens,
  ResolvedDistortion,
  ResolvedProfile,
  ResolvedTca,
  ResolvedVignetting,
  TcaCal,
  VignettingCal,
} from "./types";

/**
 * Resolve a Lensfun lens profile for a specific focal length, aperture, and
 * focus distance by interpolating between the calibration entries.
 */
export function resolveProfile(
  lens: LensfunLens,
  focalLength: number,
  aperture: number,
  distance = 1000,
): ResolvedProfile {
  return {
    lensId: lens.id,
    lensName: `${lens.maker} ${lens.model}`,
    distortion: resolveDistortion(lens.distortion, focalLength),
    tca: resolveTca(lens.tca, focalLength),
    vignetting: resolveVignetting(lens.vignetting, focalLength, aperture, distance),
  };
}

// ---------------------------------------------------------------------------
// Distortion: interpolate by focal length
// ---------------------------------------------------------------------------

function resolveDistortion(
  cals: DistortionCal[],
  focal: number,
): ResolvedDistortion | null {
  if (cals.length === 0) return null;
  if (cals.length === 1) return { model: cals[0].model, k: [...cals[0].k] };

  const sorted = [...cals].sort((a, b) => a.focal - b.focal);
  const { lo, hi, t } = bracketByFocal(sorted, focal);
  return {
    model: lo.model,
    k: lerpArray(lo.k, hi.k, t),
  };
}

// ---------------------------------------------------------------------------
// TCA: interpolate by focal length
// ---------------------------------------------------------------------------

function resolveTca(
  cals: TcaCal[],
  focal: number,
): ResolvedTca | null {
  if (cals.length === 0) return null;
  if (cals.length === 1) return { model: cals[0].model, k: [...cals[0].k] };

  const sorted = [...cals].sort((a, b) => a.focal - b.focal);
  const { lo, hi, t } = bracketByFocal(sorted, focal);
  return {
    model: lo.model,
    k: lerpArray(lo.k, hi.k, t),
  };
}

// ---------------------------------------------------------------------------
// Vignetting: bilinear interpolation over (focal, aperture)
// ---------------------------------------------------------------------------

function resolveVignetting(
  cals: VignettingCal[],
  focal: number,
  aperture: number,
  _distance: number,
): ResolvedVignetting | null {
  if (cals.length === 0) return null;
  if (cals.length === 1) return { k: [...cals[0].k] };

  const apertures = [...new Set(cals.map((c) => c.aperture))].sort((a, b) => a - b);
  const focalSet = new Set(cals.map((c) => c.focal));

  if (focalSet.size <= 1 && apertures.length <= 1) {
    return { k: [...cals[0].k] };
  }

  // For single-axis interpolation
  if (apertures.length === 1) {
    const sorted = [...cals].sort((a, b) => a.focal - b.focal);
    const { lo, hi, t } = bracketByField(sorted, focal, (c) => c.focal);
    return { k: lerpArray(lo.k, hi.k, t) as [number, number, number] };
  }

  if (focalSet.size === 1) {
    const sorted = [...cals].sort((a, b) => a.aperture - b.aperture);
    const { lo, hi, t } = bracketByField(sorted, aperture, (c) => c.aperture);
    return { k: lerpArray(lo.k, hi.k, t) as [number, number, number] };
  }

  // Bilinear: interpolate along focal at each of the two nearest apertures,
  // then interpolate between those two results along aperture.
  const { loIdx: aLoIdx, hiIdx: aHiIdx, t: aT } = bracketIndex(apertures, aperture);
  const aLo = apertures[aLoIdx];
  const aHi = apertures[aHiIdx];

  const atApertureLo = interpolateVigByFocal(cals, focal, aLo);
  const atApertureHi = interpolateVigByFocal(cals, focal, aHi);

  return {
    k: lerpArray(atApertureLo, atApertureHi, aT) as [number, number, number],
  };
}

function interpolateVigByFocal(
  cals: VignettingCal[],
  focal: number,
  aperture: number,
): [number, number, number] {
  // Find calibrations at this aperture (or nearest)
  const atAperture = cals.filter((c) => c.aperture === aperture);
  if (atAperture.length === 0) {
    // Fallback: find the nearest aperture
    const nearest = cals.reduce((best, c) =>
      Math.abs(c.aperture - aperture) < Math.abs(best.aperture - aperture) ? c : best,
    );
    return [...nearest.k];
  }

  if (atAperture.length === 1) return [...atAperture[0].k];

  const sorted = [...atAperture].sort((a, b) => a.focal - b.focal);
  const { lo, hi, t } = bracketByField(sorted, focal, (c) => c.focal);
  return lerpArray(lo.k, hi.k, t) as [number, number, number];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bracketByFocal<T extends { focal: number }>(
  sorted: T[],
  focal: number,
): { lo: T; hi: T; t: number } {
  return bracketByField(sorted, focal, (c) => c.focal);
}

function bracketByField<T>(
  sorted: T[],
  value: number,
  field: (item: T) => number,
): { lo: T; hi: T; t: number } {
  if (sorted.length === 1) return { lo: sorted[0], hi: sorted[0], t: 0 };

  const { loIdx, hiIdx, t } = bracketIndex(
    sorted.map(field),
    value,
  );
  return { lo: sorted[loIdx], hi: sorted[hiIdx], t };
}

function bracketIndex(
  sorted: number[],
  value: number,
): { loIdx: number; hiIdx: number; t: number } {
  if (value <= sorted[0]) return { loIdx: 0, hiIdx: 0, t: 0 };
  if (value >= sorted[sorted.length - 1])
    return { loIdx: sorted.length - 1, hiIdx: sorted.length - 1, t: 0 };

  for (let i = 0; i < sorted.length - 1; i++) {
    if (value >= sorted[i] && value <= sorted[i + 1]) {
      const range = sorted[i + 1] - sorted[i];
      const t = range > 0 ? (value - sorted[i]) / range : 0;
      return { loIdx: i, hiIdx: i + 1, t };
    }
  }
  return { loIdx: sorted.length - 1, hiIdx: sorted.length - 1, t: 0 };
}

function lerpArray(a: number[], b: number[], t: number): number[] {
  const len = Math.min(a.length, b.length);
  const out: number[] = [];
  for (let i = 0; i < len; i++) {
    out.push(a[i] + (b[i] - a[i]) * t);
  }
  return out;
}
