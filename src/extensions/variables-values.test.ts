// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, expect, it } from "vitest";
import { estimateSize, frozenCopy, jsonEqual, nameProblem, valueProblem } from "./variables-values";

describe("nameProblem", () => {
  it("accepts module-style names", () => {
    for (const n of ["map.overlays", "gps-track.state", "a", "x_1-2.y", "x".repeat(128)])
      expect(nameProblem(n)).toBeNull();
  });

  it("refuses names outside the module-id rule", () => {
    for (const n of ["", "Map.overlays", ".x", "-x", "a b", "a/b", "x".repeat(129)])
      expect(nameProblem(n)).toMatch(/^invalid variable name /);
  });

  it("reserves core and core.*", () => {
    expect(nameProblem("core")).toBe('variable name "core" is reserved for core');
    expect(nameProblem("core.theme")).toBe('variable name "core.theme" is reserved for core');
    expect(nameProblem("corey.x")).toBeNull();
  });
});

describe("valueProblem", () => {
  it("accepts JSON data", () => {
    expect(valueProblem({ a: [1, "two", true, null, { b: -0.5 }], c: {} })).toBeNull();
    expect(valueProblem(Object.create(null))).toBeNull();
    expect(valueProblem("x")).toBeNull();
    const shared = { x: 1 };
    expect(valueProblem({ p: shared, q: shared })).toBeNull();
  });

  it("allows undefined object properties", () => {
    expect(valueProblem({ ele: undefined, lat: 1 })).toBeNull();
  });

  it("names the path of the first value that isn't JSON data", () => {
    expect(valueProblem({ track: { segments: [[{ t: 1 }, { t: NaN }]] } })).toBe("value.track.segments[0][1].t: NaN");
    expect(valueProblem([1, undefined])).toBe("value[1]: undefined");
    expect(valueProblem(undefined)).toBe("value: undefined");
    expect(valueProblem({ f: () => 1 })).toBe("value.f: function");
    expect(valueProblem({ "a b": Infinity })).toBe('value["a b"]: Infinity');
    expect(valueProblem({ n: 10n })).toBe("value.n: bigint");
    expect(valueProblem({ s: Symbol("x") })).toBe("value.s: symbol");
  });

  it("refuses dates, maps, sets, binary data and class instances", () => {
    class Point {
      x = 1;
    }
    expect(valueProblem({ d: new Date(0) })).toBe("value.d: Date instance");
    expect(valueProblem(new Map())).toBe("value: Map instance");
    expect(valueProblem(new Set())).toBe("value: Set instance");
    expect(valueProblem({ p: new Float64Array(2) })).toBe("value.p: binary data");
    expect(valueProblem(new ArrayBuffer(4))).toBe("value: binary data");
    expect(valueProblem(new Point())).toBe("value: Point instance");
  });

  it("refuses empty array slots and circular references", () => {
    // eslint-disable-next-line no-sparse-arrays
    expect(valueProblem([1, , 3])).toBe("value[1]: empty slot");
    const o: Record<string, unknown> = {};
    o.self = o;
    expect(valueProblem(o)).toBe("value.self: circular reference");
  });

  it("starts the path with the prefix it is given", () => {
    expect(valueProblem(NaN, "initial")).toBe("initial: NaN");
  });
});

describe("frozenCopy", () => {
  it("deep-copies and freezes, dropping undefined properties", () => {
    const src = { a: [{ b: 1 }], u: undefined };
    const out = frozenCopy(src);
    expect(out).toEqual({ a: [{ b: 1 }] });
    expect("u" in out).toBe(false);
    expect(out).not.toBe(src);
    expect(out.a).not.toBe(src.a);
    expect(Object.isFrozen(out)).toBe(true);
    expect(Object.isFrozen(out.a)).toBe(true);
    expect(Object.isFrozen(out.a[0])).toBe(true);
    src.a[0].b = 2;
    expect(out.a[0].b).toBe(1);
  });

  it("returns primitives unchanged", () => {
    expect(frozenCopy(3)).toBe(3);
    expect(frozenCopy("s")).toBe("s");
    expect(frozenCopy(null)).toBeNull();
  });

  it("keeps an own __proto__ key as data, not as the copy's prototype", () => {
    const original = JSON.parse('{"__proto__":{"x":1}}') as Record<string, unknown>;
    const copy = frozenCopy(original);
    expect(Object.keys(copy)).toContain("__proto__");
    expect(copy.x).toBeUndefined();
    expect(jsonEqual(original, copy)).toBe(true);
  });
});

describe("jsonEqual", () => {
  it("compares structure, not identity", () => {
    expect(jsonEqual({ a: [1, { b: null }] }, { a: [1, { b: null }] })).toBe(true);
    expect(jsonEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(jsonEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
    expect(jsonEqual([1, 2], [2, 1])).toBe(false);
    expect(jsonEqual({}, [])).toBe(false);
    expect(jsonEqual(null, {})).toBe(false);
    expect(jsonEqual(1, 1)).toBe(true);
  });
});

describe("estimateSize", () => {
  it("counts 2 bytes a string character and 8 a number, boolean or null", () => {
    expect(estimateSize("abc")).toBe(6);
    expect(estimateSize(1)).toBe(8);
    expect(estimateSize([true, null])).toBe(16);
    expect(estimateSize({ ab: 1 })).toBe(4 + 8);
  });
});
