// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useEffect, useId, useRef, useState } from "react";
import { makeCurveEvaluator } from "@/rendering/curve";
import { useKeyboardCanvasEditing } from "@/state/accessibility";
import { useSettings } from "@/state/settings-store";
import type { CurvePoint, ToneCurveChannel, ToneCurves } from "@/catalog/types";

const PAD = 8;
const HIT_RADIUS = 11;
// Arrow-key nudge amounts (fraction of the 0..1 range); Shift = coarse.
const STEP = 0.01;
const COARSE = 0.05;

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
//
// Keyboard / non-drag editing is opt-in via Accessibility ▸ Keyboard canvas
// editing (useKeyboardCanvasEditing). When ON: the graph is focusable and owns
// arrows (nudge the selected point), Page Up/Down + Home/End (selection), Enter
// (add) and Delete (remove), and the In/Out number fields + prev/next buttons
// below give a single-click non-drag path; edits are announced via a polite live
// region. When OFF: the graph is the plain pointer-only editor (click to add,
// drag to move, double-click to remove) and doesn't capture bare-key shortcuts.
export function CurveEditor({ curves, onChange, onCommit, compact }: CurveEditorProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState(220);
  const [channel, setChannel] = useState<ToneCurveChannel>("rgb");
  const [selected, setSelected] = useState(0);
  const [focused, setFocused] = useState(false);
  const [announce, setAnnounce] = useState("");
  const draggingRef = useRef<number | null>(null);
  // A run of arrow nudges commits once on key-up, not per repeat, to keep undo sane.
  const dirtyRef = useRef(false);
  const helpId = useId();
  // Opt-in: gates only the on-canvas keyboard layer, not the number fields below.
  const kbd = useKeyboardCanvasEditing();
  // Whether to draw the selection/focus ring on the active point.
  const showHighlights = useSettings((s) => s.editingHighlights);

  const points = curves[channel];
  const color = CHANNELS.find((c) => c.key === channel)!.color;
  const channelLabel = CHANNELS.find((c) => c.key === channel)!.label;
  // Guard the index against a curve that shrank (channel switch, point removed).
  const sel = Math.min(selected, points.length - 1);
  const selPoint = points[sel];
  const isEndpoint = sel === 0 || sel === points.length - 1;

  // Keep the selection in range when the curve/channel changes under us.
  useEffect(() => {
    setSelected((s) => Math.max(0, Math.min(s, points.length - 1)));
  }, [points.length, channel]);

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

  // Redraw whenever the active curve, channel color, size, selection or focus change.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw(ctx, size, points, color, sel, focused, showHighlights);
  }, [points, size, color, sel, focused, showHighlights]);

  const update = (next: CurvePoint[]) => onChange(channel, next);
  const describe = (i: number, p: CurvePoint) =>
    `Point ${i + 1} of ${points.length}: input ${Math.round(p.x * 100)}%, output ${Math.round(p.y * 100)}%`;

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
    setSelected(idx);
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

  // ── Keyboard editing ──────────────────────────────────────────────────────
  const moveSelected = (dx: number, dy: number) => {
    const i = sel;
    const next = points.map((p) => ({ ...p }));
    if (i === 0) next[i] = { x: 0, y: clamp01(next[i].y + dy) };
    else if (i === points.length - 1) next[i] = { x: 1, y: clamp01(next[i].y + dy) };
    else {
      const lo = next[i - 1].x + 0.001;
      const hi = next[i + 1].x - 0.001;
      next[i] = {
        x: Math.min(Math.max(next[i].x + dx, lo), hi),
        y: clamp01(next[i].y + dy),
      };
    }
    update(next);
    dirtyRef.current = true;
    setAnnounce(describe(i, next[i]));
  };

  const addPoint = () => {
    const i = sel;
    const nx =
      i < points.length - 1
        ? (points[i].x + points[i + 1].x) / 2
        : (points[i - 1].x + points[i].x) / 2;
    const np = { x: nx, y: clamp01(makeCurveEvaluator(points)(nx)) };
    const next = [...points, np].sort((a, b) => a.x - b.x);
    const ni = next.findIndex((p) => p === np);
    update(next);
    onCommit();
    setSelected(ni);
    setAnnounce(`Added. ${describe(ni, np)}`);
  };

  const removePoint = () => {
    if (isEndpoint) {
      setAnnounce("Endpoints can't be removed");
      return;
    }
    const i = sel;
    const next = points.filter((_, j) => j !== i);
    update(next);
    onCommit();
    setSelected(Math.max(0, i - 1));
    setAnnounce(`Removed point. ${next.length} points remain`);
  };

  const selectIndex = (i: number) => {
    const ni = Math.max(0, Math.min(points.length - 1, i));
    setSelected(ni);
    setAnnounce(describe(ni, points[ni]));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLCanvasElement>) => {
    const step = e.shiftKey ? COARSE : STEP;
    switch (e.key) {
      case "ArrowLeft": e.preventDefault(); moveSelected(-step, 0); break;
      case "ArrowRight": e.preventDefault(); moveSelected(step, 0); break;
      case "ArrowUp": e.preventDefault(); moveSelected(0, step); break;
      case "ArrowDown": e.preventDefault(); moveSelected(0, -step); break;
      case "PageUp": e.preventDefault(); selectIndex(sel + 1); break;
      case "PageDown": e.preventDefault(); selectIndex(sel - 1); break;
      case "Home": e.preventDefault(); selectIndex(0); break;
      case "End": e.preventDefault(); selectIndex(points.length - 1); break;
      case "Enter":
      case "Insert":
      case "+":
      case "=": e.preventDefault(); addPoint(); break;
      case "Delete":
      case "Backspace": e.preventDefault(); removePoint(); break;
    }
  };

  const onKeyUp = () => {
    if (dirtyRef.current) {
      dirtyRef.current = false;
      onCommit();
    }
  };

  // ── Selected-point number fields (non-drag pointer path) ────────────────────
  const setInputPct = (raw: string) => {
    if (isEndpoint || raw === "") return;
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    const i = sel;
    const lo = points[i - 1].x + 0.001;
    const hi = points[i + 1].x - 0.001;
    const nx = Math.min(Math.max(n / 100, lo), hi);
    const next = points.map((p, j) => (j === i ? { ...p, x: nx } : p));
    update(next);
    onCommit();
    setAnnounce(describe(i, next[i]));
  };
  const setOutputPct = (raw: string) => {
    if (raw === "") return;
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    const i = sel;
    const next = points.map((p, j) => (j === i ? { ...p, y: clamp01(n / 100) } : p));
    update(next);
    onCommit();
    setAnnounce(describe(i, next[i]));
  };

  const fieldBtn =
    "rounded px-1 leading-none text-text-muted hover:text-text-primary disabled:opacity-30 disabled:hover:text-text-muted";
  const numCls =
    "w-9 rounded bg-surface-2 px-1 text-right tabular-nums text-text-primary outline-none focus:bg-surface-3";

  return (
    <>
      <div className="mb-2 flex rounded bg-surface-2" role="group" aria-label="Curve channel">
        {CHANNELS.map((c) => (
          <button
            key={c.key}
            onClick={() => setChannel(c.key)}
            aria-pressed={channel === c.key}
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
          tabIndex={kbd ? 0 : undefined}
          data-keyboard-capture={kbd ? "" : undefined}
          role={kbd ? "application" : "img"}
          aria-label={`Tone curve, ${channelLabel} channel. ${describe(sel, selPoint)}.`}
          aria-describedby={kbd ? helpId : undefined}
          style={{ width: size, height: size, touchAction: "none" }}
          className="cursor-crosshair rounded bg-surface-0"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onDoubleClick={handleDoubleClick}
          onKeyDown={kbd ? onKeyDown : undefined}
          onKeyUp={kbd ? onKeyUp : undefined}
          onFocus={kbd ? () => setFocused(true) : undefined}
          onBlur={kbd ? () => setFocused(false) : undefined}
        />
      </div>

      {/* Selected-point editor: the non-drag (single-click + keyboard) path.
          Shown only with "Keyboard canvas editing" on — otherwise the curve is
          the plain pointer-only graph. */}
      {kbd && (
      <div className="mt-1.5 flex items-center gap-1 text-[10px] text-text-secondary">
        <button
          onClick={() => selectIndex(sel - 1)}
          disabled={sel === 0}
          aria-label="Select previous point"
          className={fieldBtn}
        >
          ‹
        </button>
        <span className="w-7 text-center tabular-nums" aria-hidden="true">
          {sel + 1}/{points.length}
        </span>
        <button
          onClick={() => selectIndex(sel + 1)}
          disabled={sel === points.length - 1}
          aria-label="Select next point"
          className={fieldBtn}
        >
          ›
        </button>
        <label className="ml-1 text-text-muted" htmlFor={`${helpId}-in`}>In</label>
        <input
          id={`${helpId}-in`}
          type="number"
          min={0}
          max={100}
          value={Math.round(selPoint.x * 100)}
          disabled={isEndpoint}
          onChange={(e) => setInputPct(e.target.value)}
          aria-label="Selected point input level (%)"
          className={`${numCls} disabled:opacity-40`}
        />
        <label className="text-text-muted" htmlFor={`${helpId}-out`}>Out</label>
        <input
          id={`${helpId}-out`}
          type="number"
          min={0}
          max={100}
          value={Math.round(selPoint.y * 100)}
          onChange={(e) => setOutputPct(e.target.value)}
          aria-label="Selected point output level (%)"
          className={numCls}
        />
        <button onClick={addPoint} aria-label="Add point" className={`${fieldBtn} ml-auto`}>
          +
        </button>
        <button
          onClick={removePoint}
          disabled={isEndpoint}
          aria-label="Remove selected point"
          className={fieldBtn}
        >
          ×
        </button>
      </div>
      )}

      {!compact && (
        <p className="mt-1 text-[10px] text-text-muted">
          Click to add · drag to move · double-click to remove.
          {kbd &&
            " With the graph focused: arrows nudge, Page Up/Down select, Enter adds, Delete removes."}
        </p>
      )}
      {kbd && (
        <p id={helpId} className="sr-only">
          Tone curve graph editor. Arrow keys move the selected point; hold Shift
          for larger steps. Page Up and Page Down select the next or previous
          point; Home and End select the first or last. Enter adds a point; Delete
          removes the selected one.
        </p>
      )}
      <div aria-live="polite" className="sr-only">
        {announce}
      </div>
    </>
  );
}

function draw(
  ctx: CanvasRenderingContext2D,
  size: number,
  points: CurvePoint[],
  color: string,
  selected: number,
  focused: boolean,
  showHighlight: boolean,
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

  // Control points, with a ring on the selected one (brighter when focused) so
  // keyboard selection is visible.
  for (let i = 0; i < points.length; i++) {
    const cx = PAD + points[i].x * plot;
    const cy = PAD + (1 - points[i].y) * plot;
    if (showHighlight && i === selected) {
      ctx.strokeStyle = focused ? "#ffffff" : "#9c9c9c";
      ctx.lineWidth = focused ? 2 : 1.5;
      ctx.beginPath();
      ctx.arc(cx, cy, 6, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = "#f0f0f0";
    ctx.beginPath();
    ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
