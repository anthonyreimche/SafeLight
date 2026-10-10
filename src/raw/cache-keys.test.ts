// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, expect, it } from "vitest";
import { scopeBounds, scopedKey, unscopedKey } from "./cache-keys";

const A = "D:/A/.safelight/raw";
const B = "D:/B/.safelight/raw";
const KEY = "v6:x.ARW:10:0";

describe("scoped raw-cache keys", () => {
  it("round-trips a key through its own project's scope", () => {
    expect(unscopedKey(A, scopedKey(A, KEY))).toBe(KEY);
  });

  it("doesn't hand one project's entry to another", () => {
    expect(unscopedKey(B, scopedKey(A, KEY))).toBeNull();
  });

  it("doesn't read an entry written before keys were scoped", () => {
    expect(unscopedKey(A, KEY)).toBeNull();
  });

  // One project folder can sit inside another, so its path extends the
  // other's: the scopes must still stay apart in both directions.
  it("keeps a nested project's scope apart from its parent's", () => {
    expect(unscopedKey("D:/A", scopedKey(`D:/A/.safelight/raw`, KEY))).toBeNull();
    expect(unscopedKey(`D:/A/.safelight/raw`, scopedKey("D:/A", KEY))).toBeNull();
  });
});

describe("scopeBounds", () => {
  const within = (scope: string, stored: string) => {
    const [lower, upper] = scopeBounds(scope);
    return stored >= lower && stored <= upper;
  };

  it("spans every key stored under the scope", () => {
    for (const key of ["", KEY, "v6:\u{1F4F7}.RAF:1:270", "\uffff"])
      expect(within(A, scopedKey(A, key))).toBe(true);
  });

  it("leaves out other projects and legacy unscoped entries", () => {
    expect(within(A, scopedKey(B, KEY))).toBe(false);
    expect(within(A, scopedKey(`${A}2`, KEY))).toBe(false);
    expect(within(A, scopedKey("D:/A", KEY))).toBe(false);
    expect(within("D:/A", scopedKey(A, KEY))).toBe(false);
    expect(within(A, KEY)).toBe(false);
  });
});
