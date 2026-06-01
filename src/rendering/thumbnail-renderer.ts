import type { DevelopParams } from "@/catalog/types";
import { WebGLRenderer } from "./webgl/renderer";

// A single, lazily-created offscreen WebGL renderer shared by all edited-
// thumbnail generation. Reused across photos so we never pay context-creation
// cost per thumbnail, and kept alive for the session for fast re-renders.
let canvas: HTMLCanvasElement | null = null;
let renderer: WebGLRenderer | null = null;
let unavailable = false;

function getRenderer(): WebGLRenderer | null {
  if (renderer) return renderer;
  if (unavailable) return null;
  try {
    canvas = document.createElement("canvas");
    renderer = new WebGLRenderer(canvas);
    return renderer;
  } catch {
    unavailable = true;
    return null;
  }
}

// Grid thumbnails never need more than a few hundred px; this keeps each render
// (and the resulting JPEG) cheap while staying crisp at large grid sizes.
const MAX_THUMB_EDGE = 640;

// Render a source bitmap through the develop pipeline with the given params and
// return an edited (and cropped/straightened) thumbnail as a JPEG blob. Returns
// null if WebGL is unavailable. Calls are expected to be serialized by the
// caller, since the underlying renderer/canvas is a shared singleton.
export async function renderEditedThumbnail(
  source: ImageBitmap,
  params: DevelopParams,
  maxEdge: number = MAX_THUMB_EDGE,
): Promise<Blob | null> {
  const r = getRenderer();
  if (!r || !canvas) return null;
  r.setImage(source, maxEdge);
  r.setParams(params);
  r.render();
  return await new Promise<Blob | null>((resolve) =>
    canvas!.toBlob((b) => resolve(b), "image/jpeg", 0.9),
  );
}
