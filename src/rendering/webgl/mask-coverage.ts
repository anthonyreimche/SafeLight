// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { BrushDab } from "@/catalog/types";
import { MAX_BRUSH_MASKS } from "@/catalog/types";

// Freehand coverage (brush masks, and an official stage's atlas texture such
// as Heal's brush strokes) is rasterized into the four channels (R,G,B,A) of
// one RGBA texture, so the shader can read every item's coverage with a single
// sample. MAX_BRUSH_MASKS is that channel count, bounded by RGBA.

export const BAKE_SIZE = 768; // coverage resolution; soft shapes tolerate downscaling

export interface CoverageItem {
  id: string;
  dabs: BrushDab[]; // each dab carries its own feather (0..1)
}

export interface CoverageResult {
  data: Uint8Array; // RGBA, BAKE_SIZE x BAKE_SIZE
  size: number;
  channelOf: Record<string, number>; // item id -> channel 0..3
}

// Cheap signature: the geometry AND the image aspect, since the bake divides dab
// x-radii by aspect — an aspect change with unchanged dabs still restretches the
// atlas, so it must invalidate the cached texture.
export function coverageSignature(items: CoverageItem[], imageAspect: number): string {
  const geo = items
    .map(
      (it) =>
        it.id +
        ":" +
        it.dabs
          .map(
            (d) =>
              `${d.x.toFixed(4)},${d.y.toFixed(4)},${d.radius.toFixed(4)},${d.feather.toFixed(3)},${(d.opacity ?? 1).toFixed(3)},${(d.flow ?? 1).toFixed(3)},${d.erase ? 1 : 0},${d.strokeStart === true ? 1 : 0}`,
          )
          .join("|"),
    )
    .join(";");
  return `${imageAspect.toFixed(5)}|${geo}`;
}

/** Remembers the inputs of the last coverage bake by identity, so a frame that
 *  changed none of them skips re-signing every dab. The signature walks every
 *  dab, which on a heavily brushed photo costs milliseconds per frame. */
export class CoverageInputs {
  private last: readonly unknown[] | null = null;

  /** True, and remembers `inputs` at once, when any differs by identity from the
   *  previous call's or the count changed. Work that can throw belongs in
   *  `bakeIfChanged`, which forgets them again when it does. */
  changed(inputs: readonly unknown[]): boolean {
    const prev = this.last;
    if (prev && prev.length === inputs.length && inputs.every((v, i) => Object.is(v, prev[i]))) {
      return false;
    }
    this.last = [...inputs];
    return true;
  }

  reset(): void {
    this.last = null;
  }

  /** Runs `bake` when `changed(inputs)`. A bake that throws may have left its
   *  texture half done, so nothing is remembered then: the next call bakes
   *  again, whatever its inputs. */
  bakeIfChanged(inputs: readonly unknown[], bake: () => void): void {
    if (!this.changed(inputs)) return;
    try {
      bake();
    } catch (err) {
      this.reset();
      throw err;
    }
  }
}

export interface StrokeRun<D extends BrushDab = BrushDab> {
  erase: boolean;
  dabs: D[];
}

// Splits an item's dabs into the strokes that composite one over another. A
// stroke starts at a strokeStart dab, and a marked stroke also splits where
// the brush flips between paint and erase. Dabs ahead of the first marker were
// painted before strokes were recorded, so they stay one paint run with any
// erase dabs inside it, which is how they always baked. `splits` starts a
// stroke wherever else the item's kind of dab needs one.
function strokeRuns<D extends BrushDab>(dabs: D[], splits?: (prev: D, next: D) => boolean): StrokeRun<D>[] {
  const runs: StrokeRun<D>[] = [];
  let legacy = true;
  for (const dab of dabs) {
    const start = dab.strokeStart === true;
    if (start) legacy = false;
    const last = runs[runs.length - 1];
    const continues =
      last && !start && (legacy || last.erase === dab.erase) && !splits?.(last.dabs[last.dabs.length - 1], dab);
    if (continues) last.dabs.push(dab);
    else runs.push({ erase: !legacy && dab.erase, dabs: [dab] });
  }
  return runs;
}

