// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A kept pass's checkpoint is reused while the signature of everything up to
// that pass holds: the source, the size, the linearization, the process
// version, and the values and draw counts of that pass and every pass before
// it. Nothing after the pass may reach it, except whether anything draws there
// at all, which decides whether the pass's last draw is the stage's last.

import { describe, expect, it } from "vitest";
import { prefixSig, type SigFrame } from "./prepass-signature";
import type { ContributedBinding, PrepassPass, PrepassStage } from "./stage-injection";

const ID = "acme.keep";

const binding = (key: string): ContributedBinding => ({
  qualifiedKey: `${ID}.${key}`,
  glslName: `u_${key}`,
  glslType: "float",
  default: 0,
});

const pass = (key: string, iterations: number, over: Partial<PrepassPass> = {}): PrepassPass => ({
  fragmentSource: `void main() { /* ${key} */ }`,
  iterations,
  bindings: [binding(key)],
  ...over,
});

const STAGE: PrepassStage = {
  stageId: ID,
  resultUniform: "u_result",
  passes: [
    pass("u0", 4, { keep: true }),
    pass("u1", 3, { keep: true, drawCount: { qualifiedKey: `${ID}.n1`, max: 6, fallback: 3 } }),
    pass("u2", 2, { drawCount: { qualifiedKey: `${ID}.n2`, max: 4, fallback: 2 } }),
  ],
};

const FRAME: SigFrame = {
  bag: { [`${ID}.u0`]: 0.25, [`${ID}.u1`]: 0.5, [`${ID}.u2`]: 0.75, [`${ID}.n1`]: 3, [`${ID}.n2`]: 2 },
  w: 64,
  h: 48,
  baseCurve: 0,
  linear: true,
  isFallbackPreview: false,
  processVersion: 2,
  sourceWidth: 6000,
  sourceHeight: 4000,
};

const SRC = "e1";

const sigAt = (through: number, frame: SigFrame = FRAME, stage: PrepassStage = STAGE, srcSig = SRC): string =>
  prefixSig(stage, frame, srcSig, through);

const withBag = (over: Record<string, unknown>): SigFrame => ({ ...FRAME, bag: { ...FRAME.bag, ...over } });

const withIterations = (index: number, iterations: number): PrepassStage => ({
  ...STAGE,
  passes: STAGE.passes.map((p, i) => (i === index ? { ...p, iterations } : p)),
});

describe("prefixSig", () => {
  it.each([0, 1, 2])("changes with a uniform value of pass %i and every pass after it", (changed) => {
    const frame = withBag({ [`${ID}.u${changed}`]: 0.125 });
    for (let through = 0; through < 3; through++) {
      const moved = sigAt(through, frame) !== sigAt(through);
      expect(moved, `through pass ${through}`).toBe(through >= changed);
    }
  });

  it("changes with a draw count read from the bag, at that pass and after", () => {
    const frame = withBag({ [`${ID}.n1`]: 5 });
    expect(sigAt(0, frame)).toBe(sigAt(0));
    expect(sigAt(1, frame)).not.toBe(sigAt(1));
    expect(sigAt(2, frame)).not.toBe(sigAt(2));
  });

  it("changes with a fixed draw count, at that pass and after", () => {
    expect(sigAt(0, FRAME, withIterations(0, 5))).not.toBe(sigAt(0));
    expect(sigAt(1, FRAME, withIterations(0, 5))).not.toBe(sigAt(1));
    expect(sigAt(0, FRAME, withIterations(1, 5))).toBe(sigAt(0));
  });

  it("changes when nothing after the pass draws any more", () => {
    expect(sigAt(0, withBag({ [`${ID}.n1`]: 0, [`${ID}.n2`]: 0 }))).not.toBe(sigAt(0));
    expect(sigAt(0, withBag({ [`${ID}.n2`]: 0 }))).toBe(sigAt(0));
    expect(sigAt(1, withBag({ [`${ID}.n2`]: 0 }))).not.toBe(sigAt(1));
    expect(sigAt(1, withBag({ [`${ID}.n2`]: 3 }))).toBe(sigAt(1));
  });

  it("changes with the source, the split token folded into it, and the size", () => {
    for (let through = 0; through < 3; through++) {
      expect(sigAt(through, FRAME, STAGE, "e2")).not.toBe(sigAt(through));
      expect(sigAt(through, FRAME, STAGE, `${SRC}|split:7`)).not.toBe(sigAt(through, FRAME, STAGE, `${SRC}|split:8`));
      expect(sigAt(through, { ...FRAME, w: 32 })).not.toBe(sigAt(through));
      expect(sigAt(through, { ...FRAME, h: 32 })).not.toBe(sigAt(through));
    }
  });

  it("changes with the decoded source's size alone, which passes read as uSourceSize", () => {
    for (let through = 0; through < 3; through++) {
      expect(sigAt(through, { ...FRAME, sourceWidth: 3000 })).not.toBe(sigAt(through));
      expect(sigAt(through, { ...FRAME, sourceHeight: 2000 })).not.toBe(sigAt(through));
    }
  });

  it("changes with the linearization, the fallback preview, the base curve and the process version", () => {
    for (let through = 0; through < 3; through++) {
      expect(sigAt(through, { ...FRAME, linear: false })).not.toBe(sigAt(through));
      expect(sigAt(through, { ...FRAME, isFallbackPreview: true })).not.toBe(sigAt(through));
      expect(sigAt(through, { ...FRAME, baseCurve: 1 })).not.toBe(sigAt(through));
      expect(sigAt(through, { ...FRAME, processVersion: 1 })).not.toBe(sigAt(through));
    }
  });

  it.each([0, 1, 2])("changes with the source of pass %i and every pass after it", (changed) => {
    const edited: PrepassStage = {
      ...STAGE,
      passes: STAGE.passes.map((p, i) =>
        i === changed ? { ...p, fragmentSource: `${p.fragmentSource}\n// edited`, vertexSource: "void main() {}" } : p,
      ),
    };
    for (let through = 0; through < 3; through++) {
      expect(sigAt(through, FRAME, edited) !== sigAt(through), `through pass ${through}`).toBe(through >= changed);
    }
  });

  it("ignores bag entries the stage doesn't bind", () => {
    const frame = withBag({ "other.stage.u0": 1, [`${ID}.inlineOnly`]: 1 });
    for (let through = 0; through < 3; through++) expect(sigAt(through, frame)).toBe(sigAt(through));
  });
});
