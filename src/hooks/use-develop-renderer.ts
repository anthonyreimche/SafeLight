// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { CatalogPhoto, DevelopParams } from "@/catalog/types";
import { cancelCrossfade, snapshotCrossfade } from "@/ui/canvas-crossfade";
import { endHandover } from "@/ui/canvas-handover";

// Coverage overlay: a single red tint, faded in/out for all masks.
const VIZ_COLOR: [number, number, number] = [0.9, 0.25, 0.25];
const VIZ_STRENGTH = 0.5;
import { resolveVizMaskIndex } from "@/modules/develop/mask-viz";
import { getRenderBridge } from "@/rendering/render-bridge";
import type { RendererAvailability } from "@/rendering/render-bridge";
import type { RenderBridge, FrameResult } from "@/rendering/render-bridge";
import { loadPhotoImage, photoSourceKey } from "@/catalog/load-image";
import type { DecodedImage, Fallback } from "@/catalog/load-image";
import { setHealSourceImage } from "@/rendering/heal-source";
import { useDevelopStore } from "@/state/develop-store";
import { useCatalogStore } from "@/state/catalog-store";
import { showsEdit, standsForPhoto } from "@/state/fallback-rules";
import { visibleList } from "@/modules/library/photo-navigation";
import { getSettings, useSettings } from "@/state/settings-store";
import { usePipelineStore } from "@/extensions/pipelines";
import { useRegistry } from "@/extensions/registry";
import { applyPanelBypass, bypassParamBag } from "@/modules/develop/panel-bypass";
import { denoiseBag } from "@/rendering/webgl/builtin-denoise";
import { getExtSetting, useExtSettings } from "@/extensions/ext-settings";
import { createRenderParams } from "./render-params";
import { previewShowsEdit } from "./preview-shows-edit";

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

/** Whether a load settled on a preview of the photo instead of its own pixels: a fallback
 *  (the camera's preview, or the stored one), or a float the decoder marked as one. */
function isPreview(image: DecodedImage): boolean {
  if (image.kind === "float") return image.isFallbackPreview ?? false;
  return image.kind === "bitmap" && image.fallback !== undefined;
}

/** Why the canvas shows a preview of the photo for good, in the words of its corner. */
function previewReason(fallback: Fallback | null | undefined): string | null {
  if (fallback?.unsupported) return "Safelight can't open this RAW yet";
  if (fallback?.timedOut) return "this RAW took too long to open";
  if (fallback?.offline) return "the original isn't available";
  return null;
}

/** The key a fallback the load settled on goes into the GPU source cache under. The
 *  renderer binds back the source it held after a neighbour is uploaded without binding
 *  (prefetchNeighbors) only when it held it under a key, so the open photo's source
 *  always has one; but no open binds this one, so the next open loads the photo again. */
const fallbackKey = (key: string): string => `${key}#fallback`;

/** The stage bag the worker draws with: the photo's own and the built-in denoise stage's
 *  entries, with what bypassed panels own taken out. */
function stageBag(
  params: DevelopParams,
  paramBag: Record<string, unknown>,
  bypassed: Record<string, boolean>,
): Record<string, unknown> {
  return {
    ...bypassParamBag(paramBag, bypassed),
    ...denoiseBag(applyPanelBypass(params, bypassed)),
  };
}

// The keys of the sources this view put in the GPU cache that are a preview (isPreview),
// with what the load fell back on, so a photo bound from there again isn't taken for its
// full decode and still says why. Kept per bridge, whose worker holds the cache.
const previewSources = new WeakMap<RenderBridge, Map<string, Fallback | null>>();

function notePreviewSource(bridge: RenderBridge, key: string, image: DecodedImage) {
  let keys = previewSources.get(bridge);
  if (!keys) {
    keys = new Map();
    previewSources.set(bridge, keys);
  }
  if (!isPreview(image)) keys.delete(key);
  else keys.set(key, image.kind === "bitmap" ? (image.fallback ?? null) : null);
}

/** What the develop canvas shows of the open photo: "stored", its stored preview, drawn
 *  as it is; "preview", frames of the camera's embedded preview while the full decode
 *  runs, or for good when the load settled on a preview; "final", frames of the image
 *  the load settled on (the full decode, the decode cache, or the source still resident
 *  on the GPU). */
