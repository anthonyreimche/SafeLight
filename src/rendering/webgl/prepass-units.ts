// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Texture units for the develop program's samplers. The shader owns 0 (image),
// 1 (curve), 2 (mask), 3 (retouch), 4 (developed) and 6 (mask curves), and uses
// 7 as transient scratch. Extension stage textures (baked LUT atlases, etc.)
// bind from 12 up, at most four of them.
//
// Prepass results take every other unit. MAX_TEXTURE_IMAGE_UNITS (16 on ANGLE)
// limits how many samplers a shader declares, not which unit one reads: a unit
// only has to be below MAX_COMBINED_TEXTURE_IMAGE_UNITS, which WebGL2 puts at 32
// or more. Five units used to be the whole budget, and a sixth active stage read
// another stage's result instead of its own (SafeLight #155). A version 2
// program whose stages would pass the sampler limit reads their results from one
// array instead (stage-result-layers.ts), which takes the first of these units;
// the rest serve stages that keep a sampler of their own.

export const STAGE_TEX_UNIT_BASE = 12;
export const MAX_STAGE_TEXTURES = 4;

/** The units official stages' per-photo textures (TextureRequirement "photo"
 *  and "atlas") bind at, in order: the ones the program bound those tables at
 *  itself before the tools left core, so extensions keep all four of theirs.
 *  Unit 1 held the tone curve's table, unit 3 the heal's brush atlas, unit 6
 *  the masks' curve atlas. Counted among DEVELOP_SAMPLERS. */
export const PHOTO_TEX_UNITS: readonly number[] = [1, 3, 6];

/** The samplers the develop shader declares before any stage adds its own:
 *  uImage, uCurve, uMaskTex, uRetouchTex, uDevelopedSrc and uMaskCurves. What
 *  MAX_TEXTURE_IMAGE_UNITS leaves past them is the stages' sampler budget. */
export const DEVELOP_SAMPLERS = 6;

// The four long-standing prepass units, then unit 5, so their numbers stay put.
const FIRST_PREPASS_UNITS: readonly number[] = [8, 9, 10, 11, 5];

/** The units prepass results may take, in the order stages are handed them, on a
 *  context with `combinedUnits` texture units whose stage textures take
 *  `stageTextures` units from STAGE_TEX_UNIT_BASE. */
export function prepassUnits(combinedUnits: number, stageTextures: number): number[] {
  // Photo textures past PHOTO_TEX_UNITS bind right after the stage textures,
  // so the count can pass MAX_STAGE_TEXTURES.
  const firstFree = STAGE_TEX_UNIT_BASE + stageTextures;
  const units = [...FIRST_PREPASS_UNITS];
  for (let unit = firstFree; unit < combinedUnits; unit++) units.push(unit);
  return units;
}
