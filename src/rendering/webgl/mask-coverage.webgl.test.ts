// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// bakeCoverage rasterizes brush strokes through a 2D canvas, so in node it can
// only be checked as far as its empty-list guard (see mask-coverage.test.ts,
// which also owns the pure coverageSignature). Here it runs for real: the two
// controls that shape a dab — flow builds coverage up, opacity caps how far it
// can build — and the RGBA packing the shader reads every mask through.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrushDab } from "@/catalog/types";
import { MAX_BRUSH_MASKS } from "@/catalog/types";
import type { BrushTipContribution } from "@/extensions/api/contributions";
import { differingBytes } from "./bake-bytes.test-support";
import { setActiveBrushTips } from "./brush-tips";
import { BAKE_SIZE, CoverageBaker, bakeCoverage, type CoverageItem, type CoverageResult } from "./mask-coverage";

function dab(over: Partial<BrushDab> = {}): BrushDab {
  return { x: 0.5, y: 0.5, radius: 0.2, erase: false, feather: 0, ...over };
}

function bake(dabs: BrushDab[], aspect = 1): CoverageResult {
  const result = bakeCoverage([{ id: "a", dabs }], aspect);
  if (!result) throw new Error("bakeCoverage returned null");
  return result;
}

/** Coverage byte at a normalized position, in the given atlas channel. */
function coverageAt(result: CoverageResult, u: number, v: number, channel = 0): number {
  const x = Math.min(result.size - 1, Math.max(0, Math.round(u * result.size)));
  const y = Math.min(result.size - 1, Math.max(0, Math.round(v * result.size)));
  return result.data[(y * result.size + x) * 4 + channel];
}

