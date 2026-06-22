// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { CatalogPhoto, DevelopParams } from "@/catalog/types";
import type { DecodedImage } from "@/catalog/load-image";
import { loadPhotoImage } from "@/catalog/load-image";
import { computeHistogram, type HistogramData } from "@/rendering/histogram";
import { WebGLRenderer } from "./webgl/renderer";

// The histogram renderer still runs on the main thread — it's lightweight
// (256px) and uses thumbnail bitmaps that are already in memory.
interface Ctx {
  canvas: HTMLCanvasElement;
  renderer: WebGLRenderer;
}
let histCtx: Ctx | null = null;
let histDead = false;

function getHistCtx(): Ctx | null {
  if (histCtx) return histCtx;
  if (histDead) return null;
  try {
    const canvas = document.createElement("canvas");
    histCtx = { canvas, renderer: new WebGLRenderer(canvas) };
    return histCtx;
  } catch {
    histDead = true;
    return null;
  }
}

const MAX_HIST_EDGE = 256;

// Compute the histogram of a photo rendered through the develop pipeline with the
// given params, so the Library histogram reflects the saved edits.
//
// Lightweight by design: the Library Info histogram fires on every photo
// selection, so it renders the already-decoded grid thumbnail (≤768px, in
// memory) through the pipeline rather than re-running loadPhotoImage — which
// would gunzip the multi-MB develop-cache blob (or do a full libraw decode) each
// time you arrow through the grid. The trade-off is thumbnail-grade precision and
// (for RAW) the camera's baked tone instead of the base curve; the full-precision
// histogram still lives in Develop. Falls back to the full decode only when the
// thumbnail isn't loaded yet.
export async function renderPhotoHistogram(
  photo: CatalogPhoto,
  params: DevelopParams,
  maxEdge: number = MAX_HIST_EDGE,
): Promise<HistogramData | null> {
  const ctx = getHistCtx();
  if (!ctx) return null;

  let image: DecodedImage | null = null;
  if (photo.thumbnailBlob) {
    try {
      // Grid thumbnails are baked upright, so no extra orientation needed.
      const bitmap = await createImageBitmap(photo.thumbnailBlob);
      image = { kind: "bitmap", bitmap };
    } catch {
      image = null;
    }
  }
  if (!image) image = await loadPhotoImage(photo);
  if (!image) return null;

  try {
    const asShotTemp = photo.exif.colorTemperature ?? 6500;
    const isFallback = image.kind === "float" ? (image.isFallbackPreview ?? false) : false;
    const cachedRaw = image.kind === "bitmap" && (image.cached ?? false);
    ctx.renderer.setAsShotTemperature(asShotTemp);
    ctx.renderer.setImage(
      image.kind === "bitmap" ? image.bitmap : image,
      maxEdge,
      isFallback,
      cachedRaw,
    );
    ctx.renderer.setParams(params);
    ctx.renderer.render();
    return computeHistogram(ctx.canvas);
  } finally {
    if (image.kind === "bitmap") image.bitmap.close();
  }
}
