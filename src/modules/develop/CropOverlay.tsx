import { useEffect, useRef, useState } from "react";
import type { CropRect } from "@/catalog/types";
import { constrainCropToImage } from "@/rendering/crop-transform";
import type { Mat3 } from "@/rendering/transform";
import { guideShapes, type CropGuide } from "./crop-guides";

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
// Translucent so the cropped-out image stays visible (darkened) rather than
// being hidden behind a solid panel.
const DIM = "rgba(0, 0, 0, 0.55)";

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v));

interface CropOverlayProps {
  rect: Rect; // displayed canvas rect (frame coords); shows the viewCrop region
  crop: CropRect; // transformed-frame, normalized to the image
  viewCrop: CropRect; // transformed-frame region the canvas shows
  inv: Mat3; // transformed coord -> source UV (for image-bounds constraints)
  forward: Mat3; // source UV -> transformed coord (image quad for move clamp)
  straightenDeg: number;
  aspect: number; // crop aspect lock, width:height in pixels (0 = free)
  imageAspect: number;
  constrain: boolean;
  guide: CropGuide;
  onChange: (crop: CropRect) => void;
  onCommit: () => void;
  onLevel: (deg: number) => void;
  onCycleGuide: () => void;
}

export function CropOverlay({
  rect,
  crop,
  viewCrop,
  inv,
  forward,
  straightenDeg,
  aspect,
  imageAspect,
  constrain,
  guide,
  onChange,
  onCommit,
  onLevel,
  onCycleGuide,
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
  // The same pixel ratio in the opposite orientation (e.g. 3:2 → 2:3), in
  // normalized crop.w/crop.h terms, so a drag can flip the lock automatically.
  const normRatioFlip = aspect > 0 ? 1 / (aspect * imageAspect) : 0;

  // "O" cycles the composition guide while the crop overlay is mounted.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      )
        return;
      if (e.key === "o" || e.key === "O") {
        e.preventDefault();
        onCycleGuide();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCycleGuide]);

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

    let next = applyDrag(d.mode, d.startCrop, dnx, dny, normRatio, normRatioFlip);
    next = clampToBounds(next, viewCrop);
    if (constrain) {
      next = constrainCropToImage(
        d.startCrop,
        next,
        d.mode,
        inv,
        forward,
        imageAspect,
        normRatio > 0,
      );
    }
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
        // Residual tilt of the drawn line, reduced to the nearest axis. The
        // image rotates to bring that line level, so we add the residual.
        let residual = (Math.atan2(dy, dx) * 180) / Math.PI;
        while (residual > 45) residual -= 90;
        while (residual < -45) residual += 90;
        onLevel(clamp(straightenDeg + residual, -45, 45));
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
        <div className="absolute" style={{ left: 0, top: 0, right: 0, height: Math.max(0, by), background: DIM }} />
        <div className="absolute" style={{ left: 0, top: by + bh, right: 0, bottom: 0, background: DIM }} />
        <div className="absolute" style={{ left: 0, top: by, width: Math.max(0, bx), height: bh, background: DIM }} />
        <div className="absolute" style={{ left: bx + bw, top: by, right: 0, height: bh, background: DIM }} />
      </div>

      <div
        className="pointer-events-none absolute border border-white/80"
        style={{ left: bx, top: by, width: bw, height: bh }}
      >
        <GuideSvg guide={guide} w={bw} h={bh} />
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
  normRatioFlip: number,
): CropRect {
  let x = c.x;
  let y = c.y;
  let w = c.width;
  let h = c.height;

  if (mode === "move") {
    x += dnx;
    y += dny;
  } else if (normRatio > 0) {
    // Aspect-locked corner resize, anchored at the opposite corner. The lock
    // can take either orientation (e.g. 3:2 or 2:3); we pick whichever matches
    // the drag's shape, so dragging tall vs wide flips it automatically.
    const right = mode.includes("e");
    const bottom = mode.includes("s");
    const anchorX = right ? c.x : c.x + c.width;
    const anchorY = bottom ? c.y : c.y + c.height;
    const dw = Math.max(MIN, right ? c.width + dnx : c.width - dnx);
    const dh = Math.max(MIN, bottom ? c.height + dny : c.height - dny);
    const rFlip = normRatioFlip > 0 ? normRatioFlip : normRatio;
    const dragRatio = dw / dh;
    const r =
      Math.abs(Math.log(dragRatio / normRatio)) <=
      Math.abs(Math.log(dragRatio / rFlip))
        ? normRatio
        : rFlip;
    // Size so the locked rect reaches the cursor, then keep the smaller side
    // above MIN without breaking the ratio.
    w = Math.max(dw, dh * r);
    h = w / r;
    if (r >= 1) {
      if (h < MIN) {
        h = MIN;
        w = h * r;
      }
    } else if (w < MIN) {
      w = MIN;
      h = w / r;
    }
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

// The active composition guide, drawn in the crop box's pixel space.
function GuideSvg({ guide, w, h }: { guide: CropGuide; w: number; h: number }) {
  if (w <= 1 || h <= 1) return null;
  const { lines, paths } = guideShapes(guide, w, h);
  return (
    <svg
      className="pointer-events-none absolute left-0 top-0"
      width={w}
      height={h}
    >
      {lines.map((l, i) => (
        <line
          key={i}
          x1={l.x1}
          y1={l.y1}
          x2={l.x2}
          y2={l.y2}
          stroke="rgba(255,255,255,0.4)"
          strokeWidth={1}
        />
      ))}
      {paths.map((d, i) => (
        <path
          key={`p${i}`}
          d={d}
          fill="none"
          stroke="rgba(255,255,255,0.55)"
          strokeWidth={1}
        />
      ))}
    </svg>
  );
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
