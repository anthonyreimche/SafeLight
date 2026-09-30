// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A photo's display transform lives in its develop params. Edits saved before
// the field existed must open following the Preferences default (null), so an
// upgrade never changes how an existing edit looks.

import { describe, expect, it } from "vitest";
import { DEFAULT_DEVELOP_PARAMS, normalizeParams, type DevelopParams } from "./types";

describe("normalizeParams: displayTransform", () => {
  it("defaults to null, meaning the photo follows the Preferences default", () => {
    expect(DEFAULT_DEVELOP_PARAMS.displayTransform).toBeNull();
    expect(normalizeParams(undefined).displayTransform).toBeNull();
  });

  it("gives an edit saved before the field existed the default", () => {
    expect(normalizeParams({ exposure: 1 }).displayTransform).toBeNull();
  });

  it("keeps a picked transform id", () => {
    expect(normalizeParams({ displayTransform: "rendering.agx" }).displayTransform).toBe(
      "rendering.agx",
    );
  });

  it("turns an empty or mistyped value into null", () => {
    expect(normalizeParams({ displayTransform: "" }).displayTransform).toBeNull();
    const corrupt = { displayTransform: 42 } as unknown as Partial<DevelopParams>;
    expect(normalizeParams(corrupt).displayTransform).toBeNull();
  });
});
