// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { BrushDab } from "@/catalog/types";
import { MAX_BRUSH_MASKS } from "@/catalog/types";

// Freehand coverage (brush masks and brush-shaped retouch) is rasterised into
// the four channels (R,G,B,A) of one RGBA texture, so the shader can read every
// item's coverage with a single sample. MAX_BRUSH_MASKS is that channel count —
// the same cap the retouch atlas uses (MAX_RETOUCH_BRUSH), both bounded by RGBA.

const BAKE_SIZE = 768; // coverage resolution; soft shapes tolerate downscaling

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

interface StrokeRun {
  erase: boolean;
  dabs: BrushDab[];
}

// Splits an item's dabs into the strokes that composite one over another. A
// stroke starts at a strokeStart dab, and a marked stroke also splits where
// the brush flips between paint and erase. Dabs ahead of the first marker were
// painted before strokes were recorded, so they stay one paint run with any
// erase dabs inside it, which is how they always baked.
function strokeRuns(dabs: BrushDab[]): StrokeRun[] {
  const runs: StrokeRun[] = [];
  let legacy = true;
  for (const dab of dabs) {
    const start = dab.strokeStart === true;
    if (start) legacy = false;
    const last = runs[runs.length - 1];
    if (last && !start && (legacy || last.erase === dab.erase)) last.dabs.push(dab);
    else runs.push({ erase: !legacy && dab.erase, dabs: [dab] });
  }
  return runs;
}

// Bake up to four coverage items into an RGBA atlas. Returns null when empty.
//
// Two controls shape each dab, mirroring a classic paint brush:
//   • flow — how much coverage one dab deposits. Overlapping dabs accumulate
//     (alpha "source-over"), so a low-flow brush builds density gradually as
//     it passes back over an area.
//   • opacity — the ceiling that build-up can reach within one stroke. Each
//     dab raises a per-pixel ceiling (max of its own opacity); the stroke's
//     coverage is its accumulated flow clamped to that ceiling.
// Strokes then stack: a paint stroke lays its coverage over what is there
// ("source-over", so two 50% strokes reach 75%), and an erase stroke removes
// that share of it.
// At the defaults (flow 1, opacity 1) a stroke fills solidly to full coverage.
export function bakeCoverage(
  items: CoverageItem[],
  imageAspect: number,
): CoverageResult | null {
  const list = items.slice(0, MAX_BRUSH_MASKS);
  if (list.length === 0) return null;

  // The renderer runs in a Web Worker (no `document`), so fall back to an
  // OffscreenCanvas there; the main thread can still use a DOM canvas.
  const canvas: HTMLCanvasElement | OffscreenCanvas =
    typeof document !== "undefined"
      ? document.createElement("canvas")
      : new OffscreenCanvas(BAKE_SIZE, BAKE_SIZE);
  canvas.width = BAKE_SIZE;
  canvas.height = BAKE_SIZE;
  // Every stroke is read back, so keep the canvas in CPU memory.
  const ctx = canvas.getContext("2d", { willReadFrequently: true }) as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) return null;

  const out = new Uint8Array(BAKE_SIZE * BAKE_SIZE * 4);
  const channelOf: Record<string, number> = {};
  const aspect = imageAspect > 0 ? imageAspect : 1;
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

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

  // The pixel box a run's dabs can reach, or null when they reach none.
  const runBox = (dabs: BrushDab[]) => {
    let x0 = BAKE_SIZE;
    let y0 = BAKE_SIZE;
    let x1 = 0;
    let y1 = 0;
    for (const dab of dabs) {
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
    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
  };

  list.forEach((item, ch) => {
    channelOf[item.id] = ch;
    const total = new Float32Array(BAKE_SIZE * BAKE_SIZE);

    for (const run of strokeRuns(item.dabs)) {
      const box = runBox(run.dabs);
      if (!box) continue;

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

      // The run's coverage = accumulated flow clamped to its opacity ceiling,
      // laid over (or cut out of) the strokes before it.
      for (let y = 0; y < box.h; y++) {
        for (let x = 0; x < box.w; x++) {
          const j = (y * box.w + x) * 4;
          const a = cover[j + 3]; // accumulated flow (alpha)
          const c = ceil[j]; // opacity ceiling (luminance)
          const s = (a < c ? a : c) / 255;
          if (s === 0) continue;
          const i = (box.y + y) * BAKE_SIZE + box.x + x;
          total[i] = run.erase ? total[i] * (1 - s) : total[i] + s * (1 - total[i]);
        }
      }
    }

    for (let i = 0; i < BAKE_SIZE * BAKE_SIZE; i++) {
      out[i * 4 + ch] = Math.round(total[i] * 255);
    }
  });

  return { data: out, size: BAKE_SIZE, channelOf };
}
