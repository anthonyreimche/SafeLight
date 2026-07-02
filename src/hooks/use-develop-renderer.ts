// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

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
import { setHealSourceImage } from "@/rendering/heal-source";
import { useDevelopStore } from "@/state/develop-store";
import { useCatalogStore } from "@/state/catalog-store";
import { useUIStore } from "@/state/ui-store";
import { visiblePhotos } from "@/modules/library/visible-photos";
import { getSettings, useSettings } from "@/state/settings-store";
import { usePipelineStore } from "@/extensions/pipelines";
import { applyPanelBypass, bypassParamBag } from "@/modules/develop/panel-bypass";
import { denoiseBag } from "@/rendering/webgl/builtin-denoise";
import { getExtSetting, useExtSettings } from "@/extensions/ext-settings";

// Resolve the colour actually painted behind the image (the canvas surround) to
// linear-display RGB in 0..1, by reading the surround element's computed
// background. Reading the DOM rather than re-deriving from settings keeps the
// crop-mode margin matching every case at once — theme surface, the fixed
// surround override, and color-assessment grey. Falls back to the legacy dark.
function surroundRGB(): [number, number, number] {
  if (typeof document !== "undefined") {
    const el = document.querySelector("[data-canvas-surround]");
    if (el) {
      const m = getComputedStyle(el).backgroundColor.match(/[\d.]+/g);
      if (m && m.length >= 3) {
        return [Number(m[0]) / 255, Number(m[1]) / 255, Number(m[2]) / 255];
      }
    }
  }
  return [0.04, 0.04, 0.04];
}

interface RendererStatus {
  supported: boolean;
  loading: boolean;
  width: number;
  height: number;
  // True decoded source dimensions (upright), for image-aspect-dependent UI like
  // the crop overlay. 0 until the first frame decodes.
  sourceWidth: number;
  sourceHeight: number;
  source: string | null;
  // Render-pipeline working precision: true = float (RGBA16F), false = RGBA8,
  // null until the worker reports its caps. Diagnostic for tonal banding.
  pipelineFloat: boolean | null;
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
  // True dimensions of the decoded source last handed to the renderer (already
  // upright). Drives the image aspect — see `aspect` below.
  const [sourceSize, setSourceSize] = useState({ width: 0, height: 0 });
  const [source, setSource] = useState<string | null>(null);
  // Working precision of the render pipeline (EXT_color_buffer_float). When false,
  // the whole pipeline is RGBA8 and any source bands after a tonal stretch.
  const [pipelineFloat, setPipelineFloat] = useState<boolean | null>(null);
  // Effective params: a hover preview (e.g. from the Presets panel) overrides
  // the committed params for rendering only, without touching history.
  const params = useDevelopStore((s) => s.previewParams ?? s.params);
  // Generic param bag for extension-contributed processing stages (e.g. denoise).
  // A hover preview overrides it (paired with previewParams) so a preset's
  // extension adjustments preview too, without touching the committed bag.
  const paramBag = useDevelopStore((s) => s.previewParamBag ?? s.paramBag);
  const asShotTemperature = useDevelopStore((s) => s.asShotTemperature);
  const cropping = useDevelopStore((s) => s.cropping);
  const showClipping = useDevelopStore((s) => s.showClipping);
  // Drives the crop-mode margin colour (canvas surround). Read reactively so the
  // margin tracks the assessment toggle and the surround override/shade live.
  const colorAssessment = useDevelopStore((s) => s.colorAssessment);
  const canvasSurround = useSettings((s) => s.canvasSurround);
  const canvasSurroundOverride = useSettings((s) => s.canvasSurroundOverride);
  const hoveredMaskId = useDevelopStore((s) => s.hoveredMaskId);
  const selectedMaskId = useDevelopStore((s) => s.selectedMaskId);
  const maskTab = useDevelopStore((s) => s.maskTab);
  const sharpenViz = useDevelopStore((s) => s.sharpenViz);
  const bypassedPanels = useDevelopStore((s) => s.bypassedPanels);
  const fileAccessNonce = useCatalogStore((s) => s.fileAccessNonce);
  const pipelineId = usePipelineStore((s) => s.activeId);
  // Global HSL band shaping (Preferences ▸ HSL). Subscribe so the live view
  // re-renders when the user drags the pref; 100 = the default 1.0 multiplier.
  useExtSettings((s) => s["core.hsl"]);
  const hslRangePref = getExtSetting("core.hsl", "hueRange", 100);
  const hslSmoothPref = getExtSetting("core.hsl", "smoothness", 100);

  // Aspect of the image as actually decoded and shown on screen. We prefer the
  // real buffer dims (set from every image handed to the renderer) over
  // photo.width/height, because RAW decode paths disagree on whether they bake
  // EXIF orientation: libraw rotates the pixels, the CFA and embedded-JPEG
  // fallbacks don't. When the path that ran at develop differs from the one that
  // ran at import, stored metadata can be transposed relative to the pixels on
  // screen — which skewed every aspect-locked crop (e.g. 1:1 drawn tall). Using
  // the live buffer keeps the GPU transform and the crop overlay in agreement.
  const aspect =
    sourceSize.width > 0 && sourceSize.height > 0
      ? sourceSize.width / sourceSize.height
      : photo && photo.height > 0
        ? photo.width / photo.height
        : 1;
  const forRender = (p: DevelopParams, crop: boolean): DevelopParams => {
    // Neutralize any bypassed panels' params first (view-only, no history).
    const bp = applyPanelBypass(p, bypassedPanels);
    return crop
      ? {
          ...bp,
          crop: transformedViewCrop(
            buildForwardTransform(bp.straighten, bp.transform, aspect),
          ),
        }
      : bp;
  };

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
    void bridge.ready.then(() => setPipelineFloat(bridge.pipelineFloat ?? null));

