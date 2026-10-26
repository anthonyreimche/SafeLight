// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The rows of the DevTools Pipeline tab: the develop shader's own blocks in
// program order and, between them, what buildStageInjection wrote for the
// stages (their blocks, the conversions and the clips it inserted). Those come
// from the steps it records while writing the GLSL, from the same call the
// renderer makes, so they can't drift from the program. Only the core blocks
// and their clips are a table; pipeline-description.test.ts holds it to
// shaders.ts's text.

import { DEFAULT_PIPELINE, type ResolvedPipeline } from "@/extensions/pipelines";
import type { ProcessingPhase, ProcessingStageContribution, StageSpace } from "@/extensions/types";
import { spaceKey, type StageDomain } from "../stage-space";
import { BUILTIN_DENOISE_ID } from "./builtin-denoise";
import { isBuiltInStage, isCoreStage } from "./builtin-stage";
import { isMaskInstance, isMaskableStage } from "./mask-stage-instances";
import type { ShaderVariant } from "./shaders";
import {
  buildStageInjection,
  coreStageHelpers,
  phaseInfo,
  withoutComments,
  type InjectionGroup,
  type InjectionStep,
} from "./stage-injection";
import { toneShoulderOn } from "./variant-decisions";

/** When a clip runs: on every frame; while the tool above it is in use; inside
 *  each mask that uses it, blended in by the mask's coverage; only for a
 *  fallback preview's source, which has no headroom above 1; only when the
 *  output isn't sRGB (an export to a wider space, or a monitor profile); only
 *  on a GPU without float render targets (or none it can mipmap), where an
 *  intermediate is stored in a format that holds [0, 1]. */
export type ClipWhen =
  | "always"
  | "while-active"
  | "per-mask"
  | "fallback-preview"
  | "non-srgb-output"
  | "no-float-targets";

export type PipelineRow =
  | { kind: "core"; label: string; note?: string }
  | {
      kind: "stage";
      id: string;
      name: string;
      phase: ProcessingPhase;
      priority: number;
      /** The extension that registered it; null for Safelight's own. */
      owner: string | null;
      space: StageSpace | null;
      /** The values its block sees: scene-linear `lin`, display-encoded `c`,
       *  or none for geometry, which moves pixels and holds no colour. */
      domain: StageDomain | null;
      reads: "source" | "current";
      maskable: boolean;
      /** Floors and clips found in its GLSL (findFloors). */
      floors: string[];
      /** How many mask copies run it again. They have no rows of their own:
       *  `note` says what is written for each. */
      copies?: number;
      note?: string;
    }
  | { kind: "convert"; from: string; to: string; elided: boolean }
  | {
      kind: "clamp";
      /** One of the develop shader's own blocks (the core row above it), or
       *  the output encode. */
      reason: "core" | "output";
      /** The values coming in, or what the block made. */
      where: "input" | "result";
      when: ClipWhen;
      detail: string;
    }
  | {
      kind: "clamp";
      reason: "legacy-display-stage";
      /** The stage that declares no space. */
      stageId: string;
      /** Its block's input, or what its passes read (their split draw only,
       *  not the frame). */
      where: "input" | "pass-input";
      when: "always";
      detail: string;
    }
  | {
      kind: "clamp";
      /** A clip inside one of Safelight's own stages that findFloors can't
       *  see, such as one in its passes. An extension stage's row shows only
       *  what findFloors finds in its glsl and helpers. */
      reason: "builtin-stage";
      stageId: string;
      where: "result";
      when: "while-active";
      detail: string;
    }
  | {
      kind: "transform";
      /** null for the built-in transform. */
      id: string | null;
      /** The flags the transform sets, each with whether this version honours it. */
      flags: { flag: "skipBaseCurve" | "skipToneShoulder"; honoured: boolean }[];
    }
  | { kind: "output"; mapped: boolean; detail: string };

type Stage = ProcessingStageContribution & { extensionId?: string };
type StageRow = Extract<PipelineRow, { kind: "stage" }>;
/** A stage's mask copies: how many, and the rows of what is written for them. */
type Copies = { count: number; folded: PipelineRow[] };

