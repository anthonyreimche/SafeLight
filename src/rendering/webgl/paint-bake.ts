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
import { brushTipsGeneration } from "./brush-tips";
import {
  BAKE_SIZE,
  bakeStrokes,
  lazyBakeContext,
  sameDab,
  unionBox,
  WHOLE_BAKE,
  type PixelBox,
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
  /** The pixels that differ from the result the same baker gave before: the
   *  whole texture for its first, null when none do. */
  changed: PixelBox | null;
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
  copy: (p, into) => {
    if (!into) return { a: p.a.slice(), r: p.r.slice(), g: p.g.slice(), b: p.b.slice() };
    into.a.set(p.a);
    into.r.set(p.r);
    into.g.set(p.g);
    into.b.set(p.b);
    return into;
  },
  reset: (p, before, i) => {
    p.a[i] = before.a[i];
    p.r[i] = before.r[i];
    p.g[i] = before.g[i];
    p.b[i] = before.b[i];
  },
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
  keep: (dab) => ({ ...dab, color: [dab.color[0], dab.color[1], dab.color[2]] }),
  same: (x, y) => sameDab(x, y) && sameColour(x.color, y.color),
  splits: (prev, next) => !sameColour(prev.color, next.color),
};

const toByte = (v: number): number => Math.round(Math.max(0, Math.min(1, v)) * 255);

/** Writes `box` of layer `index`'s planes into its tile, and returns that box
 *  in the texture's pixels. Where nothing is painted the texel is clear. */
function writeTile(out: Uint8Array, size: number, index: number, { a, r, g, b }: PaintPlanes, box: PixelBox): PixelBox {
  const x0 = (index % 2) * BAKE_SIZE;
  const y0 = Math.floor(index / 2) * BAKE_SIZE;
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) {
      const i = y * BAKE_SIZE + x;
      const alpha = a[i];
      const o = ((y0 + y) * size + x0 + x) * 4;
      if (alpha === 0) {
        out.fill(0, o, o + 4);
        continue;
      }
      out[o] = toByte(r[i] / alpha);
      out[o + 1] = toByte(g[i] / alpha);
      out[o + 2] = toByte(b[i] / alpha);
      out[o + 3] = toByte(alpha);
    }
  }
  return { x: x0 + box.x, y: y0 + box.y, w: box.w, h: box.h };
}

/** Bakes paint layers like `bakePaint`, byte for byte, keeping each layer's
 *  last bake so a stroke being painted rasterizes only the dabs added to it.
 *  It keeps one texture's bytes and rewrites the pixels that changed: a result's
 *  `data` is those bytes, good until the next bake, and `changed` the pixels
 *  that differ from the result before (null for layers that all stand as last
 *  baked, as a copy of the same strokes does). */
export class PaintBaker {
  private aspect = Number.NaN;
  private tips = -1;
  private baked = new Map<string, LayerBake>();
  private texture: { data: Uint8Array; ids: string[] } | null = null;
  private readonly context = lazyBakeContext();

  bake(layers: PaintLayer[], imageAspect: number): PaintBakeResult | null {
    const list = layers.slice(0, MAX_PAINT_LAYERS);
    if (list.length === 0) {
      this.forget();
      return null;
    }
    const aspect = imageAspect > 0 ? imageAspect : 1;
    // A stroke baked before its tip arrived, or with one since replaced, is stale.
    const tips = brushTipsGeneration();
    if (aspect !== this.aspect || tips !== this.tips) this.forget();
    this.tips = tips;
    try {
      return this.bakeList(list, aspect);
    } catch (err) {
      this.forget();
      throw err;
    }
  }

  private bakeList(list: PaintLayer[], aspect: number): PaintBakeResult | null {
    const size = BAKE_SIZE * 2;
    const ids = list.map((layer) => layer.id);
    // Layers under one id can't each be continued from their own last bake.
    if (new Set(ids).size !== ids.length) this.forget();
    const last = this.texture;
    // Another set or order of layers moves tiles, so every one is written again.
    const whole = !last || last.ids.length !== ids.length || last.ids.some((id, i) => id !== ids[i]);
    const data = whole ? new Uint8Array(size * size * 4) : last.data;
    const kept = new Map<string, LayerBake>();
    let changed: PixelBox | null = whole ? { x: 0, y: 0, w: size, h: size } : null;
    for (const [index, layer] of list.entries()) {
      const result = bakeStrokes(PAINT, layer.dabs, this.baked.get(layer.id), aspect, this.context);
      if (!result) {
        this.forget();
        return null;
      }
      kept.set(layer.id, result.bake);
      const box = whole ? WHOLE_BAKE : result.changed;
      if (box) {
        const written = writeTile(data, size, index, result.bake.total, box);
        if (!whole) changed = unionBox(changed, written);
      }
    }
    this.baked = kept;
    this.texture = { data, ids };
    this.aspect = aspect;
    return { data, size, tile: BAKE_SIZE, changed };
  }

  /** Bakes the next layers from scratch. */
  private forget(): void {
    this.baked.clear();
    this.texture = null;
    this.aspect = Number.NaN;
  }
}

/** Bakes up to four paint layers into one tiled texture. Null for no layers. */
export function bakePaint(layers: PaintLayer[], imageAspect: number): PaintBakeResult | null {
  return new PaintBaker().bake(layers, imageAspect);
}