describe("bakeCoverage", () => {
  it("bakes an empty atlas for an item nothing has been painted on yet", () => {
    const baked = bakeCoverage([{ id: "a", dabs: [] }], 1);
    if (!baked) throw new Error("bakeCoverage returned null");
    expect(baked.channelOf).toEqual({ a: 0 });
    expect(baked.data.every((byte) => byte === 0)).toBe(true);
  });

  it("fills a hard-edged dab solidly and leaves the rest clear", () => {
    const baked = bake([dab()]);
    expect(coverageAt(baked, 0.5, 0.5)).toBe(255);
    expect(coverageAt(baked, 0.6, 0.5)).toBe(255);
    expect(coverageAt(baked, 0.9, 0.5)).toBe(0);
    expect(baked.channelOf).toEqual({ a: 0 });
  });

  it("falls off across the feathered band", () => {
    const baked = bake([dab({ feather: 1 })]);
    const samples = [0.5, 0.56, 0.62, 0.68].map((u) => coverageAt(baked, u, 0.5));
    // Full feather leaves no solid core — the gradient starts at the dab centre,
    // so the peak is a hair under 255 and every step outward is strictly lower.
    expect(samples[0]).toBeGreaterThan(250);
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]).toBeLessThan(samples[i - 1]);
    }
    expect(samples[samples.length - 1]).toBeLessThan(64);
  });

  it("caps coverage at the dab's opacity", () => {
    const baked = bake([dab({ opacity: 0.5 })]);
    expect(coverageAt(baked, 0.5, 0.5)).toBeCloseTo(128, -1);
  });

  it("builds coverage up as low-flow dabs overlap", () => {
    const once = coverageAt(bake([dab({ flow: 0.5 })]), 0.5, 0.5);
    const twice = coverageAt(bake([dab({ flow: 0.5 }), dab({ flow: 0.5 })]), 0.5, 0.5);
    expect(once).toBeCloseTo(128, -1);
    expect(twice).toBeGreaterThan(once);
    expect(twice).toBeLessThan(255);
  });

  it("never builds past the opacity ceiling", () => {
    const dabs = [dab({ opacity: 0.5 }), dab({ opacity: 0.5 }), dab({ opacity: 0.5 })];
    expect(coverageAt(bake(dabs), 0.5, 0.5)).toBeCloseTo(128, -1);
  });

  it("lays each new stroke over the last, so low opacity builds up stroke by stroke", () => {
    const one = coverageAt(bake([dab({ opacity: 0.5, strokeStart: true })]), 0.5, 0.5);
    const two = coverageAt(
      bake([dab({ opacity: 0.5, strokeStart: true }), dab({ opacity: 0.5, strokeStart: true })]),
      0.5,
      0.5,
    );
    const three = coverageAt(
      bake([
        dab({ opacity: 0.2, strokeStart: true }),
        dab({ opacity: 0.2, strokeStart: true }),
        dab({ opacity: 0.2, strokeStart: true }),
      ]),
      0.5,
      0.5,
    );
    expect(one).toBeCloseTo(128, -1);
    expect(two).toBeCloseTo(191, -1); // 0.5 over 0.5
    expect(three).toBeCloseTo(124, -1); // 1 - 0.8³
  });

  it("caps each stroke at its own opacity, however many dabs it lays", () => {
    const dabs = [
      dab({ opacity: 0.5, strokeStart: true }),
      dab({ opacity: 0.5 }),
      dab({ opacity: 0.5 }),
      dab({ opacity: 0.3, strokeStart: true }),
      dab({ opacity: 0.3 }),
    ];
    expect(coverageAt(bake(dabs), 0.5, 0.5)).toBeCloseTo(166, -1); // 0.3 over 0.5
  });

  it("lets a stroke reach past an earlier, lower one", () => {
    const dabs = [dab({ opacity: 0.2, strokeStart: true }), dab({ opacity: 1, strokeStart: true })];
    expect(coverageAt(bake(dabs), 0.5, 0.5)).toBe(255);
  });

  it("erases by the erase stroke's opacity", () => {
    const dabs = [dab({ strokeStart: true }), dab({ erase: true, opacity: 0.5, strokeStart: true })];
    expect(coverageAt(bake(dabs), 0.5, 0.5)).toBeCloseTo(128, -1);
  });

  it("only touches what a stroke covers", () => {
    const dabs = [
      dab({ x: 0.25, radius: 0.1, opacity: 0.5, strokeStart: true }),
      dab({ x: 0.75, radius: 0.1, opacity: 0.5, strokeStart: true }),
    ];
    const baked = bake(dabs);
    expect(coverageAt(baked, 0.25, 0.5)).toBeCloseTo(128, -1);
    expect(coverageAt(baked, 0.75, 0.5)).toBeCloseTo(128, -1);
    expect(coverageAt(baked, 0.5, 0.5)).toBe(0);
  });

  it("removes coverage under an erase dab", () => {
    const baked = bake([dab({ radius: 0.3 }), dab({ radius: 0.1, erase: true })]);
    expect(coverageAt(baked, 0.5, 0.5)).toBe(0);
    expect(coverageAt(baked, 0.7, 0.5)).toBe(255);
  });

  it("keeps a dab round on screen by dividing its x-radius by the aspect", () => {
    const baked = bake([dab({ radius: 0.2 })], 2);
    // Half the horizontal reach, unchanged vertically.
    expect(coverageAt(baked, 0.59, 0.5)).toBe(255);
    expect(coverageAt(baked, 0.65, 0.5)).toBe(0);
    expect(coverageAt(baked, 0.5, 0.69)).toBe(255);
  });

  it("packs one item per channel and drops what the atlas cannot hold", () => {
    const items: CoverageItem[] = [0, 1, 2, 3, 4].map((i) => ({
      id: `item${i}`,
      dabs: [dab({ x: 0.1 + i * 0.15 })],
    }));
    const baked = bakeCoverage(items, 1);
    if (!baked) throw new Error("bakeCoverage returned null");
    expect(Object.keys(baked.channelOf)).toHaveLength(MAX_BRUSH_MASKS);
    expect(baked.channelOf.item4).toBeUndefined();
    for (let channel = 0; channel < MAX_BRUSH_MASKS; channel++) {
      expect(coverageAt(baked, 0.1 + channel * 0.15, 0.5, channel)).toBe(255);
    }
  });
});