export type BakeContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function createBakeContext(): BakeContext | null {
  // The renderer runs in a Web Worker (no `document`), so fall back to an
  // OffscreenCanvas there; the main thread can still use a DOM canvas.
  const canvas: HTMLCanvasElement | OffscreenCanvas =
    typeof document !== "undefined"
      ? document.createElement("canvas")
      : new OffscreenCanvas(BAKE_SIZE, BAKE_SIZE);
  canvas.width = BAKE_SIZE;
  canvas.height = BAKE_SIZE;
  // Every stroke is read back, so keep the canvas in CPU memory.
  return canvas.getContext("2d", { willReadFrequently: true }) as BakeContext | null;
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

// Two controls shape each dab, mirroring a classic paint brush:
//   • flow — how much coverage one dab deposits. Overlapping dabs accumulate
//     (alpha "source-over"), so a low-flow brush builds density gradually as
//     it passes back over an area.
//   • opacity — the ceiling that build-up can reach within one stroke. Each
//     dab raises a per-pixel ceiling (max of its own opacity); the stroke's
//     coverage is its accumulated flow clamped to that ceiling.
// At the defaults (flow 1, opacity 1) a stroke fills solidly to full coverage.
// `lay` receives the stroke's coverage `s` at each pixel `i` it reaches, to
// stack it over the strokes before (StrokeAccumulator).
//
// A run reads back only the pixels it cleared first, so what earlier runs left
// on the canvas never reaches it: each run's coverage depends on its own dabs.
function layRun(ctx: BakeContext, run: StrokeRun, aspect: number, lay: (i: number, s: number) => void): void {
  // Stamp one dab's unit disc with the given composite op; addStops fills in the
  // radial gradient (the solid centre runs out to `core`, then falls off).
  const stamp = (
    dab: BrushDab,
    op: GlobalCompositeOperation,
    addStops: (g: CanvasGradient, core: number) => void,
  ) => {
    const ry = dab.radius * BAKE_SIZE;
    const rx = (dab.radius / aspect) * BAKE_SIZE;
    if (rx < 0.3 || ry < 0.3) return;
    const core = clamp01(1 - dab.feather); // solid centre fraction
    ctx.save();
    ctx.translate(dab.x * BAKE_SIZE, dab.y * BAKE_SIZE);
    ctx.scale(rx, ry);
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    addStops(grad, core);
    ctx.globalCompositeOperation = op;
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  // The pixel box the run's dabs can reach.
  let x0 = BAKE_SIZE;
  let y0 = BAKE_SIZE;
  let x1 = 0;
  let y1 = 0;
  for (const dab of run.dabs) {
    const ry = dab.radius * BAKE_SIZE;
    const rx = (dab.radius / aspect) * BAKE_SIZE;
    x0 = Math.min(x0, Math.floor(dab.x * BAKE_SIZE - rx) - 1);
    y0 = Math.min(y0, Math.floor(dab.y * BAKE_SIZE - ry) - 1);
    x1 = Math.max(x1, Math.ceil(dab.x * BAKE_SIZE + rx) + 1);
    y1 = Math.max(y1, Math.ceil(dab.y * BAKE_SIZE + ry) + 1);
  }
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  x1 = Math.min(BAKE_SIZE, x1);
  y1 = Math.min(BAKE_SIZE, y1);
  if (x1 <= x0 || y1 <= y0) return;
  const box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };

  // ── Pass 1: coverage with flow build-up, in the alpha channel ──
  // Transparent base. Dabs deposit `flow` alpha (source-over accumulates);
  // erase dabs inside a paint run remove it (destination-out).
  ctx.globalCompositeOperation = "source-over";
  ctx.clearRect(box.x, box.y, box.w, box.h);
  for (const dab of run.dabs) {
    const a = clamp01(dab.flow ?? 1).toFixed(4);
    stamp(dab, dab.erase && !run.erase ? "destination-out" : "source-over", (g, core) => {
      g.addColorStop(0, `rgba(255,255,255,${a})`);
      g.addColorStop(core, `rgba(255,255,255,${a})`);
      g.addColorStop(1, "rgba(255,255,255,0)");
    });
  }
  const cover = ctx.getImageData(box.x, box.y, box.w, box.h).data;

  // ── Pass 2: opacity ceiling (luminance) ──
  // Each dab of the run's own kind raises the ceiling to its opacity via
  // max(); erase dabs inside a paint run don't cap anything.
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = "#000";
  ctx.fillRect(box.x, box.y, box.w, box.h);
  for (const dab of run.dabs) {
    if (dab.erase !== run.erase) continue;
    const lvl = Math.round(clamp01(dab.opacity ?? 1) * 255);
    const fill = `rgb(${lvl},${lvl},${lvl})`;
    stamp(dab, "lighten", (g, core) => {
      g.addColorStop(0, fill);
      g.addColorStop(core, fill);
      g.addColorStop(1, "#000");
    });
  }
  ctx.globalCompositeOperation = "source-over";
  const ceil = ctx.getImageData(box.x, box.y, box.w, box.h).data;

  // The run's coverage = accumulated flow clamped to its opacity ceiling.
  for (let y = 0; y < box.h; y++) {
    for (let x = 0; x < box.w; x++) {
      const j = (y * box.w + x) * 4;
      const a = cover[j + 3]; // accumulated flow (alpha)
      const c = ceil[j]; // opacity ceiling (luminance)
      const s = (a < c ? a : c) / 255;
      if (s === 0) continue;
      lay((box.y + y) * BAKE_SIZE + box.x + x, s);
    }
  }
}

export function sameDab(a: BrushDab, b: BrushDab): boolean {
  return (
    a.x === b.x &&
    a.y === b.y &&
    a.radius === b.radius &&
    a.feather === b.feather &&
    a.erase === b.erase &&
    a.opacity === b.opacity &&
    a.flow === b.flow &&
    a.strokeStart === b.strokeStart
  );
}

/** How one kind of item stacks its strokes: the planes it starts from, how a
 *  stroke's coverage `s` lands on pixel `i` of them, which dabs are the same,
 *  and where else a stroke starts (strokeRuns). */
export interface StrokeAccumulator<D extends BrushDab, P> {
  empty(): P;
  copy(planes: P): P;
  lay(planes: P, run: StrokeRun<D>): (i: number, s: number) => void;
  same(a: D, b: D): boolean;
  splits?(prev: D, next: D): boolean;
}

/** One item as last baked: `before` holds every stroke run but the last, which
 *  more dabs of the same stroke replace. Never written once kept. */
export interface StrokeBake<D extends BrushDab, P> {
  dabs: D[];
  runs: number;
  before: P;
  total: P;
}

/** An item's strokes laid into its accumulator's planes, from `prev` where its
 *  dabs only grew since: dabs added after those baked rasterize only the stroke
 *  they continue and the ones they start, and unchanged dabs not at all. Null
 *  when there is no canvas to rasterize with. */
export function bakeStrokes<D extends BrushDab, P>(
  acc: StrokeAccumulator<D, P>,
  dabs: D[],
  prev: StrokeBake<D, P> | undefined,
  aspect: number,
  context: () => BakeContext | null,
): StrokeBake<D, P> | null {
  if (prev?.dabs === dabs) return prev;
  const grows =
    prev !== undefined &&
    prev.dabs.length <= dabs.length &&
    prev.dabs.every((d, i) => acc.same(d, dabs[i]));
  if (grows && prev.dabs.length === dabs.length) return { ...prev, dabs };

  const ctx = context();
  if (!ctx) return null;
  const runs = strokeRuns(dabs, acc.splits);
  // Added dabs only extend the last baked run or start new ones, so the runs
  // before it stand as baked, and so does that run when they took none of it.
  let from = 0;
  let total: P;
  if (grows) {
    const extended = runs.slice(0, prev.runs).reduce((n, run) => n + run.dabs.length, 0) > prev.dabs.length;
    from = extended ? prev.runs - 1 : prev.runs;
    total = acc.copy(extended ? prev.before : prev.total);
  } else {
    total = acc.empty();
  }
  let before = total;
  for (let r = from; r < runs.length; r++) {
    if (r === runs.length - 1) before = acc.copy(total);
    layRun(ctx, runs[r], aspect, acc.lay(total, runs[r]));
  }
  return { dabs, runs: runs.length, before, total };
}

/** Lazily made, so a bake whose items all stand as baked makes no canvas. */
export function lazyBakeContext(): () => BakeContext | null {
  let ctx: BakeContext | null | undefined;
  return () => (ctx === undefined ? (ctx = createBakeContext()) : ctx);
}

// A paint stroke lays its coverage over what is there ("source-over", so two
// 50% strokes reach 75%), and an erase stroke removes that share of it.
const COVERAGE: StrokeAccumulator<BrushDab, Float32Array> = {
  empty: () => new Float32Array(BAKE_SIZE * BAKE_SIZE),
  copy: (total) => total.slice(),
  lay: (total, run) =>
    run.erase
      ? (i, s) => {
          total[i] = total[i] * (1 - s);
        }
      : (i, s) => {
          total[i] = total[i] + s * (1 - total[i]);
        },
  same: sameDab,
};

type ItemBake = StrokeBake<BrushDab, Float32Array>;

/** Bakes coverage items like `bakeCoverage`, byte for byte, keeping each item's
 *  last bake: dabs added after those baked rasterize only the stroke they
 *  continue and the ones they start, and an item whose dabs are unchanged is not
 *  rasterized at all. Dabs are compared by value, so a structured clone of the
 *  same history still counts as unchanged. */
export class CoverageBaker {
  private aspect = Number.NaN;
  private baked = new Map<string, ItemBake>();

  bake(items: CoverageItem[], imageAspect: number): CoverageResult | null {
    const list = items.slice(0, MAX_BRUSH_MASKS);
    if (list.length === 0) return null;
    const aspect = imageAspect > 0 ? imageAspect : 1;
    if (aspect !== this.aspect) this.baked.clear();

    const context = lazyBakeContext();
    const kept = new Map<string, ItemBake>();
    const out = new Uint8Array(BAKE_SIZE * BAKE_SIZE * 4);
    const channelOf: Record<string, number> = {};
    for (const [ch, item] of list.entries()) {
      const bake = bakeStrokes(COVERAGE, item.dabs, this.baked.get(item.id), aspect, context);
      if (!bake) return null;
      kept.set(item.id, bake);
      channelOf[item.id] = ch;
      for (let i = 0; i < BAKE_SIZE * BAKE_SIZE; i++) {
        out[i * 4 + ch] = Math.round(bake.total[i] * 255);
      }
    }
    // Only a bake that finished is kept, so one that threw leaves the last.
    this.baked = kept;
    this.aspect = aspect;
    return { data: out, size: BAKE_SIZE, channelOf };
  }
}

// Bake up to four coverage items into an RGBA atlas. Returns null when empty.
export function bakeCoverage(
  items: CoverageItem[],
  imageAspect: number,
): CoverageResult | null {
  return new CoverageBaker().bake(items, imageAspect);
}
