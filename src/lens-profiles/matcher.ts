// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { ExifData } from "@/catalog/types";
import type { LensfunLens, ResolvedProfile } from "./types";
import { resolveProfile } from "./interpolate";

// Manufacturer names in EXIF vary wildly. Map common variants to Lensfun's
// canonical names so we can pre-filter by maker before fuzzy-matching.
const MAKER_ALIASES: Record<string, string> = {
  "nikon corporation": "Nikon",
  "canon inc.": "Canon",
  "canon": "Canon",
  "sony corporation": "Sony",
  "sony": "Sony",
  "fujifilm": "Fujifilm",
  "fujifilm corporation": "Fujifilm",
  "olympus corporation": "Olympus",
  "olympus": "Olympus",
  "om digital solutions": "Olympus",
  "panasonic": "Panasonic",
  "sigma": "Sigma",
  "sigma corporation": "Sigma",
  "tamron": "Tamron",
  "tamron co.,ltd.": "Tamron",
  "samyang": "Samyang",
  "samyang optics": "Samyang",
  "leica": "Leica",
  "leica camera ag": "Leica",
  "carl zeiss": "Zeiss",
  "zeiss": "Zeiss",
  "hasselblad": "Hasselblad",
  "ricoh": "Ricoh",
  "pentax": "Pentax",
  "pentax corporation": "Pentax",
  "apple": "Apple",
  "samsung": "Samsung",
  "tokina": "Tokina",
  "voigtlander": "Voigtlander",
  "cosina": "Voigtlander",
};

function canonicalMaker(raw: string): string {
  const key = raw.trim().toLowerCase();
  return MAKER_ALIASES[key] ?? raw.trim();
}

interface MatchResult {
  lens: LensfunLens;
  score: number;
}

/**
 * Find the best matching Lensfun lens for the given EXIF data.
 * Returns null if no reasonable match is found.
 */
export function matchLens(
  exif: ExifData,
  db: LensfunLens[],
): LensfunLens | null {
  if (!exif.lens) return null;

  const exifLens = normalize(exif.lens);
  const exifMaker = exif.lensMake ? canonicalMaker(exif.lensMake) : null;

  let best: MatchResult | null = null;

  for (const lens of db) {
    const dbModel = normalize(lens.model);
    const dbMaker = canonicalMaker(lens.maker);

    // Exact match on normalized model string
    if (exifLens === dbModel) {
      return lens;
    }

    // Maker filter: if we know the EXIF maker, skip lenses from other makers
    if (exifMaker && dbMaker.toLowerCase() !== exifMaker.toLowerCase()) {
      continue;
    }

    // Token-based fuzzy match
    const score = tokenScore(exifLens, dbModel);
    if (score < 0.5) continue;

    // Bonus: focal length range match
    let focalBonus = 0;
    if (exif.focalLength && lens.focalMin > 0 && lens.focalMax > 0) {
      if (exif.focalLength >= lens.focalMin && exif.focalLength <= lens.focalMax) {
        focalBonus = 0.1;
      }
    }

    const total = score + focalBonus;
    if (!best || total > best.score) {
      best = { lens, score: total };
    }
  }

  return best && best.score >= 0.6 ? best.lens : null;
}

/**
 * Resolve a full profile for a photo: match the lens from EXIF, then
 * interpolate calibration data for the shot's focal/aperture/distance.
 */
export function resolveForPhoto(
  exif: ExifData,
  db: LensfunLens[],
): { lens: LensfunLens; profile: ResolvedProfile } | null {
  const lens = matchLens(exif, db);
  if (!lens) return null;

  const focal = exif.focalLength ?? lens.focalMin;
  const aperture = exif.aperture ?? lens.apertureMin;
  const distance = exif.subjectDistance ?? 1000;

  const profile = resolveProfile(lens, focal, aperture, distance);
  return { lens, profile };
}

// ---------------------------------------------------------------------------
// String matching helpers
// ---------------------------------------------------------------------------

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\w\s.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(s: string): string[] {
  return s.split(/\s+/).filter((t) => t.length > 0);
}

function tokenScore(exifNorm: string, dbNorm: string): number {
  const exifTokens = tokenize(exifNorm);
  const dbTokens = tokenize(dbNorm);
  if (exifTokens.length === 0) return 0;

  let matched = 0;
  for (const et of exifTokens) {
    if (dbTokens.some((dt) => dt === et || dt.includes(et) || et.includes(dt))) {
      matched++;
    }
  }
  return matched / exifTokens.length;
}
