// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The cache key of a split draw: everything upstream of its cut. A split is a
// full develop draw at prepass size, so it must not run again when only the
// stage's own inline params, a downstream stage, the crop or an output-frame
// effect changed.

import type { DevelopParams, Mask, MaskAdjustments } from "@/catalog/types";
import type { SplitCut, StageSplit } from "./stage-injection";

export interface SplitUpstreamInputs {
  params: DevelopParams;
  /** Where the split stops the program (StageSplit.cut). */
  cut: SplitCut;
  /** The renderer's contributed param bag; untyped because extensions
   *  define its values at runtime. */
  bag: Record<string, unknown>;
  /** Stages whose params and textures feed the cut, in pipeline order. */
  upstreamStageIds: readonly string[];
  /** Stage texture versions by qualified key. */
  textureVersions: Record<string, number>;
  /** Renderer-level state folded into scene and display cuts verbatim:
   *  transform, process version, HSL style, as-shot white balance, core NR on
   *  or off. None of it reaches a decode cut. */
  context: string;
}

/** What SplitTokens reads from the renderer on every frame. */
export type SplitSources = Omit<SplitUpstreamInputs, "cut" | "upstreamStageIds">;

// A decode cut sits ahead of every core edit. The retouch alone reaches it:
// without a patched source the split draw heals in the shader first, and the
// source signature covers the retouch only when the source is patched.
const DECODE_INPUTS: readonly (keyof DevelopParams)[] = ["retouch"];

const NEVER_UPSTREAM: readonly (keyof DevelopParams)[] = [
  "crop", "straighten", "transform", "uprightMode", "guidedLines", "vignette", "grain",
];

const DISPLAY_ONLY: readonly (keyof DevelopParams)[] = [
  "whites", "blacks", "contrast", "toneCurve", "hsl", "dehaze", "clarity", "texture",
  "highlightDetail", "shadowDetail", "vibrance", "saturation", "colorGrading",
  "sharpening", "sharpenRadius", "sharpenDetail", "sharpenMasking",
];

const LINEAR_MASK_ADJUSTMENTS: readonly (keyof MaskAdjustments)[] = [
  "exposure", "highlights", "shadows", "temperature", "tint",
];

// Masks feed a scene cut through their coverage and linear adjustments only.
function sceneMask(m: Mask): unknown {
  const adj = Object.fromEntries(LINEAR_MASK_ADJUSTMENTS.map((k) => [k, m.adj[k]]));
  return { ...m, adj, hsl: undefined, toneCurve: undefined };
}

function feedingParams(params: DevelopParams, cut: SplitCut): [string, unknown][] {
  if (cut === "decode") return DECODE_INPUTS.map((k) => [k, params[k]]);
  const dropped = new Set<string>(
    cut === "scene" ? [...NEVER_UPSTREAM, ...DISPLAY_ONLY] : NEVER_UPSTREAM,
  );
  const masks = cut === "scene" ? params.masks.map(sceneMask) : params.masks;
  return Object.entries(params)
    .filter(([k]) => !dropped.has(k))
    .map(([k, v]) => [k, k === "masks" ? masks : v]);
}

/** The entries of upstream stages (keys "{stageId}.…"), sorted by key. */
function upstreamEntries<T>(record: Record<string, T>, ids: readonly string[]): [string, T][] {
  return Object.keys(record)
    .filter((qualified) => ids.some((id) => qualified.startsWith(`${id}.`)))
    .sort()
    .map((k) => [k, record[k]]);
}

const sameEntries = <T>(a: [string, T][], b: [string, T][]): boolean =>
  a === b || (a.length === b.length && a.every(([k, v], i) => k === b[i][0] && v === b[i][1]));

/** Whether `b` still holds the very values of `a` that feed `cut`. A decode cut reads
 *  DECODE_INPUTS alone, so a replaced params object can keep its key; the other cuts
 *  read most of the params, and only the same object is known to match. */
const sameFeedingValues = (a: DevelopParams, b: DevelopParams, cut: SplitCut): boolean =>
  a === b || (cut === "decode" && DECODE_INPUTS.every((k) => a[k] === b[k]));

export function splitUpstreamKey(i: SplitUpstreamInputs): string {
  return JSON.stringify([
    i.cut,
    i.cut === "decode" ? "" : i.context,
    feedingParams(i.params, i.cut),
    upstreamEntries(i.bag, i.upstreamStageIds),
    upstreamEntries(i.textureVersions, i.upstreamStageIds),
  ]);
}

interface SplitMemo {
  split: StageSplit;
  params: DevelopParams;
  paramsKey: string;
  bag: Record<string, unknown>;
  entries: [string, unknown][];
  entriesKey: string;
  versions: [string, number][];
  context: string;
  token: number;
}

/** Per-stage stand-ins for splitUpstreamKey in the prepass cache: a token
 *  changes exactly when the stage's key does. Serialising the develop params,
 *  brush dabs included, is the costly part, so it runs only when the params
 *  object is replaced (for a decode cut, only when its retouch array is).
 *  Bag entries are compared by reference and texture versions by value, so a
 *  frame that replaced nothing, or only a param of the stage's own or a later
 *  stage's, serialises nothing. Callers replace params and the bag on change
 *  rather than mutating them. */
export class SplitTokens {
  private readonly memo = new Map<string, SplitMemo>();
  private issued = 0;

  token(stageId: string, split: StageSplit, s: SplitSources): number {
    const prev = this.memo.get(stageId);
    const same = prev?.split === split ? prev : undefined;
    const paramsKey =
      same && sameFeedingValues(same.params, s.params, split.cut)
        ? same.paramsKey
        : JSON.stringify(feedingParams(s.params, split.cut));
    const entries =
      same?.bag === s.bag ? same.entries : upstreamEntries(s.bag, split.upstreamStageIds);
    const entriesKey =
      same && sameEntries(same.entries, entries) ? same.entriesKey : JSON.stringify(entries);
    const versions = upstreamEntries(s.textureVersions, split.upstreamStageIds);
    const context = split.cut === "decode" ? "" : s.context;
    const unchanged =
      same !== undefined &&
      paramsKey === same.paramsKey &&
      entriesKey === same.entriesKey &&
      sameEntries(versions, same.versions) &&
      context === same.context;
    const token = unchanged ? same.token : ++this.issued;
    this.memo.set(stageId, {
      split,
      params: s.params,
      paramsKey,
      bag: s.bag,
      entries,
      entriesKey,
      versions,
      context,
      token,
    });
    return token;
  }

  /** Forgets every stage, as when the stage set changes. */
  clear(): void {
    this.memo.clear();
  }
}
