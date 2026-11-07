// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useCallback, useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import type { CatalogPhoto, CropRect, DevelopParams } from "@/catalog/types";
import { usesSignedOutput } from "@/catalog/types";
import type { ImageWindow } from "@/ui/viewport-view";

// Coverage overlay: a single red tint, faded in/out for all masks.
const VIZ_COLOR: [number, number, number] = [0.9, 0.25, 0.25];
const VIZ_STRENGTH = 0.5;
import { useMaskCoverageView } from "@/modules/develop/mask-coverage-view";
import { useStageViewValues } from "@/modules/develop/stage-view-values";
import { currentDisplaySpace } from "@/rendering/display-space";
import { getRenderBridge } from "@/rendering/render-bridge";
import type { RendererAvailability } from "@/rendering/render-bridge";
import type { RenderBridge, FrameResult } from "@/rendering/render-bridge";
import { setSourcePixels } from "@/rendering/source-pixels";
import { useDevelopStore } from "@/state/develop-store";
import { useCatalogStore } from "@/state/catalog-store";
import { useSettings } from "@/state/settings-store";
import { usePipelineStore } from "@/extensions/pipelines";
import { useRegistry } from "@/extensions/registry";
import { applyPanelBypass, bypassParamBag } from "@/modules/develop/panel-bypass";
import { frameStageBag } from "@/rendering/stage-bag";
import { createRenderParams, type ViewParams } from "./render-params";
import { canvasToolView, useCanvasToolStore } from "@/modules/develop/canvas-tool";
import { watchCacheFills } from "./develop-sources";
import { createHistogramScheduler } from "./histogram-scheduler";
import { NO_STAGES, useDevelopPhotoLoad } from "./use-develop-photo-load";
import { useDevelopPicture, type DevelopTier } from "./use-develop-picture";

export type { DevelopTier };

