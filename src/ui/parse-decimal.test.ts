// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, expect, it } from "vitest";
import { parseDecimal } from "./parse-decimal";

describe("parseDecimal", () => {
  it("reads integers and signs", () => {
    expect(parseDecimal("200")).toBe(200);
    expect(parseDecimal(" -3 ")).toBe(-3);
    expect(parseDecimal("+4")).toBe(4);
  });

  it("takes a comma or a dot as the decimal separator", () => {
    expect(parseDecimal("1,5")).toBe(1.5);
    expect(parseDecimal("1.5")).toBe(1.5);
    expect(parseDecimal("-,5")).toBe(-0.5);
    expect(parseDecimal("2,")).toBe(2);
  });

  it("rejects grouping, repeated separators and garbage", () => {
    expect(parseDecimal("1,234.5")).toBeNaN();
    expect(parseDecimal("1.2.3")).toBeNaN();
    expect(parseDecimal("1,,5")).toBeNaN();
    expect(parseDecimal("")).toBeNaN();
    expect(parseDecimal("-")).toBeNaN();
    expect(parseDecimal(".")).toBeNaN();
    expect(parseDecimal("abc")).toBeNaN();
    expect(parseDecimal("1e3")).toBeNaN();
  });
});
