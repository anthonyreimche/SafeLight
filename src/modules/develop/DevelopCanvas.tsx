// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CatalogPhoto } from "@/catalog/types";
import { useDevelopRenderer } from "@/hooks/use-develop-renderer";
import { useDevelopStore } from "@/state/develop-store";
import { useSettings } from "@/state/settings-store";
import { mat3Apply } from "@/rendering/transform";
import { photoGeometry } from "@/rendering/photo-geometry";
import { ViewportImage, assessMatPx } from "@/ui/ViewportImage";
import { leavePicture, releaseHandover, takeHandover } from "@/ui/canvas-handover";
import { Slot } from "@/extensions/Slot";
import { boundaryKey, guardCallback } from "@/extensions/guard";
import { ErrorBoundary } from "@/ui/components/ErrorBoundary";
import { useCanvasGesture } from "@/state/canvas-gesture";
import { DevelopOverlayProvider } from "@/extensions/develop-host";
import type { OverlayRect } from "@/extensions/develop-host";
import { getRenderBridge } from "@/rendering/render-bridge";
import { useRegistry } from "@/extensions/registry";
import {
  GRAPHICS_STILL_WORKS,
  GRAPHICS_UNAVAILABLE,
  graphicsUnavailableDetail,
  probeGraphics,
  useGraphics,
} from "@/state/graphics-store";
import { overflowNotice } from "./stage-overflow";
import { usePickDragStore, type CanvasPoint, type PickDragTool } from "./pick-drag";
import { useCanvasToolStore } from "./canvas-tool";
import { lendCanvasProbe } from "./canvas-probe";

interface GuardedPickDrag {
  onPress(point: CanvasPoint): void;
  onDown(rgb: readonly [number, number, number], point: CanvasPoint): void;
  onMove(point: CanvasPoint): void;
  onUp(): void;
}

// One guarded set per tool: guardCallback counts throws per function, so a
// fresh wrapper per press would never switch a failing tool off.
const guardedPickDrags = new WeakMap<PickDragTool, GuardedPickDrag>();

function guardedPickDrag(owner: string, tool: PickDragTool): GuardedPickDrag {
  let g = guardedPickDrags.get(tool);
  if (!g) {
    g = {
      onPress: guardCallback(owner, "pick-drag press", (point: CanvasPoint) => tool.onPress?.(point), undefined),
      onDown: guardCallback(
        owner,
        "pick-drag down",
        (rgb: readonly [number, number, number], point: CanvasPoint) => tool.onDown?.(rgb, point),
        undefined,
      ),
      onMove: guardCallback(owner, "pick-drag move", (point: CanvasPoint) => tool.onMove?.(point), undefined),
      onUp: guardCallback(owner, "pick-drag up", () => tool.onUp?.(), undefined),
    };
    guardedPickDrags.set(tool, g);
  }
  return g;
}