interface NoteContext {
  variant: ShaderVariant;
  pipeline: ResolvedPipeline;
  /** The noise-reduction stage the core block steps aside for, as the renderer
   *  sets uSkipCoreNR: an extension's always, the built-in denoiser only where
   *  it can run. */
  replacedNR: "denoiser" | "extension" | null;
}

/** A clip a core block makes of the working colour. */
interface CoreClip {
  readonly where: "input" | "result";
  /** When it runs on version 1, and on version 2 and later; null where that
   *  program doesn't clip there. `v3` only where version 3 differs. */
  readonly v1: ClipWhen | null;
  readonly v2: ClipWhen | null;
  readonly v3?: ClipWhen | null;
  /** Said instead of "<block> clips …". */
  readonly detail?: string;
}

interface CoreBlock {
  readonly label: string;
  /** The injection group whose stages run right after the block. */
  readonly stages?: InjectionGroup;
  /** The display transform, which the transform row follows. */
  readonly transform?: true;
  readonly clips?: readonly CoreClip[];
  readonly note?: (at: NoteContext) => string | undefined;
}

// A tool that opens with clampInput (shaders.ts): nothing upstream clips its
// input from version 2 on, so it does, while in use.
const CLAMPED_TOOL: readonly CoreClip[] = [
  { where: "input", v1: null, v2: "while-active" },
  { where: "result", v1: "while-active", v2: "while-active" },
];
// A tool version 1 runs for every pixel and version 2 only while in use.
const ungated = (where: CoreClip["where"]): CoreClip => ({ where, v1: "always", v2: "while-active" });
// Mask stage 2: clips inside a mask's coverage, on the versions given.
const perMask = (where: CoreClip["where"], detail: string, on: "all" | "v1" | "v2" = "all"): CoreClip => ({
  where,
  v1: on === "v2" ? null : "per-mask",
  v2: on === "v1" ? null : "per-mask",
  detail: `${detail}, blended in by its coverage`,
});

/** The develop shader's own blocks, in main()'s order, with the clips each
 *  makes (pipeline-description.test.ts holds them to the shader's text). */
export const CORE_BLOCKS: readonly CoreBlock[] = [
  { label: "Crop & Straighten", stages: "srcUv" },
  {
    label: "Heal",
    // The patched copy is stored as developedFormatFor decides: only float16
    // keeps values outside [0, 1], and version 1 never takes it.
    clips: [
      {
        where: "result",
        v1: "while-active",
        v2: null,
        detail: "A retouched frame develops from a patched copy of the source, stored clipped to [0, 1]",
      },
      {
        where: "result",
        v1: null,
        v2: "no-float-targets",
        detail:
          "Where the GPU can't render or mipmap a float copy, a retouched frame develops from a " +
          "patched copy of the source stored clipped to [0, 1]",
      },
    ],
  },
  { label: "Linear source and baseline tone", stages: "noiseReduction" },
  {
    label: "Noise Reduction",
    note: ({ replacedNR }) =>
      replacedNR === "denoiser"
        ? "Skipped: the built-in denoiser replaces it. Runs where the denoiser can't (no float render targets): colour NR only on a RAW under the baseline tone"
        : replacedNR === "extension"
          ? "Skipped: a noise-reduction stage replaces it"
          : undefined,
  },
  {
    label: "Channel reconstruction",
    // The camera baseline (baseline-tone.ts) runs right after it from version 2 on.
    note: ({ variant, pipeline }) =>
      variant.fullInfo && !pipeline.skipBaseCurve
        ? "Then a RAW's baseline is refit to the camera curve and given the camera maker's exposure offset"
        : undefined,
  },
  { label: "White Balance" },
  { label: "Exposure, Highlights, Shadows & tone shoulder" },
  { label: "Masking (scene values)", stages: "sceneLinear" },
  {
    label: "Display transform",
    transform: true,
    clips: [{ where: "result", v1: "always", v2: null, detail: "Clipped to [0, 1] after the transform" }],
    // slPathToWhite, which version 2 runs wherever the shoulder does.
    note: ({ variant, pipeline }) =>
      variant.fullInfo && toneShoulderOn(variant, pipeline.skipToneShoulder)
        ? "Rolls the strongest channel off into white first"
        : undefined,
  },
  { label: "Whites", clips: CLAMPED_TOOL },
  { label: "Blacks", clips: CLAMPED_TOOL },
  { label: "Contrast", clips: CLAMPED_TOOL },
  { label: "Tone Curve", clips: [ungated("input")] },
  { label: "HSL", clips: [{ where: "input", v1: null, v2: "while-active" }, ungated("result")] },
  { label: "Dehaze", clips: CLAMPED_TOOL },
  { label: "Clarity" },
  { label: "Texture" },
  { label: "Highlight Detail & Shadow Detail", clips: [{ where: "result", v1: "always", v2: null }] },
  {
    label: "Vibrance & Saturation",
    // Version 1 calls it for every pixel, but it clips its result only for a
    // saturation or vibrance it applies.
    clips: [ungated("input"), { where: "result", v1: "while-active", v2: "while-active" }],
  },
  { label: "Color Grading", clips: [{ where: "input", v1: null, v2: "while-active" }, ungated("result")] },
  {
    label: "Sharpening",
    clips: [
      {
        where: "result",
        v1: "fallback-preview",
        v2: "fallback-preview",
        // Nothing produces a fallback preview, so version 3's program drops it.
        v3: null,
        detail: "A fallback preview, which has no headroom above 1, is clipped to [0, 1] here",
      },
    ],
  },
  {
    label: "Masking (display values)",
    stages: "effects",
    clips: [
      perMask("input", "Each mask with display adjustments clips the values coming in to [0, 1]", "v2"),
      perMask("result", "Each mask with display adjustments clips their result to [0, 1]", "v2"),
      // Version 1 runs every mask's display adjustments, whichever it has.
      perMask("result", "Every mask clips the result of its display adjustments to [0, 1]", "v1"),
      perMask("input", "Each mask with an HSL adjustment clips the values coming in to [0, 1]"),
      perMask("result", "Each mask's HSL adjustment clips its result to [0, 1]"),
      perMask("input", "Each mask with a tone curve clips the values coming in to [0, 1] to look them up"),
    ],
  },
];

