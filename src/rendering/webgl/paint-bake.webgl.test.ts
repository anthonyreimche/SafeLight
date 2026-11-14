// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The paint bake rasterizes through a 2D canvas, so it runs here in the
// browser suite. Its strokes are shaped by the coverage bake's own maths, which
// the alpha-matches-coverage case pins.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrushDab } from "@/catalog/types";
import {
  MAX_PAINT_LAYERS,
  type BrushTipContribution,
  type PaintDab,
  type PaintLayer,
} from "@/extensions/api/contributions";
import { differingBytes } from "./bake-bytes.test-support";
import { setActiveBrushTips } from "./brush-tips";
import { bakeCoverage } from "./mask-coverage";
import { PaintBaker, bakePaint, type PaintBakeResult } from "./paint-bake";

type Rgb = [number, number, number];
const RED: Rgb = [1, 0, 0];
const BLUE: Rgb = [0, 0, 1];

function dab(over: Partial<PaintDab> = {}): PaintDab {
  return { x: 0.5, y: 0.5, radius: 0.2, erase: false, feather: 0, color: RED, ...over };
}

const layer = (id: string, dabs: PaintDab[]): PaintLayer => ({ id, dabs });

function bake(layers: PaintLayer[], aspect = 1): PaintBakeResult {
  const result = bakePaint(layers, aspect);
  if (!result) throw new Error("bakePaint returned null");
  return result;
}

/** A layer's RGBA bytes at a normalized position within its tile. */
function paintAt(result: PaintBakeResult, index: number, u: number, v: number): number[] {
  const { tile } = result;
  const x = (index % 2) * tile + Math.min(tile - 1, Math.max(0, Math.round(u * tile)));
  const y = Math.floor(index / 2) * tile + Math.min(tile - 1, Math.max(0, Math.round(v * tile)));
  const at = (y * result.size + x) * 4;
  return Array.from(result.data.subarray(at, at + 4));
}

