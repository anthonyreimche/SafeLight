// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, expect, it } from "vitest";
import { rawCacheKey } from "./raw-cache";

describe("rawCacheKey", () => {
  // Cached previews bake the decode in, so the key carries the decode contract:
  // entries written before the white-point fix must miss, not be served dark.
  it("versions the decode contract ahead of the file identity", () => {
    expect(rawCacheKey("2026/DSCF2946.RAF", 31_457_280, 90)).toBe(
      "v5:2026/DSCF2946.RAF:31457280:90",
    );
  });
});
