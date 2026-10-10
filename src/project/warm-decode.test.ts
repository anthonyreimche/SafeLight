// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, expect, it } from "vitest";
import { shouldWarmDecodePool } from "./warm-decode";

describe("shouldWarmDecodePool", () => {
  it("warms the main window", () => {
    expect(shouldWarmDecodePool(null)).toBe(true);
  });

  it("warms a popped-out Develop window, which decodes RAWs", () => {
    expect(shouldWarmDecodePool("develop")).toBe(true);
  });

  it("leaves other pop-out windows cold", () => {
    expect(shouldWarmDecodePool("library")).toBe(false);
    expect(shouldWarmDecodePool("map")).toBe(false);
  });
});