// A brush stroke grows by a few dabs a frame, and each frame's params hand the
// renderer the whole stroke history again, cloned. CoverageBaker keeps what it
// baked, so a frame rasterizes only the stroke still being painted, and an item
// whose dabs didn't change not at all, and comes out byte for byte as a full bake.
describe("CoverageBaker", () => {
  /** A soft, low-flow stroke of `n` dabs along a line, so overlaps build up. */
  function stroke(n: number, over: Partial<BrushDab> = {}, y = 0.5): BrushDab[] {
    return Array.from({ length: n }, (_, i) =>
      dab({ x: 0.2 + i * 0.03, y, radius: 0.08, feather: 0.6, flow: 0.4, opacity: 0.8, strokeStart: i === 0, ...over }),
    );
  }

  function expectSameAsFullBake(baked: CoverageResult | null, items: CoverageItem[], aspect = 1) {
    const full = bakeCoverage(items, aspect);
    if (!baked || !full) throw new Error("a bake returned null");
    expect(baked.channelOf).toEqual(full.channelOf);
    expect(differingBytes(baked.data, full.data)).toBe(0);
  }

  /** The radial gradients a call creates: two for every dab it rasterizes. */
  function gradientsDuring(run: () => void): number {
    const spy = vi.spyOn(OffscreenCanvasRenderingContext2D.prototype, "createRadialGradient");
    try {
      run();
      return spy.mock.calls.length;
    } finally {
      spy.mockRestore();
    }
  }

  it("matches a full bake as a stroke grows, new strokes start and an erase stroke cuts in", () => {
    const baker = new CoverageBaker();
    let dabs: BrushDab[] = [];
    const steps = [
      stroke(3),
      stroke(4).slice(1).map((d) => ({ ...d, x: d.x + 0.01 })),
      stroke(5, { opacity: 0.5 }, 0.55),
      stroke(2, { erase: true, opacity: 0.6 }, 0.5),
      stroke(3, { erase: true, opacity: 0.6, strokeStart: false }, 0.52),
      stroke(4, { flow: 1, opacity: 1 }, 0.45),
    ];
    for (const added of steps) {
      dabs = structuredClone([...dabs, ...added]);
      const items = [{ id: "a", dabs }];
      expectSameAsFullBake(baker.bake(items, 1), items);
    }
  });

  it("matches a full bake for dabs painted before strokes were recorded", () => {
    const baker = new CoverageBaker();
    const legacy = stroke(6, { strokeStart: undefined });
    for (const dabs of [legacy.slice(0, 2), legacy.slice(0, 4), [...legacy.slice(0, 4), dab({ x: 0.3, erase: true, radius: 0.05 })], legacy]) {
      const items = [{ id: "a", dabs: structuredClone(dabs) }];
      expectSameAsFullBake(baker.bake(items, 1.5), items, 1.5);
    }
  });

  it("matches a full bake after an undo, an edited dab, or a new aspect", () => {
    const baker = new CoverageBaker();
    const two = [...stroke(4), ...stroke(4, {}, 0.6)];
    const bake = (dabs: BrushDab[], aspect = 1) => {
      const items = [{ id: "a", dabs: structuredClone(dabs) }];
      expectSameAsFullBake(baker.bake(items, aspect), items, aspect);
    };
    bake(two);
    bake(stroke(4));
    bake([{ ...two[0], x: 0.25 }, ...two.slice(1)]);
    bake(two, 2);
  });

  it("rasterizes only the dabs added, and nothing for an unchanged item", () => {
    const baker = new CoverageBaker();
    const other = { id: "b", dabs: stroke(10, {}, 0.3) };
    const history = stroke(20);
    baker.bake([{ id: "a", dabs: history }, other], 1);

    const next = structuredClone([...history, ...stroke(2, {}, 0.7)]);
    expect(gradientsDuring(() => baker.bake([{ id: "a", dabs: next }, other], 1))).toBe(4);

    const grown = structuredClone([...next, dab({ x: 0.5, y: 0.7, radius: 0.08 })]);
    const items = [{ id: "a", dabs: grown }, structuredClone(other)];
    let baked: CoverageResult | null = null;
    expect(gradientsDuring(() => (baked = baker.bake(items, 1)))).toBe(2);
    expectSameAsFullBake(baked, items);
  });
});

