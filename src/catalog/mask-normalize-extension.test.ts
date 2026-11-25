// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Extension mask components (kind "extension") through normalizeParams: what a
// saved one keeps, what drops it, and that an unregistered type survives.

import { describe, expect, it } from "vitest";
import { normalizeParams, type Mask } from "./types";

function masksOf(raw: unknown[]): Mask[] {
  return normalizeParams({ masks: raw } as never).masks;
}

const ext = (extension: unknown, over: Record<string, unknown> = {}) => ({
  id: "m",
  components: [{ id: "c", kind: "extension", mode: "add", invert: false, extension, ...over }],
});

describe("extension mask components", () => {
  it("keeps a component whose type is qualified, with its values", () => {
    const [m] = masksOf([ext({ type: "acme.fuzzy.pick", values: { seeds: [[0.1, 0.2]], tol: 12 } })]);
    expect(m.components[0].kind).toBe("extension");
    expect(m.components[0].extension).toEqual({ type: "acme.fuzzy.pick", values: { seeds: [[0.1, 0.2]], tol: 12 } });
  });

  it("names an extension-first mask 'Mask', not 'extension'", () => {
    const [m] = masksOf([ext({ type: "acme.fuzzy.pick", values: {} })]);
    expect(m.name).toBe("Mask");
  });

  it.each([
    ["no extension", undefined],
    ["a missing type", { values: {} }],
    ["an empty type", { type: "", values: {} }],
    ["an unqualified type", { type: "fuzzy", values: {} }],
    ["a non-string type", { type: 4, values: {} }],
  ])("drops a component with %s", (_what, extension) => {
    expect(masksOf([ext(extension)])).toEqual([]);
  });

  it.each([
    ["missing", undefined],
    ["an array", [1, 2]],
    ["a string", "x"],
    ["null", null],
  ])("makes values {} when they are %s", (_what, values) => {
    const [m] = masksOf([ext({ type: "a.b", values })]);
    expect(m.components[0].extension).toEqual({ type: "a.b", values: {} });
  });

  it("deep-clones values, so the saved object is not shared", () => {
    const values = { nested: { n: 1 } };
    const [m] = masksOf([ext({ type: "a.b", values })]);
    expect(m.components[0].extension?.values).toEqual(values);
    expect(m.components[0].extension?.values).not.toBe(values);
    expect((m.components[0].extension?.values.nested as object)).not.toBe(values.nested);
  });

  it("empties values over 16 KB but keeps the component", () => {
    const [m] = masksOf([ext({ type: "a.b", values: { blob: "x".repeat(17 * 1024) } })]);
    expect(m.components[0].extension).toEqual({ type: "a.b", values: {} });
  });

  it("keeps values just under the cap", () => {
    const [m] = masksOf([ext({ type: "a.b", values: { blob: "x".repeat(15 * 1024) } })]);
    expect((m.components[0].extension?.values.blob as string).length).toBe(15 * 1024);
  });

  it("is idempotent", () => {
    const first = masksOf([ext({ type: "a.b", values: { k: [1, { z: true }] } })]);
    expect(masksOf(first)).toEqual(first);
  });

  it("sits beside other kinds in one mask", () => {
    const [m] = masksOf([
      {
        id: "m",
        components: [
          { id: "l", kind: "lumRange", mode: "add", invert: false, lumRange: {} },
          { id: "e", kind: "extension", mode: "subtract", invert: true, extension: { type: "a.b", values: {} } },
        ],
      },
    ]);
    expect(m.components.map((c) => c.kind)).toEqual(["lumRange", "extension"]);
    expect(m.components[1].mode).toBe("subtract");
    expect(m.name).toBe("lumRange");
  });
});
