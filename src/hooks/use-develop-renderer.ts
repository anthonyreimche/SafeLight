import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { CatalogPhoto } from "@/catalog/types";
import { WebGLRenderer } from "@/rendering/webgl/renderer";
import { loadPhotoBitmap } from "@/catalog/load-image";
import { computeHistogram } from "@/rendering/histogram";
import { useDevelopStore } from "@/state/develop-store";

interface RendererStatus {
  supported: boolean;
  loading: boolean;
  width: number; // rendered output buffer size (for zoom)
  height: number;
}

export function useDevelopRenderer(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  photo: CatalogPhoto | undefined,
): RendererStatus {
  const rendererRef = useRef<WebGLRenderer | null>(null);
  const [supported, setSupported] = useState(true);
  const [loading, setLoading] = useState(false);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const params = useDevelopStore((s) => s.params);
  const setHistogram = useDevelopStore((s) => s.setHistogram);

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
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
  }, [canvasRef]);

  // Load the active photo into the renderer.
  useEffect(() => {
    let cancelled = false;
    if (!photo || !rendererRef.current) return;

    setLoading(true);
    loadPhotoBitmap(photo).then((bitmap) => {
      const renderer = rendererRef.current;
      if (cancelled || !bitmap || !renderer) {
        bitmap?.close();
        setLoading(false);
        return;
      }
      renderer.setImage(bitmap);
      renderer.setParams(useDevelopStore.getState().params);
      renderer.render();
      syncSize();
      updateHistogram();
      bitmap.close();
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [photo]);

  // Re-render on parameter changes, coalesced to one frame.
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer) return;
    renderer.setParams(params);
    const id = requestAnimationFrame(() => {
      renderer.render();
      syncSize();
      updateHistogram();
    });
    return () => cancelAnimationFrame(id);
  }, [params]);

  return { supported, loading, width: size.width, height: size.height };
}
