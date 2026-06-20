import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { CatalogPhoto, DevelopParams } from "@/catalog/types";

// Coverage overlay: a single red tint, faded in/out for all masks.
const VIZ_COLOR: [number, number, number] = [0.9, 0.25, 0.25];
const VIZ_STRENGTH = 0.5;
import { transformedViewCrop } from "@/rendering/crop-transform";
import { buildForwardTransform } from "@/rendering/transform";
import { getRenderBridge } from "@/rendering/render-bridge";
import type { RenderBridge, FrameResult } from "@/rendering/render-bridge";
import { loadPhotoImage, photoSourceKey } from "@/catalog/load-image";
import { lastLibRawStatus } from "@/raw/libraw-wasm-adapter";
import { computeHistogram } from "@/rendering/histogram";
import { useDevelopStore } from "@/state/develop-store";
import { useCatalogStore } from "@/state/catalog-store";
import { useUIStore } from "@/state/ui-store";
import { visiblePhotos } from "@/modules/library/visible-photos";
import { getSettings } from "@/state/settings-store";
import { usePipelineStore } from "@/extensions/pipelines";

interface RendererStatus {
  supported: boolean;
  loading: boolean;
  width: number;
  height: number;
  source: string | null;
  // Render only `roi` (a window into the displayed image, normalized [0,1]) at
  // outW×outH device pixels — crisp zoom from the resident full-res source. Pass
  // null to return to the whole-frame fit render.
  setViewport: (
    roi: { x: number; y: number; w: number; h: number } | null,
    outW?: number,
    outH?: number,
  ) => void;
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
  // Effective params: a hover preview (e.g. from the Presets panel) overrides
  // the committed params for rendering only, without touching history.
  const params = useDevelopStore((s) => s.previewParams ?? s.params);
  const asShotTemperature = useDevelopStore((s) => s.asShotTemperature);
  const cropping = useDevelopStore((s) => s.cropping);
  const showClipping = useDevelopStore((s) => s.showClipping);
  const resolvedLensProfile = useDevelopStore((s) => s.resolvedLensProfile);
  const hoveredMaskId = useDevelopStore((s) => s.hoveredMaskId);
  const selectedMaskId = useDevelopStore((s) => s.selectedMaskId);
  const maskTab = useDevelopStore((s) => s.maskTab);
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
    let histTimer: ReturnType<typeof setTimeout> | null = null;
    let lastHistTime = 0;
    const HIST_THROTTLE = 80;
    // When live histogram is off, recompute only once edits go quiet for this long.
    const HIST_SETTLE = 250;

