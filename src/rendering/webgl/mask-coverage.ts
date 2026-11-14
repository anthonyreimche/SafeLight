// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { BrushDab } from "@/catalog/types";
import type { BrushTipContribution } from "@/extensions/api/contributions";
import { MAX_BRUSH_MASKS } from "@/catalog/types";
import { brushTip, brushTipVersion, brushTipsGeneration, tipCoverageShape, tipLevelShape } from "./brush-tips";

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
  /** The pixels that differ from the result the same baker gave before: the
   *  whole bake for its first, null when none do. */
  changed: PixelBox | null;
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
              `${d.x.toFixed(4)},${d.y.toFixed(4)},${d.radius.toFixed(4)},${d.feather.toFixed(3)},${(d.opacity ?? 1).toFixed(3)},${(d.flow ?? 1).toFixed(3)},${d.erase ? 1 : 0},${d.strokeStart === true ? 1 : 0},${d.tip ?? ""}@${brushTipVersion(d.tip)},${(d.angle ?? 0).toFixed(3)}`,
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
  /** The tip and angle of the stroke's start dab, which every run of the stroke
   *  inherits, including the one that begins where the brush flips to erase. */
  tip?: string;
  angle?: number;
}

/** Where splitting an item's dabs into runs stood after its last dab, so dabs
 *  added later split as they would among all of them. */
interface RunCursor<D extends BrushDab> {
  legacy: boolean;
  tip?: string;
  angle?: number;
  /** The last run, `dabs` holding only its last dab. */
  last: StrokeRun<D> | null;
}

const RUN_START: RunCursor<never> = { legacy: true, last: null };

// Splits an item's dabs into the strokes that composite one over another. A
// stroke starts at a strokeStart dab, and a marked stroke also splits where
// the brush flips between paint and erase. Dabs ahead of the first marker were
// painted before strokes were recorded, so they stay one paint run with any
// erase dabs inside it, which is how they always baked. `splits` starts a
// stroke wherever else the item's kind of dab needs one.
//
// Splits `added`, the dabs after those `cursor` has seen: `continues` when the
// first run returned carries on the cursor's last run.
function strokeRuns<D extends BrushDab>(
  cursor: RunCursor<D>,
  added: D[],
  splits?: (prev: D, next: D) => boolean,
): { runs: StrokeRun<D>[]; continues: boolean; cursor: RunCursor<D> } {
  const runs: StrokeRun<D>[] = [];
  let { legacy, tip, angle, last } = cursor;
  let continues = false;
  for (const dab of added) {
    const start = dab.strokeStart === true;
    if (start) {
      legacy = false;
      tip = dab.tip;
      angle = dab.angle;
    }
    if (last && !start && (legacy || last.erase === dab.erase) && !splits?.(last.dabs[0], dab)) {
      if (runs.length === 0) {
        continues = true;
        runs.push({ ...last, dabs: [] });
      }
      runs[runs.length - 1].dabs.push(dab);
      last = { ...last, dabs: [dab] };
    } else {
      const run = { erase: !legacy && dab.erase, dabs: [dab], tip, angle };
      runs.push(run);
      last = { ...run, dabs: [dab] };
    }
  }
  return { runs, continues, cursor: { legacy, tip, angle, last } };
}

