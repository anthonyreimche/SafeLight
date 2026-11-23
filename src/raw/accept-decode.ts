// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Whether a full RAW decode may be shown and whether it may be remembered.
// Develop's load and the background pre-decode both ask, so a bad decode is
// kept out of the develop-preview cache by either. The same look at the
// camera's preview gives the photo its camera match (camera-match.ts). A leaf
// module on purpose: the importers' tests replace it wholesale, which only
// works while it pulls in nothing from the app beyond that arithmetic and the
// preview's sample (preview-sample.ts, a leaf too).

import { cameraMatch, lumaSamples, type CameraMatch } from "./camera-match";
import { samplePreview, type LinearPixels, type PreviewSample } from "./preview-sample";

export interface DecodeVerdict {
  /** The decode's colours agree with the camera's own preview. */
  use: boolean;
  /** `use`, and the decode is not marginal (inferred dimensions). */
  cache: boolean;
  /** For a decode it uses: the camera match against the preview. Absent
   *  without a preview, or with one that gives no usable match. */
  match?: CameraMatch;
}

type Pixels = LinearPixels;

/**
 * `upright` is the decode as it would be cached (already turned); `preview` the
 * embedded JPEG, or null when the camera stored none (the decode is trusted).
 * `sampled` is that preview's sample when the caller began it while the RAW
 * was still decoding (preview-sample.ts); without it the preview is read here.
 */
export async function acceptDecode(
  decode: { suspicious?: boolean },
  upright: Pixels,
  preview: Blob | null,
  sampled?: PreviewSample,
): Promise<DecodeVerdict> {
  const sample = preview ? await (sampled ?? samplePreview(preview)) : null;
  const use = !sample || rawColorMatchesPreview(upright, sample);
  const verdict: DecodeVerdict = { use, cache: use && !decode.suspicious };
  if (use && sample) {
    const match = cameraMatch(lumaSamples(upright), lumaSamples(sample));
    if (match) verdict.match = match;
  }
  return verdict;
}

/** The camera match between `scene`, scene-linear luminance samples of a decode
 *  (camera-match.ts lumaSamples, halfLumaSamples), and the camera's preview.
 *  Undefined when the preview can't be read or gives no usable match. */
export async function matchCameraPreview(scene: Float32Array, preview: Blob): Promise<CameraMatch | undefined> {
  const sample = await samplePreview(preview);
  return sample ? cameraMatch(scene, lumaSamples(sample)) : undefined;
}

export interface ChannelMeans {
  r: number;
  g: number;
  b: number;
}

export interface BalanceComparison {
  /** R/G and B/G of each image. */
  rawRG: number;
  preRG: number;
  rawBG: number;
  preBG: number;
  /** How far apart the two R/G (and B/G) ratios are, as a factor of at least 1. */
  rgFactor: number;
  bgFactor: number;
  ok: boolean;
}

/**
 * Compares two images' R/G and B/G balance and flags a mismatch when either
 * ratio differs by 2x or more. That catches the LibRaw <0.21 Canon EOS R bug
 * (wrong colour matrix, badly shifted R/B gains) without rejecting legitimate
 * warm or cool shots. A preview channel that reads back empty or not as a
 * number leaves nothing to compare against, so the decode stands: some Mesa
 * drivers read every pixel back as zero, which says nothing about the decode.
 */
/** The decode's channels that are negative in a good share of its pixels:
 *  colour outside sRGB (the deep blue of a stage light carries negative red),
 *  which the decode keeps and the camera's JPEG maps into its gamut. Their
 *  means then say nothing of the decode's balance. */
export type OutOfGamut = ReadonlySet<"r" | "g" | "b">;

// The share of sampled pixels a channel must be negative in to count. Across the
// sample RAWs it was at most 9.4 %; a deep blue Nikon D7000 frame whose decode
// darktable renders the same has 35 % of its red negative.
const OUT_OF_GAMUT_SHARE = 0.2;

export function compareBalance(
  raw: ChannelMeans,
  preview: ChannelMeans,
  outOfGamut?: OutOfGamut,
): BalanceComparison {
  const rg = raw.g || 1e-6;
  const pg = preview.g || 1e-6;

  const rawRG = raw.r / rg, preRG = preview.r / pg;
  const rawBG = raw.b / rg, preBG = preview.b / pg;

  const rgFactor = Math.max(rawRG / preRG, preRG / rawRG);
  const bgFactor = Math.max(rawBG / preBG, preBG / rawBG);
  const comparable = [preview.r, preview.g, preview.b].every((m) => Number.isFinite(m) && m > 0);
  // A ratio with a channel the decode holds outside sRGB is left out (see
  // OutOfGamut).
  const rgOk = rgFactor < 2.0 || !!outOfGamut?.has("r") || !!outOfGamut?.has("g");
  const bgOk = bgFactor < 2.0 || !!outOfGamut?.has("b") || !!outOfGamut?.has("g");
  const ok = !comparable || (rgOk && bgOk);
  return { rawRG, preRG, rawBG, preBG, rgFactor, bgFactor, ok };
}

// Compare the decoded RAW float image's channel balance against the embedded
// JPEG preview's sample (the camera's own rendering — always colour-correct).
// Returns true when the decode looks plausible, false when it should be rejected.
function rawColorMatchesPreview(raw: Pixels, pf: Pixels): boolean {
  // Mean R/G/B of the JPEG preview (linear after inverse-sRGB in bitmapToFloat).
  let pR = 0, pG = 0, pB = 0;
  for (let i = 0; i < pf.data.length; i += 4) {
    pR += pf.data[i]; pG += pf.data[i + 1]; pB += pf.data[i + 2];
  }
  const pN = pf.data.length / 4;

  // Mean R/G/B of the RAW decode, sampled at a stride to keep it fast, and how
  // many of the samples each channel is negative in.
  const n = raw.width * raw.height;
  const step = Math.max(1, Math.floor(n / 4096));
  let rR = 0, rG = 0, rB = 0, rN = 0;
  let nR = 0, nG = 0, nB = 0;
  for (let i = 0; i < n * 4; i += step * 4) {
    rR += raw.data[i]; rG += raw.data[i + 1]; rB += raw.data[i + 2]; rN++;
    if (raw.data[i] < 0) nR++;
    if (raw.data[i + 1] < 0) nG++;
    if (raw.data[i + 2] < 0) nB++;
  }

  if (!rN || !pN) return true;
  const outOfGamut = new Set(
    ([["r", nR], ["g", nG], ["b", nB]] as const).flatMap(([c, k]) => (k >= OUT_OF_GAMUT_SHARE * rN ? [c] : [])),
  );
  const balance = compareBalance(
    { r: rR / rN, g: rG / rN, b: rB / rN },
    { r: pR / pN, g: pG / pN, b: pB / pN },
    outOfGamut,
  );

  console.info(
    `[load] RAW vs JPEG — R/G: ${balance.rawRG.toFixed(2)} vs ${balance.preRG.toFixed(2)}` +
    ` (×${balance.rgFactor.toFixed(2)}),` +
    ` B/G: ${balance.rawBG.toFixed(2)} vs ${balance.preBG.toFixed(2)}` +
    ` (×${balance.bgFactor.toFixed(2)})`,
  );

  return balance.ok;
}
