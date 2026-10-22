// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, expect, it } from "vitest";
import { formatArg } from "./format-arg";

describe("formatArg", () => {
  it("formats objects in node, where there is no Element global", () => {
    expect(typeof globalThis.Element).toBe("undefined");
    expect(formatArg({ a: 1 })).toBe('{"a":1}');
  });

  it("marks circular references", () => {
    const o: { self?: unknown } = {};
    o.self = o;
    expect(formatArg(o)).toBe('{"self":"[Circular]"}');
  });
});
