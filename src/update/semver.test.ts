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
});

describe("isNewer", () => {
  it("is strict (candidate must exceed current)", () => {
    expect(isNewer("0.9.0", "1.0.0")).toBe(true);
    expect(isNewer("1.0.0", "1.0.0")).toBe(false);
    expect(isNewer("1.2.0", "1.1.0")).toBe(false);
    expect(isNewer("v1.0.0", "v1.0.1")).toBe(true);
  });
});
