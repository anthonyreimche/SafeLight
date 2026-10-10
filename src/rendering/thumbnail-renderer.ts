// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import type { CatalogPhoto, DevelopParams } from "@/catalog/types";
import type { DecodedImage } from "@/catalog/load-image";
import { loadPhotoImage } from "@/catalog/load-image";
import { computeHistogram, type HistogramData } from "@/rendering/histogram";
import { setPhotoParams } from "@/extensions/pipelines";
import { WebGLRenderer } from "./webgl/renderer";

// The histogram renderer still runs on the main thread — it's lightweight
// (256px) and uses thumbnail bitmaps that are already in memory.
interface Ctx {
  canvas: HTMLCanvasElement;
  renderer: WebGLRenderer;
}
let histCtx: Ctx | null = null;
let histDead = false;
// The last build failure reported. The renderer rethrows a remembered failure as the
// same object, so one that every photo meets is logged once, not once per photo.
let lastBuildError: unknown = null;

// Drop a context that can no longer be used. Calls aren't serialized and a lost
// context is dropped by its listener, so another call may have replaced it by now;
// that replacement is not to be touched.
function dropHistCtx(ctx: Ctx): void {
  ctx.renderer.dispose();
  if (histCtx === ctx) histCtx = null;
}

// The histogram is over for the session: no renderer can be created, or the driver
// can't build the stock program, and neither recovers on retry. `ctx` is the context
// that failed. If another has replaced it, its failure says nothing about the
// replacement and nothing changes.
function endHistogram(ctx: Ctx | null, err: unknown): void {
  if (ctx && histCtx !== ctx) return;
  console.error("[histogram] the renderer is unavailable:", err);
  if (ctx) dropHistCtx(ctx);
  histDead = true;
}

// A lost context fails every compile, the stock program's too. That says nothing
// about the machine: its listener drops the context and the next call starts afresh.
function contextLost(ctx: Ctx): boolean {
  return ctx.canvas.getContext("webgl2")?.isContextLost() ?? false;
}

// Builds the develop program for a photo's process version, which a renderer would
// otherwise build on the first frame it draws. False when it can't be. If even the
// stock program can't, the histogram is over for the session. Otherwise only these
// stages or this transform fail: this photo gets no histogram and a later one can,
// the renderer rethrowing its remembered failure so a retry is cheap.
function prepare(ctx: Ctx, processVersion: number): boolean {
  try {
    ctx.renderer.prepareProgram(processVersion);
    return true;
  } catch (err) {
    if (contextLost(ctx)) return false;
    try {
      ctx.renderer.prepareStockProgram(processVersion);
    } catch (stockErr) {
      endHistogram(ctx, stockErr);
      return false;
    }
    if (err !== lastBuildError) {
      lastBuildError = err;
      console.error(
        "[histogram] stages or display transform can't be built; no histogram until they change:",
        err,
      );
    }
    return false;
  }
}

function getHistCtx(processVersion: number): Ctx | null {
  if (histDead) return null;
  let ctx = histCtx;
  if (!ctx) {
    try {
      const canvas = document.createElement("canvas");
      const created: Ctx = { canvas, renderer: new WebGLRenderer(canvas) };
      // A GPU reset kills the singleton's context; drop it so the next call
      // rebuilds instead of rendering into a dead renderer (histDead stays a
      // latch for what won't recover on retry: see endHistogram).
      canvas.addEventListener("webglcontextlost", () => dropHistCtx(created));
      histCtx = created;
      ctx = created;
    } catch (err) {
      endHistogram(null, err);
      return null;
    }
  }
  // Building the program here, not on the first frame, fails a photo before it is
  // decoded.
  return prepare(ctx, processVersion) ? ctx : null;
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
  const ctx = getHistCtx(params.processVersion);
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
    // A cached RAW (float16) is capped to the histogram edge like a thumbnail:
    // this renderer runs on the main thread, and a 256 px render needs no more.
    ctx.renderer.setImage(
      image.kind === "bitmap" ? image.bitmap : image,
      maxEdge,
      isFallback,
      cachedRaw,
      true,
    );
    setPhotoParams(ctx.renderer, params);
    // The program for this photo's display transform and version, unless an earlier
    // photo built it. Left to render(), a build failure would throw out of this async
    // function; any other failure of the frame still does, and leaves the histogram
    // for the next photo.
    if (!prepare(ctx, params.processVersion)) return null;
    ctx.renderer.render();
    return computeHistogram(ctx.canvas);
  } finally {
    if (image.kind === "bitmap") image.bitmap.close();
  }
}
