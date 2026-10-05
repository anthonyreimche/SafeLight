// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The one rule every reader of a stored edit uses to turn its history cursor
// into a snapshot index. Whatever was persisted, numeric or not, the result is
// an index inside the stack.

import { describe, expect, it } from "vitest";
import { historyCursor } from "./history-cursor";

describe("historyCursor", () => {
  it.each<[currentIndex: unknown, length: number, expected: number]>([
    [0, 3, 0],
    [2, 3, 2],
    [-3, 3, 0],
    [99, 3, 2],
    [1.7, 3, 1],
    [NaN, 3, 2],
    [Infinity, 3, 2],
    [-Infinity, 3, 0],
    [5, 1, 0],
    [undefined, 3, 2],
    [null, 3, 2],
    ["abc", 3, 2],
  ])("(%s, %s) resolves to %s", (currentIndex, length, expected) => {
    expect(historyCursor(currentIndex, length)).toBe(expected);
  });
});
