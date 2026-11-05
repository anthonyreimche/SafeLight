// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The cache key of a split draw: everything upstream of its cut. A split is a
// full develop draw at prepass size, so it must not run again when only the
// stage's own inline params, a downstream stage, the crop or an output-frame
// effect changed.

import type { DevelopParams, Mask, MaskAdjustments } from "@/catalog/types";
import { isUniformValue } from "@/extensions/pipeline-validation";
import type { StageDomain } from "../stage-space";
import type { ContributedBinding, SplitCut, StageSplit } from "./stage-injection";

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
  /** The display transform's uniform bindings (ResolvedPipeline.bindings).
   *  A display cut is drawn through the transform, so what they bind feeds
   *  it; the program they bind in is part of `context`. */
  transformBindings: readonly ContributedBinding[];
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

// A mask's bag drives its stage copies (mask-stage-instances.ts), whose values
// reach a split through the stage bag under the copies' own keys, upstream
// copies only, as any stage's do.
function stagelessMask(m: Mask): Mask {
  return { ...m, bag: undefined };
}

// Masks feed a scene cut through their coverage and linear adjustments only.
function sceneMask(m: Mask): unknown {
  const adj = Object.fromEntries(LINEAR_MASK_ADJUSTMENTS.map((k) => [k, m.adj[k]]));
  return { ...stagelessMask(m), adj, hsl: undefined, toneCurve: undefined };
}

const DROPPED: Record<StageDomain, ReadonlySet<string>> = {
  scene: new Set([...NEVER_UPSTREAM, ...DISPLAY_ONLY]),
  display: new Set(NEVER_UPSTREAM),
};

const MASK_VIEW: Record<StageDomain, (m: Mask) => unknown> = {
  scene: sceneMask,
  display: stagelessMask,
};

/** The params fields that feed `cut`, masks as the params hold them. */
function feedingFields(params: DevelopParams, cut: SplitCut): [string, unknown][] {
  if (cut === "decode") return DECODE_INPUTS.map((k) => [k, params[k]]);
  const dropped = DROPPED[cut];
  return Object.entries(params).filter(([k]) => !dropped.has(k));
}

function feedingParams(params: DevelopParams, cut: SplitCut): [string, unknown][] {
  if (cut === "decode") return feedingFields(params, cut);
  const masks = params.masks.map(MASK_VIEW[cut]);
  return feedingFields(params, cut).map(([k, v]) => [k, k === "masks" ? masks : v]);
}

// Serialized text by value. Callers replace a field, and each mask, on change and
// never mutate one in place, so a slider tick that replaced the params object
// serializes only the fields it replaced, and a mask edit only that mask.
const keyTexts = new Map<string, string>();
const entryTexts = new Map<string, WeakMap<object, string>>();
const maskTexts: Record<StageDomain, WeakMap<Mask, string>> = { scene: new WeakMap(), display: new WeakMap() };
const masksEntryTexts: Record<StageDomain, WeakMap<Mask[], string>> = { scene: new WeakMap(), display: new WeakMap() };

interface TextCache<K> {
  get(key: K): string | undefined;
  set(key: K, text: string): unknown;
}

function cachedText<K>(cache: TextCache<K>, key: K, text: () => string): string {
  let cached = cache.get(key);
  if (cached === undefined) {
    cached = text();
    cache.set(key, cached);
  }
  return cached;
}

/** A value as JSON.stringify writes it inside an array. */
const elementText = (v: unknown): string => JSON.stringify(v) ?? "null";

const keyText = (k: string): string => cachedText(keyTexts, k, () => JSON.stringify(k));

function entryText(k: string, v: unknown): string {
  const text = () => `[${keyText(k)},${elementText(v)}]`;
  if (typeof v !== "object" || v === null) return text();
  let byValue = entryTexts.get(k);
  if (!byValue) entryTexts.set(k, (byValue = new WeakMap()));
  return cachedText(byValue, v, text);
}

function masksEntryText(masks: Mask[], cut: StageDomain): string {
  const view = MASK_VIEW[cut];
  const mask = (m: Mask) => cachedText(maskTexts[cut], m, () => elementText(view(m)));
  return cachedText(masksEntryTexts[cut], masks, () => `[${keyText("masks")},[${masks.map(mask).join(",")}]]`);
}

