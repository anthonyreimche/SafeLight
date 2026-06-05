import type { BrushDab } from "@/catalog/types";

// Freehand coverage (brush masks and brush-shaped retouch) is rasterised into
// the four channels (R,G,B,A) of one RGBA texture, so the shader can read every
// item's coverage with a single sample.

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

// Cheap signature: only geometry affects the texture.
export function coverageSignature(items: CoverageItem[]): string {
  return items
    .map(
      (it) =>
        it.id +
        ":" +
        it.dabs
          .map(
            (d) =>
              `${d.x.toFixed(4)},${d.y.toFixed(4)},${d.radius.toFixed(4)},${d.feather.toFixed(3)},${d.erase ? 1 : 0}`,
          )
          .join("|"),
    )
    .join(";");
}

// Bake up to four coverage items into an RGBA atlas. Returns null when empty.
//
// Coverage is encoded as luminance on an opaque black canvas, and dabs are
// composited with "lighten" (per-pixel max) for paint and "darken" (min) for
// erase. Taking the max — rather than summing alpha — means overlapping dabs
// combine as a union without washing out their soft edges, so a soft dab and a
// hard dab painted into the same mask each keep their own feather. Each dab's
// feather sets the width of its own radial falloff.
export function bakeCoverage(
  items: CoverageItem[],
  imageAspect: number,
): CoverageResult | null {
  const list = items.slice(0, 4);
  if (list.length === 0) return null;

  const canvas = document.createElement("canvas");
  canvas.width = BAKE_SIZE;
  canvas.height = BAKE_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const out = new Uint8Array(BAKE_SIZE * BAKE_SIZE * 4);
  const channelOf: Record<string, number> = {};
  const aspect = imageAspect > 0 ? imageAspect : 1;

  list.forEach((item, ch) => {
    channelOf[item.id] = ch;

    // Opaque black base; coverage lives in the luminance (R) channel.
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, BAKE_SIZE, BAKE_SIZE);

    for (const dab of item.dabs) {
      const ry = dab.radius * BAKE_SIZE;
      const rx = (dab.radius / aspect) * BAKE_SIZE;
      if (rx < 0.3 || ry < 0.3) continue;
      const core = Math.max(0, Math.min(1, 1 - dab.feather)); // solid centre fraction

      ctx.save();
      ctx.translate(dab.x * BAKE_SIZE, dab.y * BAKE_SIZE);
      ctx.scale(rx, ry);
      const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
      if (dab.erase) {
        // Punch a hole: 0 (erased) in the core, fading to white (no-op) at the
        // edge, combined with the existing coverage by min().
        grad.addColorStop(0, "#000");
        grad.addColorStop(core, "#000");
        grad.addColorStop(1, "#fff");
        ctx.globalCompositeOperation = "darken";
      } else {
        // Paint: full coverage in the core, fading to 0 at the edge, combined by
        // max() so it unions cleanly with neighbouring dabs.
        grad.addColorStop(0, "#fff");
        grad.addColorStop(core, "#fff");
        grad.addColorStop(1, "#000");
        ctx.globalCompositeOperation = "lighten";
      }
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, 1, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    ctx.globalCompositeOperation = "source-over";

    const img = ctx.getImageData(0, 0, BAKE_SIZE, BAKE_SIZE).data;
    for (let i = 0; i < BAKE_SIZE * BAKE_SIZE; i++) {
      out[i * 4 + ch] = img[i * 4]; // R channel holds the coverage value
    }
  });

  return { data: out, size: BAKE_SIZE, channelOf };
}