// While the brush moves, each frame's params add a dab or two to one item. The
// baker lays only those over the stroke as it stood and repacks only the pixels
// they reach, and the atlas comes out byte for byte as a bake from scratch.
describe("CoverageBaker, dab by dab", () => {
  const SMALLEST = 0.01;
  const LARGEST = 0.5;

  /** `n` overlapping dabs a quarter of the brush apart, as Masking spaces them. */
  function stroke(n: number, over: Partial<BrushDab>, from: [number, number] = [0.2, 0.5], heading = 0.4): BrushDab[] {
    const radius = over.radius ?? 0.08;
    return Array.from({ length: n }, (_, i) =>
      dab({
        x: from[0] + Math.cos(heading) * i * radius * 0.25,
        y: from[1] + Math.sin(heading) * i * radius * 0.25,
        radius,
        feather: 0.5,
        flow: 0.3,
        opacity: 0.7,
        strokeStart: i === 0,
        ...over,
      }),
    );
  }

  /** The same as a fresh baker's bake of the same items. */
  function expectFullBake(baked: CoverageResult | null, items: CoverageItem[], aspect: number, step: string) {
    const full = bakeCoverage(structuredClone(items), aspect);
    if (!baked || !full) throw new Error(`${step}: a bake returned null`);
    expect(baked.channelOf, step).toEqual(full.channelOf);
    expect(differingBytes(baked.data, full.data), step).toBe(0);
  }

  /** Bakes `item` in `others`' company once per dab added to it, each a clone as
   *  the render worker gets them, against a full bake each time. */
  function growDabByDab(dabs: BrushDab[], aspect: number, others: CoverageItem[] = [], at = 0) {
    const baker = new CoverageBaker();
    for (let n = 0; n <= dabs.length; n++) {
      const items = [...others];
      items.splice(at, 0, { id: "grown", dabs: dabs.slice(0, n) });
      const cloned = structuredClone(items);
      expectFullBake(baker.bake(cloned, aspect), cloned, aspect, `after ${n} dabs`);
    }
  }

  /** The pixel box a dab of this radius can reach, as the bake bounds it. */
  const reachOf = (d: BrushDab, aspect: number) => {
    const rx = (d.radius / aspect) * BAKE_SIZE;
    const ry = d.radius * BAKE_SIZE;
    return (2 * rx + 4) * (2 * ry + 4);
  };

  it("matches a full bake at the smallest and the largest brush", () => {
    for (const radius of [SMALLEST, LARGEST]) {
      growDabByDab([...stroke(14, { radius }), ...stroke(10, { radius }, [0.6, 0.3], 2)], 1.5);
    }
  });

  it("matches a full bake as an erase stroke cuts in and a stroke flips to erase", () => {
    const painted = [...stroke(8, {}), ...stroke(6, { opacity: 1, flow: 1 }, [0.3, 0.45], 0)];
    const flipped = stroke(10, { radius: 0.05 }, [0.25, 0.55], -0.3).map((d, i) => (i >= 5 ? { ...d, erase: true } : d));
    growDabByDab([...painted, ...stroke(7, { erase: true, opacity: 0.6 }, [0.2, 0.52], 0.1), ...flipped], 1);
  });

  it("matches a full bake for dabs painted before strokes were recorded, erase dabs among them", () => {
    const legacy = stroke(12, { strokeStart: undefined }).map((d, i) => (i % 4 === 3 ? { ...d, erase: true, radius: 0.03 } : d));
    growDabByDab(legacy, 0.75);
  });

  it("matches a full bake with a tip, and while other items hold the atlas's other channels", () => {
    setActiveBrushTips({
      half: {
        id: "half",
        label: "Half",
        alpha: { width: 8, height: 8, data: Uint8Array.from({ length: 64 }, (_, i) => (i % 8 < 4 ? 255 : 0)) },
      },
    });
    try {
      const others = [
        { id: "left", dabs: stroke(6, {}, [0.1, 0.2]) },
        { id: "right", dabs: stroke(6, { erase: false, opacity: 0.4 }, [0.6, 0.7]) },
      ];
      growDabByDab(stroke(10, { tip: "half", angle: 0.7 }, [0.3, 0.3]), 1.5, others, 1);
    } finally {
      setActiveBrushTips({});
    }
  });

  it("matches a full bake after an undo, an edited dab, a new aspect, and items reordered or dropped", () => {
    const baker = new CoverageBaker();
    const a = stroke(12, {});
    const b = stroke(8, { radius: 0.12 }, [0.5, 0.2], 1.2);
    const steps: [CoverageItem[], number][] = [
      [[{ id: "a", dabs: a }, { id: "b", dabs: b }], 1],
      [[{ id: "a", dabs: a.slice(0, 7) }, { id: "b", dabs: b }], 1],
      [[{ id: "a", dabs: [a[0], { ...a[1], x: 0.3 }, ...a.slice(2)] }, { id: "b", dabs: b }], 1],
      [[{ id: "a", dabs: a }, { id: "b", dabs: b }], 2],
      [[{ id: "b", dabs: b }, { id: "a", dabs: a }], 2],
      [[{ id: "b", dabs: [...b, ...stroke(3, {}, [0.7, 0.7])] }], 2],
      [[{ id: "b", dabs: [...b, ...stroke(4, {}, [0.7, 0.7])] }, { id: "a", dabs: a }], 2],
    ];
    for (const [i, [items, aspect]] of steps.entries()) {
      const cloned = structuredClone(items);
      expectFullBake(baker.bake(cloned, aspect), cloned, aspect, `step ${i}`);
    }
  });

  it("reports what changed: everything first, nothing for the same dabs, the new dab's reach for one more", () => {
    const baker = new CoverageBaker();
    const dabs = stroke(20, {});
    const first = baker.bake([{ id: "a", dabs: structuredClone(dabs) }], 1);
    expect(first?.changed).toEqual({ x: 0, y: 0, w: BAKE_SIZE, h: BAKE_SIZE });
    expect(baker.bake([{ id: "a", dabs: structuredClone(dabs) }], 1)?.changed).toBeNull();

    const added = stroke(21, {})[20];
    const grown = baker.bake([{ id: "a", dabs: structuredClone([...dabs, added]) }], 1);
    const box = grown?.changed;
    if (!box) throw new Error("one more dab changed nothing");
    expect(box.w * box.h).toBeLessThanOrEqual(reachOf(added, 1));
    expect(box.x).toBeLessThanOrEqual(added.x * BAKE_SIZE);
    expect(box.x + box.w).toBeGreaterThanOrEqual(added.x * BAKE_SIZE);
  });

  // The work one more dab costs, on top of a heavily brushed item: each earlier
  // dab is compared once with the values it was baked from (the caller may have
  // edited it in place), and only the new dab is rasterized and repacked.
  it("compares each earlier dab once and rasterizes and repacks only the added dab, on top of thousands", () => {
    // Forty strokes of a hundred dabs, each circling its own cell of the photo.
    const history = Array.from({ length: 40 }, (_, k) =>
      Array.from({ length: 100 }, (_, i) =>
        dab({
          x: 0.1 + (k % 8) * 0.11 + 0.04 * Math.cos(i * 0.12 + k),
          y: 0.1 + Math.floor(k / 8) * 0.19 + 0.04 * Math.sin(i * 0.12 + k),
          radius: 0.02 + (k % 5) * 0.01,
          feather: 0.5,
          flow: 0.3,
          opacity: 0.7,
          erase: k % 7 === 6,
          strokeStart: i === 0,
        }),
      ),
    ).flat();
    let reads = 0;
    const watched = history.map(
      (d) =>
        new Proxy(d, {
          get(from, key) {
            reads++;
            return Reflect.get(from, key);
          },
        }),
    );
    const baker = new CoverageBaker();
    baker.bake([{ id: "a", dabs: watched }], 1.5);
    const added = { ...history[history.length - 1], x: history[history.length - 1].x + 0.004, strokeStart: false };

    reads = 0;
    const spy = vi.spyOn(OffscreenCanvasRenderingContext2D.prototype, "createRadialGradient");
    let baked: CoverageResult | null = null;
    try {
      baked = baker.bake([{ id: "a", dabs: [...watched, added] }], 1.5);
      expect(spy.mock.calls.length).toBe(2);
    } finally {
      spy.mockRestore();
    }
    // sameDab reads ten fields.
    expect(reads).toBeLessThanOrEqual(10 * history.length);
    const box = (baked as CoverageResult | null)?.changed;
    if (!box) throw new Error("one more dab changed nothing");
    expect(box.w * box.h).toBeLessThanOrEqual(reachOf(added, 1.5));
    expectFullBake(baked, [{ id: "a", dabs: [...history, added] }], 1.5, "4,001 dabs");
  });

  /** A long stroke of low flow whose every control changes dab by dab, circling back over itself. */
  function wobbly(n: number, seed: number): BrushDab[] {
    let s = seed;
    const rnd = () => (s = (s * 16807) % 2147483647) / 2147483647;
    return Array.from({ length: n }, (_, i) =>
      dab({
        x: 0.5 + 0.18 * Math.cos(i * 0.05) + 0.01 * rnd(),
        y: 0.5 + 0.12 * Math.sin(i * 0.07) + 0.01 * rnd(),
        radius: 0.03 + 0.03 * rnd(),
        feather: 0.2 + 0.8 * rnd(),
        flow: 0.02 + 0.2 * rnd(),
        opacity: 0.2 + 0.8 * rnd(),
        strokeStart: i === 0,
      }),
    );
  }

  it("matches a full bake after hundreds of dabs laid one at a time over each other", () => {
    const dabs = wobbly(400, 1);
    const baker = new CoverageBaker();
    for (let n = 1; n <= dabs.length; n++) {
      const items = structuredClone([{ id: "a", dabs: dabs.slice(0, n) }]);
      const baked = baker.bake(items, 1.3);
      if (n % 100 === 0) expectFullBake(baked, items, 1.3, `after ${n} dabs`);
    }
  });

  // Main-thread renderers (an export, the histogram) are handed the caller's
  // own objects, not structured clones: what was baked is kept by value.
  it("bakes again a dab edited in place and then handed over in a new list", () => {
    const dabs = wobbly(30, 5);
    const baker = new CoverageBaker();
    baker.bake([{ id: "a", dabs }], 1);
    dabs[10].radius = 0.12;
    const next = [...dabs];
    expectFullBake(baker.bake([{ id: "a", dabs: next }], 1), [{ id: "a", dabs: next }], 1, "edited dab");
  });

  it("bakes the dabs pushed onto a list it was handed before", () => {
    const dabs = wobbly(30, 5);
    const baker = new CoverageBaker();
    baker.bake([{ id: "a", dabs }], 1);
    dabs.push(dab({ x: 0.2, y: 0.8, radius: 0.1 }));
    expectFullBake(baker.bake([{ id: "a", dabs: [...dabs] }], 1), [{ id: "a", dabs }], 1, "pushed dab");
  });

  it("bakes two items under one id as a full bake does, frame after frame", () => {
    const shared = wobbly(20, 2);
    const baker = new CoverageBaker();
    const frames = [
      [{ id: "x", dabs: [...shared, dab({ x: 0.2, y: 0.2, radius: 0.08 })] }, { id: "x", dabs: shared }],
      [{ id: "x", dabs: [...shared, dab({ x: 0.8, y: 0.8, radius: 0.08 })] }, { id: "x", dabs: shared }],
    ];
    for (const [i, items] of frames.entries()) {
      const cloned = structuredClone(items);
      const baked = baker.bake(cloned, 1);
      const full = bakeCoverage(structuredClone(cloned), 1);
      if (!baked || !full) throw new Error("a bake returned null");
      expect(differingBytes(baked.data, full.data), `frame ${i}`).toBe(0);
    }
  });
});