export type BakeContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function createBakeContext(): BakeContext | null {
  // An OffscreenCanvas wherever there is one, as in the render worker, which
  // has no `document`. A DOM canvas read back often rasterizes a dab's edge a
  // level apart once anything has drawn another canvas onto it (a brush tip),
  // so its bytes would depend on what was baked before them.
  const canvas: HTMLCanvasElement | OffscreenCanvas =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(BAKE_SIZE, BAKE_SIZE)
      : document.createElement("canvas");
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
//
// With `open`, the run keeps its own coverage (OpenStroke) in the pixels its
// dabs reach, and when `continued`, `run.dabs` are dabs added to a run laid
// before: the canvas starts from the coverage it kept rather than clear, which
// is what the canvas held after its last dab, so laying only the added dabs
// leaves the same bytes as laying the whole run again. Its pixels then stack
// over the strokes before it again from `reset`. Returns the pixels it laid.
function layRun(
  ctx: BakeContext,
  run: StrokeRun,
  aspect: number,
  lay: (i: number, s: number) => void,
  open?: { stroke: OpenStroke; continued: boolean; reset: (i: number) => void },
): PixelBox | null {
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

  // A registered tip is stamped in place of the disc: its longest edge across the
  // dab's diameter, turned by the stroke's angle in the picture's own proportions
  // (the turn comes before the stretch to the image's aspect), at `alpha`.
  const tip = brushTip(run.tip);
  const coverShape = tip ? tipCoverageShape(tip) : null;
  const stampTip = (
    { alpha: { width, height } }: BrushTipContribution,
    dab: BrushDab,
    op: GlobalCompositeOperation,
    shape: CanvasImageSource,
    alpha: number,
  ) => {
    const ry = dab.radius * BAKE_SIZE;
    const rx = (dab.radius / aspect) * BAKE_SIZE;
    if (rx < 0.3 || ry < 0.3) return;
    const halfWidth = width >= height ? 1 : width / height;
    const halfHeight = height >= width ? 1 : height / width;
    ctx.save();
    ctx.translate(dab.x * BAKE_SIZE, dab.y * BAKE_SIZE);
    ctx.scale(rx, ry);
    ctx.rotate(run.angle ?? 0);
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = op;
    ctx.drawImage(shape, -halfWidth, -halfHeight, halfWidth * 2, halfHeight * 2);
    ctx.restore();
  };
  // A tip's corners reach past the disc it replaces.
  const reach = tip && coverShape ? Math.SQRT2 : 1;

  const box = reachOf(run.dabs, aspect, reach);
  if (!box) return null;
  const continued = open?.continued === true;

  // ── Pass 1: coverage with flow build-up, in the alpha channel ──
  // Transparent base. Dabs deposit `flow` alpha (source-over accumulates);
  // erase dabs inside a paint run remove it (destination-out).
  ctx.globalCompositeOperation = "source-over";
  if (continued) restoreCanvas(ctx, box, open.stroke.cover, "alpha");
  else ctx.clearRect(box.x, box.y, box.w, box.h);
  for (const dab of run.dabs) {
    const flow = clamp01(dab.flow ?? 1);
    const a = flow.toFixed(4);
    const op = dab.erase && !run.erase ? "destination-out" : "source-over";
    if (tip && coverShape) {
      stampTip(tip, dab, op, coverShape, flow);
      continue;
    }
    stamp(dab, op, (g, core) => {
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
  if (continued) {
    restoreCanvas(ctx, box, open.stroke.ceil, "grey");
  } else {
    ctx.fillStyle = "#000";
    ctx.fillRect(box.x, box.y, box.w, box.h);
  }
  for (const dab of run.dabs) {
    if (dab.erase !== run.erase) continue;
    const lvl = Math.round(clamp01(dab.opacity ?? 1) * 255);
    const levelShape = tip && coverShape ? tipLevelShape(tip, lvl) : null;
    if (tip && levelShape) {
      stampTip(tip, dab, "lighten", levelShape, 1);
      continue;
    }
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
      const i = (box.y + y) * BAKE_SIZE + box.x + x;
      if (open) {
        open.stroke.cover[i] = a;
        open.stroke.ceil[i] = c;
        if (continued) open.reset(i);
      }
      const s = (a < c ? a : c) / 255;
      if (s === 0) continue;
      lay(i, s);
    }
  }
  return box;
}

/** Puts a kept plane back on the canvas over `box`: as the alpha of white for
 *  the flow pass, as an opaque grey for the ceiling pass. putImageData replaces
 *  the pixels whatever the composite op or transform. */
function restoreCanvas(ctx: BakeContext, box: PixelBox, plane: Uint8Array, as: "alpha" | "grey"): void {
  const image = ctx.createImageData(box.w, box.h);
  const px = image.data;
  for (let y = 0; y < box.h; y++) {
    for (let x = 0; x < box.w; x++) {
      const v = plane[(box.y + y) * BAKE_SIZE + box.x + x];
      const j = (y * box.w + x) * 4;
      const c = as === "alpha" ? 255 : v;
      px[j] = c;
      px[j + 1] = c;
      px[j + 2] = c;
      px[j + 3] = as === "alpha" ? v : 255;
    }
  }
  ctx.putImageData(image, box.x, box.y);
}

/** A rectangle of atlas pixels. */
export interface PixelBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Every pixel of one coverage bake. */
export const WHOLE_BAKE: Readonly<PixelBox> = Object.freeze({ x: 0, y: 0, w: BAKE_SIZE, h: BAKE_SIZE });

export function unionBox(a: PixelBox | null, b: PixelBox | null): PixelBox | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

// The pixels the dabs can reach, `reach` times their radius out, plus a pixel
// for antialiasing; null when that misses the bake.
function reachOf(dabs: BrushDab[], aspect: number, reach: number): PixelBox | null {
  let x0 = BAKE_SIZE;
  let y0 = BAKE_SIZE;
  let x1 = 0;
  let y1 = 0;
  for (const dab of dabs) {
    const ry = dab.radius * BAKE_SIZE * reach;
    const rx = (dab.radius / aspect) * BAKE_SIZE * reach;
    x0 = Math.min(x0, Math.floor(dab.x * BAKE_SIZE - rx) - 1);
    y0 = Math.min(y0, Math.floor(dab.y * BAKE_SIZE - ry) - 1);
    x1 = Math.max(x1, Math.ceil(dab.x * BAKE_SIZE + rx) + 1);
    y1 = Math.max(y1, Math.ceil(dab.y * BAKE_SIZE + ry) + 1);
  }
  x0 = Math.max(0, x0);
  y0 = Math.max(0, y0);
  x1 = Math.min(BAKE_SIZE, x1);
  y1 = Math.min(BAKE_SIZE, y1);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
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
    a.strokeStart === b.strokeStart &&
    a.tip === b.tip &&
    a.angle === b.angle
  );
}

/** How one kind of item stacks its strokes: the planes it starts from, how a
 *  stroke's coverage `s` lands on pixel `i` of them, how pixel `i` goes back to
 *  what it was before the last stroke, which dabs are the same, and where else
 *  a stroke starts (strokeRuns). */
export interface StrokeAccumulator<D extends BrushDab, P> {
  empty(): P;
  /** `planes` copied into `into`, or into new planes. */
  copy(planes: P, into?: P): P;
  lay(planes: P, run: StrokeRun<D>): (i: number, s: number) => void;
  reset(planes: P, before: P, i: number): void;
  /** A copy of a dab's values, which a later bake compares with `same`. */
  keep(dab: D): D;
  same(a: D, b: D): boolean;
  splits?(prev: D, next: D): boolean;
}

/** The last stroke's own coverage, per bake pixel: the flow it built up and
 *  its opacity ceiling, as its canvas held them after its last dab. */
interface OpenStroke {
  cover: Uint8Array;
  ceil: Uint8Array;
}

/** One item as last baked: `total` holds every stroke, `before` every stroke
 *  but the last, which more dabs of the same stroke continue from `open`. The
 *  next bake of the item writes them in place, so a bake that throws leaves
 *  them unusable: its baker forgets them. */
export interface StrokeBake<D extends BrushDab, P> {
  /** Copies of the dabs baked: a caller may edit its own list or dabs in place
   *  (a main-thread renderer is handed them uncloned). */
  dabs: D[];
  cursor: RunCursor<D>;
  before: P;
  total: P;
  open: OpenStroke | null;
}

/** An item's strokes laid into its accumulator's planes, continuing `prev`
 *  where its dabs only grew since: only the dabs added are rasterized, and
 *  `changed` holds the pixels they changed. Otherwise the item bakes from
 *  scratch and `changed` is the whole bake. Null when there is no canvas to
 *  rasterize with. */
export function bakeStrokes<D extends BrushDab, P>(
  acc: StrokeAccumulator<D, P>,
  dabs: D[],
  prev: StrokeBake<D, P> | undefined,
  aspect: number,
  context: () => BakeContext | null,
): { bake: StrokeBake<D, P>; changed: PixelBox | null } | null {
  const grows =
    prev !== undefined && prev.dabs.length <= dabs.length && prev.dabs.every((d, i) => acc.same(d, dabs[i]));
  if (grows && prev.dabs.length === dabs.length) return { bake: prev, changed: null };

  const ctx = context();
  if (!ctx) return null;
  const bake: StrokeBake<D, P> = grows
    ? prev
    : { dabs: [], cursor: RUN_START, before: acc.empty(), total: acc.empty(), open: null };
  const added = dabs.slice(bake.dabs.length).map((d) => acc.keep(d));
  const { runs, continues, cursor } = strokeRuns(bake.cursor, added, acc.splits);
  const reset = (i: number) => acc.reset(bake.total, bake.before, i);
  let changed: PixelBox | null = null;
  for (const [r, run] of runs.entries()) {
    const continued = r === 0 && continues;
    let open: OpenStroke | undefined;
    if (continued) {
      if (!bake.open) throw new Error("coverage bake: the stroke being continued kept no coverage");
      open = bake.open;
    } else if (r === runs.length - 1) {
      acc.copy(bake.total, bake.before);
      open = bake.open ?? { cover: new Uint8Array(BAKE_SIZE * BAKE_SIZE), ceil: new Uint8Array(BAKE_SIZE * BAKE_SIZE) };
      open.cover.fill(0);
      open.ceil.fill(0);
      bake.open = open;
    }
    const lay = acc.lay(bake.total, run);
    const box = layRun(ctx, run, aspect, lay, open && { stroke: open, continued, reset });
    changed = unionBox(changed, box);
  }
  for (const d of added) bake.dabs.push(d);
  bake.cursor = cursor;
  return { bake, changed: grows ? changed : WHOLE_BAKE };
}

/** Lazily made, so a bake whose items all stand as baked makes no canvas, and
 *  then kept: every run clears or restores the pixels it reads first. */
export function lazyBakeContext(): () => BakeContext | null {
  let ctx: BakeContext | null | undefined;
  return () => (ctx === undefined ? (ctx = createBakeContext()) : ctx);
}

// A paint stroke lays its coverage over what is there ("source-over", so two
// 50% strokes reach 75%), and an erase stroke removes that share of it.
const COVERAGE: StrokeAccumulator<BrushDab, Float32Array> = {
  empty: () => new Float32Array(BAKE_SIZE * BAKE_SIZE),
  copy: (total, into) => {
    if (!into) return total.slice();
    into.set(total);
    return into;
  },
  lay: (total, run) =>
    run.erase
      ? (i, s) => {
          total[i] = total[i] * (1 - s);
        }
      : (i, s) => {
          total[i] = total[i] + s * (1 - total[i]);
        },
  reset: (total, before, i) => {
    total[i] = before[i];
  },
  keep: (dab) => ({ ...dab }),
  same: sameDab,
};

type ItemBake = StrokeBake<BrushDab, Float32Array>;

function packChannel(out: Uint8Array, ch: number, total: Float32Array, box: PixelBox): void {
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let i = y * BAKE_SIZE + box.x, end = i + box.w; i < end; i++) {
      out[i * 4 + ch] = Math.round(total[i] * 255);
    }
  }
}

