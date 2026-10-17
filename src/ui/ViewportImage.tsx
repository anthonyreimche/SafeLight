// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  comboFromWheelEvent,
  getBinding,
  isEditableTarget,
  shortcutsSuspended,
} from "@/state/keybindings-store";
import { resolveCursorCss, useCanvasCursor } from "@/state/cursor-store";
import { useCanvasGesture, setCanvasZoomGesture } from "@/state/canvas-gesture";
import { registerViewportZoomCommands } from "@/state/viewport-zoom-commands";
import { snapshotCrossfade } from "@/ui/canvas-crossfade";
import { frameLocalPoint } from "@/ui/frame-point";
import { reducedMotion } from "@/ui/reduced-motion";
import {
  clampView,
  easeOutCubic,
  interpolateView,
  placeBuffer,
  viewWindow,
  type ImageWindow,
  type View,
} from "@/ui/viewport-view";

interface ViewportImageProps {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  // The crossfade overlay, laid over the canvas with its placement. The develop
  // renderer fades its tiers on it too.
  fadeCanvasRef: RefObject<HTMLCanvasElement | null>;
  bufferWidth: number; // rendered buffer size, in px
  bufferHeight: number;
  // The window of the image the buffer holds, normalized (the develop renderer's
  // zoom window); null or absent, the whole image. The canvas is placed by it, so a
  // buffer drawn for another view shows where its pixels belong in this one.
  bufferWindow?: ImageWindow | null;
  zoom: number | null; // null = fit; number = scale (1 = 100% of buffer)
  onZoomChange: (zoom: number | null) => void;
  // A short word on what the image shows (e.g. "Preview"), in the frame's corner.
  status?: string | null;
  resetKey?: string; // changing this snaps back to the initial zoom (e.g. a new photo)
  // Zoom a fresh photo (resetKey change) opens at. null = fit (default); a number
  // = that scale (1 = 100%). Lets the Develop loupe honor the user's preference.
  initialZoom?: number | null;
  // When provided, the viewport renders this overlay on top, given the displayed
  // image rect in frame coordinates. By default an overlay forces a static fit
  // (crop), but see overlayZoomable.
  overlay?: (rect: { x: number; y: number; w: number; h: number }) => ReactNode;
  // When true (mask/heal overlays), zoom/pan stay active beneath the overlay:
  // Ctrl/⌘+click toggles 100%↔fit at the cursor, Ctrl/⌘ or Space + drag pans,
  // and the overlay turns click-through while the gesture key is held so the
  // zoom/pan controls underneath receive the pointer.
  overlayZoomable?: boolean;
  // When set, a click samples instead of zooming: receives the clicked point in
  // canvas buffer pixels (the WB eyedropper). Cursor becomes a crosshair.
  onPick?: (bufferX: number, bufferY: number) => void;
  // For HSL picker: drag-based picking that receives pointer events.
  // Called on pointer down, move (while dragging), and up.
  onPickDrag?: {
    onDown: (bufferX: number, bufferY: number) => void;
    onMove: (bufferX: number, bufferY: number) => void;
    onUp: () => void;
  } | null;
  // When provided, zoomed views render only the visible window at screen
  // resolution (crisp 1:1 from the resident full-res source) instead of CSS-
  // upscaling the fit buffer. Called with the window in normalized image coords
  // and the device-pixel output size; null returns to the whole-frame fit render.
  // Fit mode (zoom == null) is unaffected.
  onViewport?: (
    roi: { x: number; y: number; w: number; h: number } | null,
    outW: number,
    outH: number,
  ) => void;
  // Bump this number to crossfade the displayed frame: the current canvas pixels
  // are snapshotted and faded out over the freshly-rendered frame beneath. Used
  // for the Presets hover preview so the look eases in/out instead of snapping.
  fadeToken?: number;
  // Reports where the image pixels are actually shown on screen, in frame-local
  // coords, whenever the fit/zoom/pan layout changes. Lets a sibling overlay
  // (e.g. a before/after split) align to the displayed image. `visible` is where
  // the displayed pixels sit (the window fills the frame in ROI-zoom mode);
  // `image` is where the FULL image sits (extends past the frame when zoomed),
  // which interactive image-anchored overlays map against. `frame` is the
  // viewport's own size.
  onLayout?: (
    visible: { x: number; y: number; w: number; h: number },
    image: { x: number; y: number; w: number; h: number },
    frame: { w: number; h: number },
  ) => void;
  // ISO 12646 color-assessment mode: frame the displayed image in brilliant
  // white (a paper-white reference). The surround grey is set by the parent.
  colorAssessment?: boolean;
  // Width of the color-assessment mat as a fraction of the smaller viewport
  // dimension (resolution-independent). Defaults to 0.045 (4.5%).
  assessBorder?: number;
}

