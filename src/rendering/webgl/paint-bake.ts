// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Paint-kind stage textures (TextureRequirement "paint"): coloured strokes on
// up to four layers, baked into the 2×2 tiles of one RGBA texture so a stage
// reads any layer with one sampler. Each stroke is shaped by the coverage
// bake's own maths (mask-coverage.ts); what differs is that it also lays its
// colour, and that a change of colour starts a new stroke.

import { MAX_PAINT_LAYERS, type PaintDab, type PaintLayer } from "@/extensions/api/contributions";
import {
  BAKE_SIZE,
  bakeStrokes,
  lazyBakeContext,
  sameDab,
  type StrokeAccumulator,
  type StrokeBake,
} from "./mask-coverage";

const PIXELS = BAKE_SIZE * BAKE_SIZE;

export interface PaintBakeResult {
  /** RGBA, `size` × `size`: layer n's tile at column n % 2, row n / 2. A
   *  tile's RGB is its layer's straight colour, A its coverage. */
  data: Uint8Array;
  size: number;
  /** A tile's edge, the coverage bake's size. */
  tile: number;
}

/** A layer's coverage and its colour premultiplied by that coverage. */
interface PaintPlanes {
  a: Float32Array;
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
}

type LayerBake = StrokeBake<PaintDab, PaintPlanes>;

const sameColour = (x: PaintDab["color"], y: PaintDab["color"]): boolean =>
  x[0] === y[0] && x[1] === y[1] && x[2] === y[2];

// A paint stroke lays its colour over what is there by its coverage, so where
// it covers fully its colour replaces what was under it; an erase stroke takes
// that share of coverage and colour away together, leaving the colour as it was.
const PAINT: StrokeAccumulator<PaintDab, PaintPlanes> = {
  empty: () => ({
    a: new Float32Array(PIXELS),
    r: new Float32Array(PIXELS),
    g: new Float32Array(PIXELS),
    b: new Float32Array(PIXELS),
  }),
  copy: (p) => ({ a: p.a.slice(), r: p.r.slice(), g: p.g.slice(), b: p.b.slice() }),
  lay: ({ a, r, g, b }, run) => {
    if (run.erase) {
      return (i, s) => {
        const keep = 1 - s;
        a[i] = a[i] * keep;
        r[i] = r[i] * keep;
        g[i] = g[i] * keep;
        b[i] = b[i] * keep;
      };
    }
    const [cr, cg, cb] = run.dabs[0].color;
    return (i, s) => {
      const keep = 1 - s;
      a[i] = a[i] + s * (1 - a[i]);
      r[i] = r[i] * keep + cr * s;
      g[i] = g[i] * keep + cg * s;
      b[i] = b[i] * keep + cb * s;
    };
  },
  same: (x, y) => sameDab(x, y) && sameColour(x.color, y.color),
  splits: (prev, next) => !sameColour(prev.color, next.color),
};

const toByte = (v: number): number => Math.round(Math.max(0, Math.min(1, v)) * 255);

function writeTile(out: Uint8Array, size: number, index: number, { a, r, g, b }: PaintPlanes): void {
  const x0 = (index % 2) * BAKE_SIZE;
  const y0 = Math.floor(index / 2) * BAKE_SIZE;
  for (let y = 0; y < BAKE_SIZE; y++) {
    for (let x = 0; x < BAKE_SIZE; x++) {
      const i = y * BAKE_SIZE + x;
      const alpha = a[i];
      if (alpha === 0) continue;
      const o = ((y0 + y) * size + x0 + x) * 4;
      out[o] = toByte(r[i] / alpha);
      out[o + 1] = toByte(g[i] / alpha);
      out[o + 2] = toByte(b[i] / alpha);
      out[o + 3] = toByte(alpha);
    }
  }
}

/** Bakes paint layers like `bakePaint`, byte for byte, keeping each layer's
 *  last bake so a stroke being painted rasterizes only itself. Layers that all
 *  stand as last baked (a copy of the same strokes, as the render worker gets)
 *  return the last result itself, so the caller can tell nothing changed. */
export class PaintBaker {
  private aspect = Number.NaN;
  private baked = new Map<string, LayerBake>();
  private last: { result: PaintBakeResult; planes: PaintPlanes[] } | null = null;

  bake(layers: PaintLayer[], imageAspect: number): PaintBakeResult | null {
    const list = layers.slice(0, MAX_PAINT_LAYERS);
    if (list.length === 0) return null;
    const aspect = imageAspect > 0 ? imageAspect : 1;
    if (aspect !== this.aspect) {
      this.baked.clear();
      this.last = null;
    }

    const context = lazyBakeContext();
    const kept = new Map<string, LayerBake>();
    const bakes: LayerBake[] = [];
    for (const layer of list) {
      const bake = bakeStrokes(PAINT, layer.dabs, this.baked.get(layer.id), aspect, context);
      if (!bake) return null;
      kept.set(layer.id, bake);
      bakes.push(bake);
    }
    // Only a bake that finished is kept, so one that threw leaves the last.
    this.baked = kept;
    this.aspect = aspect;
    const planes = bakes.map((b) => b.total);
    const last = this.last;
    if (last && last.planes.length === planes.length && last.planes.every((p, i) => p === planes[i])) {
      return last.result;
    }
    const size = BAKE_SIZE * 2;
    const out = new Uint8Array(size * size * 4);
    for (const [index, bake] of bakes.entries()) {
      if (bake.dabs.length > 0) writeTile(out, size, index, bake.total);
    }
    const result = { data: out, size, tile: BAKE_SIZE };
    this.last = { result, planes };
    return result;
  }
}

/** Bakes up to four paint layers into one tiled texture. Null for no layers. */
export function bakePaint(layers: PaintLayer[], imageAspect: number): PaintBakeResult | null {
  return new PaintBaker().bake(layers, imageAspect);
}