export function DevelopCanvas({
  photo,
  zoom,
  onZoomChange,
}: {
  photo: CatalogPhoto;
  zoom: number | null;
  onZoomChange: (zoom: number | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // The crossfade overlay over the canvas: the renderer fades one tier of the photo
  // into the next on it, and the viewport fades the Presets hover on it.
  const fadeCanvasRef = useRef<HTMLCanvasElement>(null);
  const {
    supported,
    availability,
    availabilityReason,
    status,
    overflowedStages,
    width,
    height,
    bufferWindow,
    wholeWidth,
    wholeHeight,
    bufferCrop,
    sourceWidth,
    sourceHeight,
    setViewport,
    pictureCanvas,
  } = useDevelopRenderer(canvasRef, photo, fadeCanvasRef);
  const processingStages = useRegistry((s) => s.processingStages);
  const notice = overflowNotice(overflowedStages, processingStages);
  const stalled = availability !== "starting" && availability !== "ready";
  const noWebGL2 = useGraphics((s) => s.webgl2 === "no");
  const graphicsReason = useGraphics((s) => s.reason);
  useEffect(() => {
    if (stalled) probeGraphics();
  }, [stalled]);

  // Geometry of the displayed image + a nonce that bumps on any view change, so
  // extension overlays (e.g. before/after) can align and refresh. Generic: core
  // doesn't know what's mounted into the develop-canvas-overlay slot.
  const [overlayRect, setOverlayRect] = useState<OverlayRect | null>(null);
  const [overlayImageRect, setOverlayImageRect] = useState<OverlayRect | null>(null);
  const [overlayNonce, setOverlayNonce] = useState(0);
  // Where the pixels last showed, in the viewport's own CSS px, and its size.
  const layoutRef = useRef<{ visible: OverlayRect; frame: { w: number; h: number } } | null>(null);
  const sameRect = (a: OverlayRect | null, r: OverlayRect) =>
    !!a && a.x === r.x && a.y === r.y && a.w === r.w && a.h === r.h;
  const handleLayout = useCallback(
    (r: OverlayRect, image: OverlayRect, frame: { w: number; h: number }) => {
      layoutRef.current = { visible: r, frame };
      setOverlayRect((prev) => (sameRect(prev, r) ? prev : r));
      setOverlayImageRect((prev) => (sameRect(prev, image) ? prev : image));
      setOverlayNonce((n) => n + 1);
    },
    [],
  );

  // DevelopStage builds this view anew for every photo, so the picture on screen is
  // handed to the next view as this one goes, and the one the view before left is
  // shown until this photo's first picture (canvas-handover.ts). Layout effects: the
  // view going away and the one coming run theirs in the same commit, before paint.
  const handoverRef = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const handover = handoverRef.current;
    if (handover) takeHandover(handover);
    return () => {
      if (handover) releaseHandover(handover);
      const picture = pictureCanvas();
      const layout = layoutRef.current;
      if (!picture || !layout) return;
      const { colorAssessment: assessing } = useDevelopStore.getState();
      const { assessBorderPct: border } = useSettings.getState();
      leavePicture({
        canvas: picture,
        rect: layout.visible,
        mat: assessing ? assessMatPx(layout.frame.w, layout.frame.h, border / 100) : 0,
      });
    };
  }, [pictureCanvas]);

  // Crossfade the canvas whenever the hover preview turns on, off, or switches
  // to another preset, so the look eases in/out instead of snapping.
  const previewParams = useDevelopStore((s) => s.previewParams);
  const openZoom = useSettings((s) => s.developOpenZoom);
  const assessBorderPct = useSettings((s) => s.assessBorderPct);
  const [fadeToken, setFadeToken] = useState(0);
  const fadeInit = useRef(false);
  useEffect(() => {
    if (!fadeInit.current) {
      fadeInit.current = true;
      return;
    }
    setFadeToken((t) => t + 1);
  }, [previewParams]);

  // An extension's on-image tool holding the canvas (canvas-tool.ts): crop mode,
  // Guided Upright's lines.
  const canvasTool = useCanvasToolStore((s) => s.held?.tool ?? null);
  const canvasToolOwner = useCanvasToolStore((s) => s.held?.owner ?? null);
  const colorAssessment = useDevelopStore((s) => s.colorAssessment);
  // While a pan/zoom gesture key is held, force the extension-overlay slot
  // click-through (global passthrough — see canvas-gesture + ViewportImage).
  const overlayPassthrough = useCanvasGesture((s) => s.zoomGesture);
  const pickDrag = usePickDragStore((s) => s.held?.tool ?? null);
  const pickDragOwner = usePickDragStore((s) => s.held?.owner ?? null);

  // The eyedropper's convergence loop and extensions probe by canvas point
  // (canvas-probe.ts).
  useEffect(
    () =>
      lendCanvasProbe(({ x, y }) =>
        width > 0 && height > 0 ? getRenderBridge().probe(x / width, y / height, "output") : Promise.resolve(null),
      ),
    [width, height],
  );

  // An extension's pick-drag tool (pick-drag.ts): the press, then the colour the
  // view shows there, then the drag. Counts presses and releases: a probe
  // answers after the press that asked, so it only starts the drag if that press
  // is still the latest and has not been released.
  const pickPress = useRef(0);
  const pickDragging = useRef(false);
  const onPickDrag = useMemo(() => {
    if (!pickDrag || !pickDragOwner || canvasTool) return null;
    const tool = guardedPickDrag(pickDragOwner, pickDrag);
    // The linear colour the output stage gives the buffer pixel (bx, by), read from
    // the worker's live frame; null when it has none.
    const probeOutput = (bx: number, by: number) =>
      width > 0 && height > 0
        ? getRenderBridge().probe(bx / width, by / height, "output")
        : Promise.resolve(null);
    return {
      onDown: async (bx: number, by: number) => {
        const press = ++pickPress.current;
        tool.onPress({ x: bx, y: by });
        if (!pickDrag.onDown) return;
        const rgb = await probeOutput(bx, by).catch(() => null);
        if (!rgb || !pickDrag.onDown || press !== pickPress.current) return;
        pickDragging.current = true;
        tool.onDown(rgb, { x: bx, y: by });
      },
      onMove: (bx: number, by: number) => {
        if (pickDragging.current) tool.onMove({ x: bx, y: by });
      },
      onUp: () => {
        pickPress.current++;
        if (!pickDragging.current) return;
        pickDragging.current = false;
        tool.onUp();
      },
    };
  }, [pickDrag, pickDragOwner, canvasTool, width, height]);

  // Use the real decoded source aspect (upright) when available, so aspect-locked
  // crops match the pixels on screen even when stored metadata is transposed by
  // a decode path that orients differently (see use-develop-renderer). Falls back
  // to metadata until the first frame decodes.
  const imageAspect =
    sourceWidth > 0 && sourceHeight > 0
      ? sourceWidth / sourceHeight
      : photo.height > 0
        ? photo.width / photo.height
        : 1;

  // The photo's geometry as the geometry stage derives it (photo-geometry.ts): the
  // crop, and the transformed image to the source and back. Read in the selector,
  // so a params change that leaves the geometry be hands back the same object;
  // re-read on every render too, so installing Crop & Straighten (processingStages
  // above) maps through it at once.
  const geometry = useDevelopStore((s) => photoGeometry(s.params, imageAspect));
  const crop = geometry.region;
  const invRaw = geometry.inverse;
  const forwardRaw = geometry.forward;

  // Mapping helpers handed to develop-canvas-overlay extensions, so interactive
  // marks anchored to the image stay correct through zoom/pan/crop/straighten —
  // the same source-UV <-> screen mapping the built-in mask/heal overlay uses.
  const overlayState = useMemo(() => {
    const ir = overlayImageRect;
    if (!ir) {
      return {
        rect: overlayRect, imageRect: null, nonce: overlayNonce,
        toScreen: null, toImage: null, radiusToScreen: null, radiusToImage: null,
        region: null, imageAspect,
      };
    }
    // Through the region the canvas shows: crop mode shows the whole image past the
    // crop, and a slow frame can still show the one before.
    const shown = bufferCrop ?? crop;
    return {
      rect: overlayRect,
      imageRect: ir,
      nonce: overlayNonce,
      region: shown,
      imageAspect,
      toScreen: (u: number, v: number) => {
        const t = mat3Apply(forwardRaw, u, v);
        const ox = (t.x - shown.x) / shown.width;
        const oy = (t.y - shown.y) / shown.height;
        return { x: ir.x + ox * ir.w, y: ir.y + oy * ir.h };
      },
      toImage: (px: number, py: number) => {
        const ox = (px - ir.x) / ir.w;
        const oy = (py - ir.y) / ir.h;
        return mat3Apply(invRaw, shown.x + ox * shown.width, shown.y + oy * shown.height);
      },
      radiusToScreen: (r: number) => (r / shown.height) * ir.h,
      radiusToImage: (px: number) => (px / ir.h) * shown.height,
    };
  }, [overlayRect, overlayImageRect, overlayNonce, crop, bufferCrop, geometry, imageAspect]);

  const toolOverlay = useMemo(
    () =>
      canvasTool && canvasToolOwner
        ? (rect: OverlayRect) => (
            <DevelopOverlayProvider value={overlayState}>
              <ErrorBoundary
                key={boundaryKey(canvasToolOwner, canvasTool.overlay)}
                what={`Canvas tool "${canvasToolOwner}"`}
                className="text-[11px] text-danger"
              >
                <canvasTool.overlay rect={rect} />
              </ErrorBoundary>
            </DevelopOverlayProvider>
          )
        : undefined,
    [canvasTool, canvasToolOwner, overlayState],
  );

  if (!supported) {
    return (
      <div className="flex flex-col items-center gap-2 text-center text-text-muted">
        {photo.thumbnailUrl && (
          <img
            src={photo.thumbnailUrl}
            alt={photo.filename}
            className="max-h-[80vh] max-w-full object-contain opacity-80"
          />
        )}
        <p className="text-xs">Can't show edits on this computer. Showing the unedited preview.</p>
        {availabilityReason && <p className="text-[10px]">Reason: {availabilityReason}</p>}
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
    {stalled && (
      <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
        <div className="max-w-md rounded bg-surface-2 px-3 py-2 text-center text-xs text-text-muted">
          {noWebGL2 ? (
            <>
              <p className="break-words" title={graphicsUnavailableDetail(graphicsReason)}>
                {GRAPHICS_UNAVAILABLE}
              </p>
              <p className="mt-1 text-[10px]">{GRAPHICS_STILL_WORKS}</p>
            </>
          ) : (
            <>
              <p>
                {availability === "failed"
                  ? "Can't show images right now. Restart Safelight."
                  : availability === "unresponsive"
                    ? "The graphics engine isn't responding. Waiting for it…"
                    : availability === "lost"
                      ? "The graphics engine was reset. Waiting for it…"
                      : "Can't show images right now. Trying again…"}
              </p>
              {availabilityReason && (
                <p className="mt-1 break-words text-[10px]">Reason: {availabilityReason}</p>
              )}
            </>
          )}
        </div>
      </div>
    )}
    {notice && (
      <div className="pointer-events-none absolute inset-x-0 top-2 z-10 flex justify-center">
        <p className="rounded bg-surface-2 px-3 py-2 text-xs text-text-muted">{notice}</p>
      </div>
    )}
    <ViewportImage
      canvasRef={canvasRef}
      fadeCanvasRef={fadeCanvasRef}
      bufferWidth={width}
      bufferHeight={height}
      bufferWindow={bufferWindow}
      imageWidth={wholeWidth}
      imageHeight={wholeHeight}
      zoom={zoom}
      onZoomChange={onZoomChange}
      onViewport={setViewport}
      onLayout={handleLayout}
      colorAssessment={colorAssessment}
      assessBorder={assessBorderPct / 100}
      status={status}
      resetKey={photo.id}
      initialZoom={openZoom === "100" ? 1 : null}
      fadeToken={fadeToken}
      overlayZoomable={!!canvasTool?.zoomable}
      onPickDrag={onPickDrag}
      overlay={toolOverlay}
    />
      {/* The photo before, where it showed, until this photo's first picture. Placed
          and sized by canvas-handover; hidden until then. */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <canvas
          ref={handoverRef}
          data-handover=""
          aria-hidden
          style={{ position: "absolute", display: "none", pointerEvents: "none" }}
        />
      </div>
      {/* Extension overlay layer (e.g. before/after split). Click-through by
          default; interactive children opt back in via pointerEvents. While a
          zoom-gesture key (Ctrl/⌘/Space) is held, the whole subtree is forced
          click-through so pan/zoom underneath works under ANY extension overlay
          — the global passthrough trait, so extensions don't each re-implement it.
          A held canvas tool's overlay stacks above this layer (ViewportImage). */}
      <DevelopOverlayProvider value={overlayState}>
        <div
          className={
            overlayPassthrough
              ? "canvas-overlay-passthrough absolute inset-0"
              : "pointer-events-none absolute inset-0"
          }
        >
          <Slot name="develop-canvas-overlay" />
        </div>
      </DevelopOverlayProvider>
    </div>
  );
}