const DRAG_THRESHOLD = 4; // px of movement before a press counts as a pan

// Wheel / keyboard zoom. The rebindable gesture is the viewport.wheelZoom
// action (default: bare Wheel); Ctrl/⌘+Wheel stays fixed on top — it's how
// Chromium encodes a trackpad pinch, and Ctrl/⌘ already means pan/zoom
// passthrough, which keeps wheel zoom reachable under extension overlays.
const WHEEL_ZOOM_ACTION = "viewport.wheelZoom";
const ZOOM_STEP = 1.25; // per keyboard step and per classic wheel notch (100 px)
const MAX_ZOOM = 2; // the status bar's 200% top stop
const FIT_SNAP = 1.0001; // a zoom-out landing within this of fit snaps to fit
const ZOOM_MS = 150; // a zoom eases from the view on screen to its target
// Wheel input under this per frame (a trackpad pinch, precision scrolling) streams
// its own motion, so it zooms at once.
const WHEEL_EASE_MIN = 50;

/** Width in px of the colour-assessment mat for a viewport of `frameW`×`frameH`,
 *  `assessBorder` being its share of the smaller side. */
export function assessMatPx(frameW: number, frameH: number, assessBorder: number): number {
  return Math.max(2, Math.round(Math.min(frameW, frameH) * assessBorder));
}

