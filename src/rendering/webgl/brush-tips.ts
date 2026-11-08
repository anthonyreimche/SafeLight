// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The brush tips the coverage and paint bakes stamp with. One set per thread:
// the window sets it from what extensions registered (brush-tip-registry.ts) and
// the render worker from the setBrushTips command, so every renderer on a thread
// bakes with the same tips whether it draws the live view, a thumbnail or an
// export. The bakes read it here rather than being handed it.

import type { BrushTipContribution } from "@/extensions/api/contributions";

type TipCanvas = HTMLCanvasElement | OffscreenCanvas;

const MAX_SHAPES = 64;

let tips: Readonly<Record<string, BrushTipContribution>> = {};
let generation = 0;
let shapes = new Map<string, TipCanvas | null>();

/** Replace the set. Everything baked with the old one is stale, which
 *  `brushTipsGeneration` tells. */
export function setActiveBrushTips(next: Readonly<Record<string, BrushTipContribution>>): void {
  tips = next;
  generation++;
  shapes = new Map();
}

/** The tip a dab names, or undefined for none, an id nothing registered, or a
 *  tip a stroke bakes as the disc. */
export function brushTip(id: string | undefined): BrushTipContribution | undefined {
  return typeof id === "string" && Object.hasOwn(tips, id) ? tips[id] : undefined;
}

/** Changes whenever the set does. */
export function brushTipsGeneration(): number {
  return generation;
}

/** What a bake that used tip `id` was made with: 0 for a tip not held, else a
 *  number that changes with the set. */
export function brushTipVersion(id: string | undefined): number {
  return brushTip(id) ? generation : 0;
}

function scratchCanvas(width: number, height: number): TipCanvas {
  // The renderer runs in a Web Worker, which has no `document`.
  const canvas: TipCanvas =
    typeof document !== "undefined" ? document.createElement("canvas") : new OffscreenCanvas(width, height);
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function shapeCanvas(key: string, tip: BrushTipContribution, texel: (alpha: number) => [number, number, number, number]) {
  const held = shapes.get(key);
  if (held !== undefined) return held;
  const { width, height, data } = tip.alpha;
  const canvas = scratchCanvas(width, height);
  const ctx = canvas.getContext("2d");
  let shape: TipCanvas | null = null;
  if (ctx) {
    const pixels = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < width * height; i++) pixels.set(texel(data[i]), i * 4);
    ctx.putImageData(new ImageData(pixels, width, height), 0, 0);
    shape = canvas;
  }
  // One opacity level per canvas: a brush paints at a few levels, a sweep of the slider at many.
  if (shapes.size >= MAX_SHAPES) shapes.clear();
  shapes.set(key, shape);
  return shape;
}

/** The tip as white whose alpha is its coverage, to stamp as flow. Null where
 *  there is no 2D canvas. */
export function tipCoverageShape(tip: BrushTipContribution): TipCanvas | null {
  return shapeCanvas(`${tip.id}:cover`, tip, (a) => [255, 255, 255, a]);
}

/** The tip as opaque grey, its coverage scaled by `level` (0 to 255), to stamp
 *  with "lighten" as an opacity ceiling. */
export function tipLevelShape(tip: BrushTipContribution, level: number): TipCanvas | null {
  return shapeCanvas(`${tip.id}:${level}`, tip, (a) => {
    const grey = Math.round((a * level) / 255);
    return [grey, grey, grey, 255];
  });
}