export type DevelopTier = "stored" | "preview" | "final";

// What the canvas holds of the open photo eases into the next tier of it: the stored
// preview into the first developed frame, the camera's preview into the full decode.
// Anything else cuts, and so does every move to another photo.
const STORED_FADE_MS = 150;
const PREVIEW_FADE_MS = 220;

function fadeMs(from: DevelopTier, to: DevelopTier): number | null {
  if (from === "stored" && to !== "stored") return STORED_FADE_MS;
  if (from === "preview" && to === "final") return PREVIEW_FADE_MS;
  return null;
}

// A photo opened this soon after the one before (an arrow key held) cuts between its
// tiers. Kept per bridge: DevelopView mounts a new canvas, and so a new view, per photo.
const QUICK_SWITCH_MS = 150;
const lastOpened = new WeakMap<RenderBridge, { photoId: string; at: number; fades: boolean }>();

/** Notes that `bridge`'s view opened `photoId`, and says whether its tiers may fade.
 *  The same photo opened again at once (React's StrictMode runs a mounting view's
 *  effects twice) is the same open. */
function noteOpened(bridge: RenderBridge, photoId: string): boolean {
  const at = performance.now();
  const before = lastOpened.get(bridge);
  if (before?.photoId === photoId && at - before.at < QUICK_SWITCH_MS) return before.fades;
  const fades = at - (before?.at ?? -Infinity) >= QUICK_SWITCH_MS;
  lastOpened.set(bridge, { photoId, at, fades });
  return fades;
}

/** Whether one size scaled into a box of the other's shows unstretched. */
function sameAspect(aw: number, ah: number, bw: number, bh: number): boolean {
  if (!(aw > 0 && ah > 0 && bw > 0 && bh > 0)) return false;
  return Math.abs(aw / ah / (bw / bh) - 1) < 0.01;
}

/** Something to put on the canvas: a frame, or the stored preview. Owns its bitmap. */
interface Picture {
  bitmap: ImageBitmap;
  width: number;
  height: number;
  tier: DevelopTier;
}

// The canvas corner says "Preview" once a preview has shown for LABEL_DELAY_MS, and
// "Full quality" for FULL_QUALITY_MS when the full image then replaces it. A photo
// that opens quickly says nothing.
const LABEL_DELAY_MS = 300;
const FULL_QUALITY_MS = 1000;

interface LabelState {
  load: string | undefined;
  late: boolean;
  sawPreview: boolean;
  doneFull: boolean;
}

const freshLabel = (load: string | undefined): LabelState => ({
  load,
  late: false,
  sawPreview: false,
  doneFull: false,
});

/** The develop canvas's corner label, given the tier shown (DevelopRenderer.tier) and
 *  whether the photo's load still runs. `load` names one load of a photo: a new one,
 *  the next photo's or the same photo loaded again, starts the label over. */
export function useTierLabel(
  tier: DevelopTier | null,
  loading: boolean,
  load: string | undefined,
): string | null {
  const [held, setHeld] = useState(() => freshLabel(load));
  const state = held.load === load ? held : freshLabel(load);

  let label: string | null = null;
  if (state.late) {
    if (tier === "final") label = state.sawPreview && !state.doneFull ? "Full quality" : null;
    else if (tier !== null) label = "Preview";
    else if (loading) label = "Loading…";
  }

  useEffect(() => {
    const timer = setTimeout(
      () => setHeld({ ...freshLabel(load), late: true }),
      LABEL_DELAY_MS,
    );
    return () => clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    if (label === "Preview") {
      setHeld((s) => (s.load === load && !s.sawPreview ? { ...s, sawPreview: true } : s));
      return;
    }
    if (label !== "Full quality") return;
    const timer = setTimeout(
      () => setHeld((s) => (s.load === load ? { ...s, doneFull: true } : s)),
      FULL_QUALITY_MS,
    );
    return () => clearTimeout(timer);
  }, [label, load]);

  return label;
}

