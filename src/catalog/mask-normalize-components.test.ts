// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Characterization of how saved masks and retouch spots are normalised on
// load (normalizeMasks / normalizeRetouch in types.ts, reached through
// normalizeParams): legacy single-geometry masks, component modes, geometry
// clamps, dab filtering, and the MAX_MASKS / MAX_RETOUCH caps.

import { describe, expect, it } from "vitest";
import {
  LEGACY_MASK_PANELS,
  normalizeParams,
  type LinearMaskGeo,
  type LumRangeGeo,
  type Mask,
  type RadialMaskGeo,
  type RetouchSpot,
} from "./types";

// Persisted shapes as they come off disk: older saves carry a top-level `type`
// plus geometry instead of `components`, and nothing is guaranteed numeric.
interface RawDab {
  x?: unknown;
  y?: number;
  radius?: number;
  erase?: boolean;
  feather?: number;
  opacity?: number;
  flow?: number;
}

interface RawBrush {
  feather?: number;
  dabs?: (RawDab | null)[];
}

interface RawComponent {
  id?: string;
  kind?: string;
  mode?: string;
  invert?: boolean;
  linear?: Partial<LinearMaskGeo>;
  radial?: Partial<RadialMaskGeo>;
  brush?: RawBrush;
  lumRange?: Partial<LumRangeGeo>;
}

interface RawMask {
  id?: string;
  type?: string;
  mode?: string;
  visible?: boolean;
  invert?: boolean;
  linear?: Partial<LinearMaskGeo>;
  radial?: Partial<RadialMaskGeo>;
  brush?: RawBrush;
  components?: RawComponent[];
}

interface RawSpot {
  id?: string;
  shape?: string;
  mode?: string;
  visible?: boolean;
  dstX?: unknown;
  dstY?: number;
  srcX?: number;
  srcY?: number;
  radius?: number;
  feather?: number;
  opacity?: number;
  dabs?: (RawDab | null)[];
}

function masksOf(raw: RawMask[]): Mask[] {
  return normalizeParams({ masks: raw as Mask[] }).masks;
}

function spotsOf(raw: RawSpot[]): RetouchSpot[] {
  return normalizeParams({ retouch: raw as RetouchSpot[] }).retouch;
}

const radialMask = (id: string): RawMask => ({ id, type: "radial", radial: {} });

describe("legacy single-geometry masks", () => {
  it("becomes one add component whose id is the mask id plus -c0", () => {
    const [m] = masksOf([
      {
        id: "m",
        type: "radial",
        radial: { cx: 0.4, cy: 0.6, rx: 0.2, ry: 0.1, feather: 0.3, angle: 0.5 },
      },
    ]);
    expect(m.components).toEqual([
      {
        id: "m-c0",
        kind: "radial",
        mode: "add",
        invert: false,
        radial: { cx: 0.4, cy: 0.6, rx: 0.2, ry: 0.1, feather: 0.3, angle: 0.5 },
      },
    ]);
    expect(m.id).toBe("m");
    expect(m.name).toBe("radial");
    expect(m.opacity).toBe(100);
    expect(m.panels).toEqual(LEGACY_MASK_PANELS);
  });

  it("always adds, whatever mode the old record carries, and keeps the mask-level invert on the mask", () => {
    const [m] = masksOf([
      { id: "m", type: "radial", radial: {}, mode: "subtract", invert: true },
    ]);
    expect(m.components[0].mode).toBe("add");
    expect(m.components[0].invert).toBe(false);
    expect(m.invert).toBe(true);
  });

  it("migrates a linear mask that has geometry", () => {
    const [m] = masksOf([
      { id: "l", type: "linear", linear: { x0: 0.1, y0: 0.2, x1: 0.9, y1: 0.8 } },
    ]);
    expect(m.components).toEqual([
      {
        id: "l-c0",
        kind: "linear",
        mode: "add",
        invert: false,
        linear: { x0: 0.1, y0: 0.2, x1: 0.9, y1: 0.8 },
      },
    ]);
  });

  it("drops a linear mask that has no geometry", () => {
    expect(masksOf([{ id: "m", type: "linear" }])).toEqual([]);
  });

  it("drops a radial mask that has no geometry", () => {
    expect(masksOf([{ id: "m", type: "radial" }])).toEqual([]);
  });

  it("names an id-less mask mask-N and its component mask-N-c0", () => {
    const raw: RawMask[] = [
      { type: "radial", radial: {} },
      { type: "linear", linear: { x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.9 } },
    ];
    const first = masksOf(raw);
    expect(first.map((m) => m.id)).toEqual(["mask-0", "mask-1"]);
    expect(first.map((m) => m.components[0].id)).toEqual(["mask-0-c0", "mask-1-c0"]);
  });

  it("gives identical ids when the same id-less data is normalised twice", () => {
    const raw: RawMask[] = [
      { type: "radial", radial: {} },
      { type: "linear", linear: { x0: 0.1, y0: 0.1, x1: 0.9, y1: 0.9 } },
    ];
    const first = masksOf(raw);
    expect(masksOf(raw)).toEqual(first);
    expect(masksOf(first)).toEqual(first);
  });
});

