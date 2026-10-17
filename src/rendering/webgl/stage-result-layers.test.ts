// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Which layer of the version 2 result array each prepass stage writes: a stage
// keeps its layer while it stays in the stage set, so its cached result
// survives turning off and on again, and the array holds no spare layers.

import { describe, expect, it } from "vitest";
import { assignLayers, layerDepth, releaseLayers } from "./stage-result-layers";

const held = (entries: [string, number][]): Map<string, number> => new Map(entries);

describe("assignLayers", () => {
  it("hands new stages the lowest free layers, in order", () => {
    expect([...assignLayers(held([]), ["a", "b"])]).toEqual([["a", 0], ["b", 1]]);
  });

  it("keeps every layer already held, asked for or not", () => {
    expect([...assignLayers(held([["a", 0], ["b", 1]]), ["b", "c"])]).toEqual([
      ["a", 0],
      ["b", 1],
      ["c", 2],
    ]);
  });

  it("reuses a freed layer before adding one", () => {
    expect([...assignLayers(held([["a", 0], ["c", 2]]), ["d", "e"])]).toEqual([
      ["a", 0],
      ["c", 2],
      ["d", 1],
      ["e", 3],
    ]);
  });
});

describe("layerDepth", () => {
  it("is the highest layer held plus one", () => {
    expect(layerDepth(held([]))).toBe(0);
    expect(layerDepth(held([["a", 0], ["c", 2]]))).toBe(3);
  });
});

describe("releaseLayers", () => {
  it("frees the layers of stages that left the set, and only those", () => {
    expect([...releaseLayers(held([["a", 0], ["b", 1], ["c", 2]]), new Set(["a", "c"]))]).toEqual([
      ["a", 0],
      ["c", 2],
    ]);
  });
});
