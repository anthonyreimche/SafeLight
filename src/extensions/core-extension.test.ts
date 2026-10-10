// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The ids only Safelight's own extensions may hold. electron/extension-origins.cjs
// states the same rule for the main process, and its test holds the same table.

import { describe, expect, it } from "vitest";
import { isReservedExtensionId } from "./core-extension";

describe("isReservedExtensionId", () => {
  it.each(["core", "core.x", "CORE", "Core.Tools"])("reserves %s", (id) => {
    expect(isReservedExtensionId(id)).toBe(true);
  });

  it.each(["corel", "coreutils", "my.core", "acme.core.x"])(
    "leaves %s to external extensions",
    (id) => {
      expect(isReservedExtensionId(id)).toBe(false);
    },
  );
});
