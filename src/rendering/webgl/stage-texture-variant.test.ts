// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, expect, it } from "vitest";
import { boundStageTextureKey, variantTextureKey } from "./stage-texture-variant";

describe("stage texture variants", () => {
  it("files a variant under the texture's key and its name", () => {
    expect(variantTextureKey("acme.stage.table", "dark-1f3a")).toBe("acme.stage.table#dark-1f3a");
  });

  it("refuses a name that could pass for part of a key, or none", () => {
    for (const bad of ["", "a.b", "a#b", "a b", "x".repeat(65), "é"]) {
      expect(variantTextureKey("acme.stage.table", bad), bad).toBeNull();
    }
  });

  it("binds the variant a photo's bag names under the texture's key", () => {
    expect(boundStageTextureKey("acme.stage.table", { "acme.stage.table": "v2" })).toBe("acme.stage.table#v2");
  });

  it("binds the plain texture when the bag names no variant, or names one badly", () => {
    expect(boundStageTextureKey("acme.stage.table", {})).toBe("acme.stage.table");
    expect(boundStageTextureKey("acme.stage.table", { "acme.stage.table": 3 })).toBe("acme.stage.table");
    expect(boundStageTextureKey("acme.stage.table", { "acme.stage.table": "a.b" })).toBe("acme.stage.table");
  });
});