function clipRow(label: string, clip: CoreClip, when: ClipWhen): PipelineRow {
  const what = clip.where === "input" ? "the values coming in" : "its result";
  const detail = clip.detail ?? `${label} clips ${what} to [0, 1]${when === "while-active" ? " while in use" : ""}`;
  return { kind: "clamp", reason: "core", where: clip.where, when, detail };
}

// A floor or clip of the colour variable; the call's end is found by bracket
// depth, since its other arguments can hold calls of their own. A floor counts
// when it is a constant: it drops every value under it, whatever the constant.
const FLOOR_HEAD = /\b(max|clamp)\s*\(\s*(?:lin|c)\s*,/g;
const NUMBER = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?[fF]?`;
const CONSTANT = new RegExp(
  String.raw`^\s*(?:${NUMBER}|vec3\s*\(\s*${NUMBER}\s*(?:,\s*${NUMBER}\s*,\s*${NUMBER}\s*)?\))\s*$`,
);

/** The index of the ")" that closes a call whose arguments run from `from`. */
function closingParen(code: string, from: number): number {
  let depth = 0;
  for (let i = from; i < code.length; i++) {
    if (code[i] === "(") depth++;
    else if (code[i] === ")" && depth-- === 0) return i;
  }
  return -1;
}

/** The constant floors (`max(lin, 0.0)`, `max(c, vec3(1e-6))`) and clips
 *  (`clamp(lin, …)`, `clamp(c, …)`) in a stage's glsl and helpers. The core
 *  can't know what a stage does inside, so the tab shows these as found in its
 *  GLSL. Only `lin` and `c` are read: a floor on a copy of them, or in a pass's
 *  GLSL, isn't seen. */
export function findFloors(stage: ProcessingStageContribution): string[] {
  const found: string[] = [];
  for (const code of [stage.glsl, stage.helpers ?? ""].map(withoutComments)) {
    for (const head of code.matchAll(FLOOR_HEAD)) {
      const args = head.index + head[0].length;
      const end = closingParen(code, args);
      if (end < 0 || (head[1] === "max" && !CONSTANT.test(code.slice(args, end)))) continue;
      found.push(code.slice(head.index, end + 1).replace(/\s+/g, " "));
    }
  }
  return found;
}

// The denoiser floors a luma it computes, in its passes, where findFloors can't
// see it (pipeline-description.test.ts holds this to builtin-denoise.ts).
function builtinStageClips(stageId: string): PipelineRow[] {
  if (stageId !== BUILTIN_DENOISE_ID) return [];
  const detail =
    "Its passes floor luma at 0 (the noise transform takes its square root): " +
    "a colour whose luma is below 0 comes back at luma 0, its chroma kept";
  return [{ kind: "clamp", reason: "builtin-stage", stageId, where: "result", when: "while-active", detail }];
}

function stageRow(s: Stage, variant: ShaderVariant, readsCurrent: boolean): StageRow {
  // Scanned as compiled: version 2 drops the clamp closing the core Vignette
  // and Grain helpers.
  const compiled = isCoreStage(s) && s.helpers ? { ...s, helpers: coreStageHelpers(s.helpers, variant) } : s;
  return {
    kind: "stage",
    id: s.id,
    name: s.name,
    phase: s.phase,
    priority: s.priority ?? 100,
    owner: isBuiltInStage(s) ? null : (s.extensionId ?? null),
    space: s.space ?? null,
    domain: phaseInfo(s.phase).domain,
    reads: readsCurrent ? "current" : "source",
    maskable: isMaskableStage(s),
    floors: findFloors(compiled),
  };
}

function transformRow(variant: ShaderVariant, pipeline: ResolvedPipeline): PipelineRow {
  const flags: Extract<PipelineRow, { kind: "transform" }>["flags"] = [];
  if (pipeline.skipBaseCurve) flags.push({ flag: "skipBaseCurve", honoured: true });
  if (pipeline.skipToneShoulder) flags.push({ flag: "skipToneShoulder", honoured: !toneShoulderOn(variant, true) });
  return { kind: "transform", id: pipeline.id === DEFAULT_PIPELINE ? null : pipeline.id, flags };
}

/** What each of a stage's mask copies gets written, as its stage's own rows
 *  would say it. A copy is the stage's declaration again, so it clips its input
 *  where the stage does; emitMaskCopy writes that clip inside its block, where
 *  no step records it. */
function copiesNote(count: number, clipsInput: boolean, folded: readonly PipelineRow[]): string {
  const clips = (where: string) => folded.some((r) => r.kind === "clamp" && r.where === where);
  const conversions = new Set(
    folded.flatMap((r) => (r.kind === "convert" && !r.elided ? [`${r.from} → ${r.to}`] : [])),
  );
  const each = [
    ...(clips("pass-input") ? ["hands its passes values clipped to [0, 1]"] : []),
    ...(conversions.size > 0 ? [`converts ${[...conversions].join(", ")}`] : []),
    ...(clipsInput || clips("input") ? ["clips its input to [0, 1]"] : []),
  ];
  const runs = `Runs again inside ${count} ${count === 1 ? "mask" : "masks"}`;
  return each.length > 0 ? `${runs}; each copy ${each.join(", ")}` : runs;
}

function outputRows(variant: ShaderVariant): PipelineRow[] {
  if (variant.signedOutput) {
    const detail =
      "Mapped into the target's gamut, then encoded. The target is the screen's space for the view " +
      "(sRGB or Display P3, or a monitor profile's), the export's colour space for an export";
    return [{ kind: "output", mapped: true, detail }];
  }
  return [
    { kind: "clamp", reason: "output", where: "input", when: "always", detail: "Clipped to [0, 1] for encoding" },
    {
      kind: "clamp",
      reason: "output",
      where: "result",
      when: "non-srgb-output",
      detail:
        "Clipped to [0, 1] again in the target's linear space when it isn't sRGB: " +
        "an export to Display P3, Adobe RGB or ProPhoto, or a screen with a monitor profile",
    },
    {
      kind: "output",
      mapped: false,
      detail: "Encoded as sRGB for the view (or a monitor profile's space), in the export's colour space for an export",
    },
  ];
}

/** The rows for the program `variant` assembles from `stages` under
 *  `pipeline`, in program order. Pass the stages with the open photo's mask
 *  copies (maskInstances), as the renderer builds the program. */
export function describePipeline(
  stages: readonly Stage[],
  variant: ShaderVariant,
  pipeline: ResolvedPipeline,
): PipelineRow[] {
  const { steps, hasNoiseReduction } = buildStageInjection(stages, variant);
  const byId = new Map(stages.map((s) => [s.id, s]));
  const readers = new Set(steps.flatMap((step) => (step.kind === "exit" ? [step.stageId] : [])));
  const clipped = new Set(steps.flatMap((step) => (step.kind === "clamp" ? [step.stageId] : [])));

  const nameOf = (id: string): string => byId.get(id)?.name ?? id;
  const stepRows = (step: Exclude<InjectionStep, { kind: "stage" }>): PipelineRow[] => {
    switch (step.kind) {
      case "convert":
        return [
          {
            kind: "convert",
            from: spaceKey(step.from, step.domain),
            to: spaceKey(step.to, step.domain),
            elided: step.elided === true,
          },
        ];
      case "clamp": {
        const detail = `${nameOf(step.stageId)} declares no space, so it gets display values clipped to [0, 1]`;
        return [{ kind: "clamp", reason: step.reason, stageId: step.stageId, where: "input", when: "always", detail }];
      }
      case "exit":
        // An exit that doesn't clip shows only as its stage's `reads`.
        if (!step.clamped) return [];
        return [
          {
            kind: "clamp",
            reason: "legacy-display-stage",
            stageId: step.stageId,
            where: "pass-input",
            when: "always",
            detail: `${nameOf(step.stageId)}'s passes read display values clipped to [0, 1]`,
          },
        ];
    }
  };

  // A group's rows in the order written. A mask copy gets none: what is
  // written for it folds into its stage's note. That is the conversions ahead
  // of its block and its exit, found by its id, since an output-frame copy's
  // exit is written ahead of the stage itself.
  const groupRows = (group: InjectionGroup): PipelineRow[] => {
    const rows: PipelineRow[] = [];
    const copies = new Map<string, Copies>();
    const copiesOf = (stageId: string): Copies => {
      const known = copies.get(stageId);
      if (known) return known;
      const fresh: Copies = { count: 0, folded: [] };
      copies.set(stageId, fresh);
      return fresh;
    };
    let ahead: PipelineRow[] = [];
    for (const step of steps) {
      if (step.group !== group) continue;
      const owner = step.kind === "convert" ? undefined : byId.get(step.stageId);
      const copy = owner && isMaskInstance(owner) ? copiesOf(owner.instanceOf) : undefined;
      if (step.kind !== "stage") {
        (copy?.folded ?? ahead).push(...stepRows(step));
      } else if (copy) {
        copy.count++;
        copy.folded.push(...ahead);
        ahead = [];
      } else if (owner) {
        rows.push(...ahead, stageRow(owner, variant, readers.has(owner.id)), ...builtinStageClips(owner.id));
        ahead = [];
      }
    }
    return [...rows, ...ahead].map((r) => {
      const c = r.kind === "stage" ? copies.get(r.id) : undefined;
      if (r.kind !== "stage" || !c) return r;
      return { ...r, copies: c.count, note: copiesNote(c.count, clipped.has(r.id), c.folded) };
    });
  };

  // The denoiser is in the set only while no extension's NR supersedes it.
  const denoiserInSet = steps.some((s) => s.kind === "stage" && s.stageId === BUILTIN_DENOISE_ID);
  const replacedNR = denoiserInSet ? "denoiser" : hasNoiseReduction ? "extension" : null;
  const at: NoteContext = { variant, pipeline, replacedNR };
  const rows: PipelineRow[] = [];
  for (const block of CORE_BLOCKS) {
    const note = block.note?.(at);
    rows.push({ kind: "core", label: block.label, ...(note ? { note } : {}) });
    if (block.transform) rows.push(transformRow(variant, pipeline));
    for (const clip of block.clips ?? []) {
      const when = variant.signedOutput && clip.v3 !== undefined ? clip.v3 : variant.fullInfo ? clip.v2 : clip.v1;
      if (when) rows.push(clipRow(block.label, clip, when));
    }
    if (block.stages) rows.push(...groupRows(block.stages));
  }
  return [...rows, ...outputRows(variant)];
}
