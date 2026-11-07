// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// View-only stage values (api.develop.setViewValues): what an extension asks
// the live view to draw over its own stages' values, such as a hovered
// layer's highlight. Never part of the edit.

import { afterEach, describe, expect, it } from "vitest";
import { ownStageValues, setStageViewValues, useStageViewValues } from "./stage-view-values";

const stages = [
  { id: "paint.composite", extensionId: "paint" },
  { id: "other.glow", extensionId: "other" },
];

afterEach(() => {
  setStageViewValues("paint", null);
  setStageViewValues("other", null);
});

describe("ownStageValues", () => {
  it("keeps only the keys of the extension's own stages", () => {
    const values = { "paint.composite.highlight": 1, "other.glow.amount": 9, "paint.compositeX.y": 2, loose: 3 };
    expect(ownStageValues("paint", values, stages)).toEqual({ "paint.composite.highlight": 1 });
  });
});

describe("setStageViewValues", () => {
  it("merges every extension's values for the live view", () => {
    setStageViewValues("paint", { "paint.composite.highlight": 1 });
    setStageViewValues("other", { "other.glow.amount": 2 });
    expect(useStageViewValues.getState().merged).toEqual({
      "paint.composite.highlight": 1,
      "other.glow.amount": 2,
    });
  });

  it("replaces an extension's values, and null clears only its own", () => {
    setStageViewValues("paint", { "paint.composite.highlight": 1 });
    setStageViewValues("paint", { "paint.composite.strength": 0.5 });
    setStageViewValues("other", { "other.glow.amount": 2 });
    setStageViewValues("paint", null);
    expect(useStageViewValues.getState().merged).toEqual({ "other.glow.amount": 2 });
  });

  it("keeps the same empty object while nothing is set", () => {
    const empty = useStageViewValues.getState().merged;
    setStageViewValues("paint", {});
    setStageViewValues("paint", null);
    expect(useStageViewValues.getState().merged).toBe(empty);
    expect(empty).toEqual({});
  });
});