// Resolve the colour actually painted behind the image (the canvas surround) to
// linear-display RGB in 0..1, by reading the surround element's computed
// background. Reading the DOM rather than re-deriving from settings keeps the
// crop-mode margin matching every case at once — theme surface and the fixed
// surround override. Falls back to the legacy dark. While assessing, the
// buffer sits inside Assess's white mat (ViewportImage), so the margin is the
// mat's white rather than the grey around it.
function surroundRGB(assessing: boolean): [number, number, number] {
  if (assessing) return [1, 1, 1];
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

/** The stage bag the worker draws with: the photo's own and the built-in stages'
 *  entries (frameStageBag) under the extensions' view values, with what
 *  bypassed panels own taken out. */
function stageBag(
  params: DevelopParams,
  paramBag: Record<string, unknown>,
  bypassed: Record<string, boolean>,
  viewValues: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const shown = Object.keys(viewValues).length > 0 ? { ...paramBag, ...viewValues } : paramBag;
  return frameStageBag(applyPanelBypass(params, bypassed), bypassParamBag(shown, bypassed));
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
  /** Why edits can't be drawn: the last init failure while availability is
   *  "retrying" or "failed", the worker's silence or lost context while it is
   *  "unresponsive" or "lost", or the missing canvas when not supported. */
  availabilityReason: string | null;
  width: number;
  height: number;
  // The window of the image the canvas holds, committed with its pixels and size;
  // null, the whole image.
  bufferWindow: ImageWindow | null;
  // The size of a picture of the whole image at the canvas's resolution, which its
  // window is part of; 0 when nothing says.
  wholeWidth: number;
  wholeHeight: number;
  // The region of the transformed image the canvas is of (the crop it was drawn with,
  // which crop mode widens), committed with its pixels; null when nothing says.
  bufferCrop: CropRect | null;
  // Size of the source the last frame was drawn from (upright, as the renderer
  // holds it), for image-aspect-dependent UI like the crop overlay. 0 until a
  // frame of the photo is drawn.
  sourceWidth: number;
  sourceHeight: number;
  // null until anything of the photo is drawn.
  tier: DevelopTier | null;
  // The canvas corner's label for it (useTierLabel), or why nothing of the photo shows.
  status: string | null;
  // The processing stages the last frame of the photo was drawn without, for want
  // of a GPU texture unit: they are on, but change nothing.
  overflowedStages: readonly string[];
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
  // The photo this view draws, for listeners that outlive a render.
  const openPhotoIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    openPhotoIdRef.current = photo?.id;
  }, [photo?.id]);
  const rafIdRef = useRef<number | null>(null);
  const awaitingSourceRef = useRef(true);
  const finalGenRef = useRef<number | null>(null);
  const sentGenRef = useRef<number | null>(null);
  const [histogram] = useState(() =>
    createHistogramScheduler({
      renderQueued: () => rafIdRef.current != null,
      compute: () => bridgeRef.current?.computeHistogram(true),
      publish: (data) => useDevelopStore.getState().setHistogram(data),
    }),
  );
  const [cantShow, setCantShow] = useState<string | null>(null);
  const [settledReason, setSettledReason] = useState<string | null>(null);
  const [supported, setSupported] = useState(true);
  const [availability, setAvailability] = useState<RendererAvailability>("starting");
  const [availabilityReason, setAvailabilityReason] = useState<string | null>(null);
  // Counts the worker's renderer coming back after its graphics context was lost, which
  // took every source it held: each time, the photo is loaded again.
  const [restores, setRestores] = useState(0);
  const [loading, setLoading] = useState(false);
  const picture = useDevelopPicture(canvasRef, fadeCanvasRef);
  const { size, tier, ctxRef, present, dropPending } = picture;
  // Size of the source the last frame was drawn from, as the renderer holds it
  // (already upright). Drives the image aspect — see `aspect` below.
  const [sourceSize, setSourceSize] = useState({ width: 0, height: 0 });
  // The stages the last frame of the photo was drawn without (FrameResult).
  const [overflowedStages, setOverflowedStages] = useState<readonly string[]>(NO_STAGES);
  // Effective params: a hover preview (e.g. from the Presets panel) overrides
  // the committed params for rendering only, without touching history.
  const params = useDevelopStore((s) => s.previewParams ?? s.params);
  // Generic param bag for extension-contributed processing stages (e.g. denoise).
  // A hover preview overrides it (paired with previewParams) so a preset's
  // extension adjustments preview too, without touching the committed bag.
  const paramBag = useDevelopStore((s) => s.previewParamBag ?? s.paramBag);
  const asShotTemperature = useDevelopStore((s) => s.asShotTemperature);
  // The held canvas tool's view of the edit (crop mode widens the crop).
  const view = useCanvasToolStore((s) => canvasToolView(s.held));
  const showClipping = useDevelopStore((s) => s.showClipping);
  // The space the soft proof previews, the export default, or none: the proof is
  // version 3's (usesSignedOutput), and says so rather than leave it to the worker.
  const proof = useDevelopStore((s) => s.proof);
  const exportColorSpace = useSettings((s) => s.exportColorSpace);
  const proofSpace = proof && usesSignedOutput(params) ? exportColorSpace : null;
  // Drives the crop-mode margin colour (canvas surround). Read reactively so the
  // margin tracks the assessment toggle and the surround override/shade live.
  const colorAssessment = useDevelopStore((s) => s.colorAssessment);
  const canvasSurround = useSettings((s) => s.canvasSurround);
  const canvasSurroundOverride = useSettings((s) => s.canvasSurroundOverride);
  const shownMaskId = useMaskCoverageView((s) => s.maskId);
  const viewValues = useStageViewValues((s) => s.merged);
  const sharpenViz = useDevelopStore((s) => s.sharpenViz);
  const bypassedPanels = useDevelopStore((s) => s.bypassedPanels);
  const fileAccessNonce = useCatalogStore((s) => s.fileAccessNonce);
  const pipelineId = usePipelineStore((s) => s.activeId);

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
  const forRender = (p: DevelopParams, v: ViewParams | null): DevelopParams =>
    renderParams(p, v, aspect, bypassedPanels);

  // Draws the source just handed over (sent, or bound from the GPU cache) with the
  // photo's edit. The frame carries its own histogram, extended for the clipping
  // readouts.
  const drawSource = (bridge: RenderBridge, opened: CatalogPhoto) => {
    awaitingSourceRef.current = false;
    sentGenRef.current = bridge.sourceGen;
    setCantShow(null);
    bridge.setAsShotTemperature(opened.exif.colorTemperature ?? 6500);
    const st = useDevelopStore.getState();
    bridge.setContributedParams(
      stageBag(st.params, st.paramBag, st.bypassedPanels, useStageViewValues.getState().merged),
    );
    bridge.setParams(forRender(st.params, canvasToolView(useCanvasToolStore.getState().held)));
    histogram.clearDirty();
    bridge.render(true, true);
  };
  // The load runs on across renders, so it draws through the latest one: a panel
  // bypassed or an aspect learnt while it waits must not be undone by its first draw.
  const drawSourceRef = useRef(drawSource);
  drawSourceRef.current = drawSource;

  // Set up the bridge + 2D display canvas. The worker owns the WebGL context;
  // this canvas just blits ImageBitmap frames from the worker.
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    // A context's colour space is fixed by its first getContext, which is why
    // DevelopStage builds the canvas again when the screen's space changes. A P3
    // frame keeps its gamut on a P3 screen; an sRGB one converts exactly onto it.
    const ctx = cv.getContext("2d", { colorSpace: currentDisplaySpace() });
    if (!ctx) {
      setSupported(false);
      setAvailabilityReason("this window has no 2D canvas to draw on.");
      return;
    }
    ctxRef.current = ctx;

    const bridge = getRenderBridge();
    bridgeRef.current = bridge;

    const offFilled = watchCacheFills(bridge, openPhotoIdRef);

    bridge.setOnFrame((frame: FrameResult) => {
      if (awaitingSourceRef.current) {
        frame.bitmap.close();
        return;
      }
      const finalGen = finalGenRef.current;
      const frameTier: DevelopTier =
        finalGen !== null && frame.sourceGen >= finalGen ? "final" : "preview";
      present({
        bitmap: frame.bitmap,
        width: frame.width,
        height: frame.height,
        tier: frameTier,
        window: frame.roi,
        whole:
          frame.wholeWidth > 0 && frame.wholeHeight > 0
            ? { width: frame.wholeWidth, height: frame.wholeHeight }
            : null,
        crop: frame.crop,
      });
      const overflowed = frame.overflowedStages;
      setOverflowedStages((s) =>
        s.length === overflowed.length && s.every((id, i) => id === overflowed[i]) ? s : overflowed,
      );
      // The renderer's own size of the source, which the drawn transform's aspect
      // comes from, so the crop overlay agrees with the pixels on screen. A source
      // bound from the GPU cache is reported by its frames alone.
      const { sourceWidth, sourceHeight, sourceFullWidth, sourceFullHeight, sourceNative } = frame;
      if (sourceWidth > 0 && sourceHeight > 0) {
        setSourceSize((s) =>
          s.width === sourceWidth && s.height === sourceHeight
            ? s
            : { width: sourceWidth, height: sourceHeight },
        );
        // Panels (Crop/Transform) derive imageAspect from the store, not this hook.
        useDevelopStore
          .getState()
          .setSourceSize(sourceWidth, sourceHeight, { width: sourceFullWidth, height: sourceFullHeight, native: sourceNative });
      }
      histogram.onFrame(frame.histogram);
    });
    bridge.setOnHistogram((data) => {
      if (!awaitingSourceRef.current) useDevelopStore.getState().setHistogram(data);
    });

    bridge.setOnError((msg) => {
      console.error("[render-worker]", msg);
    });
    bridge.setOnSourceError((gen, message) => {
      if (gen === sentGenRef.current) setCantShow(`Can't show this photo: ${message}`);
    });
    let lost = false;
    bridge.setOnAvailability((next, detail) => {
      if (next === "lost") lost = true;
      if (next === "ready" && lost) {
        lost = false;
        setRestores((n) => n + 1);
      }
      setAvailability(next);
      setAvailabilityReason(detail ?? null);
    });

    // The worker owns the decoded source; mirror its downscaled copy into this
    // (window) module instance, where extensions search it.
    bridge.setOnSourcePixels(({ data, width, height }) => {
      setSourcePixels(data, width, height);
    });

    // The bridge repaints stage and pipeline swaps itself, past the params effect.
    const stopWatchingStages = useRegistry.subscribe((s, prev) => {
      if (s.processingStages !== prev.processingStages || s.pipelines !== prev.pipelines) {
        histogram.markDirty();
      }
    });

    setSupported(true);
    return () => {
      offFilled();
      stopWatchingStages();
      histogram.dispose();
      if (rafIdRef.current != null) cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
      bridge.setOnFrame(null);
      bridge.setOnHistogram(null);
      bridge.setOnError(null);
      bridge.setOnSourceError(null);
      bridge.setOnAvailability(null);
      bridge.setOnSourcePixels(null);
      bridgeRef.current = null;
      ctxRef.current = null;
      dropPending();
    };
  }, [canvasRef, present, dropPending]);

  const { holdEditedPreview } = useDevelopPhotoLoad({
    photo,
    // The load runs again when either moves on.
    fileAccessNonce: fileAccessNonce + restores,
    bridgeRef,
    picture,
    openPhotoIdRef,
    awaitingSourceRef,
    finalGenRef,
    sentGenRef,
    setLoading,
    setCantShow,
    setSettledReason,
    setOverflowedStages,
    drawSourceRef,
  });

  // Only a tool's view draws with the aspect (crop mode's widened crop), so outside
  // one the source's own size, which comes with its first frame, doesn't render and
  // measure that frame a second time.
  const viewAspect = view ? aspect : 0;

  // What the view draws of the edit. It stays the same object while an edit changes
  // nothing drawn, as a drag of the crop box in crop mode does, so that edit renders
  // nothing. The stage bag doesn't read the crop either.
  const drawn = forRender(params, view);

  // Re-render on parameter changes. The frame that answers asks for the
  // histogram (setOnFrame above), throttled or settled per Preferences.
  useEffect(() => {
    const bridge = bridgeRef.current;
    if (!bridge) return;
    bridge.setAsShotTemperature(asShotTemperature);
    bridge.setContributedParams(stageBag(params, paramBag, bypassedPanels, viewValues));
    bridge.setParams(drawn);
    histogram.markDirty();
    if (rafIdRef.current == null) {
      rafIdRef.current = requestAnimationFrame(() => {
        rafIdRef.current = null;
        bridgeRef.current?.render(false);
      });
    }
    // `params` feeds only the stage bag here, which changes with `drawn`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawn, paramBag, view, pipelineId, asShotTemperature, viewAspect, bypassedPanels, viewValues]);

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

  useEffect(() => {
    const bridge = bridgeRef.current;
    if (!bridge) return;
    bridge.setProof(proofSpace);
    bridge.render(false);
  }, [proofSpace]);

  // Paint out-of-image margins (crop mode, out-of-frame straighten) in the canvas
  // surround so the photo isn't framed in a black border. Re-reads the resolved
  // surround whenever it can change; the DOM read happens after layout commits.
  useEffect(() => {
    const bridge = bridgeRef.current;
    if (!bridge) return;
    bridge.setOutsideColor(surroundRGB(colorAssessment));
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
    const idx = shownMaskId ? params.masks.findIndex((m) => m.id === shownMaskId) : -1;
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
  }, [shownMaskId, params.masks]);

  // Sharpening preview: while Alt/Ctrl-dragging a Detail-panel sharpening slider,
  // the shader renders a greyscale visualization of that sub-signal. Push the mode
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
    availabilityReason,
    width: size.width,
    height: size.height,
    bufferWindow: size.window,
    wholeWidth: size.whole?.width ?? 0,
    wholeHeight: size.whole?.height ?? 0,
    bufferCrop: size.crop,
    sourceWidth: sourceSize.width,
    sourceHeight: sourceSize.height,
    tier,
    status,
    overflowedStages,
    pictureCanvas: picture.pictureCanvas,
    setViewport,
  };
}
