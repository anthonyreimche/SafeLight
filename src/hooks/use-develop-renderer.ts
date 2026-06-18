import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { CatalogPhoto, DevelopParams } from "@/catalog/types";
import { transformedViewCrop } from "@/rendering/crop-transform";
import { buildForwardTransform } from "@/rendering/transform";
import { getRenderBridge } from "@/rendering/render-bridge";
import type { RenderBridge, FrameResult } from "@/rendering/render-bridge";
import { loadPhotoImage } from "@/catalog/load-image";
import { lastLibRawStatus } from "@/raw/libraw-wasm-adapter";
import { computeHistogram } from "@/rendering/histogram";
import { useDevelopStore } from "@/state/develop-store";
import { useCatalogStore } from "@/state/catalog-store";
import { getSettings } from "@/state/settings-store";
import { usePipelineStore } from "@/extensions/pipelines";

interface RendererStatus {
  supported: boolean;
  loading: boolean;
  width: number;
  height: number;
  source: string | null;
}

export function useDevelopRenderer(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  photo: CatalogPhoto | undefined,
): RendererStatus {
  const bridgeRef = useRef<RenderBridge | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const [supported, setSupported] = useState(true);
  const [loading, setLoading] = useState(false);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [source, setSource] = useState<string | null>(null);
  const params = useDevelopStore((s) => s.params);
  const asShotTemperature = useDevelopStore((s) => s.asShotTemperature);
  const cropping = useDevelopStore((s) => s.cropping);
  const showClipping = useDevelopStore((s) => s.showClipping);
  const resolvedLensProfile = useDevelopStore((s) => s.resolvedLensProfile);
  const fileAccessNonce = useCatalogStore((s) => s.fileAccessNonce);
  const pipelineId = usePipelineStore((s) => s.activeId);

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

  // Set up the bridge + 2D display canvas. The worker owns the WebGL context;
  // this canvas just blits ImageBitmap frames from the worker.
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) {
      setSupported(false);
      return;
    }
    ctxRef.current = ctx;

    const bridge = getRenderBridge();
    bridgeRef.current = bridge;

    const setHistogramRef = useDevelopStore.getState().setHistogram;
    let histPending = false;
    bridge.setOnFrame((frame: FrameResult) => {
      if (cv.width !== frame.width) cv.width = frame.width;
      if (cv.height !== frame.height) cv.height = frame.height;
      ctx.drawImage(frame.bitmap, 0, 0);
      frame.bitmap.close();
      setSize((s) =>
        s.width === frame.width && s.height === frame.height
          ? s
          : { width: frame.width, height: frame.height },
      );
      if (frame.histogram) {
        setHistogramRef(frame.histogram);
      } else if (!histPending) {
        histPending = true;
        setTimeout(() => {
          histPending = false;
          if (cv.width > 0 && cv.height > 0) {
            const hist = computeHistogram(cv);
            const prev = useDevelopStore.getState().histogram;
            if (prev?.extended) hist.extended = prev.extended;
            setHistogramRef(hist);
          }
        }, 0);
      }
    });
    bridge.setOnHistogram((histogram) => {
      setHistogramRef(histogram);
    });

    bridge.setOnError((msg) => {
      console.error("[render-worker]", msg);
    });

    setSupported(true);
    return () => {
      if (rafIdRef.current != null) cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
      bridge.setOnFrame(null);
      bridge.setOnHistogram(null);
      bridge.setOnError(null);
      bridgeRef.current = null;
      ctxRef.current = null;
    };
  }, [canvasRef]);

  // Load the active photo into the worker.
  useEffect(() => {
    let cancelled = false;
    const bridge = bridgeRef.current;
    if (!photo || !bridge) return;

    setLoading(true);

    const sendImage = (
      image:
        | ImageBitmap
        | { kind: "float"; data: Float32Array; width: number; height: number; isFallbackPreview?: boolean }
        | { kind: "srgb16"; data: Uint16Array; width: number; height: number },
      isFallback = false,
      cachedRaw = false,
    ) => {
      if (cancelled) return;
      bridge.setAsShotTemperature(photo?.exif.colorTemperature ?? 6500);
      if (image instanceof ImageBitmap) {
        bridge.setImage(
          { kind: "bitmap", bitmap: image },
          getSettings().developMaxEdge,
          isFallback,
          cachedRaw,
        );
      } else {
        bridge.setImage(image, getSettings().developMaxEdge, isFallback);
      }
      const st = useDevelopStore.getState();
      bridge.setLensProfile(st.resolvedLensProfile);
      bridge.setParams(forRender(st.params, st.cropping));
      bridge.render(true);
    };

    const run = async () => {
      await bridge.ready;

      if (photo.thumbnailBlob) {
        try {
          const bm = await createImageBitmap(photo.thumbnailBlob);
          if (!cancelled) {
            sendImage(bm);
          } else {
            bm.close();
            return;
          }
        } catch { /* thumbnail is optional */ }
      }

      const image = await loadPhotoImage(photo, {
        onPreview: (preview) => {
          if (cancelled) {
            if (preview.kind === "bitmap") preview.bitmap.close();
            return;
          }
          const dims =
            preview.kind === "bitmap"
              ? `${preview.bitmap.width}×${preview.bitmap.height}`
              : `${preview.width}×${preview.height}`;
          if (preview.kind === "bitmap") {
            sendImage(preview.bitmap);
          } else {
            sendImage(preview);
          }
          setSource(`Preview ${dims} — loading full…`);
        },
      });
      if (cancelled) {
        if (image?.kind === "bitmap") image.bitmap.close();
        return;
      }
      if (!image) { setLoading(false); return; }

      if (photo.exif.colorTemperature) {
        const st = useDevelopStore.getState();
        if (st.photoId === photo.id && st.asShotTemperature !== photo.exif.colorTemperature) {
          const asShot = photo.exif.colorTemperature;
          const wasUninitialised = st.asShotTemperature === 6500;
          const needsTempUpdate = wasUninitialised && st.params.temperature === 6500;
          useDevelopStore.setState({
            asShotTemperature: asShot,
            ...(needsTempUpdate ? { params: { ...st.params, temperature: asShot } } : {}),
          });
        }
      }

      const isFallback = image.kind === "float" ? (image.isFallbackPreview ?? false) : false;
      const cachedRaw = image.kind === "bitmap" && (image.cached ?? false);
      if (image.kind === "bitmap") {
        sendImage(image.bitmap, isFallback, cachedRaw);
      } else {
        sendImage(image, isFallback);
      }

      if (image.kind === "float") {
        setSource(
          image.isFallbackPreview
            ? `Preview ${image.width}×${image.height}`
            : `RAW ${image.width}×${image.height} — ${lastLibRawStatus}`,
        );
      } else if (image.kind === "srgb16") {
        setSource(`Cached ${image.width}×${image.height}`);
      } else {
        const b = image.bitmap;
        setSource(
          image.cached
            ? `Cached ${b.width}×${b.height}`
            : `8-bit ${b.width}×${b.height} — ${lastLibRawStatus}`,
        );
      }
      setLoading(false);
    };

    run();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photo?.id, fileAccessNonce]);

  // Re-render on parameter changes. The standard histogram is computed on
  // the main thread from the already-drawn canvas (zero worker cost). The
  // extended histogram (float readback) is debounced via the worker.
  const extTimerRef = useRef<number | null>(null);

  useEffect(() => {
    const bridge = bridgeRef.current;
    if (!bridge) return;
    bridge.setAsShotTemperature(asShotTemperature);
    bridge.setLensProfile(resolvedLensProfile);
    bridge.setParams(forRender(params, cropping));
    if (rafIdRef.current == null) {
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null;
        bridgeRef.current?.render(false);
      });
    }
    if (extTimerRef.current != null) clearTimeout(extTimerRef.current);
    extTimerRef.current = window.setTimeout(() => {
      extTimerRef.current = null;
      bridgeRef.current?.computeHistogram(true);
    }, 150);
    return () => {
      if (extTimerRef.current != null) {
        clearTimeout(extTimerRef.current);
        extTimerRef.current = null;
      }
    };
  }, [params, cropping, pipelineId, asShotTemperature, resolvedLensProfile]);

  useEffect(() => {
    const bridge = bridgeRef.current;
    if (!bridge) return;
    bridge.setShowClipping(showClipping);
    bridge.render(false);
  }, [showClipping]);

  return {
    supported,
    loading,
    width: size.width,
    height: size.height,
    source,
  };
}
