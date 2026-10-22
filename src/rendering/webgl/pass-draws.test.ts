// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A pass's draws this frame: its fixed count, or the bag value its count key
// holds (the uniform's default without one), rounded and clamped to [0, max].

import { describe, expect, it } from "vitest";
import { passDraws, stageDraws } from "./pass-draws";

const keyed = { iterations: 6, drawCount: { qualifiedKey: "acme.look.draws", max: 6, fallback: 2 } };

describe("passDraws", () => {
  it("returns a fixed count as it is", () => {
    expect(passDraws({ iterations: 4 }, { "acme.look.draws": 1 })).toBe(4);
  });

  it.each([
    [3, 3],
    [2.4, 2],
    [2.5, 3],
    [0, 0],
    [-2, 0],
    [9, 6],
  ])("reads %s from the bag as %s draws", (value, draws) => {
    expect(passDraws(keyed, { "acme.look.draws": value })).toBe(draws);
  });

  it.each([[undefined], ["3"], [Number.NaN], [Number.POSITIVE_INFINITY], [[3]]])(
    "falls back to the uniform's default for %s",
    (value) => {
      expect(passDraws(keyed, { "acme.look.draws": value })).toBe(2);
    },
  );
});

describe("stageDraws", () => {
  it("adds up every pass", () => {
    const stage = { passes: [{ iterations: 2 }, keyed, { ...keyed, drawCount: { ...keyed.drawCount, fallback: 0 } }] };
    expect(stageDraws(stage, {})).toBe(4);
    expect(stageDraws(stage, { "acme.look.draws": 5 })).toBe(12);
  });

  it("is 0 when every keyed pass reads 0", () => {
    expect(stageDraws({ passes: [keyed] }, { "acme.look.draws": 0 })).toBe(0);
  });
});