describe("mask components[]", () => {
  it("keeps add, subtract and intersect and turns an unknown or missing mode into add", () => {
    const [m] = masksOf([
      {
        id: "m",
        components: [
          { id: "a", kind: "radial", radial: {}, mode: "intersect" },
          { id: "b", kind: "radial", radial: {}, mode: "bogus" },
          { id: "c", kind: "radial", radial: {}, mode: "subtract", invert: true },
          { id: "d", kind: "radial", radial: {} },
        ],
      },
    ]);
    expect(m.components.map((c) => [c.id, c.mode, c.invert])).toEqual([
      ["a", "intersect", false],
      ["b", "add", false],
      ["c", "subtract", true],
      ["d", "add", false],
    ]);
  });

  it("names id-less components after the mask and their position", () => {
    const [m] = masksOf([
      {
        id: "m",
        components: [
          { kind: "radial", radial: {} },
          { kind: "lumRange" },
        ],
      },
    ]);
    expect(m.components.map((c) => c.id)).toEqual(["m-c0", "m-c1"]);
    expect(m.components[1].lumRange).toEqual({
      lo: 0,
      hi: 1,
      loFeather: 0.1,
      hiFeather: 0.1,
    });
  });

  it("drops a mask whose components are all unusable", () => {
    expect(
      masksOf([
        {
          id: "m",
          components: [{ kind: "linear" }, { kind: "bogus" }, { id: "x" }],
        },
      ]),
    ).toEqual([]);
  });
});

describe("radial geometry clamps", () => {
  it("clamps each field into range and replaces a non-finite one with its default", () => {
    const [high, low] = masksOf([
      {
        id: "high",
        type: "radial",
        radial: { cx: 0.4, cy: Number.NaN, rx: 0, ry: 10, feather: 5, angle: 9 },
      },
      {
        id: "low",
        type: "radial",
        radial: { cx: -9, cy: 9, rx: -1, ry: 0.2, feather: -1, angle: -9 },
      },
    ]);
    expect(high.components[0].radial).toEqual({
      cx: 0.4,
      cy: 0.5,
      rx: 0.001,
      ry: 4,
      feather: 1,
      angle: 7,
    });
    expect(low.components[0].radial).toEqual({
      cx: -2,
      cy: 2,
      rx: 0.001,
      ry: 0.2,
      feather: 0,
      angle: -7,
    });
  });
});

describe("brush dabs", () => {
  it("drops a dab with a non-numeric x or no body and clamps what is left", () => {
    const [m] = masksOf([
      {
        id: "b",
        type: "brush",
        brush: {
          feather: 0.2,
          dabs: [
            { x: "0.5", y: 0.5, radius: 0.1 },
            null,
            { x: 0.1, y: 0.2, radius: 0 },
            { x: 0.3, y: 0.4, radius: 9, erase: true, opacity: 2, flow: -1, feather: 0.7 },
            { x: 0.5, y: 0.6 },
          ],
        },
      },
    ]);
    expect(m.components[0].brush).toEqual({
      feather: 0.2,
      dabs: [
        { x: 0.1, y: 0.2, radius: 0.001, erase: false, feather: 0.5, opacity: 1, flow: 1 },
        { x: 0.3, y: 0.4, radius: 2, erase: true, feather: 0.7, opacity: 1, flow: 0 },
        { x: 0.5, y: 0.6, radius: 0.05, erase: false, feather: 0.5, opacity: 1, flow: 1 },
      ],
    });
  });
});

