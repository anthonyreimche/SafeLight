// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The Extensions store's caches (registry-cache.cjs): the search cache file
// keeps one row per query ever run, so expired rows are dropped on load and on
// write, and an empty registry index is never served or cached as the catalog
// (it would blank the store until the cache expired).

import { describe, expect, it } from "vitest";
import { pruneExpired, usableIndex } from "./registry-cache.cjs";

describe("pruneExpired", () => {
  const TTL = 15 * 60 * 1000;
  const NOW = 1_000_000_000;

  it("keeps fresh entries and drops stale ones", () => {
    const map = new Map([
      ["fresh", { at: NOW - 1000, items: [] }],
      ["edge", { at: NOW - TTL, items: [] }],
      ["stale", { at: NOW - TTL - 1, items: [] }],
    ]);
    pruneExpired(map, TTL, NOW);
    expect([...map.keys()]).toEqual(["fresh"]);
  });
});

describe("usableIndex", () => {
  it("rejects a missing or empty index", () => {
    expect(usableIndex(null)).toBe(false);
    expect(usableIndex([])).toBe(false);
  });

  it("accepts an index with at least one extension", () => {
    expect(usableIndex([{ fullName: "owner/repo" }])).toBe(true);
  });
});