    const recomputeHistogram = () => {
      histTimer = null;
      lastHistTime = performance.now();
      if (cv.width > 0 && cv.height > 0) {
        const hist = computeHistogram(cv);
        const prev = useDevelopStore.getState().histogram;
        if (prev?.extended) hist.extended = prev.extended;
        setHistogramRef(hist);
      }
    };

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
        lastHistTime = performance.now();
      } else if (getSettings().liveHistogram) {
        // Live: recompute continuously while editing, throttled to HIST_THROTTLE.
        if (!histTimer) {
          const elapsed = performance.now() - lastHistTime;
          const delay = Math.max(0, HIST_THROTTLE - elapsed);
          histTimer = setTimeout(recomputeHistogram, delay);
        }
      } else {
        // Off: debounce — reset on every frame so we only recompute after the
        // edit settles, instead of on each intermediate frame.
        if (histTimer) clearTimeout(histTimer);
        histTimer = setTimeout(recomputeHistogram, HIST_SETTLE);
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
      if (histTimer) { clearTimeout(histTimer); histTimer = null; }
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

    // When cacheKey is set, the image is uploaded into the GPU source cache
    // (the final full decode) so a later re-open is a zero-decode bindSource;
    // otherwise it's a transient setImage (thumbnail/preview frames).
    const sendImage = (
      image:
        | ImageBitmap
        | { kind: "float"; data: Float32Array; width: number; height: number; isFallbackPreview?: boolean }
        | { kind: "srgb16"; data: Uint16Array; width: number; height: number },
      isFallback = false,
      cachedRaw = false,
      cacheKey?: string,
    ) => {
      if (cancelled) return;
      bridge.setAsShotTemperature(photo?.exif.colorTemperature ?? 6500);
      const maxEdge = getSettings().developMaxEdge;
      const src = image instanceof ImageBitmap ? { kind: "bitmap" as const, bitmap: image } : image;
      if (cacheKey) {
        bridge.uploadSource("main", cacheKey, src, maxEdge, isFallback, cachedRaw);
      } else {
        bridge.setImage(src, maxEdge, isFallback, cachedRaw);
      }
      const st = useDevelopStore.getState();
      bridge.setLensProfile(st.resolvedLensProfile);
      bridge.setParams(forRender(st.params, st.cropping));
      bridge.render(true);
    };

    // Re-render from an already-resident source (bindSource hit) — no decode.
    const renderResident = () => {
      if (cancelled) return;
      bridge.setAsShotTemperature(photo?.exif.colorTemperature ?? 6500);
      const st = useDevelopStore.getState();
      bridge.setLensProfile(st.resolvedLensProfile);
      bridge.setParams(forRender(st.params, st.cropping));
      bridge.render(true);
    };

    // Mirror the photo's as-shot WB into the develop store (same logic on a cache
    // hit and after a fresh decode).
    const syncAsShotTemp = () => {
      if (!photo?.exif.colorTemperature) return;
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
    };

    // Background-decode the prev/next photo (in the Library's visible order) so
    // navigating to it is an instant bindSource hit. Best-effort and cancellable;
    // gated by a preference. Uploads with bind=false so the displayed image is
    // untouched. Runs after a short delay so rapid navigation skips it.
    const prefetchNeighbors = async () => {
      if (!getSettings().developPrefetchNeighbors) return;
      await new Promise((r) => setTimeout(r, 250));
      if (cancelled) return;
      const ui = useUIStore.getState();
      const ordered = visiblePhotos(
        useCatalogStore.getState().photos,
        ui.filter,
        ui.sortField,
        ui.sortDirection,
        ui.activeFolder,
      );
      const idx = ordered.findIndex((p) => p.id === photo.id);
      if (idx < 0) return;
      const neighbours = [ordered[idx + 1], ordered[idx - 1]].filter(Boolean);
      const maxEdge = getSettings().developMaxEdge;
      for (const np of neighbours) {
        if (cancelled) return;
        const nk = photoSourceKey(np);
        if (await bridge.hasSource("main", nk)) continue;
        if (cancelled) return;
        const image = await loadPhotoImage(np);
        if (cancelled || !image) {
          if (image?.kind === "bitmap") image.bitmap.close();
          return;
        }
        if (image.kind === "bitmap") {
          bridge.uploadSource("main", nk, { kind: "bitmap", bitmap: image.bitmap }, maxEdge, false, image.cached, false);
        } else {
          bridge.uploadSource("main", nk, image, maxEdge, image.kind === "float" ? image.isFallbackPreview : false, false, false);
        }
      }
    };

    const run = async () => {
      await bridge.ready;

      // Clear any zoom window left over from the previously open photo so the
      // first frame renders the whole image (ViewportImage re-emits an ROI if the
      // new photo ends up zoomed).
      bridge.setViewport(null);

      const key = photoSourceKey(photo);

      // Fast path: the decoded source is already resident on the GPU from a prior
      // open/thumbnail render — bind and render without decoding (instant re-entry).
      if (await bridge.bindSource(key)) {
        if (cancelled) return;
        syncAsShotTemp();
        renderResident();
        setSource("RAW — resident in GPU");
        setLoading(false);
        void prefetchNeighbors();
        return;
      }
      if (cancelled) return;

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

      syncAsShotTemp();

      const isFallback = image.kind === "float" ? (image.isFallbackPreview ?? false) : false;
      const cachedRaw = image.kind === "bitmap" && (image.cached ?? false);
      // Cache the final full decode under `key` so the next open is a bindSource hit.
      if (image.kind === "bitmap") {
        sendImage(image.bitmap, isFallback, cachedRaw, key);
      } else {
        sendImage(image, isFallback, false, key);
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
      void prefetchNeighbors();
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

  // Coverage overlay: shown when a mask row is hovered, or when the selected
  // mask is open on the Coverage tab. Always red; the strength fades in/out.
  const vizAnim = useRef({ idx: -1, cur: 0, target: 0, raf: null as number | null });
  useEffect(() => {
    const vizId =
      hoveredMaskId ?? (selectedMaskId && maskTab === "coverage" ? selectedMaskId : null);
    const idx = vizId ? params.masks.findIndex((m) => m.id === vizId) : -1;
    const a = vizAnim.current;
    if (idx >= 0) a.idx = idx; // keep last index while fading out
    a.target = idx >= 0 ? VIZ_STRENGTH : 0;
    const tick = () => {
      const bridge = bridgeRef.current;
      if (!bridge) { a.raf = null; return; }
      a.cur += (a.target - a.cur) * 0.3;
      if (Math.abs(a.target - a.cur) < 0.01) a.cur = a.target;
      const activeIdx = a.cur > 0.002 ? a.idx : -1;
      bridge.setMaskViz(activeIdx, VIZ_COLOR, a.cur);
      bridge.render(false);
      a.raf = a.cur !== a.target ? requestAnimationFrame(tick) : null;
    };
    if (a.raf == null) a.raf = requestAnimationFrame(tick);
    return () => {
      if (a.raf != null) { cancelAnimationFrame(a.raf); a.raf = null; }
    };
  }, [hoveredMaskId, selectedMaskId, maskTab, params.masks]);

  const setViewport = useCallback(
    (
      roi: { x: number; y: number; w: number; h: number } | null,
      outW?: number,
      outH?: number,
    ) => {
      const bridge = bridgeRef.current;
      if (!bridge) return;
      bridge.setViewport(roi, outW, outH);
      if (rafIdRef.current == null) {
        rafIdRef.current = requestAnimationFrame(() => {
          rafIdRef.current = null;
          bridgeRef.current?.render(false);
        });
      }
    },
    [],
  );

  return {
    supported,
    loading,
    width: size.width,
    height: size.height,
    source,
    setViewport,
  };
}
