// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, it, expect } from "vitest";
import { previewUprightRotation } from "./orient";

// Landscape sensor dims and portrait (pre-uprighted) dims for the aspect gate.
const LAND = { w: 6000, h: 4000 };
const PORT = { w: 4000, h: 6000 };

describe("previewUprightRotation", () => {
  it("applies the full EXIF rotation to a sensor-native (landscape) preview", () => {
    // Orientation 6 → 90° upright. A still-landscape preview is sensor-native.
    expect(previewUprightRotation(LAND.w, LAND.h, 90, 6)).toBe(90);
    // Orientation 8 → 270°.
    expect(previewUprightRotation(LAND.w, LAND.h, 270, 8)).toBe(270);
  });

  it("leaves an already-uprighted (portrait) quarter-turn preview unrotated", () => {
    // The camera baked the rotation into the preview pixels already.
    expect(previewUprightRotation(PORT.w, PORT.h, 90, 6)).toBe(0);
    expect(previewUprightRotation(PORT.w, PORT.h, 270, 8)).toBe(0);
  });

  it("does nothing for an upright (orientation 1) landscape preview", () => {
    expect(previewUprightRotation(LAND.w, LAND.h, 0, 1)).toBe(0);
    expect(previewUprightRotation(LAND.w, LAND.h, 0, undefined)).toBe(0);
  });

  it("applies 180° regardless of aspect (can't be told apart by aspect)", () => {
    expect(previewUprightRotation(LAND.w, LAND.h, 180, 3)).toBe(180);
  });

  it("always applies the manual portion on top of the EXIF portion", () => {
    // photo.rotation 180 with EXIF orientation 6 (90°) → 90° manual turn.
    // Sensor-native preview: 90 (EXIF) + 90 (manual) = 180.
    expect(previewUprightRotation(LAND.w, LAND.h, 180, 6)).toBe(180);
    // Pre-uprighted preview: EXIF portion gated to 0, manual 90 still applies.
    expect(previewUprightRotation(PORT.w, PORT.h, 180, 6)).toBe(90);
  });
});
