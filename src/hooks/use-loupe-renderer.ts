import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { CatalogPhoto, DevelopParams } from "@/catalog/types";
import { DEFAULT_DEVELOP_PARAMS } from "@/catalog/types";
import { WebGLRenderer } from "@/rendering/webgl/renderer";
import { loadPhotoImage } from "@/catalog/load-image";
import { loadSavedParams } from "@/catalog/edit-params";
import { useCatalogStore } from "@/state/catalog-store";

// Loupe zooms to 1:1, so decode at (up to) full sensor resolution like Develop
// rather than the 2560px interactive cap — otherwise a RAW whose libraw bitmap
// path falls back to the small embedded preview shows up soft/low-res.
const LOUPE_MAX_EDGE = 6144;

interface RendererStatus {
  supported: boolean;
  loading: boolean;
  width: number; // rendered output buffer size (for zoom)
  height: number;
}

// Renders a photo through the develop pipeline using its *saved* params (read
// from IndexedDB), not the live Develop store — Loupe browses any photo,
// including ones not currently open for editing. The before/after toggle swaps
// saved params for defaults without reloading the pixels.
export function useLoupeRenderer(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  photo: CatalogPhoto,
  showBefore: boolean,
): RendererStatus {
  const rendererRef = useRef<WebGLRenderer | null>(null);
  const savedParamsRef = useRef<DevelopParams>(DEFAULT_DEVELOP_PARAMS);
  const showBeforeRef = useRef(showBefore);
  showBeforeRef.current = showBefore;

  const [supported, setSupported] = useState(true);
  const [loading, setLoading] = useState(false);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const fileAccessNonce = useCatalogStore((s) => s.fileAccessNonce);

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
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
  }, [canvasRef]);

  // Load the photo's pixels and saved params, then render. Keyed on id so
  // unrelated catalog updates (e.g. rating) don't trigger a reload.
  useEffect(() => {
    let cancelled = false;
    if (!rendererRef.current) return;
    setLoading(true);
    Promise.all([loadPhotoImage(photo), loadSavedParams(photo.id)]).then(
      ([image, saved]) => {
        const renderer = rendererRef.current;
        if (cancelled || !renderer) {
          if (image?.kind === "bitmap") image.bitmap.close();
          setLoading(false);
          return;
        }
        savedParamsRef.current = saved;
        if (image) {
          // Same decode as Develop: full-res RAW float when available (gets the
          // base tone curve in the renderer), else the 8-bit bitmap. Keeps Loupe
          // pixel-consistent with Develop at full resolution.
          const isFallback =
            image.kind === "float" ? (image.isFallbackPreview ?? false) : false;
          // Cached develop preview is linear-encoded RAW; it needs the base tone
          // curve, unlike a genuine camera-rendered bitmap.
          const cachedRaw = image.kind === "bitmap" && (image.cached ?? false);
          renderer.setImage(
            image.kind === "bitmap" ? image.bitmap : image,
            LOUPE_MAX_EDGE,
            isFallback,
            cachedRaw,
          );
          if (image.kind === "bitmap") image.bitmap.close();
        }
        renderer.setParams(
          showBeforeRef.current ? DEFAULT_DEVELOP_PARAMS : saved,
        );
        renderer.render();
        syncSize();
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photo.id, fileAccessNonce]);

  // Re-render on the before/after toggle without reloading pixels.
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.setParams(
      showBefore ? DEFAULT_DEVELOP_PARAMS : savedParamsRef.current,
    );
    const id = requestAnimationFrame(() => {
      renderer.render();
      syncSize();
    });
    return () => cancelAnimationFrame(id);
  }, [showBefore]);

  return { supported, loading, width: size.width, height: size.height };
}