describe("bakePaint", () => {
  it("returns nothing to bake for no layers", () => {
    expect(bakePaint([], 1)).toBeNull();
  });

  it("lays out four tiles of the coverage bake's size", () => {
    const baked = bake([layer("a", [])]);
    const coverage = bakeCoverage([{ id: "a", dabs: [] }], 1);
    expect(baked.tile).toBe(coverage?.size);
    expect(baked.size).toBe(baked.tile * 2);
    expect(baked.data.length).toBe(baked.size * baked.size * 4);
    expect(baked.data.every((byte) => byte === 0)).toBe(true);
  });

  it("stores a solid stroke's colour and full coverage, and leaves the rest clear", () => {
    const baked = bake([layer("a", [dab({ color: [1, 0.5, 0] })])]);
    expect(paintAt(baked, 0, 0.5, 0.5)).toEqual([255, 128, 0, 255]);
    expect(paintAt(baked, 0, 0.9, 0.5)).toEqual([0, 0, 0, 0]);
  });

  it("puts layer n in tile n and drops layers past the fourth", () => {
    const colours: Rgb[] = [RED, [0, 1, 0], BLUE, [1, 1, 0], [1, 1, 1]];
    const layers = colours.map((color, i) => layer(`l${i}`, [dab({ color })]));
    const baked = bake(layers);
    for (let i = 0; i < MAX_PAINT_LAYERS; i++) {
      expect(paintAt(baked, i, 0.5, 0.5)).toEqual([...colours[i].map((c) => c * 255), 255]);
    }
  });

  it("keeps the colour straight while half-opacity strokes build coverage", () => {
    const half = (start: boolean) => dab({ opacity: 0.5, strokeStart: start });
    const baked = bake([layer("a", [half(true), half(true)])]);
    const [r, g, b, a] = paintAt(baked, 0, 0.5, 0.5);
    expect([r, g, b]).toEqual([255, 0, 0]);
    expect(a).toBeCloseTo(191, -1);
  });

  it("mixes a later stroke's colour over an earlier one by its coverage", () => {
    const baked = bake([layer("a", [dab({ strokeStart: true }), dab({ strokeStart: true, color: BLUE, opacity: 0.5 })])]);
    const [r, g, b, a] = paintAt(baked, 0, 0.5, 0.5);
    expect(r).toBeCloseTo(128, -1);
    expect(g).toBe(0);
    expect(b).toBeCloseTo(128, -1);
    expect(a).toBe(255);
  });

  it("starts a new stroke where the colour changes, even without a stroke marker", () => {
    const baked = bake([layer("a", [dab({ strokeStart: true }), dab({ color: BLUE })])]);
    expect(paintAt(baked, 0, 0.5, 0.5)).toEqual([0, 0, 255, 255]);
  });

  it("erases coverage and leaves the colour that's left as it was", () => {
    const baked = bake([layer("a", [dab({ strokeStart: true }), dab({ strokeStart: true, erase: true, opacity: 0.5 })])]);
    const [r, g, b, a] = paintAt(baked, 0, 0.5, 0.5);
    expect([r, g, b]).toEqual([255, 0, 0]);
    expect(a).toBeCloseTo(128, -1);
  });

  it("gives a layer the coverage bake's alpha for the same dabs", () => {
    const shape: Partial<BrushDab>[] = [
      { x: 0.3, radius: 0.15, feather: 0.7, flow: 0.4, opacity: 0.8, strokeStart: true },
      { x: 0.35, radius: 0.15, feather: 0.7, flow: 0.4, opacity: 0.8 },
      { x: 0.5, y: 0.55, radius: 0.1, feather: 0.3, opacity: 0.6, strokeStart: true },
      { x: 0.4, radius: 0.08, erase: true, opacity: 0.7, strokeStart: true },
    ];
    const dabs = shape.map((s) => dab(s));
    const baked = bake([layer("a", dabs)], 1.5);
    const coverage = bakeCoverage([{ id: "a", dabs }], 1.5);
    if (!coverage) throw new Error("bakeCoverage returned null");
    let differing = 0;
    for (let y = 0; y < baked.tile; y++) {
      for (let x = 0; x < baked.tile; x++) {
        if (baked.data[(y * baked.size + x) * 4 + 3] !== coverage.data[(y * coverage.size + x) * 4]) differing++;
      }
    }
    expect(differing).toBe(0);
  });
});

