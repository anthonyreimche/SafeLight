import { useEffect, useRef, useState } from "react";
import { makeCurveEvaluator } from "@/rendering/curve";
import type { CurvePoint, ToneCurveChannel, ToneCurves } from "@/catalog/types";

const PAD = 8;
const HIT_RADIUS = 11;

const CHANNELS: { key: ToneCurveChannel; label: string; color: string }[] = [
  { key: "rgb", label: "RGB", color: "#c8c8c8" },
  { key: "red", label: "R", color: "#e74c3c" },
  { key: "green", label: "G", color: "#2ecc71" },
  { key: "blue", label: "B", color: "#4aa3ff" },
];

export interface CurveEditorProps {
  curves: ToneCurves;
  onChange: (channel: ToneCurveChannel, points: CurvePoint[]) => void;
  onCommit: () => void;
  // Compact mode for embedding inside another panel (mask sub-panels).
  compact?: boolean;
}

// Controlled RGB + per-channel curve editor. The global Tone Curve panel and
// per-mask Curve sub-panels both render this; state lives with the caller.
export function CurveEditor({ curves, onChange, onCommit, compact }: CurveEditorProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState(220);
  const [channel, setChannel] = useState<ToneCurveChannel>("rgb");
  const draggingRef = useRef<number | null>(null);

  const points = curves[channel];
  const color = CHANNELS.find((c) => c.key === channel)!.color;

  // Track available width; keep the plot square.
  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0].contentRect.width;
      if (w > 0) setSize(Math.round(w));
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  // Redraw whenever the active curve, channel color, or size change (and on mount).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(ctx, size, points, color);
  }, [points, size, color]);

  const update = (next: CurvePoint[]) => onChange(channel, next);

  // Pointer position in the canvas's `size`-unit space. Derived from clientX/Y
  // and the element rect rather than offsetX/offsetY, which Chromium/Electron
  // mis-scale under non-100% Windows display scaling; the rect ratio also
  // corrects for any CSS stretching of the canvas.
  const localXY = (
    e: React.PointerEvent<HTMLCanvasElement> | React.MouseEvent<HTMLCanvasElement>,
  ) => {
    const r = e.currentTarget.getBoundingClientRect();
    const sx = r.width > 0 ? size / r.width : 1;
    const sy = r.height > 0 ? size / r.height : 1;
    return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy };
  };

  const toData = (cx: number, cy: number): CurvePoint => {
    const plot = size - 2 * PAD;
    return {
      x: clamp01((cx - PAD) / plot),
      y: clamp01(1 - (cy - PAD) / plot),
    };
  };

  const toCanvas = (p: CurvePoint): [number, number] => {
    const plot = size - 2 * PAD;
    return [PAD + p.x * plot, PAD + (1 - p.y) * plot];
  };

  const findPoint = (cx: number, cy: number): number => {
    for (let i = 0; i < points.length; i++) {
      const [px, py] = toCanvas(points[i]);
      if (Math.hypot(px - cx, py - cy) <= HIT_RADIUS) return i;
    }
    return -1;
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { x: cx, y: cy } = localXY(e);
    e.currentTarget.setPointerCapture(e.pointerId);

    let idx = findPoint(cx, cy);
    if (idx === -1) {
      const d = toData(cx, cy);
      const next = [...points, d].sort((a, b) => a.x - b.x);
      idx = next.findIndex((p) => p === d);
      update(next);
    }
    draggingRef.current = idx;
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const idx = draggingRef.current;
    if (idx === null) return;
    const { x, y } = localXY(e);
    const d = toData(x, y);
    const next = points.map((p) => ({ ...p }));
    const isFirst = idx === 0;
    const isLast = idx === points.length - 1;

    if (isFirst) {
      next[idx] = { x: 0, y: d.y };
    } else if (isLast) {
      next[idx] = { x: 1, y: d.y };
    } else {
      const lo = next[idx - 1].x + 0.001;
      const hi = next[idx + 1].x - 0.001;
      next[idx] = { x: Math.min(Math.max(d.x, lo), hi), y: d.y };
    }
    update(next);
  };

  const handlePointerUp = () => {
    if (draggingRef.current !== null) {
      draggingRef.current = null;
      onCommit();
    }
  };

  const handleDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y } = localXY(e);
    const idx = findPoint(x, y);
    if (idx > 0 && idx < points.length - 1) {
      update(points.filter((_, i) => i !== idx));
      onCommit();
    }
  };

  return (
    <>
      <div className="mb-2 flex rounded bg-surface-2">
        {CHANNELS.map((c) => (
          <button
            key={c.key}
            onClick={() => setChannel(c.key)}
            className={`flex-1 py-1 text-[10px] font-medium uppercase tracking-wider first:rounded-l last:rounded-r ${
              channel === c.key
                ? "bg-surface-3"
                : "text-text-muted hover:text-text-secondary"
            }`}
            style={channel === c.key ? { color: c.color } : undefined}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div ref={wrapRef} className="w-full">
        <canvas
          ref={canvasRef}
          style={{ width: size, height: size, touchAction: "none" }}
          className="cursor-crosshair rounded bg-surface-0"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onDoubleClick={handleDoubleClick}
        />
      </div>
      {!compact && (
        <p className="mt-1 text-[10px] text-text-muted">
          Click to add · drag to move · double-click to remove
        </p>
      )}
    </>
  );
}

function draw(
  ctx: CanvasRenderingContext2D,
  size: number,
  points: CurvePoint[],
  color: string,
) {
  const plot = size - 2 * PAD;
  ctx.clearRect(0, 0, size, size);

  // Grid.
  ctx.strokeStyle = "#2a2a2a";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const t = PAD + (i / 4) * plot;
    ctx.beginPath();
    ctx.moveTo(t, PAD);
    ctx.lineTo(t, PAD + plot);
    ctx.moveTo(PAD, t);
    ctx.lineTo(PAD + plot, t);
    ctx.stroke();
  }

  // Identity reference.
  ctx.strokeStyle = "#3a3a3a";
  ctx.beginPath();
  ctx.moveTo(PAD, PAD + plot);
  ctx.lineTo(PAD + plot, PAD);
  ctx.stroke();

  // Curve, in the channel's color.
  const evaluate = makeCurveEvaluator(points);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i <= plot; i++) {
    const x = i / plot;
    const y = evaluate(x);
    const cx = PAD + x * plot;
    const cy = PAD + (1 - y) * plot;
    if (i === 0) ctx.moveTo(cx, cy);
    else ctx.lineTo(cx, cy);
  }
  ctx.stroke();

  // Control points.
  ctx.fillStyle = "#f0f0f0";
  for (const p of points) {
    const cx = PAD + p.x * plot;
    const cy = PAD + (1 - p.y) * plot;
    ctx.beginPath();
    ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
