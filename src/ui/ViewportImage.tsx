import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { isEditableTarget, shortcutsSuspended } from "@/state/keybindings-store";

interface ViewportImageProps {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  bufferWidth: number; // rendered buffer size, in px
  bufferHeight: number;
  zoom: number | null; // null = fit; number = scale (1 = 100% of buffer)
  onZoomChange: (zoom: number | null) => void;
  loading?: boolean;
  resetKey?: string; // changing this snaps back to "fit" (e.g. a new photo)
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
  overlay,
  overlayZoomable,
  onPick,
  onPickDrag,
}: ViewportImageProps) {
  // A crop overlay locks the view to fit; a mask/heal overlay (overlayZoomable)
  // keeps the zoom/pan machinery live underneath it.
  const staticFit = !!overlay && !overlayZoomable;
  const frameRef = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState({ w: 0, h: 0 });
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  // True while a zoom-gesture key (Ctrl/⌘ or Space) is held. Used to make a
  // zoomable overlay click-through so the pointer reaches the pan/zoom layer.
  const [zoomGesture, setZoomGesture] = useState(false);

  // A new image starts at fit, centered.
  useEffect(() => {
    setOffset({ x: 0, y: 0 });
    onZoomChange(null);
    // onZoomChange is a stable setter; intentionally not a dependency.
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

  const hasImage =
    bufferWidth > 0 && bufferHeight > 0 && frame.w > 0 && frame.h > 0;
  const fitScale = hasImage
    ? Math.min(frame.w / bufferWidth, frame.h / bufferHeight)
    : 1;

  const centered = (s: number) => ({
    x: (frame.w - bufferWidth * s) / 2,
    y: (frame.h - bufferHeight * s) / 2,
  });

  const clampOffset = (o: { x: number; y: number }, s: number) => {
    const iw = bufferWidth * s;
    const ih = bufferHeight * s;
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

  const stateRef = useRef({ effScale, effOffset });
  stateRef.current = { effScale, effOffset };

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

  const onPointerMove = (e: ReactPointerEvent) => {
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

  const cursor = onPick || onPickDrag
    ? "crosshair"
    : staticFit
      ? "default"
      : dragging
        ? "grabbing"
        : zoom == null
          ? "zoom-in"
          : "zoom-out";

  const canvasStyle: CSSProperties = {
    position: "absolute",
    left: 0,
    top: 0,
    width: bufferWidth || 1,
    height: bufferHeight || 1,
    transformOrigin: "0 0",
    transform: `translate(${effOffset.x}px, ${effOffset.y}px) scale(${effScale})`,
    willChange: "transform",
  };

  return (
    <div
      ref={frameRef}
      className="relative h-full w-full overflow-hidden"
      style={{ cursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <canvas ref={canvasRef} style={canvasStyle} />

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
            x: effOffset.x,
            y: effOffset.y,
            w: bufferWidth * effScale,
            h: bufferHeight * effScale,
          })}
          {/* overlay rect = displayed image region in frame coords */}
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
