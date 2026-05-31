import { useEffect, useRef, useState } from "react";
import { Panel } from "@/ui/components/Panel";
import { useDevelopStore } from "@/state/develop-store";
import { makeCurveEvaluator } from "@/rendering/curve";
import type { CurvePoint } from "@/catalog/types";

const PAD = 8;
const HIT_RADIUS = 11;

export function ToneCurvePanel() {
  // CurveEditor is a separate component so it mounts/unmounts with the Panel's
  // open state. That guarantees its canvas is (re)drawn every time the panel is
  // reopened — otherwise a collapsed-then-expanded panel showed a blank plot.
  return (
    <Panel title="Tone Curve">
      <CurveEditor />
    </Panel>
  );
}

function CurveEditor() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState(220);
  const draggingRef = useRef<number | null>(null);

  const points = useDevelopStore((s) => s.params.toneCurve);
  const setToneCurve = useDevelopStore((s) => s.setToneCurve);
  const commitEdit = useDevelopStore((s) => s.commitEdit);

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

  // Redraw whenever points or size change (and on mount).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(ctx, size, points);
  }, [points, size]);

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
    const cx = e.nativeEvent.offsetX;
    const cy = e.nativeEvent.offsetY;
    e.currentTarget.setPointerCapture(e.pointerId);

    let idx = findPoint(cx, cy);
    if (idx === -1) {
      const d = toData(cx, cy);
      const next = [...points, d].sort((a, b) => a.x - b.x);
      idx = next.findIndex((p) => p === d);
      setToneCurve(next);
    }
    draggingRef.current = idx;
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const idx = draggingRef.current;
    if (idx === null) return;
    const d = toData(e.nativeEvent.offsetX, e.nativeEvent.offsetY);
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
    setToneCurve(next);
  };

  const handlePointerUp = () => {
    if (draggingRef.current !== null) {
      draggingRef.current = null;
      commitEdit("Tone Curve");
    }
  };

  const handleDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const idx = findPoint(e.nativeEvent.offsetX, e.nativeEvent.offsetY);
    if (idx > 0 && idx < points.length - 1) {
      setToneCurve(points.filter((_, i) => i !== idx));
      commitEdit("Tone Curve");
    }
  };

  return (
    <>
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
      <p className="mt-1 text-[10px] text-text-muted">
        Click to add · drag to move · double-click to remove
      </p>
    </>
  );
}

function draw(
  ctx: CanvasRenderingContext2D,
  size: number,
  points: CurvePoint[],
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

  // Curve.
  const evaluate = makeCurveEvaluator(points);
  ctx.strokeStyle = "#c8c8c8";
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
  ctx.fillStyle = "#e8e8e8";
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
