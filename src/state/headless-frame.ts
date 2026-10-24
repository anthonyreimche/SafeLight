// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Render ONE arbitrary catalog photo through the full develop pipeline with
// caller-supplied params, off-screen, to an ImageBitmap or a frame of floats —
// without disturbing the live Develop view or its bound source.
//
// `api.develop.captureFrame` renders whatever source the live Develop renderer
// currently has bound (the active photo), so it can't measure a *different*
// photo. This binds the requested photo's source into the thumb renderer (the
// same resident-source path edited-thumbnail.ts uses), applies the photo's own
// stage `paramBag`, renders small, and hands back the frame. Extensions use it to
// build a per-photo histogram for batch Auto Tone / Auto WB across a selection.

import type { DevelopParams } from "@/catalog/types";
import { getRenderBridge, type RenderBridge, type ThumbImage, type ThumbRequest } from "@/rendering/render-bridge";
import type { FloatCaptureOptions, FloatFrame } from "@/rendering/float-frame";
import { frameStageBag } from "@/rendering/stage-bag";
import { loadPhotoImage, photoSourceKey } from "@/catalog/load-image";
import { useCatalogStore } from "./catalog-store";
import { showsEdit, standsForPhoto } from "./fallback-rules";

// Source cap mirrors edited-thumbnail.ts: small enough to stay cheap, with
// headroom above the measured frame so a tight crop still resolves.
const THUMB_SOURCE_MAX_EDGE = 1280;
// Measurement frames only feed a 256-bin histogram, so a small edge is plenty
// and keeps the per-photo convergence loop fast.
const MEASURE_MAX_EDGE = 640;
const MEASURE_JPEG_QUALITY = 0.9;

let reqSeq = 0;

/** How a measured frame is encoded for the trip back from the renderer: a JPEG,
 *  or a PNG when the frame carries data whose channel bytes must survive. */
function encodingFor(lossless: boolean): { quality: number } | { lossless: true } {
  return lossless ? { lossless: true } : { quality: MEASURE_JPEG_QUALITY };
}

/** Render `photoId` with `params` (and the photo's own extension-stage
 *  `paramBag`, drawn as the live view draws it: under the entries the built-in
 *  stages take from `params`) to an ImageBitmap, or null if the photo can't be
 *  rendered.
 *  `lossless` returns the frame from a PNG rather than a JPEG, so each channel
 *  byte the pipeline wrote reaches the bitmap exactly; it is also null where
 *  only the grid's camera preview could stand in for the photo. */
export async function renderPhotoFrame(
  photoId: string,
  params: DevelopParams,
  paramBag?: Record<string, unknown>,
  options?: { lossless?: boolean },
): Promise<ImageBitmap | null> {
  const lossless = options?.lossless === true;
  const encoding = encodingFor(lossless);
  const blob = await measure(photoId, params, paramBag, !lossless, (bridge, request) =>
    request.key !== undefined
      ? bridge.renderThumbnailFromSource({ ...request, ...encoding })
      : bridge.renderThumbnailAsync({ ...request, ...encoding }).catch(() => null),
  );
  if (!blob) return null;
  try {
    return await createImageBitmap(blob);
  } catch {
    return null;
  }
}

/** renderPhotoFrame's frame as floats: read at `opts.point` and converted into
 *  `opts.space` (the bridge's defaults, pre-output in linear Rec.709, unless
 *  given), with `opts.paramBag` drawn as renderPhotoFrame draws its bag. Like a
 *  lossless frame it is drawn from the stored or embedded preview when the
 *  original can't be decoded, and is null where only the grid's camera preview
 *  could stand in for the photo. It is null too without float render targets. */
