// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, it, expect } from "vitest";
import { adoptSidecar } from "./sidecar";

describe("adoptSidecar keywords", () => {
  it("keeps each keyword once, in the order it came", () => {
    expect(adoptSidecar({ keywords: ["dawn", "sea", "dawn", "sea", "fog"] }).keywords).toEqual([
      "dawn",
      "sea",
      "fog",
    ]);
  });

  it("keeps at most 1000 keywords", () => {
    const keywords = Array.from({ length: 5000 }, (_, i) => `k${i}`);

    const adopted = adoptSidecar({ keywords: [...keywords, ...keywords] }).keywords;

    expect(adopted).toEqual(keywords.slice(0, 1000));
  });

  it("drops a keyword longer than 512 characters rather than cutting it", () => {
    const long = "x".repeat(513);

    const adopted = adoptSidecar({ keywords: ["a", long, "y".repeat(512)] }).keywords;

    expect(adopted).toEqual(["a", "y".repeat(512)]);
  });
});