    const setHistogramRef = useDevelopStore.getState().setHistogram;
    let histTimer: ReturnType<typeof setTimeout> | null = null;
    let lastHistTime = 0;
    const HIST_THROTTLE = 80;
    // When live histogram is off, recompute only once edits go quiet for this long.
    const HIST_SETTLE = 250;

    const recomputeHistogram = () => {
      histTimer = null;
      lastHistTime = performance.now();
      // Ask the worker to compute the histogram from the RGBA16F render pipeline
      // and deliver it via setOnHistogram. The previous main-thread path read the
      // 2D display canvas with getImageData, which is ALWAYS 8-bit — so 256 source
      // codes mapped into 256 bins, and any tonal stretch (curve/exposure/WB)
      // spread them apart into the comb/banding you see. The canvas is 8-bit no
      // matter how high-bit the pipeline is, so it can never produce a clean
      // histogram; only the in-worker float readback can.
      bridgeRef.current?.computeHistogram(true);
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

    // The worker owns the decoded source; mirror its downscaled heal-source buffer
    // into this (main-thread) module instance so the overlay's findHealSource /
    // healColorOffset can pick a real source instead of a blind offset.
    bridge.setOnHealSource(({ data, width, height }) => {
      setHealSourceImage(data, width, height);
    });

    setSupported(true);
    return () => {
      if (histTimer) { clearTimeout(histTimer); histTimer = null; }
      if (rafIdRef.current != null) cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
      bridge.setOnFrame(null);
      bridge.setOnHistogram(null);
      bridge.setOnError(null);
      bridge.setOnHealSource(null);
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
      // Record the real source aspect from what we're actually rendering, so the
      // crop overlay and GPU transform never disagree with the pixels on screen.
      if (image.width > 0 && image.height > 0) {
        setSourceSize((s) =>
          s.width === image.width && s.height === image.height
            ? s
            : { width: image.width, height: image.height },
        );
      }
      if (cacheKey) {
        bridge.uploadSource("main", cacheKey, src, maxEdge, isFallback, cachedRaw);
      } else {
        bridge.setImage(src, maxEdge, isFallback, cachedRaw);
      }
      const st = useDevelopStore.getState();
      bridge.setContributedParams({
        ...bypassParamBag(st.paramBag, st.bypassedPanels),
        ...denoiseBag(applyPanelBypass(st.params, st.bypassedPanels)),
      });
      bridge.setParams(forRender(st.params, st.cropping));
      bridge.render(true);
    };

    // Re-render from an already-resident source (bindSource hit) — no decode.
    const renderResident = () => {
      if (cancelled) return;
      bridge.setAsShotTemperature(photo?.exif.colorTemperature ?? 6500);
      const st = useDevelopStore.getState();
      bridge.setContributedParams({
        ...bypassParamBag(st.paramBag, st.bypassedPanels),
        ...denoiseBag(applyPanelBypass(st.params, st.bypassedPanels)),
      });
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
    bridge.setHslStyle(hslRangePref / 100, hslSmoothPref / 100);
    bridge.setContributedParams({
      ...bypassParamBag(paramBag, bypassedPanels),
      ...denoiseBag(applyPanelBypass(params, bypassedPanels)),
    });
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
  }, [params, paramBag, cropping, pipelineId, asShotTemperature, aspect, bypassedPanels, hslRangePref, hslSmoothPref]);

  // A new photo starts from metadata aspect until its buffer decodes, so a
  // failed/slow decode never leaves the previous photo's aspect in place.
  useEffect(() => {
    setSourceSize({ width: 0, height: 0 });
  }, [photo?.id]);

  useEffect(() => {
    const bridge = bridgeRef.current;
    if (!bridge) return;
    bridge.setShowClipping(showClipping);
    bridge.render(false);
  }, [showClipping]);

  // Paint out-of-image margins (crop mode, out-of-frame straighten) in the canvas
  // surround so the photo isn't framed in a black border. Re-reads the resolved
  // surround whenever it can change; the DOM read happens after layout commits.
  useEffect(() => {
    const bridge = bridgeRef.current;
    if (!bridge) return;
    bridge.setOutsideColor(surroundRGB());
    bridge.render(false);
  }, [colorAssessment, canvasSurround, canvasSurroundOverride]);

  // Coverage overlay: shown when a mask row is hovered, or when the selected
  // mask is open on the Coverage tab. The Adjust tab hides it — so adjustment
  // sliders aren't dragged over a tinted preview, and (crucially) the worker
  // isn't rendering the coverage pass on every frame while you adjust.
  // Always red; the strength fades in/out.
  const vizAnim = useRef({ idx: -1, cur: 0, target: 0, raf: null as number | null });
  useEffect(() => {
    const vizId =
      hoveredMaskId ??
      (selectedMaskId && maskTab === "coverage" ? selectedMaskId : null);
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

  // Sharpening preview: while Alt/Ctrl-dragging a Detail-panel sharpening slider,
  // the shader renders a grayscale visualization of that sub-signal. Push the mode
  // straight through and re-render; releasing the key/drag sets it back to 0.
  useEffect(() => {
    const bridge = bridgeRef.current;
    if (!bridge) return;
    bridge.setSharpenViz(sharpenViz);
    bridge.render(false);
  }, [sharpenViz]);

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
    sourceWidth: sourceSize.width,
    sourceHeight: sourceSize.height,
    source,
    pipelineFloat,
    setViewport,
  };
}
