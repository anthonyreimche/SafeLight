import type { BrushDab } from "@/catalog/types";

// Freehand coverage (brush masks and brush-shaped retouch) is rasterised into
// the four channels (R,G,B,A) of one RGBA texture, so the shader can read every
// item's coverage with a single sample.

const BAKE_SIZE = 768; // coverage resolution; soft shapes tolerate downscaling

export interface CoverageItem {
  id: string;
  dabs: BrushDab[];
  feather: number; // 0..1 edge softness
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
        it.feather.toFixed(3) +
        ":" +
        it.dabs
          .map(
            (d) =>
              `${d.x.toFixed(4)},${d.y.toFixed(4)},${d.radius.toFixed(4)},${d.erase ? 1 : 0}`,
          )
          .join("|"),
    )
    .join(";");
}

// Bake up to four coverage items into an RGBA atlas. Returns null when empty.
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
    ctx.clearRect(0, 0, BAKE_SIZE, BAKE_SIZE);
    const feather = item.feather;
    for (const dab of item.dabs) {
      const ry = dab.radius * BAKE_SIZE;
      const rx = (dab.radius / aspect) * BAKE_SIZE;
      if (rx < 0.3 || ry < 0.3) continue;
      ctx.save();
      ctx.translate(dab.x * BAKE_SIZE, dab.y * BAKE_SIZE);
      ctx.scale(rx, ry);
      const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
      const core = Math.max(0, 1 - feather);
      grad.addColorStop(0, "rgba(255,255,255,1)");
      grad.addColorStop(core, "rgba(255,255,255,1)");
      grad.addColorStop(1, "rgba(255,255,255,0)");
      ctx.globalCompositeOperation = dab.erase ? "destination-out" : "lighter";
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(0, 0, 1, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    const img = ctx.getImageData(0, 0, BAKE_SIZE, BAKE_SIZE).data;
    for (let i = 0; i < BAKE_SIZE * BAKE_SIZE; i++) {
      out[i * 4 + ch] = img[i * 4 + 3];
    }
  });

  return { data: out, size: BAKE_SIZE, channelOf };
}
