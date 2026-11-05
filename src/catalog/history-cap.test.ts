// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Bounding an edit history: the seed stays, and so does a window of entries
// around the cursor, so undo, redo and the open look all survive compaction.

import { describe, expect, it } from "vitest";
import type { EditSnapshot, EditState } from "./types";
import { DEFAULT_DEVELOP_PARAMS } from "./types";
import { compactHistory } from "./history-cap";

function snapshot(label: string): EditSnapshot {
  return { timestamp: 0, label, params: { ...DEFAULT_DEVELOP_PARAMS } };
}

/** A history of `seed` then `length - 1` entries labelled e1, e2, … */
function history(length: number, currentIndex: number, seed = "Original"): EditState {
  const stack = [seed, ...Array.from({ length: length - 1 }, (_, i) => `e${i + 1}`)];
  return { photoId: "p1", stack: stack.map(snapshot), currentIndex };
}

function labels(edit: EditState): string[] {
  return edit.stack.map((entry) => entry.label);
}

/** The label the cursor is on. */
function at(edit: EditState): string {
  return edit.stack[edit.currentIndex].label;
}

describe("compactHistory", () => {
  it("keeps the seed and the newest `cap` entries when the cursor is on the newest", () => {
    const compacted = compactHistory(history(10, 9), 3);
    expect(labels(compacted)).toEqual(["Original", "e7", "e8", "e9"]);
    expect(at(compacted)).toBe("e9");
  });

  it("keeps a cursor a few undos back inside the newest window", () => {
    const compacted = compactHistory(history(10, 7), 3);
    expect(labels(compacted)).toEqual(["Original", "e7", "e8", "e9"]);
    expect(at(compacted)).toBe("e7");
  });

  it("starts the window at a cursor older than the newest window, keeping its redo tail", () => {
    const compacted = compactHistory(history(10, 3), 3);
    expect(labels(compacted)).toEqual(["Original", "e3", "e4", "e5"]);
    expect(at(compacted)).toBe("e3");
  });

  it("keeps the entries just after the seed when the cursor is on the seed", () => {
    const compacted = compactHistory(history(10, 0), 3);
    expect(labels(compacted)).toEqual(["Original", "e1", "e2", "e3"]);
    expect(compacted.currentIndex).toBe(0);
  });

  it("keeps a seed that isn't an Original", () => {
    const compacted = compactHistory(history(6, 5, "Pasted settings"), 2);
    expect(labels(compacted)).toEqual(["Pasted settings", "e4", "e5"]);
    expect(at(compacted)).toBe("e5");
  });

  it("returns a history within the cap as it is", () => {
    const short = history(3, 1);
    expect(compactHistory(short, 5)).toBe(short);
    const exact = history(4, 2);
    expect(compactHistory(exact, 3)).toBe(exact);
  });

  it("returns an empty history as it is", () => {
    const empty: EditState = { photoId: "p1", stack: [], currentIndex: 0 };
    expect(compactHistory(empty, 3)).toBe(empty);
  });

  it("keeps the photo id and leaves the history it was given unchanged", () => {
    const edit = history(10, 9);
    const before = structuredClone(edit);
    expect(compactHistory(edit, 3).photoId).toBe("p1");
    expect(edit).toEqual(before);
  });

  it("reads a damaged cursor as every reader does", () => {
    expect(at(compactHistory(history(10, 99), 3))).toBe("e9");
    expect(at(compactHistory(history(10, Number.NaN), 3))).toBe("e9");
    const before = compactHistory(history(10, -4), 3);
    expect(labels(before)).toEqual(["Original", "e1", "e2", "e3"]);
    expect(before.currentIndex).toBe(0);
    expect(at(compactHistory(history(10, 3.6), 3))).toBe("e3");
  });

  describe("cap edge values", () => {
    it("keeps the seed and the cursor's entry at a cap of 1", () => {
      expect(labels(compactHistory(history(10, 9), 1))).toEqual(["Original", "e9"]);
      const older = compactHistory(history(10, 4), 1);
      expect(labels(older)).toEqual(["Original", "e4"]);
      expect(at(older)).toBe("e4");
    });

    it("reads a cap below 1 as 1, so the cursor's entry always stays", () => {
      expect(labels(compactHistory(history(10, 9), 0))).toEqual(["Original", "e9"]);
      expect(labels(compactHistory(history(10, 9), -5))).toEqual(["Original", "e9"]);
    });

    it("rounds a fractional cap down", () => {
      expect(labels(compactHistory(history(10, 9), 2.9))).toEqual(["Original", "e8", "e9"]);
    });

    it("bounds nothing at a cap of Infinity or one that isn't a number", () => {
      const edit = history(10, 4);
      expect(compactHistory(edit, Number.POSITIVE_INFINITY)).toBe(edit);
      expect(compactHistory(edit, Number.NaN)).toBe(edit);
    });

    it("keeps everything but the oldest entry at a cap one short of the history", () => {
      const compacted = compactHistory(history(10, 9), 8);
      expect(labels(compacted)).toEqual(["Original", "e2", "e3", "e4", "e5", "e6", "e7", "e8", "e9"]);
    });
  });
});
