// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { simpleHash } from "./hash";
import { passDraws } from "./pass-draws";
import type { PrepassFrame } from "./prepass-runner";
import type { PrepassPass, PrepassStage } from "./stage-injection";
import { boundValue } from "./uniform-values";

/** What a prepass signature reads off the frame. */
export type SigFrame = Pick<
  PrepassFrame,
  "bag" | "w" | "h" | "baseCurve" | "linear" | "isFallbackPreview" | "processVersion" | "sourceWidth" | "sourceHeight"
>;

const sourceHashes = new WeakMap<PrepassPass, string>();

/** A pass's programs, hashed once per pass. */
function sourceHash(pass: PrepassPass): string {
  let hash = sourceHashes.get(pass);
  if (hash === undefined) {
    hash = simpleHash(`${pass.fragmentSource}\u0000${pass.vertexSource ?? ""}`);
    sourceHashes.set(pass, hash);
  }
  return hash;
}

/** Signature of everything the state after pass `through` depends on: the
 *  source (srcSig, with a reads-current stage's split token in it), the decoded
 *  source's size (uSourceSize: a completed RAW cache entry can hand it a new
 *  one), the pass size, linearization, the process version the passes were built for, and the
 *  programs, bound values and draw counts of that pass and every pass before
 *  it. Inline params don't reach a pass, so they are left out: dragging one is
 *  a cache hit. Whether any later pass draws is in it too, since that decides
 *  whether the pass's last draw is the stage's last, which is drawn whole.
 *  Through the last pass it is the signature of the stage's result. */
export function prefixSig(stage: PrepassStage, frame: SigFrame, srcSig: string, through: number): string {
  const { bag, w, h, baseCurve } = frame;
  const passes = stage.passes.slice(0, through + 1);
  let params = "";
  for (const pass of passes) {
    for (const b of pass.bindings) params += `${b.qualifiedKey}=${String(boundValue(bag, b))};`;
  }
  const sources = passes.map(sourceHash).join(",");
  const counts = stage.passes.map((p) => passDraws(p, bag));
  const draws = counts.slice(0, through + 1).join(",");
  const then = counts.slice(through + 1).some((n) => n > 0) ? 1 : 0;
  return `${srcSig}|${frame.sourceWidth}x${frame.sourceHeight}|${w}x${h}|${frame.linear ? 1 : 0}${frame.isFallbackPreview ? 1 : 0}${baseCurve}|pv${frame.processVersion}|src:${sources}|${params}|draws:${draws}|then:${then}`;
}
