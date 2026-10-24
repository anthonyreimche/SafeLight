// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Extension stages inside local adjustment masks. A maskable stage
// (ProcessingStageContribution.mask) runs once more for every mask whose bag
// holds one of its keys: a copy of the stage, placed right after it, that the
// injection wraps in the mask's coverage (keeping what it would produce local)
// and the renderer drives from the mask's values. Copies are numbered by how
// many masks use the stage ("{stageId}@0", "@1", ...), not by mask id, so every
// photo with the same count shares one program and reordering masks only moves
// their slots.

import { MAX_MASKS, type Mask } from "@/catalog/types";
import { MASKABLE_PHASES, type ProcessingStageContribution } from "@/extensions/types";
import type { ShaderVariant } from "./shaders";

/** How many mask copies' prepasses a frame of the live Develop view runs; the
 *  rest run on the frames after it (WebGLRendererOpts.maskCopyPrepassesPerFrame). */
export const LIVE_MASK_COPY_PREPASSES = 4;

/** A stage's copy for one mask. */
export type MaskInstanceStage = ProcessingStageContribution & {
  /** The id of the stage this copies. */
  readonly instanceOf: string;
};

export function isMaskInstance(s: ProcessingStageContribution): s is MaskInstanceStage {
  return typeof (s as Partial<MaskInstanceStage>).instanceOf === "string";
}

/** The stage a copy's id ("{stageId}@{n}") names; any other id as given. */
export function stageOfCopy(id: string): string {
  return id.replace(/@\d+$/, "");
}

/** Whether masks can run copies of the stage: it opted in, in a phase that
 *  runs after mask coverage is known. */
export function isMaskableStage(s: ProcessingStageContribution): boolean {
  return s.mask?.maskable === true && MASKABLE_PHASES.includes(s.phase);
}

export interface MaskInstances {
  /** The stages given, each copied stage followed by its copies. The very list
   *  given when nothing is copied. */
  stages: readonly ProcessingStageContribution[];
  /** Each copy's mask, as its index into the masks (the shader's coverage
   *  slot), or -1 while that mask applies nothing (hidden or at 0 opacity). */
  slots: ReadonlyMap<string, number>;
  /** The masks' values for their copies, under the copies' qualified keys. */
  bag: Record<string, unknown>;
  /** The copies' ids: it changes exactly when the stage list does. "" when
   *  nothing is copied. */
  sig: string;
}

const NONE: Omit<MaskInstances, "stages"> = { slots: new Map(), bag: {}, sig: "" };

/** The param keys a stage reads, inline and in its passes. */
function stageKeys(s: ProcessingStageContribution): string[] {
  const passKeys = (s.passes ?? []).flatMap((p) => (p.uniforms ?? []).map((u) => u.key));
  return [...s.uniforms.map((u) => u.key), ...passKeys];
}

const appliesNothing = (m: Mask): boolean => m.visible === false || !(m.opacity > 0);

/** The copies the masks call for. Only photos at process version 2 or later get
 *  any: version 1 renders exactly as it always has. */
export function maskInstances(
  stages: readonly ProcessingStageContribution[],
  masks: readonly Mask[],
  variant: ShaderVariant,
): MaskInstances {
  if (!variant.fullInfo) return { stages, ...NONE };
  const shown = masks.slice(0, MAX_MASKS);
  const out: ProcessingStageContribution[] = [];
  const slots = new Map<string, number>();
  const bag: Record<string, unknown> = {};

  for (const s of stages) {
    out.push(s);
    if (!isMaskableStage(s)) continue;
    const keys = stageKeys(s);
    let previous = s.id;
    let count = 0;
    shown.forEach((m, slot) => {
      const held = keys.filter((k) => m.bag?.[`${s.id}.${k}`] !== undefined);
      if (held.length === 0) return;
      const id = `${s.id}@${count++}`;
      const copy: MaskInstanceStage = {
        ...s,
        id,
        name: `${s.name} (mask ${slot + 1})`,
        after: [previous],
        instanceOf: s.id,
      };
      out.push(copy);
      slots.set(id, appliesNothing(m) ? -1 : slot);
      for (const k of held) bag[`${id}.${k}`] = m.bag?.[`${s.id}.${k}`];
      previous = id;
    });
  }

  if (slots.size === 0) return { stages, ...NONE };
  return { stages: out, slots, bag, sig: [...slots.keys()].join(",") };
}
