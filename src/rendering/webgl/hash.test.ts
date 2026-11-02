// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Program and pass caches key on these hashes, so a value change recompiles
// every cached program and changes every stage signature: pinned exactly.

import { describe, expect, it } from "vitest";
import { simpleHash } from "./hash";

describe("simpleHash", () => {
  it("gives the base-36 djb2-style hash the caches key on", () => {
    expect(simpleHash("")).toBe("0");
    expect(simpleHash("a")).toBe("2p");
    expect(simpleHash("c = vec3(1.0);")).toBe(simpleHash("c = vec3(1.0);"));
    expect(simpleHash("a")).not.toBe(simpleHash("b"));
  });
});