describe("brush tips", () => {
  // Opaque on the left half, clear on the right: a disc can't be mistaken for it.
  const halfTip: BrushTipContribution = {
    id: "half",
    label: "Half",
    alpha: { width: 8, height: 8, data: Uint8Array.from({ length: 64 }, (_, i) => (i % 8 < 4 ? 255 : 0)) },
  };
  const tipped = (over: Partial<BrushDab> = {}) => dab({ strokeStart: true, tip: "half", ...over });

  beforeEach(() => setActiveBrushTips({ half: halfTip }));
  afterEach(() => setActiveBrushTips({}));

  it("bakes an unknown tip exactly like the round disc", () => {
    const disc = bake([dab({ strokeStart: true, feather: 0.4 })]);
    const unknown = bake([dab({ strokeStart: true, feather: 0.4, tip: "missing", angle: 1 })]);
    expect(differingBytes(unknown.data, disc.data)).toBe(0);
  });

  it("stamps the tip's shape in place of the disc", () => {
    const baked = bake([tipped()]);
    expect(coverageAt(baked, 0.4, 0.5)).toBeGreaterThan(240);
    expect(coverageAt(baked, 0.6, 0.5)).toBeLessThan(15);
    expect(coverageAt(baked, 0.9, 0.5)).toBe(0);
  });

  it("turns the tip by its angle on the picture, whatever the image's aspect", () => {
    const turned = bake([tipped({ angle: Math.PI })], 1.5);
    expect(coverageAt(turned, 0.5 - 0.2 / 1.5 / 2, 0.5)).toBeLessThan(15);
    expect(coverageAt(turned, 0.5 + 0.2 / 1.5 / 2, 0.5)).toBeGreaterThan(240);
    const quarter = bake([tipped({ angle: Math.PI / 2 })]);
    expect(coverageAt(quarter, 0.5, 0.4)).toBeGreaterThan(240);
    expect(coverageAt(quarter, 0.5, 0.6)).toBeLessThan(15);
  });

  it("leaves feather out of a tip, and keeps flow, and the stroke's other dabs take the tip", () => {
    expect(differingBytes(bake([tipped({ feather: 1 })]).data, bake([tipped({ feather: 0 })]).data)).toBe(0);
    const half = coverageAt(bake([tipped({ flow: 0.5 })]), 0.4, 0.5);
    expect(half).toBeGreaterThan(120);
    expect(half).toBeLessThan(136);
    const followed = bake([tipped(), dab({ x: 0.6 })]);
    expect(coverageAt(followed, 0.55, 0.5)).toBeGreaterThan(240);
    expect(coverageAt(followed, 0.7, 0.5)).toBeLessThan(15);
  });

  it("lets an erase stroke cut with the tip", () => {
    const baked = bake([dab({ strokeStart: true }), tipped({ erase: true })]);
    expect(coverageAt(baked, 0.4, 0.5)).toBeLessThan(15);
    expect(coverageAt(baked, 0.6, 0.5)).toBeGreaterThan(240);
  });

  it("keeps the tip when a stroke splits where the brush flips to erase", () => {
    const baked = bake([dab({ strokeStart: true }), tipped(), dab({ erase: true })]);
    expect(coverageAt(baked, 0.4, 0.5)).toBeLessThan(15);
    expect(coverageAt(baked, 0.6, 0.5)).toBeGreaterThan(240);
  });

  it("bakes again when the tip arrives after the dabs were baked", () => {
    const baker = new CoverageBaker();
    const items = [{ id: "a", dabs: [tipped()] }];
    setActiveBrushTips({});
    const before = baker.bake(items, 1);
    setActiveBrushTips({ half: halfTip });
    const after = baker.bake(items, 1);
    expect(coverageAt(before as CoverageResult, 0.6, 0.5)).toBe(255);
    expect(coverageAt(after as CoverageResult, 0.6, 0.5)).toBeLessThan(15);
  });
});