describe("mask list", () => {
  it("keeps the first 16 masks of a longer list", () => {
    const raw = Array.from({ length: 20 }, (_, i) => radialMask(`m${i}`));
    const masks = masksOf(raw);
    expect(masks).toHaveLength(16);
    expect(masks[0].id).toBe("m0");
    expect(masks[15].id).toBe("m15");
  });

  it("reads a missing visible as visible and keeps an explicit false", () => {
    const masks = masksOf([
      { ...radialMask("a") },
      { ...radialMask("b"), visible: false },
      { ...radialMask("c"), visible: true },
    ]);
    expect(masks.map((m) => [m.id, m.visible])).toEqual([
      ["a", true],
      ["b", false],
      ["c", true],
    ]);
  });
});

describe("retouch spots", () => {
  it("fills every default on a minimal circle spot and leaves out dabs", () => {
    const [s] = spotsOf([{ dstX: 0.3, dstY: 0.4, srcX: 0.5, srcY: 0.6 }]);
    expect(s).toEqual({
      id: "spot-0",
      shape: "circle",
      mode: "heal",
      visible: true,
      dstX: 0.3,
      dstY: 0.4,
      srcX: 0.5,
      srcY: 0.6,
      radius: 0.04,
      feather: 50,
      opacity: 100,
      angle: 0,
      scale: 1,
      recolorR: 0,
      recolorG: 0,
      recolorB: 0,
    });
    expect(s).not.toHaveProperty("dabs");
  });

  it("ignores dabs on a circle spot", () => {
    const [s] = spotsOf([
      { shape: "circle", dstX: 0.3, dabs: [{ x: 0.1, y: 0.1, radius: 0.1 }] },
    ]);
    expect(s.shape).toBe("circle");
    expect(s).not.toHaveProperty("dabs");
  });

  it("keeps the dabs of a brush spot, filtered and clamped like mask dabs", () => {
    const [s] = spotsOf([
      {
        shape: "brush",
        dstX: 0.3,
        dabs: [
          { x: "0.5", y: 0.5, radius: 0.1 },
          null,
          { x: 0.1, y: 0.2, radius: 0 },
          { x: 0.3, y: 0.4, radius: 9, erase: true, opacity: 2, flow: -1, feather: 0.7 },
          { x: 0.5, y: 0.6 },
        ],
      },
    ]);
    expect(s.shape).toBe("brush");
    expect(s.dabs).toEqual([
      { x: 0.1, y: 0.2, radius: 0.001, erase: false, feather: 0.5, opacity: 1, flow: 1 },
      { x: 0.3, y: 0.4, radius: 2, erase: true, feather: 0.7, opacity: 1, flow: 0 },
      { x: 0.5, y: 0.6, radius: 0.04, erase: false, feather: 0.5, opacity: 1, flow: 1 },
    ]);
  });

  it("keeps clone and turns any other mode into heal", () => {
    const spots = spotsOf([
      { dstX: 0.1, mode: "clone" },
      { dstX: 0.2, mode: "bogus" },
      { dstX: 0.3, mode: "heal" },
      { dstX: 0.4 },
    ]);
    expect(spots.map((s) => s.mode)).toEqual(["clone", "heal", "heal", "heal"]);
  });

  it("names an id-less spot spot-N and keeps an explicit id", () => {
    const spots = spotsOf([{ dstX: 0.1 }, { id: "x", dstX: 0.2 }, { dstX: 0.3 }]);
    expect(spots.map((s) => s.id)).toEqual(["spot-0", "x", "spot-2"]);
  });

  it("drops a spot whose dstX is not a number", () => {
    const spots = spotsOf([{ id: "ok", dstX: 0.2 }, { id: "bad", dstX: "0.2" }]);
    expect(spots.map((s) => s.id)).toEqual(["ok"]);
  });

  it("reads a missing visible as visible and keeps an explicit false", () => {
    const spots = spotsOf([
      { dstX: 0.1 },
      { dstX: 0.2, visible: false },
      { dstX: 0.3, visible: true },
    ]);
    expect(spots.map((s) => s.visible)).toEqual([true, false, true]);
  });

  it("clamps radius, feather and opacity", () => {
    const [s] = spotsOf([{ dstX: 0.3, radius: 0, feather: 500, opacity: -5 }]);
    expect([s.radius, s.feather, s.opacity]).toEqual([0.002, 100, 0]);
  });

  it("keeps the first 32 spots of a longer list", () => {
    const raw = Array.from({ length: 40 }, () => ({ dstX: 0.5 }));
    const spots = spotsOf(raw);
    expect(spots).toHaveLength(32);
    expect(spots[31].id).toBe("spot-31");
  });
});
