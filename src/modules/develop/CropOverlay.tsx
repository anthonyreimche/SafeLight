import { useRef, useState } from "react";
import type { CropRect } from "@/catalog/types";
import { cropFitsImage } from "@/rendering/crop-transform";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Handle =
  | "nw"
  | "n"
  | "ne"
  | "e"
  | "se"
  | "s"
  | "sw"
  | "w"
  | "move"
  | "level";

const MIN = 0.04; // smallest crop, normalized to image
const HIT = 12; // px hit radius for handles

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

interface CropOverlayProps {
  rect: Rect; // displayed canvas rect (frame coords); shows the viewCrop region
  crop: CropRect; // straightened-frame, normalized to the image
  viewCrop: CropRect; // straightened-frame region the canvas shows
  straightenRad: number;
  straightenDeg: number;
  aspect: number; // crop aspect lock, width:height in pixels (0 = free)
  imageAspect: number;
  constrain: boolean;
  onChange: (crop: CropRect) => void;
  onCommit: () => void;
  onLevel: (deg: number) => void;
}

export function CropOverlay({
  rect,
  crop,
  viewCrop,
  straightenRad,
  straightenDeg,
  aspect,
  imageAspect,
  constrain,
  onChange,
  onCommit,
  onLevel,
}: CropOverlayProps) {
  const dragRef = useRef<{
    mode: Handle;
    startCrop: CropRect;
    sx: number;
    sy: number;
  } | null>(null);
  const [line, setLine] = useState<{ x: number; y: number; dx: number; dy: number } | null>(
    null,
  );

  const normRatio = aspect > 0 ? aspect / imageAspect : 0; // crop.w / crop.h

  // straightened-frame point -> frame (screen) coords
  const toScreen = (px: number, py: number) => ({
    x: rect.x + ((px - viewCrop.x) / viewCrop.width) * rect.w,
    y: rect.y + ((py - viewCrop.y) / viewCrop.height) * rect.h,
  });

  const tl = toScreen(crop.x, crop.y);
  const br = toScreen(crop.x + crop.width, crop.y + crop.height);
  const bx = tl.x;
  const by = tl.y;
  const bw = br.x - tl.x;
  const bh = br.y - tl.y;

  const cornerHandles: { id: Handle; x: number; y: number }[] = [
    { id: "nw", x: bx, y: by },
    { id: "ne", x: bx + bw, y: by },
    { id: "se", x: bx + bw, y: by + bh },
    { id: "sw", x: bx, y: by + bh },
  ];
  const edgeHandles: { id: Handle; x: number; y: number }[] = [
    { id: "n", x: bx + bw / 2, y: by },
    { id: "e", x: bx + bw, y: by + bh / 2 },
    { id: "s", x: bx + bw / 2, y: by + bh },
    { id: "w", x: bx, y: by + bh / 2 },
  ];
  const handles = normRatio > 0 ? cornerHandles : [...cornerHandles, ...edgeHandles];

  const hitTest = (px: number, py: number): Handle | null => {
    for (const h of handles) {
      if (Math.abs(px - h.x) <= HIT && Math.abs(py - h.y) <= HIT) return h.id;
    }
    if (px >= bx && px <= bx + bw && py >= by && py <= by + bh) return "move";
    return null;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const px = e.nativeEvent.offsetX;
    const py = e.nativeEvent.offsetY;
    e.currentTarget.setPointerCapture(e.pointerId);

    if (e.ctrlKey || e.metaKey) {
      dragRef.current = { mode: "level", startCrop: crop, sx: e.clientX, sy: e.clientY };
      setLine({ x: px, y: py, dx: 0, dy: 0 });
      return;
    }
    const mode = hitTest(px, py);
    if (!mode) return;
    dragRef.current = { mode, startCrop: crop, sx: e.clientX, sy: e.clientY };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (d.mode === "level") {
      setLine((l) => (l ? { ...l, dx: e.clientX - d.sx, dy: e.clientY - d.sy } : l));
      return;
    }
    // Screen delta -> straightened-frame delta.
    const dnx = ((e.clientX - d.sx) / rect.w) * viewCrop.width;
    const dny = ((e.clientY - d.sy) / rect.h) * viewCrop.height;

    let next = applyDrag(d.mode, d.startCrop, dnx, dny, normRatio);
    next = clampToBounds(next, viewCrop);
    if (constrain && !cropFitsImage(next, straightenRad, imageAspect)) return;
    onChange(next);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    if (d.mode === "level") {
      const dx = e.clientX - d.sx;
      const dy = e.clientY - d.sy;
      setLine(null);
      if (Math.abs(dx) + Math.abs(dy) > 6) {
        // Residual tilt of the drawn line, reduced to the nearest axis.
        let residual = (Math.atan2(dy, dx) * 180) / Math.PI;
        while (residual > 45) residual -= 90;
        while (residual < -45) residual += 90;
        onLevel(clamp(straightenDeg - residual, -45, 45));
      }
      return;
    }
    onCommit();
  };

  return (
    <div
      className="absolute inset-0"
      style={{ cursor: "crosshair", touchAction: "none" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute bg-black/50" style={{ left: 0, top: 0, right: 0, height: Math.max(0, by) }} />
        <div className="absolute bg-black/50" style={{ left: 0, top: by + bh, right: 0, bottom: 0 }} />
        <div className="absolute bg-black/50" style={{ left: 0, top: by, width: Math.max(0, bx), height: bh }} />
        <div className="absolute bg-black/50" style={{ left: bx + bw, top: by, right: 0, height: bh }} />
      </div>

      <div
        className="pointer-events-none absolute border border-white/80"
        style={{ left: bx, top: by, width: bw, height: bh }}
      >
        <div className="absolute inset-y-0 border-l border-white/25" style={{ left: "33.33%" }} />
        <div className="absolute inset-y-0 border-l border-white/25" style={{ left: "66.66%" }} />
        <div className="absolute inset-x-0 border-t border-white/25" style={{ top: "33.33%" }} />
        <div className="absolute inset-x-0 border-t border-white/25" style={{ top: "66.66%" }} />
      </div>

      {handles.map((h) => (
        <div
          key={h.id}
          className="pointer-events-none absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-black/40 bg-white"
          style={{ left: h.x, top: h.y }}
        />
      ))}

      {line && (
        <svg className="pointer-events-none absolute inset-0 h-full w-full">
          <line
            x1={line.x}
            y1={line.y}
            x2={line.x + line.dx}
            y2={line.y + line.dy}
            stroke="#4aa3ff"
            strokeWidth={1.5}
          />
        </svg>
      )}
    </div>
  );
}

function applyDrag(
  mode: Handle,
  c: CropRect,
  dnx: number,
  dny: number,
  normRatio: number,
): CropRect {
  let x = c.x;
  let y = c.y;
  let w = c.width;
  let h = c.height;

  if (mode === "move") {
    x += dnx;
    y += dny;
  } else if (normRatio > 0) {
    // Aspect-locked corner resize, anchored at the opposite corner.
    const right = mode.includes("e");
    const bottom = mode.includes("s");
    const anchorX = right ? c.x : c.x + c.width;
    const anchorY = bottom ? c.y : c.y + c.height;
    w = Math.max(MIN, right ? c.width + dnx : c.width - dnx);
    h = w / normRatio;
    x = right ? anchorX : anchorX - w;
    y = bottom ? anchorY : anchorY - h;
  } else {
    if (mode.includes("e")) w += dnx;
    if (mode.includes("w")) {
      x += dnx;
      w -= dnx;
    }
    if (mode.includes("s")) h += dny;
    if (mode.includes("n")) {
      y += dny;
      h -= dny;
    }
  }

  if (w < MIN) {
    if (mode.includes("w")) x = c.x + c.width - MIN;
    w = MIN;
  }
  if (h < MIN) {
    if (mode.includes("n")) y = c.y + c.height - MIN;
    h = MIN;
  }
  return { x, y, width: w, height: h };
}

// Keep the crop within the visible view region.
function clampToBounds(c: CropRect, vc: CropRect): CropRect {
  const w = Math.min(c.width, vc.width);
  const h = Math.min(c.height, vc.height);
  return {
    x: Math.min(Math.max(c.x, vc.x), vc.x + vc.width - w),
    y: Math.min(Math.max(c.y, vc.y), vc.y + vc.height - h),
    width: w,
    height: h,
  };
}