/** Bakes coverage items like `bakeCoverage`, byte for byte, keeping each item's
 *  last bake: dabs added after those baked are all it rasterizes, and an item
 *  whose dabs are unchanged is not rasterized at all. Dabs are compared by value,
 *  so a structured clone of the same history still counts as unchanged.
 *
 *  It keeps one atlas and rewrites the pixels that changed: a result's `data`
 *  is that atlas, good until the next bake, and `changed` the pixels that differ
 *  from the result before. */
export class CoverageBaker {
  private aspect = Number.NaN;
  private tips = -1;
  private baked = new Map<string, ItemBake>();
  private atlas: { data: Uint8Array; ids: string[] } | null = null;
  private readonly context = lazyBakeContext();

  bake(items: CoverageItem[], imageAspect: number): CoverageResult | null {
    const list = items.slice(0, MAX_BRUSH_MASKS);
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

  private bakeList(list: CoverageItem[], aspect: number): CoverageResult | null {
    const ids = list.map((item) => item.id);
    // Items under one id can't each be continued from their own last bake.
    if (new Set(ids).size !== ids.length) this.forget();
    const last = this.atlas;
    // Another set or order of items moves channels, so every one is written again.
    const whole = !last || last.ids.length !== ids.length || last.ids.some((id, i) => id !== ids[i]);
    const data = whole ? new Uint8Array(BAKE_SIZE * BAKE_SIZE * 4) : last.data;
    const kept = new Map<string, ItemBake>();
    const channelOf: Record<string, number> = {};
    let changed: PixelBox | null = whole ? WHOLE_BAKE : null;
    for (const [ch, item] of list.entries()) {
      const result = bakeStrokes(COVERAGE, item.dabs, this.baked.get(item.id), aspect, this.context);
      if (!result) {
        this.forget();
        return null;
      }
      kept.set(item.id, result.bake);
      channelOf[item.id] = ch;
      const box = whole ? WHOLE_BAKE : result.changed;
      if (box) packChannel(data, ch, result.bake.total, box);
      if (!whole) changed = unionBox(changed, box);
    }
    this.baked = kept;
    this.atlas = { data, ids };
    this.aspect = aspect;
    return { data, size: BAKE_SIZE, channelOf, changed };
  }

  /** Bakes the next items from scratch. */
  private forget(): void {
    this.baked.clear();
    this.atlas = null;
    this.aspect = Number.NaN;
  }
}

// Bake up to four coverage items into an RGBA atlas. Returns null when empty.
export function bakeCoverage(
  items: CoverageItem[],
  imageAspect: number,
): CoverageResult | null {
  return new CoverageBaker().bake(items, imageAspect);
}
