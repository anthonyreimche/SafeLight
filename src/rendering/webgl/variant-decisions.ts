// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The renderer's per-process-version decisions, kept out of the draw code so a
// newer version cannot change an older one's behaviour unnoticed
// (variant-decisions.test.ts pins each).

import type { ShaderVariant } from "./shaders";

// Storage of the retouched frame's patched copy of the source. Only "float16"
// keeps values outside [0, 1]; "norm16" (EXT_texture_norm16) and "rgba8" clip.
export type DevelopedFormat = "rgba8" | "norm16" | "float16";

/** Whether the core tone shoulder runs. Only version 2 and later give it up
 *  when the transform skips it: an older edit keeps its look when a transform
 *  starts setting skipToneShoulder. */
export function toneShoulderOn(variant: ShaderVariant, skipShoulder: boolean): boolean {
  return !(skipShoulder && variant.fullInfo);
}

/** The format the patched copy wants, given what the context can render.
 *  Version 1 photos keep the clipped copy their edits were made with, so they
 *  never take float16; the renderer steps down from this when an allocation
 *  fails. */
export function developedFormatFor(
  variant: ShaderVariant,
  caps: { float16: boolean; norm16: boolean },
): DevelopedFormat {
  if (variant.fullInfo && caps.float16) return "float16";
  return caps.norm16 ? "norm16" : "rgba8";
}

/** The overlay bits the program may see. Bit 2, the gamut warning, is version
 *  3's: an older program takes any bit as overlay on, which would hide the mask
 *  hover tint for nothing. */
export function clippingBits(variant: ShaderVariant): number {
  return variant.signedOutput ? 7 : 3;
}
