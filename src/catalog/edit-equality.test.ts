// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// sameEdit decides whether a commit changed anything. It compares the plain
// data an edit is made of; any other object matches only itself, so a value an
// extension keeps in its bag can never make a real change look like none.

import { describe, expect, it } from "vitest";
import { sameEdit } from "./edit-equality";
import {
  defaultMaskAdjustments,
  normalizeParams,
  type DevelopParams,
  type Mask,
  type RetouchSpot,
} from "./types";

const look = (
  params: Partial<DevelopParams> = {},
  paramBag: Record<string, unknown> = {},
) => ({ params: normalizeParams(params), paramBag });

const brushSpot = (lastDabX: number): RetouchSpot => ({
  id: "spot-1",
  shape: "brush",
  mode: "heal",
  visible: true,
  dstX: 0.4,
  dstY: 0.4,
  srcX: 0.6,
  srcY: 0.6,
  radius: 0.04,
  feather: 50,
  opacity: 100,
  dabs: [
    { x: 0.2, y: 0.2, radius: 0.03, erase: false, feather: 0.5 },
    { x: lastDabX, y: 0.25, radius: 0.03, erase: false, feather: 0.5 },
  ],
});

const mask = (extra: Partial<Mask> = {}): Mask => ({
  id: "mask-1",
  name: "Mask 1",
  visible: true,
  invert: false,
  opacity: 100,
  adj: defaultMaskAdjustments(),
  panels: ["core.basic"],
  components: [],
  ...extra,
});

describe("sameEdit", () => {
  it("matches an edit against itself", () => {
    const edit = look({ exposure: 1 }, { "ext.stage.amount": 40 });
    expect(sameEdit(edit, edit)).toBe(true);
  });

  it("matches an equal copy", () => {
    const edit = look({ exposure: 1, retouch: [brushSpot(0.3)] }, { "ext.stage.amount": 40 });
    expect(sameEdit(edit, structuredClone(edit))).toBe(true);
    expect(
      sameEdit(edit, look({ exposure: 1, retouch: [brushSpot(0.3)] }, { "ext.stage.amount": 40 })),
    ).toBe(true);
  });

  it("tells apart edits whose one nested dab moved", () => {
    expect(
      sameEdit(look({ retouch: [brushSpot(0.3)] }), look({ retouch: [brushSpot(0.31)] })),
    ).toBe(false);
  });

  it("tells apart bags where one has an extra key", () => {
    expect(
      sameEdit(look({}, { "a.stage.k": 1 }), look({}, { "a.stage.k": 1, "b.stage.k": 2 })),
    ).toBe(false);
  });

  it("never matches an array with an object of the same entries", () => {
    expect(
      sameEdit(look({}, { "a.stage.k": [1, 2] }), look({}, { "a.stage.k": { 0: 1, 1: 2 } })),
    ).toBe(false);
  });

  it("matches NaN with NaN", () => {
    expect(sameEdit(look({}, { "a.stage.k": NaN }), look({}, { "a.stage.k": NaN }))).toBe(true);
  });

  it("matches a Map or a Date only by identity", () => {
    const shared = new Map([["k", 1]]);
    expect(sameEdit(look({}, { "a.stage.k": shared }), look({}, { "a.stage.k": shared })))
      .toBe(true);
    const map = () => new Map([["k", 1]]);
    expect(sameEdit(look({}, { "a.stage.k": map() }), look({}, { "a.stage.k": map() })))
      .toBe(false);
    expect(
      sameEdit(look({}, { "a.stage.k": new Date(0) }), look({}, { "a.stage.k": new Date(0) })),
    ).toBe(false);
  });

  it("treats a key set to undefined as a missing key", () => {
    const withUndefinedBag = look();
    withUndefinedBag.params.masks = [mask({ bag: undefined })];
    const withoutBag = look();
    withoutBag.params.masks = [mask()];
    expect(sameEdit(withUndefinedBag, withoutBag)).toBe(true);
  });

  it("compares typed arrays element by element", () => {
    const values = () => new Float32Array([0.1, 0.5, 0.9]);
    expect(sameEdit(look({}, { "a.stage.lut": values() }), look({}, { "a.stage.lut": values() })))
      .toBe(true);
    const changed = values();
    changed[1] = 0.6;
    expect(sameEdit(look({}, { "a.stage.lut": values() }), look({}, { "a.stage.lut": changed })))
      .toBe(false);
    expect(
      sameEdit(
        look({}, { "a.stage.lut": new Uint8Array([1, 2]) }),
        look({}, { "a.stage.lut": new Int8Array([1, 2]) }),
      ),
    ).toBe(false);
  });
});
