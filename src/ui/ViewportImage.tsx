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
import { isEditableTarget, shortcutsSuspended } from "@/state/keybindings-store";
import { resolveCursorCss, useCanvasCursor } from "@/state/cursor-store";

interface ViewportImageProps {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  bufferWidth: number; // rendered buffer size, in px
  bufferHeight: number;
  zoom: number | null; // null = fit; number = scale (1 = 100% of buffer)
  onZoomChange: (zoom: number | null) => void;
  loading?: boolean;
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
  // which interactive image-anchored overlays map against.
  onLayout?: (
    visible: { x: number; y: number; w: number; h: number },
    image: { x: number; y: number; w: number; h: number },
  ) => void;
  // ISO 12646 color-assessment mode: frame the displayed image in brilliant
  // white (a paper-white reference). The surround grey is set by the parent.
  colorAssessment?: boolean;
  // Width of the color-assessment mat as a fraction of the smaller viewport
  // dimension (resolution-independent). Defaults to 0.045 (4.5%).
  assessBorder?: number;
}

const DRAG_THRESHOLD = 4; // px of movement before a press counts as a pan

// An interactive image viewport. The GL canvas keeps its buffer resolution; we
// position and scale it with a CSS transform. The zoom level is owned by the
// parent (so its controls can live in the status bar); panning offset is local.
// Default "fit" letterboxes the whole image; clicking zooms to 100% anchored at
// the cursor, dragging pans, clicking again returns to fit.
export function ViewportImage({
  canvasRef,
  bufferWidth,
  bufferHeight,
  zoom,
  onZoomChange,
  loading,
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
  // True while a zoom-gesture key (Ctrl/⌘ or Space) is held. Used to make a
  // zoomable overlay click-through so the pointer reaches the pan/zoom layer.
  const [zoomGesture, setZoomGesture] = useState(false);

  // A new image starts at the initial zoom (fit by default), centered.
  useEffect(() => {
    setOffset({ x: 0, y: 0 });
    onZoomChange(initialZoom);
    // onZoomChange is a stable setter; initialZoom is read at reset time only.
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

  // Logical full-image buffer dims. In fit mode the worker renders the whole
  // image so this equals the live buffer; in ROI-zoom mode the live buffer holds
  // only the window, so pan/zoom math reuses the dims captured during fit.
  const fitBufferRef = useRef({ w: 0, h: 0 });
  if (zoom == null && bufferWidth > 0 && bufferHeight > 0) {
    fitBufferRef.current = { w: bufferWidth, h: bufferHeight };
  }
  // Stable full-image dims: the dims captured during fit, falling back to the
  // live buffer until the first fit render lands.
  const logicalW = fitBufferRef.current.w > 0 ? fitBufferRef.current.w : bufferWidth;
  const logicalH = fitBufferRef.current.h > 0 ? fitBufferRef.current.h : bufferHeight;

  const hasImage = logicalW > 0 && logicalH > 0 && frame.w > 0 && frame.h > 0;

  // Color-assessment mat: a brilliant-white band hugging the image. In fit mode
  // we shrink the image to leave room for the band inside the frame, so "Assess"
  // frames the whole image plus its white surround. Computed up front so the fit
  // scale can reserve the border.
  const matBorder = Math.max(2, Math.round(Math.min(frame.w, frame.h) * assessBorder));
  const showMat = !!colorAssessment && hasImage;
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

  // ROI zoom: render just the visible window from the resident full-res source,
  // but only while the image covers the frame; below cover we render whole-frame.
  const roiMode =
    !staticFit && zoom != null && !!onViewport && zoom >= coverScale - 1e-3;

  const imgW = roiMode ? logicalW : bufferWidth;
  const imgH = roiMode ? logicalH : bufferHeight;

  const centered = (s: number) => ({
    x: (frame.w - imgW * s) / 2,
    y: (frame.h - imgH * s) / 2,
  });

  const clampOffset = (o: { x: number; y: number }, s: number) => {
    const iw = imgW * s;
    const ih = imgH * s;
    const x =
      iw <= frame.w
        ? (frame.w - iw) / 2
        : Math.min(0, Math.max(frame.w - iw, o.x));
    const y =
      ih <= frame.h
        ? (frame.h - ih) / 2
        : Math.min(0, Math.max(frame.h - ih, o.y));
    return { x, y };
  };

  const effScale = staticFit ? fitScale : (zoom ?? fitScale);
  const effOffset =
    staticFit || zoom == null ? centered(fitScale) : clampOffset(offset, zoom);

  const stateRef = useRef({ effScale, effOffset, imgW, imgH });
  stateRef.current = { effScale, effOffset, imgW, imgH };

  // Emit the visible window (normalized image coords) + device-pixel output size
  // whenever the zoomed view moves, so the renderer can draw it crisply at 1:1.
  // In fit mode (or without a handler) clear the ROI so the whole frame renders.
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  useEffect(() => {
    if (!onViewport) return;
    if (!roiMode || !hasImage) {
      onViewport(null, 0, 0);
      return;
    }
    const z = zoom as number;
    // Visible region of the logical image, in image pixels, from the pan offset.
    const x0 = -effOffset.x / z;
    const y0 = -effOffset.y / z;
    const roi = {
      x: x0 / imgW,
      y: y0 / imgH,
      w: frame.w / z / imgW,
      h: frame.h / z / imgH,
    };
    // Clamp to [0,1]; the image fully covers the frame at zoom ≥ fit.
    roi.x = Math.max(0, Math.min(1, roi.x));
    roi.y = Math.max(0, Math.min(1, roi.y));
    roi.w = Math.max(0.001, Math.min(1 - roi.x, roi.w));
    roi.h = Math.max(0.001, Math.min(1 - roi.y, roi.h));
    onViewport(roi, Math.round(frame.w * dpr), Math.round(frame.h * dpr));
  }, [roiMode, hasImage, zoom, effOffset.x, effOffset.y, frame.w, frame.h, imgW, imgH, dpr, onViewport]);

  // Report the on-screen image rect to a sibling overlay. In ROI-zoom mode the
  // worker has already rendered just the visible window to fill the frame, so
  // the pixels cover it edge-to-edge; in fit/CSS mode they sit at the letterbox.
  useEffect(() => {
    if (!onLayout) return;
    if (!hasImage) return;
    // Where the FULL image sits at the current pan/zoom (the same rect handed to
    // the overlay render-prop); image-anchored overlays map against this.
    const image = { x: effOffset.x, y: effOffset.y, w: imgW * effScale, h: imgH * effScale };
    // Where the displayed pixels sit: the window fills the frame in ROI-zoom mode.
    const visible = roiMode ? { x: 0, y: 0, w: frame.w, h: frame.h } : image;
    onLayout(visible, image);
  }, [onLayout, hasImage, roiMode, effOffset.x, effOffset.y, effScale, imgW, imgH, frame.w, frame.h]);

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
    if (onPick) {
      // Map the click into canvas buffer pixels (undo the CSS pan/scale).
      const { effScale: s, effOffset: o } = stateRef.current;
      const bx = (clientX - rect.left - o.x) / s;
      const by = (clientY - rect.top - o.y) / s;
      onPick(bx, by);
      return;
    }
    // Only toggle zoom when the click lands on the displayed image — clicks on
    // the letterbox/surround around a fitted image do nothing.
    if (!pointOnImage(clientX, clientY)) return;
    zoomToggleAt(clientX - rect.left, clientY - rect.top);
  };

  // Keep a fresh closure for the window key listener (mounted once) to call.
  const zoomToggleRef = useRef<(cx: number | null, cy: number | null) => void>(
    () => {},
  );
  zoomToggleRef.current = zoomToggleAt;
  // Last cursor position over the frame, so a keyboard zoom anchors there.
  const lastPointer = useRef<{ x: number; y: number } | null>(null);

  // Zoom-gesture keys. Space taps toggle zoom (also valid in the plain viewport);
  // in a zoomable overlay, holding Ctrl/⌘ or Space turns the overlay click-
  // through so the pointer drives zoom/pan instead of painting.
  useEffect(() => {
    if (staticFit) return;
    const frameLocal = () => {
      const r = frameRef.current?.getBoundingClientRect();
      const p = lastPointer.current;
      if (!r || !p) return { x: null, y: null };
      return { x: p.x - r.left, y: p.y - r.top };
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (shortcutsSuspended() || isEditableTarget(e.target)) return;
      if (e.code === "Space") {
        e.preventDefault();
        if (!e.repeat) {
          const { x, y } = frameLocal();
          zoomToggleRef.current(x, y);
        }
        setZoomGesture(true);
      } else if (overlayZoomable && (e.ctrlKey || e.metaKey)) {
        setZoomGesture(true);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space" || !(e.ctrlKey || e.metaKey)) setZoomGesture(false);
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
      setZoomGesture(false);
    };
  }, [staticFit, overlayZoomable]);

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

  // Crossfade: when fadeToken changes, snapshot the current frame into an
  // overlay canvas (the display canvas is a 2D canvas, so drawImage is reliable)
  // and fade it out over the new frame the renderer draws underneath.
  const fadeRef = useRef<HTMLCanvasElement>(null);
  const seenFadeToken = useRef(fadeToken);
  useLayoutEffect(() => {
    if (fadeToken == null || fadeToken === seenFadeToken.current) return;
    seenFadeToken.current = fadeToken;
    const src = canvasRef.current;
    const dst = fadeRef.current;
    if (!src || !dst || !src.width || !src.height) return;
    dst.width = src.width;
    dst.height = src.height;
    const c = dst.getContext("2d");
    if (!c) return;
    try {
      c.drawImage(src, 0, 0);
    } catch {
      return; // tainted/empty source — skip the fade rather than throw
    }
    dst.style.transition = "none";
    dst.style.opacity = "1";
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        dst.style.transition = "opacity 220ms ease-out";
        dst.style.opacity = "0";
      }),
    );
  }, [fadeToken, canvasRef]);

  // Track drag picking state
  const pickDragRef = useRef<{ active: boolean }>({ active: false });

  const onPointerDown = (e: ReactPointerEvent) => {
    // Drag picking mode (HSL picker)
    if (onPickDrag && !overlay && e.button === 0) {
      const rect = frameRef.current?.getBoundingClientRect();
      if (rect) {
        const { effScale: s, effOffset: o } = stateRef.current;
        const bx = (e.clientX - rect.left - o.x) / s;
        const by = (e.clientY - rect.top - o.y) / s;
        pickDragRef.current.active = true;
        onPickDrag.onDown(bx, by);
        frameRef.current?.setPointerCapture(e.pointerId);
      }
      return;
    }

    // Mask/heal pointer events bubble up from the overlay; only hijack them for
    // pan/zoom while a gesture key is held (otherwise the tool owns the drag).
    if (staticFit || (overlayZoomable && !zoomGesture) || e.button !== 0) return;
    frameRef.current?.setPointerCapture(e.pointerId);
    downRef.current = {
      x: e.clientX,
      y: e.clientY,
      ox: stateRef.current.effOffset.x,
      oy: stateRef.current.effOffset.y,
      moved: false,
    };
  };

  // Test whether a frame-local point falls on the displayed image rect.
  const pointOnImage = (clientX: number, clientY: number) => {
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect) return false;
    const fx = clientX - rect.left;
    const fy = clientY - rect.top;
    const { effScale: s, effOffset: o, imgW: iw, imgH: ih } = stateRef.current;
    return fx >= o.x && fx <= o.x + iw * s && fy >= o.y && fy <= o.y + ih * s;
  };

  const onPointerMove = (e: ReactPointerEvent) => {
    setHoverImage(pointOnImage(e.clientX, e.clientY));

    // Drag picking mode
    if (pickDragRef.current.active && onPickDrag) {
      const rect = frameRef.current?.getBoundingClientRect();
      if (rect) {
        const { effScale: s, effOffset: o } = stateRef.current;
        const bx = (e.clientX - rect.left - o.x) / s;
        const by = (e.clientY - rect.top - o.y) / s;
        onPickDrag.onMove(bx, by);
      }
      return;
    }

    const d = downRef.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
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

  // In ROI mode the worker has already rendered the visible window, so the canvas
  // simply fills the frame 1:1 (no CSS scale). Otherwise the fit/zoom view scales
  // and pans the full-image buffer with a CSS transform as before.
  const canvasStyle: CSSProperties = roiMode
    ? {
        position: "absolute",
        left: 0,
        top: 0,
        width: "100%",
        height: "100%",
        willChange: "transform",
      }
    : {
        position: "absolute",
        left: 0,
        top: 0,
        width: bufferWidth || 1,
        height: bufferHeight || 1,
        transformOrigin: "0 0",
        transform: `translate(${effOffset.x}px, ${effOffset.y}px) scale(${effScale})`,
        willChange: "transform",
      };

  // Color-assessment white mat: a brilliant-white band hugging the displayed
  // image, painted behind the canvas. In ROI-zoom mode the pixels fill the
  // frame, so the band sits at the frame edges; in fit/CSS mode it wraps the
  // letterboxed image. Border scales with the viewport, clamped to sane bounds.
  const display = roiMode
    ? { x: 0, y: 0, w: frame.w, h: frame.h }
    : { x: effOffset.x, y: effOffset.y, w: imgW * effScale, h: imgH * effScale };

  return (
    <div
      ref={frameRef}
      className="relative h-full w-full overflow-hidden"
      style={{ cursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
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
          Resting opacity 0 — the layout effect drives the fade. */}
      <canvas
        ref={fadeRef}
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
            // Where the FULL image sits at the current pan/zoom, in frame
            // coords. In fit/CSS-zoom mode imgW===bufferWidth so this is the
            // displayed image rect; in ROI-zoom mode the live buffer holds only
            // the window, so we must use the full-image dims (imgW/imgH) — else
            // overlay coords (masks, heal) drift with zoom.
            x: effOffset.x,
            y: effOffset.y,
            w: imgW * effScale,
            h: imgH * effScale,
          })}
          {/* overlay rect = full image region in frame coords */}
        </div>
      )}

      {loading && (
        <div className="absolute bottom-2 left-2 text-[10px] text-text-muted">
          Loading…
        </div>
      )}
    </div>
  );
}
