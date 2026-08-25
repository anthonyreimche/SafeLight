// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The coverage-overlay target: hover wins, else the selected mask when its
// editor is on the Coverage tab. Ids can go stale (undo, delete-under-pointer
// races) — a stale id must fall through instead of blanking the overlay.

import { describe, expect, it } from "vitest";
import { resolveVizMaskIndex } from "./mask-viz";

const masks = [{ id: "a" }, { id: "b" }];

describe("resolveVizMaskIndex", () => {
  it("prefers the hovered mask, on either tab", () => {
    expect(resolveVizMaskIndex(masks, "b", "a", "coverage")).toBe(1);
    expect(resolveVizMaskIndex(masks, "b", null, "adjust")).toBe(1);
  });

  it("falls back to the selected mask when the hovered id is stale", () => {
    expect(resolveVizMaskIndex(masks, "gone", "a", "coverage")).toBe(0);
  });

  it("shows the selected mask only on the Coverage tab", () => {
    expect(resolveVizMaskIndex(masks, null, "a", "coverage")).toBe(0);
    expect(resolveVizMaskIndex(masks, null, "a", "adjust")).toBe(-1);
  });

  it("resolves to none when every id is stale or absent", () => {
    expect(resolveVizMaskIndex(masks, "gone", "gone-too", "coverage")).toBe(-1);
    expect(resolveVizMaskIndex(masks, null, null, "coverage")).toBe(-1);
    expect(resolveVizMaskIndex([], "a", "a", "coverage")).toBe(-1);
  });
});
