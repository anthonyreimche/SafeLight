// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Tests for the shared semver helper. Run with `npm test`.

import { describe, it, expect } from "vitest";
import { parseSemver, compareSemver, isNewer } from "./semver.ts";

describe("parseSemver", () => {
  it("handles v-prefix, missing components, and garbage", () => {
    expect(parseSemver("v1.2.3")).toEqual([1, 2, 3]);
    expect(parseSemver("1.2.3")).toEqual([1, 2, 3]);
    expect(parseSemver("1.2")).toEqual([1, 2, 0]);
    expect(parseSemver("3")).toEqual([3, 0, 0]);
    expect(parseSemver("v1.2.3-beta.1")).toEqual([1, 2, 3]);
    expect(parseSemver("not-a-version")).toEqual([0, 0, 0]);
  });
});

describe("compareSemver", () => {
  it("orders across major/minor/patch", () => {
    expect(compareSemver("1.2.3", "v1.2.3")).toBe(0);
    expect(compareSemver("1.2.4", "1.2.3")).toBe(1);
    expect(compareSemver("1.1.9", "1.2.0")).toBe(-1);
    expect(compareSemver("2.0.0", "1.9.9")).toBe(1);
  });

  it("ranks a pre-release below its full release", () => {
    expect(compareSemver("1.2.3-beta.1", "1.2.3")).toBe(-1);
    expect(compareSemver("1.2.3", "v1.2.3-rc.2")).toBe(1);
    expect(compareSemver("1.2.3-beta.1", "1.2.3-beta.1")).toBe(0);
  });

  it("orders pre-release identifiers per semver §11", () => {
    expect(compareSemver("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
    expect(compareSemver("1.0.0-alpha.1", "1.0.0-beta")).toBe(-1);
    expect(compareSemver("1.0.0-beta.2", "1.0.0-beta.11")).toBe(-1);
    expect(compareSemver("1.0.0-rc.1", "1.0.0-1")).toBe(1);
  });

  it("ignores build metadata after the pre-release suffix", () => {
    expect(compareSemver("1.2.3-beta.1+build.5", "1.2.3-beta.1")).toBe(0);
  });
});

describe("isNewer", () => {
  it("is strict (candidate must exceed current)", () => {
    expect(isNewer("0.9.0", "1.0.0")).toBe(true);
    expect(isNewer("1.0.0", "1.0.0")).toBe(false);
    expect(isNewer("1.2.0", "1.1.0")).toBe(false);
    expect(isNewer("v1.0.0", "v1.0.1")).toBe(true);
  });

  it("sees the full release as newer than the pre-release build", () => {
    expect(isNewer("2.6.0-beta.1", "v2.6.0")).toBe(true);
    expect(isNewer("2.6.0", "v2.6.0-beta.1")).toBe(false);
    expect(isNewer("2.6.0-beta.1", "v2.6.0-beta.2")).toBe(true);
  });
});