/** The entries of JSON.stringify(feedingParams(params, cut)), each character for
 *  character as it writes them, from text cached per field value and per mask.
 *  Joined with "," inside "[…]" they are that text; compared one by one, an
 *  unchanged field is the very string it was and costs no character comparison. */
export function feedingParamsTexts(params: DevelopParams, cut: SplitCut): string[] {
  return feedingFields(params, cut).map(([k, v]) =>
    k === "masks" && cut !== "decode" ? masksEntryText(params.masks, cut) : entryText(k, v),
  );
}

const sameTexts = (a: readonly string[], b: readonly string[]): boolean =>
  a === b || (a.length === b.length && a.every((t, i) => t === b[i]));

/** The entries of upstream stages (keys "{stageId}.…"), sorted by key. */
function upstreamEntries<T>(record: Record<string, T>, ids: readonly string[]): [string, T][] {
  return Object.keys(record)
    .filter((qualified) => ids.some((id) => qualified.startsWith(`${id}.`)))
    .sort()
    .map((k) => [k, record[k]]);
}

/** The bag entries that feed `cut`: the upstream stages', then, for a display
 *  cut, what each transform binding binds as render() does: the bag's value
 *  while it fits the uniform, else the binding's default. */
function feedingEntries(
  bag: Record<string, unknown>,
  cut: SplitCut,
  upstreamStageIds: readonly string[],
  transformBindings: readonly ContributedBinding[],
): [string, unknown][] {
  const entries: [string, unknown][] = upstreamEntries(bag, upstreamStageIds);
  if (cut !== "display") return entries;
  for (const b of transformBindings) {
    const value = bag[b.qualifiedKey];
    entries.push([b.qualifiedKey, isUniformValue(value, b.glslType) ? value : b.default]);
  }
  return entries;
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
    feedingEntries(i.bag, i.cut, i.upstreamStageIds, i.transformBindings),
    upstreamEntries(i.textureVersions, i.upstreamStageIds),
  ]);
}

interface SplitMemo {
  split: StageSplit;
  params: DevelopParams;
  paramsTexts: string[];
  bag: Record<string, unknown>;
  transformBindings: readonly ContributedBinding[];
  entries: [string, unknown][];
  entriesKey: string;
  versions: [string, number][];
  context: string;
  token: number;
}

/** Per-stage stand-ins for splitUpstreamKey in the prepass cache: a token
 *  changes exactly when the stage's key does. Serializing the develop params,
 *  brush dabs included, is the costly part, so it runs only when the params
 *  object is replaced (for a decode cut, only when its retouch array is), and
 *  then only for the fields and masks that were replaced.
 *  Bag entries are compared by reference and texture versions by value, so a
 *  frame that replaced nothing, or only a param of the stage's own or a later
 *  stage's, serializes nothing. Callers replace params, the bag and the
 *  transform's bindings on change rather than mutating them. */
export class SplitTokens {
  private readonly memo = new Map<string, SplitMemo>();
  private issued = 0;

  token(stageId: string, split: StageSplit, s: SplitSources): number {
    const prev = this.memo.get(stageId);
    const same = prev?.split === split ? prev : undefined;
    const paramsTexts =
      same && sameFeedingValues(same.params, s.params, split.cut)
        ? same.paramsTexts
        : feedingParamsTexts(s.params, split.cut);
    const sameBindings = split.cut !== "display" || same?.transformBindings === s.transformBindings;
    const entries =
      same?.bag === s.bag && sameBindings
        ? same.entries
        : feedingEntries(s.bag, split.cut, split.upstreamStageIds, s.transformBindings);
    const entriesKey =
      same && sameEntries(same.entries, entries) ? same.entriesKey : JSON.stringify(entries);
    const versions = upstreamEntries(s.textureVersions, split.upstreamStageIds);
    const context = split.cut === "decode" ? "" : s.context;
    const unchanged =
      same !== undefined &&
      sameTexts(paramsTexts, same.paramsTexts) &&
      entriesKey === same.entriesKey &&
      sameEntries(versions, same.versions) &&
      context === same.context;
    const token = unchanged ? same.token : ++this.issued;
    this.memo.set(stageId, {
      split,
      params: s.params,
      paramsTexts,
      bag: s.bag,
      transformBindings: s.transformBindings,
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
