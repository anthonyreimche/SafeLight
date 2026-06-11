import type { CatalogPhoto, DevelopParams } from "@/catalog/types";
import type { DecodedImage } from "@/catalog/load-image";
import { loadPhotoImage } from "@/catalog/load-image";
import { computeHistogram, type HistogramData } from "@/rendering/histogram";
import { WebGLRenderer } from "./webgl/renderer";
import { getSettings } from "@/state/settings-store";

// Two lazily-created offscreen renderers: one drives grid-thumbnail JPEGs, the
// other the Library histogram. They are kept separate so a histogram render can't
// clobber the shared canvas midway through a thumbnail's async toBlob (and vice
// versa). Each is reused across the session to avoid per-call context cost.
interface Ctx {
  canvas: HTMLCanvasElement;
  renderer: WebGLRenderer;
}
let thumbCtx: Ctx | null = null;
let histCtx: Ctx | null = null;
let thumbDead = false;
let histDead = false;

function getCtx(which: "thumb" | "hist"): Ctx | null {
  const cur = which === "thumb" ? thumbCtx : histCtx;
  if (cur) return cur;
  if (which === "thumb" ? thumbDead : histDead) return null;
  try {
    const canvas = document.createElement("canvas");
    const ctx: Ctx = { canvas, renderer: new WebGLRenderer(canvas) };
    if (which === "thumb") thumbCtx = ctx;
    else histCtx = ctx;
    return ctx;
  } catch {
    if (which === "thumb") thumbDead = true;
    else histDead = true;
    return null;
  }
}

// Grid thumbnails never need more than a few hundred px; this keeps each render
// (and the resulting JPEG) cheap while staying crisp at large grid sizes.
// The cap is a preference (Preferences ▸ Library ▸ Thumbnail quality).
// The histogram only needs enough pixels for a stable distribution.
const MAX_HIST_EDGE = 512;

// Render a photo through the develop pipeline on the given renderer, using the
// SAME decode as Develop/Loupe/Export — full-res RAW float (with the base tone
// curve) or the cached develop preview — so every view is tonally consistent.
function drawPhoto(
  ctx: Ctx,
  image: DecodedImage,
  params: DevelopParams,
  maxEdge: number,
): void {
  const isFallback =
    image.kind === "float" ? (image.isFallbackPreview ?? false) : false;
  // Cached develop preview is linear-encoded RAW; it needs the base tone curve.
  const cachedRaw = image.kind === "bitmap" && (image.cached ?? false);
  ctx.renderer.setImage(
    image.kind === "bitmap" ? image.bitmap : image,
    maxEdge,
    isFallback,
    cachedRaw,
  );
  ctx.renderer.setParams(params);
  ctx.renderer.render();
}

// Render an edited (and cropped/straightened) thumbnail for a photo as a JPEG
// blob. Returns null if the photo can't be decoded or WebGL is unavailable.
// Calls are serialized by the caller, since the thumbnail renderer is a singleton.
export async function renderEditedThumbnail(
  photo: CatalogPhoto,
  params: DevelopParams,
  maxEdge: number = getSettings().thumbMaxEdge,
): Promise<Blob | null> {
  const ctx = getCtx("thumb");
  if (!ctx) return null;
  const image = await loadPhotoImage(photo);
  if (!image) return null;
  try {
    drawPhoto(ctx, image, params, maxEdge);
    return await new Promise<Blob | null>((resolve) =>
      ctx.canvas.toBlob((b) => resolve(b), "image/jpeg", 0.9),
    );
  } finally {
    if (image.kind === "bitmap") image.bitmap.close();
  }
}

// Compute the histogram of a photo rendered through the develop pipeline with the
// given params, so the Library histogram reflects edits and matches Develop.
export async function renderPhotoHistogram(
  photo: CatalogPhoto,
  params: DevelopParams,
  maxEdge: number = MAX_HIST_EDGE,
): Promise<HistogramData | null> {
  const ctx = getCtx("hist");
  if (!ctx) return null;
  const image = await loadPhotoImage(photo);
  if (!image) return null;
  try {
    drawPhoto(ctx, image, params, maxEdge);
    return computeHistogram(ctx.canvas);
  } finally {
    if (image.kind === "bitmap") image.bitmap.close();
  }
}
