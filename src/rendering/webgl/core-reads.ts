// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { LOCAL_TONE_GLSL } from "../local-tone";
import type { ShaderVariant } from "./shaders";

// Names core's own program reads that a tool's stage declares, now that the
// tools are extensions (#178). Each comes with a neutral stand-in: while no
// stage declares the name, the injection defines it as the stand-in, so the
// program still compiles and reads the tool as off. With the stage installed
// nothing is written, and the program is the one the tool's line builds.

type CoreRead = (
  | {
      standIn: string;
      /** A function's parameter list: the name stands in as a function-like
       *  macro. */
      params?: string;
    }
  /** An array core indexes stands in as its own declaration, a uniform left
   *  at zero: a define can't be indexed. */
  | { declaration: string }
) & {
  /** The first process version whose program reads the name; a define
   *  before it would change a frozen program its line doesn't declare it in. */
  since?: 2;
};

export const TOOL_NAME_STAND_INS: Readonly<Record<string, CoreRead>> = {
  // White Balance's sliders, which local tone (local-tone.ts) applies to its
  // region taps so they match the pixel. At the as-shot temperature and no
  // tint applyWhiteBalance changes nothing.
  uTemperature: { standIn: "uAsShotTemperature" },
  uTint: { standIn: "0.0" },
  // Basic's presence sliders, whose amounts main() declares ahead of every
  // anchor.
  uTexture: { standIn: "0.0" },
  uClarity: { standIn: "0.0" },
  uDehaze: { standIn: "0.0" },
  // What Basic's tone block took off a pixel's luminance with the default
  // shoulder, which version 2's slSceneLuma puts back. The block declares it.
  slShoulderGain: { standIn: "1.0", since: 2 },
  // Detail's sharpening preview, which main()'s preview output draws while an
  // Alt/Ctrl-drag preview is on. The sharpening block declares it.
  sharpenViz: { standIn: "0.0" },
  // Crop & Straighten's geometry, which main() maps the view through: the
  // view itself, the whole image unchanged. Its stage's helpers declare it.
  cropTransformUV: { standIn: "(o)", params: "(o)" },
  // Heal's spots, which main() and the patch pass patch the source with:
  // none, the source as it is. Its stage declares them.
  applyRetouch: { standIn: "(base)", params: "(uv, base)" },
  uSpotCount: { standIn: "0" },
  uRetouchCount: { standIn: "0" },
  // Masking's masks, which main()'s two mask loops and the mask maths read:
  // none. Its stage declares them.
  uMaskCount: { standIn: "0" },
  uCompCount: { standIn: "0" },
  compCoverage: { standIn: "(0.0)", params: "(i, uv, px, pxL)" },
  uCompMaskIdx: { declaration: "uniform int uCompMaskIdx[MAX_COMPONENTS];" },
  uCompMode: { declaration: "uniform int uCompMode[MAX_COMPONENTS];" },
  uMaskInvert: { declaration: "uniform int uMaskInvert[MAX_MASKS];" },
  uMaskOpacity: { declaration: "uniform float uMaskOpacity[MAX_MASKS];" },
  uMaskAdj0: { declaration: "uniform vec4 uMaskAdj0[MAX_MASKS];" },
  uMaskAdj1: { declaration: "uniform vec4 uMaskAdj1[MAX_MASKS];" },
  uMaskAdj2: { declaration: "uniform vec4 uMaskAdj2[MAX_MASKS];" },
  uMaskAdj3: { declaration: "uniform vec4 uMaskAdj3[MAX_MASKS];" },
  uMaskHasHsl: { declaration: "uniform int uMaskHasHsl[MAX_MASKS];" },
  uMaskHsl: { declaration: "uniform vec4 uMaskHsl[MAX_MASKS * 6];" },
  uMaskHasCurve: { declaration: "uniform int uMaskHasCurve[MAX_MASKS];" },
  uMaskCurves: { declaration: "uniform sampler2D uMaskCurves;" },
  uMaskHasDisplay: { declaration: "uniform int uMaskHasDisplay[MAX_MASKS];", since: 2 },
};

const STAND_IN_DECLARATIONS: ReadonlySet<string> = new Set(
  Object.values(TOOL_NAME_STAND_INS).flatMap((read) => ("declaration" in read ? [read.declaration] : [])),
);

/** Whether a line of the injected uniforms is one of core's stand-ins. */
export const isStandIn = (line: string): boolean => line.startsWith("#define ") || STAND_IN_DECLARATIONS.has(line);

/** Whether one of `blocks` (anchored blocks, written into main() as they
 *  read, and the helpers of stages written with raw names) declares `name`. */
const blockDeclares = (blocks: readonly string[], name: string): boolean => {
  const declaration = new RegExp(`\\b(?:float|int|bool|[iu]?vec[234])\\s+${name}\\b`);
  return blocks.some((glsl) => declaration.test(glsl));
};

// What version 2's template declares that a version 1 program lacks, which a
// later line's block calls: Basic's line 2 and 3 tone block runs the local
// tone curves and region base, and the camera match's shadows lift. An
// installed release renders every photo with its one text, so a version 1
// program carrying such a block gets them, standing for what version 1 does:
// no camera refit, gain or shadows lift. With line 1 installed nothing is
// written, and version 1's program stays frozen.
const V2_HELPER_READS =
  /\b(?:slToneHighlights|slToneShadows|slLocalToneBase|slPathToWhite|slBaselineRefit|uBaselineGain|uBaselineShadows)\b/;

/** The defines and helpers a `variant` program needs for `blocks` that read
 *  version 2's helpers. */
export function laterLineReads(
  blocks: readonly string[],
  variant: ShaderVariant,
): { defines: string[]; helpers: string[] } {
  if (variant.fullInfo || !blocks.some((glsl) => V2_HELPER_READS.test(glsl))) return { defines: [], helpers: [] };
  return {
    defines: ["#define slBaselineRefit(x) (x)", "#define uBaselineGain 1.0", "#define uBaselineShadows 0.0"],
    helpers: [LOCAL_TONE_GLSL],
  };
}

/** The defines and declarations that stand in, in a `variant` program, for
 *  the names neither `declared` (the bound uniforms and textures) nor one of
 *  `blocks` declares. */
export function standIns(declared: ReadonlySet<string>, blocks: readonly string[], variant: ShaderVariant): string[] {
  return Object.entries(TOOL_NAME_STAND_INS)
    .filter(([, read]) => variant.version >= (read.since ?? 1))
    .filter(([name]) => !declared.has(name) && !blockDeclares(blocks, name))
    .map(([name, read]) =>
      "declaration" in read ? read.declaration : `#define ${name}${read.params ?? ""} ${read.standIn}`,
    );
}
