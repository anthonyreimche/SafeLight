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
              `${d.x.toFixed(4)},${d.y.toFixed(4)},${d.radius.toFixed(4)},${d.feather.toFixed(3)},${(d.opacity ?? 1).toFixed(3)},${(d.flow ?? 1).toFixed(3)},${d.erase ? 1 : 0}`,
          )
          .join("|"),
    )
    .join(";");
  return `${imageAspect.toFixed(5)}|${geo}`;
}

// Bake up to four coverage items into an RGBA atlas. Returns null when empty.
//
// Two controls shape each dab, mirroring a classic paint brush:
//   • flow — how much coverage one dab deposits. Overlapping dabs accumulate
//     (alpha "source-over"), so a low-flow brush builds density gradually as
//     strokes pass back over an area; erase dabs remove coverage the same way.
//   • opacity — the ceiling that build-up can reach. Each paint dab raises a
//     separate per-pixel ceiling (max of its own opacity); the final coverage
//     is the accumulated flow clamped to that ceiling.
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
  const ctx = canvas.getContext("2d") as
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

  list.forEach((item, ch) => {
    channelOf[item.id] = ch;

    // ── Pass 1: coverage with flow build-up, in the alpha channel ──
    // Transparent base. Paint deposits `flow` alpha (source-over accumulates);
    // erase removes it (destination-out).
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, BAKE_SIZE, BAKE_SIZE);
    for (const dab of item.dabs) {
      const a = clamp01(dab.flow ?? 1).toFixed(4);
      stamp(dab, dab.erase ? "destination-out" : "source-over", (g, core) => {
        g.addColorStop(0, `rgba(255,255,255,${a})`);
        g.addColorStop(core, `rgba(255,255,255,${a})`);
        g.addColorStop(1, "rgba(255,255,255,0)");
      });
    }
    const cover = ctx.getImageData(0, 0, BAKE_SIZE, BAKE_SIZE).data;

    // ── Pass 2: opacity ceiling (luminance, paint dabs only) ──
    // Each paint dab raises the ceiling to its own opacity via max(); erase
    // dabs don't cap anything.
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, BAKE_SIZE, BAKE_SIZE);
    for (const dab of item.dabs) {
      if (dab.erase) continue;
      const lvl = Math.round(clamp01(dab.opacity ?? 1) * 255);
      const fill = `rgb(${lvl},${lvl},${lvl})`;
      stamp(dab, "lighten", (g, core) => {
        g.addColorStop(0, fill);
        g.addColorStop(core, fill);
        g.addColorStop(1, "#000");
      });
    }
    ctx.globalCompositeOperation = "source-over";
    const ceil = ctx.getImageData(0, 0, BAKE_SIZE, BAKE_SIZE).data;

    // Final coverage = accumulated flow clamped to the per-pixel opacity ceiling.
    for (let i = 0; i < BAKE_SIZE * BAKE_SIZE; i++) {
      const a = cover[i * 4 + 3]; // accumulated flow (alpha)
      const c = ceil[i * 4]; // opacity ceiling (luminance)
      out[i * 4 + ch] = a < c ? a : c;
    }
  });

  return { data: out, size: BAKE_SIZE, channelOf };
}
