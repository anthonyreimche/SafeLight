// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Tests for the shared type-to-jump matcher behind dropdowns and menus.

import { describe, it, expect } from "vitest";
import { createTypeahead, isTypeaheadKey } from "./typeahead";

const LABELS = ["Apple", "Apricot", "Banana", "Blueberry", "Cherry"];

describe("isTypeaheadKey", () => {
  it("accepts a printable character without a command modifier", () => {
    expect(isTypeaheadKey({ key: "a", ctrlKey: false, metaKey: false, altKey: false })).toBe(true);
    expect(isTypeaheadKey({ key: "A", ctrlKey: false, metaKey: false, altKey: false })).toBe(true);
  });

  it("leaves named keys and shortcut chords alone", () => {
    expect(isTypeaheadKey({ key: "ArrowDown", ctrlKey: false, metaKey: false, altKey: false })).toBe(false);
    expect(isTypeaheadKey({ key: "a", ctrlKey: true, metaKey: false, altKey: false })).toBe(false);
    expect(isTypeaheadKey({ key: "a", ctrlKey: false, metaKey: true, altKey: false })).toBe(false);
    expect(isTypeaheadKey({ key: "a", ctrlKey: false, metaKey: false, altKey: true })).toBe(false);
  });
});

describe("createTypeahead", () => {
  it("jumps to the first label after the current one that starts with the letter", () => {
    const t = createTypeahead();
    expect(t.match(LABELS, "b", -1, 0)).toBe(2);
  });

  it("cycles through labels sharing a letter when that letter is pressed again", () => {
    const t = createTypeahead();
    expect(t.match(LABELS, "b", 0, 0)).toBe(2);
    expect(t.match(LABELS, "b", 2, 100)).toBe(3);
    expect(t.match(LABELS, "b", 3, 200)).toBe(2);
  });

  it("moves off the current item when its own letter is pressed", () => {
    const t = createTypeahead();
    expect(t.match(LABELS, "a", 0, 0)).toBe(1);
  });

  it("narrows with a typed prefix, keeping the current item while it still matches", () => {
    const t = createTypeahead();
    expect(t.match(LABELS, "b", 0, 0)).toBe(2);
    expect(t.match(LABELS, "l", 2, 100)).toBe(3);
    expect(t.match(LABELS, "u", 3, 200)).toBe(3);
  });

  it("ignores case and leading spaces in labels", () => {
    const t = createTypeahead();
    expect(t.match(["  cherry", "Date"], "C", -1, 0)).toBe(0);
  });

  it("starts a fresh search once typing pauses", () => {
    const t = createTypeahead();
    expect(t.match(LABELS, "b", 0, 0)).toBe(2);
    expect(t.match(LABELS, "c", 2, 2_000)).toBe(4);
    expect(t.match(LABELS, "a", 4, 4_000)).toBe(0);
  });

  it("skips labels the caller marks unavailable", () => {
    const t = createTypeahead();
    expect(t.match(LABELS, "b", 0, 0, (i) => i !== 2)).toBe(3);
  });

  it("reports no match without losing what was typed", () => {
    const t = createTypeahead();
    expect(t.match(LABELS, "z", 0, 0)).toBe(-1);
    expect(t.active(100)).toBe(true);
    expect(t.active(5_000)).toBe(false);
  });
});
