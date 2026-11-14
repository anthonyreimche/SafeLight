// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { StageAnchor } from "@/extensions/types";
import type { StageDomain } from "../stage-space";
import { writesRawNames } from "./builtin-stage";

// The anchors in main()'s order, each with the values its stages work on:
// scene-linear `lin` ahead of the display transform, display `c` after it.
// The geometry anchor comes before either: its stage only declares what
// main()'s mapping of the view calls. The retouch anchor, also declarations
// only, follows the contributed geometry stages: main() patches the source
// once it has sampled it, ahead of the noise-reduction stages.
// shaders.ts writes a marker per anchor (anchorMarker), the injection fills it.

/** The injection group whose place in main() an anchor's steps are listed in:
 *  the view's mapping for the geometry, the sampled source for the retouch,
 *  else by domain. */
export type AnchorGroup = "srcUv" | "noiseReduction" | "sceneLinear" | "effects";

export const STAGE_ANCHORS: Readonly<Record<StageAnchor, { readonly domain: StageDomain; readonly group?: AnchorGroup }>> = {
  geometry: { domain: "scene", group: "srcUv" },
  retouch: { domain: "scene", group: "noiseReduction" },
  "white-balance": { domain: "scene" },
  tone: { domain: "scene" },
  masks: { domain: "scene" },
  "display-basic": { domain: "display" },
  "tone-curve": { domain: "display" },
  hsl: { domain: "display" },
  presence: { domain: "display" },
  "band-detail": { domain: "display" },
  vibrance: { domain: "display" },
  "color-grading": { domain: "display" },
  sharpen: { domain: "display" },
};

export const isStageAnchor = (value: unknown): value is StageAnchor =>
  typeof value === "string" && Object.hasOwn(STAGE_ANCHORS, value);

/** The comment shaders.ts leaves where an anchor's stages go. */
export const anchorMarker = (anchor: StageAnchor): string =>
  `//__ANCHOR_${anchor.toUpperCase().replace(/-/g, "_")}__`;

/** The anchor a stage runs at: one it names, if it is Safelight's own or an
 *  official extension's. */
export function anchorOf(
  s: { id: string; anchor?: unknown; extensionId?: unknown },
): StageAnchor | undefined {
  return isStageAnchor(s.anchor) && writesRawNames(s) ? s.anchor : undefined;
}

/** The anchors any extension's stage may name (3.2.5): the tone anchor, ahead
 *  of the tone block (Basic's exposure, curves and the default shoulder), so
 *  an exposure tool can work before the tone mapping. */
export const OPEN_ANCHORS: ReadonlySet<StageAnchor> = new Set<StageAnchor>(["tone"]);

/** The open anchor an extension's stage runs at, as its own namespaced block;
 *  Safelight's and the official extensions' stages go through anchorOf. */
export function openAnchorOf(
  s: { id: string; anchor?: unknown; extensionId?: unknown },
): StageAnchor | undefined {
  return isStageAnchor(s.anchor) && OPEN_ANCHORS.has(s.anchor) && !writesRawNames(s) ? s.anchor : undefined;
}