export async function renderPhotoFloatFrame(
  photoId: string,
  params: DevelopParams,
  opts: FloatCaptureOptions = {},
): Promise<FloatFrame | null> {
  const bridge = getRenderBridge();
  await bridge.ready;
  // The thumb renderer shares the worker's GPU: without float targets every rung
  // would read null, each after decoding the photo for nothing.
  if (!bridge.pipelineFloat) return null;
  const float = { point: opts.point, space: opts.space };
  return measure(photoId, params, opts.paramBag, false, (b, request) =>
    b.renderThumbnailFloat({ ...request, float }),
  );
}

/** Render `photoId` with `params` small, through the thumb renderer, from the
 *  first source that has it, with the photo's own `paramBag` drawn as the live
 *  view draws it: under the entries the built-in stages take from `params`.
 *  `render` draws one request and gives null for a miss or a failure.
 *  `cameraPreview` lets the grid's camera JPEG stand in, last, for a photo with
 *  no source of its own. Null for a photo the catalog doesn't hold, or one no
 *  source renders. */
async function measure<T>(
  photoId: string,
  params: DevelopParams,
  paramBag: Record<string, unknown> | undefined,
  cameraPreview: boolean,
  render: (bridge: RenderBridge, request: ThumbRequest) => Promise<T | null>,
): Promise<T | null> {
  const photo = useCatalogStore.getState().photos.find((p) => p.id === photoId);
  if (!photo) return null;
  const contributedParams = paramBag && frameStageBag(params, paramBag);

  const bridge = getRenderBridge();
  await bridge.ready;

  const key = photoSourceKey(photo);
  const request = (source: { key: string } | { image: ThumbImage }): ThumbRequest => ({
    requestId: "key" in source ? `measure-${source.key}-${++reqSeq}` : `measure-once-${++reqSeq}`,
    params,
    // Read at each render: a first decode stores the as-shot white balance it
    // learns on the photo, and a RAW whose import left it pending has none before.
    asShotTemperature: photo.exif.colorTemperature ?? 6500,
    maxEdge: MEASURE_MAX_EDGE,
    contributedParams,
    ...source,
  });

  // 1) Render from the resident source if it's already cached in the thumb
  //    renderer (e.g. a prior measure of this photo this run).
  let frame = await render(bridge, request({ key }));

  // 2) First touch of this photo: decode, upload a capped source once, retry. A
  //    preview the load fell back on is rendered from once instead (standsForPhoto),
  //    and one that already shows an edit not at all: the photo isn't measured. The
  //    load is background work: callers measure a photo many times over (batch
  //    Auto's convergence, a sampler on a timer), and a RAW libraw gave no answer
  //    for is then passed over (null) instead of decoded again on every call.
  if (!frame) {
    const decoded = await loadPhotoImage(photo, { background: true });
    if (decoded?.kind === "bitmap" && showsEdit(decoded)) {
      decoded.bitmap.close();
      return null;
    }
    if (decoded) {
      const image =
        decoded.kind === "bitmap"
          ? { kind: "bitmap" as const, bitmap: decoded.bitmap }
          : decoded;
      if (standsForPhoto(decoded)) {
        bridge.uploadSource(
          "thumb",
          key,
          image,
          THUMB_SOURCE_MAX_EDGE,
          decoded.kind === "float" ? decoded.isFallbackPreview : false,
          false,
        );
        frame = await render(bridge, request({ key }));
      } else {
        frame = await render(bridge, request({ image }));
      }
    }
  }

  // 3) Last resort: the in-memory camera JPEG preview (flatter, but lets Auto
  //    still measure something rather than skipping the photo). One that already
  //    shows an edit would be measured with the edit twice. Never for a frame that
  //    carries data about the photo's own pixels (lossless, or floats): one
  //    rendered from another source is wrong, not just flat.
  if (!frame && cameraPreview && photo.thumbnailBlob && photo.previewEdit === undefined) {
    try {
      const bitmap = await createImageBitmap(photo.thumbnailBlob);
      frame = await render(bridge, request({ image: { kind: "bitmap", bitmap } }));
    } catch {
      // fall through to null
    }
  }
  return frame;
}
