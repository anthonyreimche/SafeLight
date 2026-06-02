import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { CatalogPhoto, DevelopParams } from "@/catalog/types";
import { transformedViewCrop } from "@/rendering/crop-transform";
import { buildForwardTransform } from "@/rendering/transform";
import { WebGLRenderer } from "@/rendering/webgl/renderer";
import { loadPhotoImage } from "@/catalog/load-image";
import { lastLibRawStatus } from "@/raw/libraw-wasm-adapter";
import { computeHistogram } from "@/rendering/histogram";
import { useDevelopStore } from "@/state/develop-store";
import { useCatalogStore } from "@/state/catalog-store";

interface RendererStatus {
  supported: boolean;
  loading: boolean;
  width: number; // rendered output buffer size (for zoom)
  height: number;
  source: string | null; // diagnostic: which decode produced the image
}

// Develop renders at (up to) the sensor's full resolution so "100%" is true 1:1
// and zooming shows real pixels instead of an upscaled 2560px preview. Capped to
// bound memory on very large sensors.
const DEVELOP_MAX_EDGE = 6144;

export function useDevelopRenderer(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  photo: CatalogPhoto | undefined,
): RendererStatus {
  const rendererRef = useRef<WebGLRenderer | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const [supported, setSupported] = useState(true);
  const [loading, setLoading] = useState(false);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [source, setSource] = useState<string | null>(null);
  const params = useDevelopStore((s) => s.params);
  const setHistogram = useDevelopStore((s) => s.setHistogram);
  const cropping = useDevelopStore((s) => s.cropping);
  const fileAccessNonce = useCatalogStore((s) => s.fileAccessNonce);

  // While cropping, render a view that encloses the rotated image so the crop
  // overlay can see the whole (straightened) frame; straighten stays applied.
  const aspect = photo && photo.height > 0 ? photo.width / photo.height : 1;
  const forRender = (p: DevelopParams, crop: boolean): DevelopParams =>
    crop
      ? {
          ...p,
          crop: transformedViewCrop(
            buildForwardTransform(p.straighten, p.transform, aspect),
          ),
        }
      : p;

  // Mirror the canvas's current buffer size into state so zoom can scale it.
  const syncSize = () => {
    const cv = canvasRef.current;
    if (!cv) return;
    setSize((s) =>
      s.width === cv.width && s.height === cv.height
        ? s
        : { width: cv.width, height: cv.height },
    );
  };

  // Recompute the live histogram from the freshly rendered canvas.
  const updateHistogram = () => {
    const cv = canvasRef.current;
    if (cv && cv.width > 0 && cv.height > 0) setHistogram(computeHistogram(cv));
  };

  // Create the renderer once for the canvas.
  useEffect(() => {
    if (!canvasRef.current) return;
    try {
      rendererRef.current = new WebGLRenderer(canvasRef.current);
      setSupported(true);
    } catch (err) {
      console.error("WebGL renderer init failed:", err);
      setSupported(false);
    }
    return () => {
      if (rafIdRef.current != null) cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
  }, [canvasRef]);

  // Load the active photo into the renderer.
  // Phase 1: show the stored thumbnail immediately so the UI isn't blank.
  // Phase 2: decode the full-quality image (RAW float or hi-res bitmap) and
  //          replace the texture — typically a few seconds for large RAW files.
  useEffect(() => {
    let cancelled = false;
    if (!photo || !rendererRef.current) return;

    setLoading(true);

    const renderImage = (
      image: ImageBitmap | { kind: "float"; data: Float32Array; width: number; height: number; isFallbackPreview?: boolean },
      isFallback = false,
    ) => {
      const renderer = rendererRef.current;
      if (cancelled || !renderer) return;
      renderer.setImage(image, DEVELOP_MAX_EDGE, isFallback);
      const st = useDevelopStore.getState();
      renderer.setParams(forRender(st.params, st.cropping));
      renderer.render();
      syncSize();
      updateHistogram();
    };

    const run = async () => {
      // Phase 1: thumbnail for immediate feedback
      if (photo.thumbnailBlob) {
        try {
          const bm = await createImageBitmap(photo.thumbnailBlob);
          if (!cancelled) {
            renderImage(bm);
            bm.close();
          } else {
            bm.close();
            return;
          }
        } catch { /* ignore — thumbnail is optional */ }
      }

      // Phase 2: full quality decode
      const image = await loadPhotoImage(photo);
      if (cancelled) {
        if (image?.kind === "bitmap") image.bitmap.close();
        return;
      }
      if (!image) { setLoading(false); return; }

      const isFallback = image.kind === "float" ? (image.isFallbackPreview ?? false) : false;
      renderImage(image.kind === "bitmap" ? image.bitmap : image, isFallback);

      if (image.kind === "float") {
        setSource(
          image.isFallbackPreview
            ? `Preview ${image.width}×${image.height}`
            : `RAW ${image.width}×${image.height}`,
        );
      } else {
        const b = image.bitmap;
        setSource(
          image.cached
            ? `Cached ${b.width}×${b.height}`
            : `8-bit ${b.width}×${b.height} — ${lastLibRawStatus}`,
        );
        b.close();
      }
      setLoading(false);
    };

    run();
    return () => { cancelled = true; };
  }, [photo, fileAccessNonce]);

  // Re-render on parameter changes, coalesced to one frame.
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.setParams(forRender(params, cropping));
    // Coalesce to one render per frame, but don't cancel a pending frame on
    // re-run: a continuous drag changes params every frame, and cancelling each
    // time starved the render so the preview only updated when the drag paused.
    if (rafIdRef.current == null) {
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null;
        const r = rendererRef.current;
        if (!r) return;
        r.render();
        syncSize();
        updateHistogram();
      });
    }
  }, [params, cropping]);

  return {
    supported,
    loading,
    width: size.width,
    height: size.height,
    source,
  };
}