// An interactive image viewport. The GL canvas keeps its buffer resolution; we
// position and scale it with a CSS transform. The zoom level is owned by the
// parent (so its controls can live in the status bar); panning offset is local.
// Default "fit" letterboxes the whole image; clicking zooms to 100% anchored at
// the cursor, dragging pans, clicking again returns to fit.
export function ViewportImage({
  canvasRef,
  fadeCanvasRef,
  bufferWidth,
  bufferHeight,
  bufferWindow = null,
  zoom,
  onZoomChange,
  status,
  resetKey,
  initialZoom = null,
  overlay,
  overlayZoomable,
  onPick,
  onPickDrag,
  onViewport,
  fadeToken,
  onLayout,
  colorAssessment,
  assessBorder = 0.045,
}: ViewportImageProps) {
  // A crop overlay locks the view to fit; a mask/heal overlay (overlayZoomable)
  // keeps the zoom/pan machinery live underneath it.
  const staticFit = !!overlay && !overlayZoomable;
  const frameRef = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState({ w: 0, h: 0 });
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  // Whether the pointer is currently over the displayed image (vs. the surround),
  // so the cursor can show zoom over the image and a plain pointer elsewhere.
  const [hoverImage, setHoverImage] = useState(false);
  // True while a zoom-gesture key (Ctrl/⌘ or Space) is held. Shared via a store
  // so the extension-overlay slot can go click-through too — that's what makes
  // Ctrl/Space pan & zoom work under ANY extension overlay (global passthrough).
  // Used here to make the built-in overlay click-through and to let a gesture key
  // hand a tool drag (e.g. the HSL picker) back to pan/zoom.
  const zoomGesture = useCanvasGesture((s) => s.zoomGesture);

  // The view drawn eases from the view on screen to the target after each zoom
  // change. `snapRef` marks the next zoom change as one that shows at once.
  const animRef = useRef<{ from: View; start: number } | null>(null);
  const snapRef = useRef(false);
  const zoomSeenRef = useRef(zoom);
  const drawnRef = useRef<View | null>(null);
  const [, setTick] = useState(0);

  // A new image starts at the initial zoom (fit by default), centered, without
  // easing there from the image before.
  useEffect(() => {
    setOffset({ x: 0, y: 0 });
    animRef.current = null;
    if (zoom !== initialZoom) snapRef.current = true;
    onZoomChange(initialZoom);
    // onZoomChange is a stable setter; zoom and initialZoom are read at reset time only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  // Track the frame's pixel size.
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setFrame({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Logical full-image buffer dims: the size of the last buffer that held the whole
  // image. A window buffer (the develop renderer's zoom) holds only part of it, so
  // pan/zoom math keeps the dims of the last whole one, whatever the zoom.
  const fitBufferRef = useRef({ w: 0, h: 0 });
  if (!bufferWindow && bufferWidth > 0 && bufferHeight > 0) {
    fitBufferRef.current = { w: bufferWidth, h: bufferHeight };
  }
  // Stable full-image dims: the dims captured from a whole buffer, falling back to
  // the live buffer until the first one lands.
  const logicalW = fitBufferRef.current.w > 0 ? fitBufferRef.current.w : bufferWidth;
  const logicalH = fitBufferRef.current.h > 0 ? fitBufferRef.current.h : bufferHeight;

  const hasImage = logicalW > 0 && logicalH > 0 && frame.w > 0 && frame.h > 0;

  // Color-assessment mat: a brilliant-white band hugging the image. In fit mode
  // we shrink the image to leave room for the band inside the frame, so "Assess"
  // frames the whole image plus its white surround. Computed up front so the fit
  // scale can reserve the border.
  const matBorder = assessMatPx(frame.w, frame.h, assessBorder);
  // An empty buffer (the canvas cleared for the next photo) has nothing to frame.
  const showMat = !!colorAssessment && hasImage && bufferWidth > 0 && bufferHeight > 0;
  const fitInset = showMat && zoom == null ? matBorder : 0;

  const fitScale = hasImage
    ? Math.min((frame.w - fitInset * 2) / logicalW, (frame.h - fitInset * 2) / logicalH)
    : 1;
  // The image fully covers the frame only at/above the cover scale. ROI render
  // fills the frame edge-to-edge, so it's valid only there; below it (a zoom-out
  // past fit) we letterbox with a CSS scale instead — otherwise the window is
  // stretched to the frame's aspect ratio and the image deforms.
  const coverScale = hasImage
    ? Math.max(frame.w / logicalW, frame.h / logicalH)
    : 1;

  // The renderer is asked for the zoom window, drawn crisp from the resident
  // full-res source, only while the image covers the frame; below cover (a zoom-out
  // past fit) it renders the whole image.
  const windowed =
    !staticFit && zoom != null && !!onViewport && zoom >= coverScale - 1e-3;

  const image = { w: logicalW, h: logicalH };

  const centered = (s: number) => ({
    x: (frame.w - logicalW * s) / 2,
    y: (frame.h - logicalH * s) / 2,
  });

  const clampOffset = (o: { x: number; y: number }, s: number) => {
    const v = clampView({ scale: s, x: o.x, y: o.y }, frame, image);
    return { x: v.x, y: v.y };
  };

  // The target view: where the zoom and pan put the image.
  const effScale = staticFit ? fitScale : (zoom ?? fitScale);
  const effOffset =
    staticFit || zoom == null ? centered(fitScale) : clampOffset(offset, zoom);
  const targetView: View = { scale: effScale, x: effOffset.x, y: effOffset.y };

  // A zoom change eases from the view drawn last; pans, resizes and a locked fit
  // move the target alone, which the view drawn follows at once (or mid-ease).
  if (zoomSeenRef.current !== zoom) {
    zoomSeenRef.current = zoom;
    const from = drawnRef.current;
    animRef.current =
      from && hasImage && !staticFit && !snapRef.current && !reducedMotion()
        ? { from, start: performance.now() }
        : null;
    snapRef.current = false;
  }
  // A view locked to fit (crop) shows it at once, mid-ease or not.
  if (staticFit) animRef.current = null;
  let drawn = targetView;
  const anim = animRef.current;
  if (anim) {
    const t = (performance.now() - anim.start) / ZOOM_MS;
    if (t >= 1) animRef.current = null;
    else drawn = clampView(interpolateView(anim.from, targetView, easeOutCubic(t)), frame, image);
  }
  drawnRef.current = drawn;
  // A zoom-in shows the pixels on screen, scaled up, until it settles, and only then
  // asks for its window: they cover every view on the way. A zoom-out asks at once,
  // so its wider frame comes in time to cover the views it widens through.
  const holdWindow = !!animRef.current && targetView.scale > animRef.current.from.scale;

  useEffect(() => {
    if (!animRef.current) return;
    const id = requestAnimationFrame(() => setTick((n) => n + 1));
    return () => cancelAnimationFrame(id);
  });

  // Where the buffer's pixels sit under the view drawn, and the CSS scale that puts
  // them there from the buffer's own size.
  const placed = placeBuffer(bufferWindow, drawn, image);
  const sx = drawn.scale * (((bufferWindow?.w ?? 1) * logicalW) / (bufferWidth || 1));
  const sy = drawn.scale * (((bufferWindow?.h ?? 1) * logicalH) / (bufferHeight || 1));

  const stateRef = useRef({ zoom, fitScale, effScale, effOffset, drawn, placed, logicalW, logicalH, bufW: bufferWidth, bufH: bufferHeight });
  stateRef.current = { zoom, fitScale, effScale, effOffset, drawn, placed, logicalW, logicalH, bufW: bufferWidth, bufH: bufferHeight };

  // Map a frame-local point to canvas-BUFFER pixels (what samplers index), through
  // where the buffer is placed: the whole image, or the zoom window it holds.
  const frameToBuffer = (fx: number, fy: number) => {
    const { placed: p, bufW, bufH } = stateRef.current;
    return { bx: ((fx - p.x) / p.w) * bufW, by: ((fy - p.y) / p.h) * bufH };
  };

  // Emit the visible window (normalized image coords) + device-pixel output size
  // whenever the zoomed view moves, so the renderer can draw it crisply at 1:1.
  // In fit mode (or without a handler) clear the ROI so the whole frame renders.
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  useEffect(() => {
    if (!onViewport || holdWindow) return;
    if (!windowed || !hasImage) {
      onViewport(null, 0, 0);
      return;
    }
    const roi = viewWindow(
      { scale: effScale, x: effOffset.x, y: effOffset.y },
      { w: frame.w, h: frame.h },
      { w: logicalW, h: logicalH },
    );
    onViewport(roi, Math.round(frame.w * dpr), Math.round(frame.h * dpr));
  }, [holdWindow, windowed, hasImage, effScale, effOffset.x, effOffset.y, frame.w, frame.h, logicalW, logicalH, dpr, onViewport]);

  // Report the on-screen image rect to a sibling overlay: `visible` where the
  // buffer's pixels are placed, `image` where the full image sits in the view drawn.
  useEffect(() => {
    if (!onLayout) return;
    if (!hasImage) return;
    onLayout(
      { x: placed.x, y: placed.y, w: placed.w, h: placed.h },
      { x: drawn.x, y: drawn.y, w: logicalW * drawn.scale, h: logicalH * drawn.scale },
      { w: frame.w, h: frame.h },
    );
  }, [onLayout, hasImage, placed.x, placed.y, placed.w, placed.h, drawn.x, drawn.y, drawn.scale, logicalW, logicalH, frame.w, frame.h]);

  // Recenter on external zoom changes (status-bar buttons). Cursor-anchored
  // zooms set the offset themselves and skip this via the ref.
  const skipRecenterRef = useRef(false);
  useEffect(() => {
    if (skipRecenterRef.current) {
      skipRecenterRef.current = false;
      return;
    }
    if (zoom != null) setOffset(centered(zoom));
    // centered() reads frame/buffer from the latest render closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom]);

  // Toggle 100%↔fit, anchoring the cursor's image point. cx/cy are frame-local.
  // A null point (keyboard zoom with no known cursor) anchors at the centre.
  const zoomToggleAt = (cx: number | null, cy: number | null) => {
    if (zoom == null) {
      const { effScale: s0, effOffset: o0 } = stateRef.current;
      const target = 1;
      const ax = cx ?? frame.w / 2;
      const ay = cy ?? frame.h / 2;
      const px = (ax - o0.x) / s0;
      const py = (ay - o0.y) / s0;
      setOffset(clampOffset({ x: ax - px * target, y: ay - py * target }, target));
      skipRecenterRef.current = true;
      onZoomChange(target);
    } else {
      onZoomChange(null);
    }
  };

  const handleClick = (clientX: number, clientY: number) => {
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Frame-local LAYOUT px (undoes the <body> UI-scale zoom; see frame-point).
    const { x: fx, y: fy } = frameLocalPoint(rect, clientX, clientY);
    // A held gesture key means "pan/zoom", not "sample" — fall through to zoom.
    if (onPick && !zoomGesture) {
      // Only sample the image; a click on the letterbox/surround maps to
      // out-of-image buffer coords, so ignore it.
      if (!pointOnImage(clientX, clientY)) return;
      const { bx, by } = frameToBuffer(fx, fy);
      onPick(bx, by);
      return;
    }
    // Only toggle zoom when the click lands on the displayed image — clicks on
    // the letterbox/surround around a fitted image do nothing.
    if (!pointOnImage(clientX, clientY)) return;
    zoomToggleAt(fx, fy);
  };

  // Absolute-scale zoom anchored at a frame-local point (null = centre). A
  // zoom-out landing at/under the fit scale returns to fit rather than
  // stranding a sub-fit scale. `ease` false shows the zoom at once.
  const zoomTo = (target: number, cx: number | null, cy: number | null, ease = true) => {
    if (!hasImage) return;
    const cur = zoom ?? fitScale;
    const next = Math.min(target, MAX_ZOOM);
    if (next <= cur && next <= fitScale * FIT_SNAP) {
      if (zoom != null) {
        snapRef.current = !ease;
        onZoomChange(null);
      }
      return;
    }
    if (next === cur) return;
    const ax = cx ?? frame.w / 2;
    const ay = cy ?? frame.h / 2;
    const { effScale: s, effOffset: o } = stateRef.current;
    setOffset(
      clampOffset(
        { x: ax - ((ax - o.x) / s) * next, y: ay - ((ay - o.y) / s) * next },
        next,
      ),
    );
    skipRecenterRef.current = true;
    snapRef.current = !ease;
    onZoomChange(next);
  };

  // Keep a fresh closure for the window key listener (mounted once) to call.
  const zoomToggleRef = useRef<(cx: number | null, cy: number | null) => void>(
    () => {},
  );
  zoomToggleRef.current = zoomToggleAt;
  const zoomToRef = useRef(zoomTo);
  zoomToRef.current = zoomTo;
  const onZoomChangeRef = useRef(onZoomChange);
  onZoomChangeRef.current = onZoomChange;
  // Last cursor position over the frame, so a keyboard zoom anchors there.
  const lastPointer = useRef<{ x: number; y: number } | null>(null);
  const frameLocal = () => {
    const r = frameRef.current?.getBoundingClientRect();
    const p = lastPointer.current;
    if (!r || !p) return { x: null, y: null };
    return frameLocalPoint(r, p.x, p.y);
  };

  // Zoom-gesture keys. Space taps toggle zoom (also valid in the plain viewport);
  // in a zoomable overlay, holding Ctrl/⌘ or Space turns the overlay click-
  // through so the pointer drives zoom/pan instead of painting.
  useEffect(() => {
    if (staticFit) return;
    // Gesture keys currently held. The gesture stays live until every one is
    // released, so releasing an unrelated key mid-hold (e.g. a tool shortcut
    // while Space is down) doesn't end the pan/zoom passthrough.
    const held = new Set<string>();
    const syncGesture = () => setCanvasZoomGesture(held.size > 0);
    const onKeyDown = (e: KeyboardEvent) => {
      if (shortcutsSuspended() || isEditableTarget(e.target)) return;
      if (e.code === "Space") {
        e.preventDefault();
        if (!e.repeat) {
          const { x, y } = frameLocal();
          zoomToggleRef.current(x, y);
        }
        held.add("Space");
        syncGesture();
      } else if (e.ctrlKey || e.metaKey) {
        // Ctrl/⌘ held: hand pan/zoom back from whatever tool or extension overlay
        // is capturing the canvas. Applies everywhere (not just the built-in
        // zoomable overlays) so every extension overlay gets passthrough for free.
        held.add(e.metaKey ? "Meta" : "Control");
        syncGesture();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") held.delete("Space");
      if (!e.ctrlKey) held.delete("Control");
      if (!e.metaKey) held.delete("Meta");
      syncGesture();
    };
    const onMove = (e: MouseEvent) => {
      lastPointer.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("mousemove", onMove, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("mousemove", onMove, true);
      setCanvasZoomGesture(false);
    };
  }, [staticFit, overlayZoomable]);

  // Wheel zoom, cursor-anchored: the rebindable viewport.wheelZoom gesture
  // plus fixed Ctrl/⌘+wheel (see WHEEL_ZOOM_ACTION). Native non-passive
  // listener — React's onWheel is passive, and a handled wheel must
  // preventDefault or Ctrl+wheel browser-zooms the page. Deltas coalesce to
  // one zoom per frame, like panning. Speed-Edit-style scrub extensions
  // capture wheel on window and stopPropagation while their key is held, so
  // they keep priority without any coordination here.
  useEffect(() => {
    const el = frameRef.current;
    if (!el || staticFit) return;
    let raf: number | null = null;
    let acc = 0;
    let anchor: { x: number; y: number } | null = null;
    const flush = () => {
      raf = null;
      const d = acc;
      acc = 0;
      if (d === 0) return;
      const st = stateRef.current;
      const cur = st.zoom ?? st.fitScale;
      zoomToRef.current(
        cur * Math.pow(ZOOM_STEP, -d / 100),
        anchor?.x ?? null,
        anchor?.y ?? null,
        Math.abs(d) >= WHEEL_EASE_MIN,
      );
    };
    const onWheel = (e: WheelEvent) => {
      const fixedGesture = e.ctrlKey || e.metaKey;
      if (!fixedGesture && comboFromWheelEvent(e) !== getBinding(WHEEL_ZOOM_ACTION))
        return;
      e.preventDefault();
      let d = e.deltaY;
      if (e.deltaMode === 1) d *= 16; // lines → ~px
      else if (e.deltaMode === 2) d *= 120; // pages → ~notches
      acc += d;
      anchor = frameLocalPoint(el.getBoundingClientRect(), e.clientX, e.clientY);
      if (raf == null) raf = requestAnimationFrame(flush);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      el.removeEventListener("wheel", onWheel);
      if (raf != null) cancelAnimationFrame(raf);
    };
  }, [staticFit]);

  // Publish keyboard zoom commands (the Ctrl+=/−/0/1 quartet, dispatched by
  // use-keyboard-shortcuts) while this viewport is on screen and not locked
  // to a static fit. Keyboard zooms anchor at the last cursor position.
  useEffect(() => {
    if (staticFit) return;
    return registerViewportZoomCommands({
      zoomStep: (dir) => {
        const st = stateRef.current;
        const cur = st.zoom ?? st.fitScale;
        const { x, y } = frameLocal();
        zoomToRef.current(cur * (dir > 0 ? ZOOM_STEP : 1 / ZOOM_STEP), x, y);
      },
      zoomFit: () => {
        if (stateRef.current.zoom != null) onZoomChangeRef.current(null);
      },
      zoom100: () => {
        const { x, y } = frameLocal();
        zoomToRef.current(1, x, y);
      },
    });
    // frameLocal reads only refs; a stale closure of it is equivalent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [staticFit]);

  const downRef = useRef<{
    x: number;
    y: number;
    ox: number;
    oy: number;
    moved: boolean;
  } | null>(null);

  // Coalesce pan updates to one setOffset per animation frame. Pointer moves can
  // fire faster than the display refresh (high-Hz mice/trackpads), and each
  // setState forces a synchronous render — so without this a fast drag thrashes
  // React and the pan stutters.
  const panRaf = useRef<number | null>(null);
  const pendingOffset = useRef<{ x: number; y: number } | null>(null);
  const flushPan = () => {
    panRaf.current = null;
    if (pendingOffset.current) {
      setOffset(pendingOffset.current);
      pendingOffset.current = null;
    }
  };
  useEffect(() => () => {
    if (panRaf.current != null) cancelAnimationFrame(panRaf.current);
  }, []);

  // Crossfade: when fadeToken changes, fade the current frame out over the new
  // frame the renderer draws underneath.
  const seenFadeToken = useRef(fadeToken);
  useLayoutEffect(() => {
    if (fadeToken == null || fadeToken === seenFadeToken.current) return;
    seenFadeToken.current = fadeToken;
    const src = canvasRef.current;
    const dst = fadeCanvasRef.current;
    if (src && dst) snapshotCrossfade(src, dst, 220);
  }, [fadeToken, canvasRef, fadeCanvasRef]);

  // Track drag picking state
  const pickDragRef = useRef<{ active: boolean }>({ active: false });

  const onPointerDown = (e: ReactPointerEvent) => {
    // Drag picking mode (HSL picker). A held gesture key (Ctrl/⌘/Space) hands the
    // drag back to pan/zoom, so the picker no longer locks you out of panning a
    // zoomed image — it falls through to the pan path below.
    if (onPickDrag && !overlay && e.button === 0 && !zoomGesture) {
      const rect = frameRef.current?.getBoundingClientRect();
      // Only start a pick on the image; a press on the surround maps to
      // out-of-image buffer coords.
      if (rect && pointOnImage(e.clientX, e.clientY)) {
        const { x: fx, y: fy } = frameLocalPoint(rect, e.clientX, e.clientY);
        const { bx, by } = frameToBuffer(fx, fy);
        pickDragRef.current.active = true;
        onPickDrag.onDown(bx, by);
        frameRef.current?.setPointerCapture(e.pointerId);
      }
      return;
    }

    // Mask/heal pointer events bubble up from the overlay; only hijack them for
    // pan/zoom while a gesture key is held (otherwise the tool owns the drag).
    if (staticFit || (overlayZoomable && !zoomGesture) || e.button !== 0) return;
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect) return;
    frameRef.current?.setPointerCapture(e.pointerId);
    // Store the down point in frame-local LAYOUT px so pan deltas stay in the
    // same space as the offset under any UI-scale zoom (see frame-point.ts).
    const { x: fx, y: fy } = frameLocalPoint(rect, e.clientX, e.clientY);
    downRef.current = {
      x: fx,
      y: fy,
      ox: stateRef.current.effOffset.x,
      oy: stateRef.current.effOffset.y,
      moved: false,
    };
  };

  // Test whether a frame-local point falls on the displayed image rect.
  const pointOnImage = (clientX: number, clientY: number) => {
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect) return false;
    const { x: fx, y: fy } = frameLocalPoint(rect, clientX, clientY);
    const { drawn: v, logicalW: iw, logicalH: ih } = stateRef.current;
    return fx >= v.x && fx <= v.x + iw * v.scale && fy >= v.y && fy <= v.y + ih * v.scale;
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    setHoverImage(pointOnImage(e.clientX, e.clientY));

    // Drag picking mode
    if (pickDragRef.current.active && onPickDrag) {
      const rect = frameRef.current?.getBoundingClientRect();
      if (rect) {
        const { x: fx, y: fy } = frameLocalPoint(rect, e.clientX, e.clientY);
        const { bx, by } = frameToBuffer(fx, fy);
        onPickDrag.onMove(bx, by);
      }
      return;
    }

    const d = downRef.current;
    if (!d) return;
    // d.x/d.y are frame-local LAYOUT px; convert the move the same way so the
    // pan delta matches the offset space under any UI-scale zoom.
    const rect = frameRef.current?.getBoundingClientRect();
    const moveLocal = rect
      ? frameLocalPoint(rect, e.clientX, e.clientY)
      : { x: e.clientX, y: e.clientY };
    const dx = moveLocal.x - d.x;
    const dy = moveLocal.y - d.y;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) {
      d.moved = true;
      if (zoom != null) setDragging(true);
    }
    if (d.moved && zoom != null) {
      pendingOffset.current = clampOffset({ x: d.ox + dx, y: d.oy + dy }, zoom);
      if (panRaf.current == null) panRaf.current = requestAnimationFrame(flushPan);
    }
  };

  const onPointerUp = (e: ReactPointerEvent) => {
    // Drag picking mode
    if (pickDragRef.current.active) {
      pickDragRef.current.active = false;
      onPickDrag?.onUp();
      return;
    }

    const d = downRef.current;
    downRef.current = null;
    setDragging(false);
    if (panRaf.current != null) {
      cancelAnimationFrame(panRaf.current);
      flushPan();
    }
    if (!d || d.moved) return;
    handleClick(e.clientX, e.clientY);
  };

  // A pointercancel (touch interrupted, capture lost, OS gesture) leaves no
  // up event, so clear all gesture state and hand the pick its up — otherwise
  // a stuck downRef pans on hover and the picker never releases.
  const onPointerCancel = () => {
    if (pickDragRef.current.active) {
      pickDragRef.current.active = false;
      onPickDrag?.onUp();
    }
    downRef.current = null;
    setDragging(false);
    if (panRaf.current != null) {
      cancelAnimationFrame(panRaf.current);
      panRaf.current = null;
      pendingOffset.current = null;
    }
  };

  // The canvas's own cursor intent, as a semantic token (see cursor-store).
  const baseToken = onPick || onPickDrag
    ? hoverImage
      ? "pick"
      : "default"
    : staticFit
      ? "default"
      : dragging
        ? "panning"
        : !hoverImage
          ? "default"
          : zoom == null
            ? "zoom-in"
            : "zoom-out";

  // An extension tool can drive the canvas cursor, but a live built-in gesture
  // (active pan/pick) or a locked crop view always keeps its own cursor so a
  // passive tool cursor never fights a gesture in progress.
  const extCursor = useCanvasCursor();
  const baseOwns = dragging || staticFit || !!onPick || !!onPickDrag;
  const cursor = baseOwns
    ? resolveCursorCss(baseToken)
    : extCursor ?? resolveCursorCss(baseToken);

  // The canvas keeps its buffer size and is moved and scaled to where the image
  // region it holds sits in the view drawn: the whole image letterboxed or zoomed,
  // or the zoom window filling the frame. A buffer drawn for another view shows
  // its pixels where they belong in this one, softer until the renderer catches up.
  const canvasStyle: CSSProperties = {
    position: "absolute",
    left: 0,
    top: 0,
    width: bufferWidth || 1,
    height: bufferHeight || 1,
    transformOrigin: "0 0",
    transform: `translate(${placed.x}px, ${placed.y}px) scale(${sx === sy ? sx : `${sx}, ${sy}`})`,
    willChange: "transform",
  };

  // Color-assessment white mat: a brilliant-white band hugging the image in the
  // view drawn, painted behind the canvas. Zoomed past the frame, it sits outside
  // it. Border scales with the viewport, clamped to sane bounds.
  const display = { x: drawn.x, y: drawn.y, w: logicalW * drawn.scale, h: logicalH * drawn.scale };

  return (
    <div
      ref={frameRef}
      className="relative h-full w-full overflow-hidden"
      style={{ cursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerLeave={() => setHoverImage(false)}
    >
      {showMat && (
        <div
          aria-hidden
          style={{
            position: "absolute",
            left: display.x - matBorder,
            top: display.y - matBorder,
            width: display.w + matBorder * 2,
            height: display.h + matBorder * 2,
            background: "#ffffff",
            pointerEvents: "none",
          }}
        />
      )}
      <canvas ref={canvasRef} style={canvasStyle} />

      {/* Crossfade overlay: holds the previous frame and fades to reveal the new
          one. Same transform as the canvas so it stays aligned; click-through.
          Resting opacity 0. The fadeToken effect above drives a fade on it, and so
          does the develop renderer's paint, between tiers of the open photo. */}
      <canvas
        ref={fadeCanvasRef}
        aria-hidden
        style={{ ...canvasStyle, opacity: 0, pointerEvents: "none" }}
      />

      {/* While a zoom-gesture key is held, the overlay turns click-through so
          the pointer drives pan/zoom instead of the mask/heal tool. */}
      {overlay && (
        <div
          className="absolute inset-0"
          style={{
            pointerEvents: overlayZoomable && zoomGesture ? "none" : undefined,
          }}
        >
          {overlay({
            // Where the FULL image sits in the view drawn, in frame coords: the
            // full-image dims, never a zoom window's buffer — else overlay coords
            // (masks, heal) drift with zoom.
            x: drawn.x,
            y: drawn.y,
            w: logicalW * drawn.scale,
            h: logicalH * drawn.scale,
          })}
          {/* overlay rect = full image region in frame coords */}
        </div>
      )}

      {status && (
        <div className="absolute bottom-2 left-2 text-[10px] text-text-muted">
          {status}
        </div>
      )}
    </div>
  );
}