interface RendererStatus {
  supported: boolean;
  /** Whether the worker's renderer exists (it can fail to create a WebGL2
   *  context after a GPU reset; the bridge retries). */
  availability: RendererAvailability;
  width: number;
  height: number;
  // Size of the source the last frame was drawn from (upright, as the renderer
  // holds it), for image-aspect-dependent UI like the crop overlay. 0 until a
  // frame of the photo is drawn.
  sourceWidth: number;
  sourceHeight: number;
  // null until anything of the photo is drawn.
  tier: DevelopTier | null;
  // The canvas corner's label for it (useTierLabel), or why nothing of the photo shows.
  status: string | null;
  // The display canvas while it holds a picture of the open photo, else null: what a
  // view going away hands to the next (canvas-handover.ts).
  pictureCanvas: () => HTMLCanvasElement | null;
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
  // The overlay laid over the canvas with the same placement, which a tier of the
  // photo fades out on over the next (see fadeMs).
  fadeCanvasRef?: RefObject<HTMLCanvasElement | null>,
): RendererStatus {
  const bridgeRef = useRef<RenderBridge | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const rafIdRef = useRef<number | null>(null);
  // True from the moment a photo opens until its own source is handed to the
  // worker. Frames and histograms that arrive meanwhile belong to the photo
  // before, and are dropped.
  const awaitingSourceRef = useRef(true);
  // Something the histogram measures has changed since one was last asked for.
  // Frames that only move the view or fade an overlay leave it clear.
  const histDirtyRef = useRef(false);
  // performance.now() of the last change that set histDirtyRef.
  const histDirtyAtRef = useRef(0);
  // The source number (RenderBridge.sourceGen) of the image the photo's load settled
  // on, once it is handed over. Frames of an older number show the camera's preview.
  // Stays null when the load settled on a preview.
  const finalGenRef = useRef<number | null>(null);
  // The source number of the last image of the photo handed over.
  const sentGenRef = useRef<number | null>(null);
  // Why nothing of the photo is drawn, said in place of the label: the worker couldn't
  // take its source, or there is no picture of it to show (holdEditedPreview).
  const [cantShow, setCantShow] = useState<string | null>(null);
  // Why the load settled on a preview for good (previewReason), for the label.
  const [settledReason, setSettledReason] = useState<string | null>(null);
  const tierRef = useRef<DevelopTier | null>(null);
  const [tier, setTier] = useState<DevelopTier | null>(null);
  const [supported, setSupported] = useState(true);
  const [availability, setAvailability] = useState<RendererAvailability>("starting");
  const [loading, setLoading] = useState(false);
  // The canvas's box size. Changes in the same commit as the pixels (see present).
  const [size, setSize] = useState({ width: 0, height: 0 });
  // What the canvas holds of the open photo, and at what size; the tier is null while
  // it holds nothing of it (blank, or the photo before).
  const shownRef = useRef<DevelopTier | null>(null);
  const paintedRef = useRef({ width: 0, height: 0 });
  // The photo the load effect opened last, and the one the canvas holds a picture of.
  const openedRef = useRef<string | null>(null);
  const paintedPhotoRef = useRef<string | null>(null);
  // Whether this photo's tiers may fade into each other (QUICK_SWITCH_MS).
  const fadesRef = useRef(true);
  // A picture of another size than the box, waiting for the commit that resizes it.
  const pendingRef = useRef<Picture | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  // Size of the source the last frame was drawn from, as the renderer holds it
  // (already upright). Drives the image aspect — see `aspect` below.
  const [sourceSize, setSourceSize] = useState({ width: 0, height: 0 });
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
  // real buffer dims (reported by every frame drawn) over
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
  // The three places below that hand the bridge params all ask through this one memo,
  // so a run that changed none of its inputs gets back the object the bridge already
  // posted, instead of a rebuilt copy it would clone to the worker again.
  const [renderParams] = useState(createRenderParams);
  const forRender = (p: DevelopParams, crop: boolean): DevelopParams =>
    renderParams(p, crop, aspect, bypassedPanels);

  const resize = useCallback((width: number, height: number) => {
    setSize((s) => (s.width === width && s.height === height ? s : { width, height }));
  }, []);

  // Draws `next` now. What the canvas held eases into it when that was a lower tier of
  // the same photo, of the same shape. A picture of another shape ends any fade: the
  // overlay takes the canvas's new box and would show the old picture stretched in it.
  const paint = useCallback(
    (next: Picture) => {
      const cv = canvasRef.current;
      const ctx = ctxRef.current;
      if (!cv || !ctx) {
        next.bitmap.close();
        return;
      }
      const from = shownRef.current;
      const ms = from === null ? null : fadeMs(from, next.tier);
      const overlay = fadeCanvasRef?.current;
      const sameShape = sameAspect(cv.width, cv.height, next.width, next.height);
      if (overlay && ms !== null && fadesRef.current && sameShape) {
        snapshotCrossfade(cv, overlay, ms);
      } else if (overlay && !sameShape) {
        cancelCrossfade(overlay);
      }
      if (cv.width !== next.width) cv.width = next.width;
      if (cv.height !== next.height) cv.height = next.height;
      ctx.drawImage(next.bitmap, 0, 0);
      next.bitmap.close();
      // The photo's first picture replaces what the view before left on screen.
      if (from === null) endHandover();
      shownRef.current = next.tier;
      paintedRef.current = { width: next.width, height: next.height };
      paintedPhotoRef.current = openedRef.current;
    },
    [canvasRef, fadeCanvasRef],
  );

  // Not `shownRef`: a photo loading again keeps its last picture on screen.
  const pictureCanvas = useCallback(
    () =>
      paintedPhotoRef.current !== null && paintedPhotoRef.current === openedRef.current
        ? canvasRef.current
        : null,
    [canvasRef],
  );

  // Shows `next`. A picture of the size already painted is drawn at once, so a drag
  // costs no React render. Another size waits for the commit that resizes the box
  // (the layout effect below): drawn ahead of it, it showed stretched to the old box.
  const present = useCallback(
    (next: Picture) => {
      const painted = paintedRef.current;
      if (!pendingRef.current && painted.width === next.width && painted.height === next.height) {
        paint(next);
      } else {
        pendingRef.current?.bitmap.close();
        pendingRef.current = next;
        resize(next.width, next.height);
        setPendingCount((n) => n + 1);
      }
      if (tierRef.current !== next.tier) {
        tierRef.current = next.tier;
        setTier(next.tier);
      }
    },
    [paint, resize],
  );

  // Forgets a picture still waiting for its box, which goes back to what is painted.
  const dropPending = useCallback(() => {
    const next = pendingRef.current;
    if (!next) return;
    next.bitmap.close();
    pendingRef.current = null;
    resize(paintedRef.current.width, paintedRef.current.height);
  }, [resize]);

  // Empties the canvas and its box: what it holds of the photo is no longer true.
  const clearPicture = useCallback(() => {
    dropPending();
    const cv = canvasRef.current;
    if (cv) {
      cv.width = 0;
      cv.height = 0;
    }
    const overlay = fadeCanvasRef?.current;
    if (overlay) cancelCrossfade(overlay);
    shownRef.current = null;
    paintedRef.current = { width: 0, height: 0 };
    paintedPhotoRef.current = null;
    tierRef.current = null;
    setTier(null);
    resize(0, 0);
  }, [canvasRef, fadeCanvasRef, dropPending, resize]);

  // An edited photo's stored preview, its original out of reach (Fallback
  // "stored-edited"), shows the edit it was rendered with, so it is never a source: an
  // edit rendered over it would apply twice. It shows as it is while that is the edit
  // open, checked when the load settles on it and on every edit after (an undo back to
  // it shows it again), and nothing shows otherwise. Edits are saved all the same.
  const editedPreviewRef = useRef<{ photo: CatalogPhoto; offline: boolean } | null>(null);
  const holdEditedPreview = useCallback(
    (bitmap: ImageBitmap | null) => {
      const held = editedPreviewRef.current;
      const shows = !!held && previewShowsEdit(held.photo, useDevelopStore.getState());
      if (!held || !shows) {
        bitmap?.close();
        if (!held) return;
        if (shownRef.current !== null) clearPicture();
        setCantShow(held.offline ? "The original isn't available." : "Can't show this photo.");
        return;
      }
      setCantShow(null);
      if (bitmap) {
        present({ bitmap, width: bitmap.width, height: bitmap.height, tier: "stored" });
        return;
      }
      const blob = held.photo.thumbnailBlob;
      if (shownRef.current !== null || !blob) return;
      createImageBitmap(blob).then(
        (bm) => {
          const still =
            editedPreviewRef.current === held &&
            shownRef.current === null &&
            previewShowsEdit(held.photo, useDevelopStore.getState());
          if (still) present({ bitmap: bm, width: bm.width, height: bm.height, tier: "stored" });
          else bm.close();
        },
        () => {},
      );
    },
    [clearPicture, present],
  );

  useLayoutEffect(() => {
    const next = pendingRef.current;
    if (!next) return;
    pendingRef.current = null;
    paint(next);
  }, [pendingCount, paint]);

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
      // The worker measures its last render, so an edit whose render still waits
      // for its animation frame needs that frame to ask again. A render waiting in
      // the bridge's mailbox takes the request itself (RenderBridge.computeHistogram).
      histDirtyRef.current = rafIdRef.current != null;
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
      if (awaitingSourceRef.current) {
        frame.bitmap.close();
        return;
      }
      const finalGen = finalGenRef.current;
      const frameTier: DevelopTier =
        finalGen !== null && frame.sourceGen >= finalGen ? "final" : "preview";
      present({ bitmap: frame.bitmap, width: frame.width, height: frame.height, tier: frameTier });
      // The renderer's own size of the source, which the drawn transform's aspect
      // comes from, so the crop overlay agrees with the pixels on screen. A source
      // bound from the GPU cache is reported by its frames alone.
      const { sourceWidth, sourceHeight } = frame;
      if (sourceWidth > 0 && sourceHeight > 0) {
        setSourceSize((s) =>
          s.width === sourceWidth && s.height === sourceHeight
            ? s
            : { width: sourceWidth, height: sourceHeight },
        );
        // Panels (Crop/Transform) derive imageAspect from the store, not this hook.
        useDevelopStore.getState().setSourceSize(sourceWidth, sourceHeight);
      }
      if (frame.histogram) {
        setHistogramRef(frame.histogram);
        lastHistTime = performance.now();
        return;
      }
      if (!histDirtyRef.current) return;
      if (getSettings().liveHistogram) {
        // Live: recompute continuously while editing, throttled to HIST_THROTTLE.
        if (!histTimer) {
          const elapsed = performance.now() - lastHistTime;
          const delay = Math.max(0, HIST_THROTTLE - elapsed);
          histTimer = setTimeout(recomputeHistogram, delay);
        }
      } else {
        // Off: debounce — reset on every frame so we only recompute after the
        // edit settles, instead of on each intermediate frame. Counted from the
        // edit, not the frame: Auto Tone/WB give each step's histogram 450 ms,
        // and a slow render would otherwise use that up.
        if (histTimer) clearTimeout(histTimer);
        const sinceEdit = performance.now() - histDirtyAtRef.current;
        histTimer = setTimeout(recomputeHistogram, Math.max(0, HIST_SETTLE - sinceEdit));
      }
    });
    bridge.setOnHistogram((histogram) => {
      if (!awaitingSourceRef.current) setHistogramRef(histogram);
    });

    bridge.setOnError((msg) => {
      console.error("[render-worker]", msg);
    });
    bridge.setOnSourceError((gen) => {
      if (gen === sentGenRef.current) setCantShow("Can't show this photo.");
    });
    bridge.setOnAvailability(setAvailability);

    // The worker owns the decoded source; mirror its downscaled heal-source buffer
    // into this (main-thread) module instance so the overlay's findHealSource /
    // healColorOffset can pick a real source instead of a blind offset.
    bridge.setOnHealSource(({ data, width, height }) => {
      setHealSourceImage(data, width, height);
    });

    // The bridge repaints stage and pipeline swaps itself, past the params effect.
    const stopWatchingStages = useRegistry.subscribe((s, prev) => {
      if (s.processingStages !== prev.processingStages || s.pipelines !== prev.pipelines) {
        histDirtyRef.current = true;
        histDirtyAtRef.current = performance.now();
      }
    });

    setSupported(true);
    return () => {
      stopWatchingStages();
      if (histTimer) { clearTimeout(histTimer); histTimer = null; }
      if (rafIdRef.current != null) cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
      bridge.setOnFrame(null);
      bridge.setOnHistogram(null);
      bridge.setOnError(null);
      bridge.setOnSourceError(null);
      bridge.setOnAvailability(null);
      bridge.setOnHealSource(null);
      bridgeRef.current = null;
      ctxRef.current = null;
      dropPending();
    };
  }, [canvasRef, present, dropPending]);

  // Load the active photo into the worker.
  useEffect(() => {
    let cancelled = false;
    const bridge = bridgeRef.current;
    if (!photo || !bridge) return;
    // Once the photo is left, a decode this run asked for that still waits for a
    // decoder gives up its place. One already running finishes and fills the cache.
    const abort = new AbortController();

    setLoading(true);
    // The worker's bound source and the histogram still describe the photo
    // before; neither shows until this photo's source is handed over.
    awaitingSourceRef.current = true;
    finalGenRef.current = null;
    sentGenRef.current = null;
    setCantShow(null);
    setSettledReason(null);
    editedPreviewRef.current = null;
    tierRef.current = null;
    setTier(null);
    bridge.clearSource();
    useDevelopStore.getState().setHistogram(null);

    // What the canvas holds is of another photo, or of this one's load before: the
    // first picture of this load cuts.
    shownRef.current = null;
    openedRef.current = photo.id;
    dropPending();
    const overlay = fadeCanvasRef?.current;
    if (overlay) cancelCrossfade(overlay);
    fadesRef.current = noteOpened(bridge, photo.id);
    // Its canvas keeps its last picture until this load's first. Only a reload of the
    // same photo reaches here with one: DevelopView builds a new view per photo, and
    // canvas-handover holds the photo before for a moment over the new, blank canvas.

    // DevelopView loads this photo's edit as it mounts, after this effect has
    // run. Until it lands the store holds the previous photo's edit, so this
    // photo's source isn't rendered before it. Leaving the photo ends the wait too,
    // so whatever waited on it can let go.
    let stopWaiting: (() => void) | null = null;
    let endWait = () => {};
    const editLoaded = new Promise<void>((resolve) => {
      endWait = resolve;
      if (useDevelopStore.getState().photoId === photo.id) return resolve();
      stopWaiting = useDevelopStore.subscribe((s) => {
        if (s.photoId !== photo.id) return;
        stopWaiting?.();
        resolve();
      });
    });

    // The stored preview, drawn as it is while the source loads, once the photo's
    // edit has loaded and only if the preview shows it (previewShowsEdit).
    // An edited photo's preview is re-rendered on every Develop commit, see
    // edited-thumbnail.ts, so rendering the edit into it again would apply the
    // edit twice. Nor is its size the source's: an edited preview is cropped.
    const showStoredPreview = async () => {
      if (!photo.thumbnailBlob) return;
      let bm: ImageBitmap;
      try {
        [bm] = await Promise.all([createImageBitmap(photo.thumbnailBlob), editLoaded]);
      } catch {
        return; // the stored preview is optional
      }
      const shows = previewShowsEdit(photo, useDevelopStore.getState());
      if (!cancelled && awaitingSourceRef.current && shows) {
        present({ bitmap: bm, width: bm.width, height: bm.height, tier: "stored" });
      } else {
        bm.close();
      }
    };

    // `settled` is set for the image the load settled on: it is uploaded into the GPU
    // source cache under the photo's key when it may stand for the photo (standsForPhoto),
    // so a later re-open is a zero-decode bindSource, and under fallbackKey otherwise.
    // Without it the image is a transient setImage: the camera's preview frames while the
    // decode runs, which no neighbour is ever uploaded over (see fallbackKey).
    const sendImage = (
      image:
        | ImageBitmap
        | { kind: "float"; data: Float32Array; width: number; height: number; isFallbackPreview?: boolean }
        | { kind: "float16"; data: Uint16Array; width: number; height: number },
      isFallback = false,
      cachedRaw = false,
      settled?: { key: string; preview: boolean },
    ) => {
      if (cancelled) return;
      const maxEdge = getSettings().developMaxEdge;
      const src = image instanceof ImageBitmap ? { kind: "bitmap" as const, bitmap: image } : image;
      if (settled) {
        bridge.uploadSource("main", settled.key, src, maxEdge, isFallback, cachedRaw);
        finalGenRef.current = settled.preview ? null : bridge.sourceGen;
      } else {
        bridge.setImage(src, maxEdge, isFallback, cachedRaw);
      }
      drawSource();
    };

    // Draws the source just handed over (sent, or bound from the GPU cache) with the
    // photo's edit. The frame carries its own histogram, extended for the clipping
    // readouts.
    const drawSource = () => {
      awaitingSourceRef.current = false;
      sentGenRef.current = bridge.sourceGen;
      setCantShow(null);
      bridge.setAsShotTemperature(photo?.exif.colorTemperature ?? 6500);
      const st = useDevelopStore.getState();
      bridge.setContributedParams(stageBag(st.params, st.paramBag, st.bypassedPanels));
      bridge.setParams(forRender(st.params, st.cropping));
      histDirtyRef.current = false;
      bridge.render(true, true);
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
      const ordered = visibleList();
      const idx = ordered.findIndex((p) => p.id === photo.id);
      if (idx < 0) return;
      const neighbours = [ordered[idx + 1], ordered[idx - 1]].filter(Boolean);
      const maxEdge = getSettings().developMaxEdge;
      for (const np of neighbours) {
        if (cancelled) return;
        const nk = photoSourceKey(np);
        if (await bridge.hasSource("main", nk)) continue;
        if (cancelled) return;
        const image = await loadPhotoImage(np, { background: true, signal: abort.signal });
        if (cancelled) {
          if (image?.kind === "bitmap") image.bitmap.close();
          return;
        }
        // Null: the decoder passed it over for now, or nothing of it could be read.
        if (!image) continue;
        if (!standsForPhoto(image)) {
          if (image.kind === "bitmap") image.bitmap.close();
          continue;
        }
        notePreviewSource(bridge, nk, image);
        if (image.kind === "bitmap") {
          bridge.uploadSource("main", nk, { kind: "bitmap", bitmap: image.bitmap }, maxEdge, false, image.cached, false);
        } else {
          bridge.uploadSource("main", nk, image, maxEdge, image.kind === "float" ? image.isFallbackPreview : false, false, false);
        }
      }
    };

    const run = async () => {
      void showStoredPreview();
      await bridge.ready;
      await editLoaded;
      if (cancelled) return;

      // Clear any zoom window left over from the previously open photo so the
      // first frame renders the whole image (ViewportImage re-emits an ROI if the
      // new photo ends up zoomed).
      bridge.setViewport(null);

      const key = photoSourceKey(photo);

      // Fast path: the decoded source is already resident on the GPU from a prior
      // open/thumbnail render — bind and render without decoding (instant re-entry).
      if (await bridge.bindSource(key)) {
        if (cancelled) return;
        const kept = previewSources.get(bridge)?.get(key);
        finalGenRef.current = kept === undefined ? bridge.sourceGen : null;
        setSettledReason(previewReason(kept));
        syncAsShotTemp();
        drawSource();
        setLoading(false);
        void prefetchNeighbors();
        return;
      }
      if (cancelled) return;

      const image = await loadPhotoImage(photo, {
        onPreview: (preview) => {
          if (cancelled) {
            if (preview.kind === "bitmap") preview.bitmap.close();
            return;
          }
          if (preview.kind === "bitmap") {
            sendImage(preview.bitmap);
          } else {
            sendImage(preview);
          }
        },
        signal: abort.signal,
      });
      if (cancelled) {
        if (image?.kind === "bitmap") image.bitmap.close();
        return;
      }
      if (!image) { setLoading(false); return; }

      syncAsShotTemp();

      const fallback = image.kind === "bitmap" ? image.fallback : undefined;
      setSettledReason(previewReason(fallback));
      if (image.kind === "bitmap" && fallback && showsEdit(image)) {
        editedPreviewRef.current = { photo, offline: fallback.offline };
        holdEditedPreview(image.bitmap);
        setLoading(false);
        void prefetchNeighbors();
        return;
      }
      const isFallback = image.kind === "float" ? (image.isFallbackPreview ?? false) : false;
      const cachedRaw = image.kind === "bitmap" && (image.cached ?? false);
      const stands = standsForPhoto(image);
      const settled = stands
        ? { key, preview: isPreview(image) }
        : { key: fallbackKey(key), preview: true };
      if (stands) notePreviewSource(bridge, key, image);
      if (image.kind === "bitmap") {
        sendImage(image.bitmap, isFallback, cachedRaw, settled);
      } else {
        sendImage(image, isFallback, false, settled);
      }
      setLoading(false);
      void prefetchNeighbors();
    };

    run();
    return () => {
      cancelled = true;
      abort.abort();
      stopWaiting?.();
      endWait();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photo?.id, fileAccessNonce]);

  // Only crop mode draws with the aspect, so outside it the source's own size, which
  // comes with its first frame, doesn't render and measure that frame a second time.
  const cropAspect = cropping ? aspect : 0;

  // Re-render on parameter changes. The frame that answers asks for the
  // histogram (setOnFrame above), throttled or settled per Preferences.
  useEffect(() => {
    const bridge = bridgeRef.current;
    if (!bridge) return;
    bridge.setAsShotTemperature(asShotTemperature);
    bridge.setHslStyle(hslRangePref / 100, hslSmoothPref / 100);
    bridge.setContributedParams(stageBag(params, paramBag, bypassedPanels));
    bridge.setParams(forRender(params, cropping));
    histDirtyRef.current = true;
    histDirtyAtRef.current = performance.now();
    if (rafIdRef.current == null) {
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null;
        bridgeRef.current?.render(false);
      });
    }
  }, [params, paramBag, cropping, pipelineId, asShotTemperature, cropAspect, bypassedPanels, hslRangePref, hslSmoothPref]);

  // An edited stored preview standing in for the photo holds only while it shows the edit.
  useEffect(() => {
    holdEditedPreview(null);
  }, [params, paramBag, holdEditedPreview]);

  // A new photo starts from metadata aspect until a frame of its source is drawn,
  // so a failed/slow decode never leaves the previous photo's aspect in place.
  useEffect(() => {
    setSourceSize({ width: 0, height: 0 });
    useDevelopStore.getState().setSourceSize(0, 0);
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
  // `posted` is what the worker last drew. A mask edit renders through the params
  // effect, so the overlay re-renders only when its own index or strength moves.
  // Unknown when the view opens: the worker may still hold one the last view
  // left showing.
  const vizAnim = useRef({
    idx: -1,
    cur: 0,
    target: 0,
    raf: null as number | null,
    posted: null as { idx: number; strength: number } | null,
  });
  useEffect(() => {
    const idx = resolveVizMaskIndex(params.masks, hoveredMaskId, selectedMaskId, maskTab);
    const a = vizAnim.current;
    if (idx >= 0) a.idx = idx; // keep last index while fading out
    a.target = idx >= 0 ? VIZ_STRENGTH : 0;
    const tick = () => {
      const bridge = bridgeRef.current;
      if (!bridge) { a.raf = null; return; }
      a.cur += (a.target - a.cur) * 0.3;
      if (Math.abs(a.target - a.cur) < 0.01) a.cur = a.target;
      const activeIdx = a.cur > 0.002 ? a.idx : -1;
      const last = a.posted;
      if (!last || last.idx !== activeIdx || last.strength !== a.cur) {
        a.posted = { idx: activeIdx, strength: a.cur };
        bridge.setMaskViz(activeIdx, VIZ_COLOR, a.cur);
        bridge.render(false);
      }
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

  const label = useTierLabel(tier, loading, photo && `${photo.id}:${fileAccessNonce}`);
  const status =
    cantShow ?? (label === "Preview" && settledReason ? `Preview (${settledReason})` : label);

  return {
    supported,
    availability,
    width: size.width,
    height: size.height,
    sourceWidth: sourceSize.width,
    sourceHeight: sourceSize.height,
    tier,
    status,
    pictureCanvas,
    setViewport,
  };
}