describe("PaintBaker", () => {
  function stroke(n: number, over: Partial<PaintDab> = {}, y = 0.5): PaintDab[] {
    return Array.from({ length: n }, (_, i) =>
      dab({ x: 0.2 + i * 0.03, y, radius: 0.08, feather: 0.6, flow: 0.4, opacity: 0.8, strokeStart: i === 0, ...over }),
    );
  }

  function expectSameAsFullBake(baked: PaintBakeResult | null, layers: PaintLayer[]) {
    const full = bakePaint(layers, 1);
    if (!baked || !full) throw new Error("a bake returned null");
    expect(differingBytes(baked.data, full.data)).toBe(0);
  }

  it("matches a full bake as strokes of several colours grow and an erase cuts in", () => {
    const baker = new PaintBaker();
    let dabs: PaintDab[] = [];
    const steps = [
      stroke(3),
      stroke(4, { color: BLUE }).slice(1).map((d) => ({ ...d, x: d.x + 0.01, strokeStart: false })),
      stroke(5, { color: [0, 1, 0], opacity: 0.5 }, 0.55),
      stroke(2, { erase: true, opacity: 0.6 }, 0.5),
    ];
    for (const added of steps) {
      dabs = structuredClone([...dabs, ...added]);
      const layers = [layer("a", dabs), layer("b", stroke(3, { color: BLUE }, 0.3))];
      expectSameAsFullBake(baker.bake(layers, 1), layers);
    }
  });

  it("matches a full bake dab by dab across colour changes, an erase that clears paint, and four layers", () => {
    const baker = new PaintBaker();
    const grown = [
      ...stroke(6),
      ...stroke(5, { color: BLUE, strokeStart: false }, 0.52),
      ...stroke(6, { erase: true, opacity: 1, flow: 1, radius: 0.1 }, 0.5),
      ...stroke(4, { color: [0, 1, 0], radius: 0.01 }, 0.6),
      ...stroke(3, { color: [1, 1, 0], radius: 0.5 }, 0.4),
    ];
    const others = [layer("b", stroke(3, { color: BLUE }, 0.3)), layer("c", []), layer("d", stroke(2, {}, 0.7))];
    for (let n = 0; n <= grown.length; n++) {
      const layers = structuredClone([others[0], layer("a", grown.slice(0, n)), ...others.slice(1)]);
      expectSameAsFullBake(baker.bake(layers, 1), layers);
    }
  });

  it("bakes again a dab whose colour was edited in place, and two layers under one id as a full bake does", () => {
    const baker = new PaintBaker();
    const dabs = stroke(6);
    baker.bake([layer("a", dabs)], 1);
    dabs[3].color = BLUE;
    const next = [layer("a", [...dabs])];
    expectSameAsFullBake(baker.bake(next, 1), next);

    const shared = stroke(4, { color: BLUE }, 0.3);
    for (const extra of [stroke(2, {}, 0.6), stroke(2, {}, 0.7)]) {
      const layers = structuredClone([layer("x", [...shared, ...extra]), layer("x", shared)]);
      expectSameAsFullBake(baker.bake(layers, 1), layers);
    }
  });

  it("reports nothing changed for the same layers, and only the added dab's reach for one more", () => {
    const baker = new PaintBaker();
    const dabs = stroke(10);
    const first = baker.bake([layer("a", structuredClone(dabs))], 1);
    expect(first?.changed).toEqual({ x: 0, y: 0, w: first?.size, h: first?.size });
    expect(baker.bake([layer("a", structuredClone(dabs))], 1)?.changed).toBeNull();

    const added = stroke(11)[10];
    const box = baker.bake([layer("a", structuredClone([...dabs, added]))], 1)?.changed;
    if (!box) throw new Error("one more dab changed nothing");
    const reach = 2 * added.radius * 768 + 4;
    expect(box.w * box.h).toBeLessThanOrEqual(reach * reach);
  });
});

describe("paint brush tips", () => {
  const halfTip: BrushTipContribution = {
    id: "half",
    label: "Half",
    alpha: { width: 8, height: 8, data: Uint8Array.from({ length: 64 }, (_, i) => (i % 8 < 4 ? 255 : 0)) },
  };

  beforeEach(() => setActiveBrushTips({ half: halfTip }));
  afterEach(() => setActiveBrushTips({}));

  it("stamps a registered tip in place of the disc, in the stroke's colour", () => {
    const baked = bake([layer("a", [dab({ strokeStart: true, tip: "half", color: BLUE })])]);
    expect(paintAt(baked, 0, 0.4, 0.5)).toEqual([0, 0, 255, 255]);
    expect(paintAt(baked, 0, 0.6, 0.5)[3]).toBeLessThan(15);
  });

  it("keeps the tip across a change of colour within one stroke, and bakes an unknown tip as a disc", () => {
    const baked = bake([layer("a", [dab({ strokeStart: true, tip: "half" }), dab({ color: BLUE, x: 0.5 })])]);
    expect(paintAt(baked, 0, 0.4, 0.5)).toEqual([0, 0, 255, 255]);
    expect(paintAt(baked, 0, 0.6, 0.5)[3]).toBeLessThan(15);

    const unknown = bake([layer("a", [dab({ strokeStart: true, tip: "missing" })])]);
    const disc = bake([layer("a", [dab({ strokeStart: true })])]);
    expect(differingBytes(unknown.data, disc.data)).toBe(0);
  });
});
