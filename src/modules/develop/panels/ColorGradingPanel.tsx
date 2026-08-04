// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { useCallback, useEffect, useRef, useState } from "react";
import { Panel } from "@/ui/components/Panel";
import { Slider } from "@/ui/components/Slider";
import { useDevelopStore } from "@/state/develop-store";
import type { ColorGradingRange } from "@/catalog/types";

// ─── HSL→RGB helper (used for wheel drawing) ────────────────────────────────

function hue2rgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  ];
}

// ─── Color Wheel Component ───────────────────────────────────────────────────

const WHEEL_SIZE = 112;
const WHEEL_RADIUS = WHEEL_SIZE / 2 - 3;
const WHEEL_FINE = 0.25;

interface ColorWheelProps {
  label: string;
  range: ColorGradingRange;
  lightness: number;
  onChange: (partial: Partial<ColorGradingRange>) => void;
  onCommit: (label: string) => void;
}

function ColorWheel({ label, range, lightness, onChange, onCommit }: ColorWheelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bgRef = useRef<HTMLCanvasElement | null>(null);
  const dprRef = useRef(1);
  const dragging = useRef(false);
  const anchor = useRef<{
    rx: number;
    ry: number;
    vx: number;
    vy: number;
    shift: boolean;
  } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    dprRef.current = dpr;
    const pxSize = Math.round(WHEEL_SIZE * dpr);
    const pxRadius = WHEEL_RADIUS * dpr;
    canvas.width = pxSize;
    canvas.height = pxSize;

    const offscreen = document.createElement("canvas");
    offscreen.width = pxSize;
    offscreen.height = pxSize;
    const offCtx = offscreen.getContext("2d")!;
    const img = offCtx.createImageData(pxSize, pxSize);

    const cx = pxSize / 2;
    const cy = pxSize / 2;
    for (let y = 0; y < pxSize; y++) {
      for (let x = 0; x < pxSize; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > pxRadius + 1) continue;
        const h = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
        const s = Math.min(dist / pxRadius, 1);
        const [r, g, b] = hslToRgb(h / 360, s, lightness);
        const alpha = Math.min(Math.max(pxRadius - dist + 1, 0), 1);
        const i = (y * pxSize + x) * 4;
        img.data[i] = r;
        img.data[i + 1] = g;
        img.data[i + 2] = b;
        img.data[i + 3] = Math.round(alpha * 255);
      }
    }
    offCtx.putImageData(img, 0, 0);
    bgRef.current = offscreen;

    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, pxSize, pxSize);
    ctx.drawImage(offscreen, 0, 0);
  }, [lightness]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !bgRef.current) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = dprRef.current;
    const pxSize = Math.round(WHEEL_SIZE * dpr);
    ctx.clearRect(0, 0, pxSize, pxSize);
    ctx.drawImage(bgRef.current, 0, 0);

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const cx = WHEEL_SIZE / 2;
    const cy = WHEEL_SIZE / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, WHEEL_RADIUS, 0, 2 * Math.PI);
    ctx.strokeStyle = "rgba(0,0,0,0.4)";
    ctx.lineWidth = 1;
    ctx.stroke();

    const hRad = (range.hue * Math.PI) / 180;
    const hx = cx + (range.sat / 100) * WHEEL_RADIUS * Math.cos(hRad);
    const hy = cy + (range.sat / 100) * WHEEL_RADIUS * Math.sin(hRad);

    ctx.beginPath();
    ctx.arc(hx, hy, 5, 0, 2 * Math.PI);
    ctx.fillStyle = "white";
    ctx.fill();
    ctx.beginPath();
    ctx.arc(hx, hy, 3, 0, 2 * Math.PI);
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fill();

    ctx.restore();
  }, [range.hue, range.sat]);

  const relPointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      rx: (e.clientX - rect.left) * (WHEEL_SIZE / rect.width) - WHEEL_SIZE / 2,
      ry: (e.clientY - rect.top) * (WHEEL_SIZE / rect.height) - WHEEL_SIZE / 2,
    };
  };

  const valueVec = () => {
    const r = (range.sat / 100) * WHEEL_RADIUS;
    const a = (range.hue * Math.PI) / 180;
    return { vx: Math.cos(a) * r, vy: Math.sin(a) * r };
  };

  const applyVec = (vx: number, vy: number) => {
    const dist = Math.sqrt(vx * vx + vy * vy);
    const newHue = ((Math.atan2(vy, vx) * 180) / Math.PI + 360) % 360;
    const newSat = Math.min(dist / WHEEL_RADIUS, 1) * 100;
    onChange({ hue: newHue, sat: newSat });
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragging.current = true;
    // Second click of a double-click reset must not move (and commit) the value
    // first — commitEdit has no no-change dedup, so the stray entry would sit
    // between the pre-click state and the reset, hijacking the next undo.
    if (e.detail > 1) return;
    const { rx, ry } = relPointer(e);
    const { vx, vy } = valueVec();
    anchor.current = { rx, ry, vx, vy, shift: e.shiftKey };
    if (e.shiftKey) applyVec(vx, vy);
    else applyVec(rx, ry);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragging.current || !anchor.current) return;
    const a = anchor.current;
    const { rx, ry } = relPointer(e);
    if (e.shiftKey !== a.shift) {
      const v = valueVec();
      a.rx = rx;
      a.ry = ry;
      a.vx = v.vx;
      a.vy = v.vy;
      a.shift = e.shiftKey;
    }
    if (e.shiftKey) {
      applyVec(a.vx + (rx - a.rx) * WHEEL_FINE, a.vy + (ry - a.ry) * WHEEL_FINE);
    } else {
      applyVec(rx, ry);
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    anchor.current = null;
    if (e.detail > 1) return;
    onCommit(label);
  };

  const onDoubleClick = () => {
    onChange({ hue: 0, sat: 0 });
    onCommit(label);
  };

  const [editHue, setEditHue] = useState<string | null>(null);
  const [editSat, setEditSat] = useState<string | null>(null);

  return (
    <div className="flex flex-col items-center gap-1">
      <span className="text-[10px] text-text-muted">{label}</span>
      <canvas
        ref={canvasRef}
        width={WHEEL_SIZE}
        height={WHEEL_SIZE}
        style={{ width: WHEEL_SIZE, height: WHEEL_SIZE, borderRadius: "50%", cursor: "crosshair" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={onDoubleClick}
        title={`${label} color wheel — drag to set hue & saturation, hold Shift for precise control, double-click to reset`}
      />
      <div className="flex items-center justify-center text-[9px] tabular-nums text-text-muted">
        <input
          type="text"
          inputMode="decimal"
          value={editHue ?? String(Math.round(range.hue))}
          onFocus={() => setEditHue(String(Math.round(range.hue)))}
          onChange={(e) => {
            setEditHue(e.target.value);
            const n = Number(e.target.value);
            // Number("") === 0 passes isFinite; don't snap the wheel to 0 while
            // the field is empty mid-edit — blur restores the current value.
            if (e.target.value.trim() !== "" && Number.isFinite(n))
              onChange({ hue: ((n % 360) + 360) % 360 });
          }}
          onBlur={() => { setEditHue(null); onCommit(label); }}
          className="w-7 rounded bg-transparent text-center text-text-secondary outline-none focus:bg-surface-2"
        />
        <span>°</span>
        <span className="mx-0.5">/</span>
        <input
          type="text"
          inputMode="decimal"
          value={editSat ?? String(Math.round(range.sat))}
          onFocus={() => setEditSat(String(Math.round(range.sat)))}
          onChange={(e) => {
            setEditSat(e.target.value);
            const n = Number(e.target.value);
            if (e.target.value.trim() !== "" && Number.isFinite(n))
              onChange({ sat: Math.max(0, Math.min(100, n)) });
          }}
          onBlur={() => { setEditSat(null); onCommit(label); }}
          className="w-6 rounded bg-transparent text-center text-text-secondary outline-none focus:bg-surface-2"
        />
      </div>
      <div className="w-full">
        <Slider
          label=""
          compact
          value={range.luma}
          min={-100}
          max={100}
          step={1}
          defaultValue={0}
          onChange={(v) => onChange({ luma: v })}
          onCommit={() => onCommit(label)}
        />
      </div>
    </div>
  );
}

// ─── Panel ───────────────────────────────────────────────────────────────────

export function ColorGradingPanel() {
  const params = useDevelopStore((s) => s.params);
  const setParam = useDevelopStore((s) => s.setParam);
  const commitEdit = useDevelopStore((s) => s.commitEdit);

  const cg = params.colorGrading;

  const updateRange = useCallback(
    (
      key: "shadows" | "midtones" | "highlights" | "global",
      partial: Partial<ColorGradingRange>,
    ) => {
      setParam("colorGrading", {
        ...cg,
        [key]: { ...cg[key], ...partial },
      });
    },
    [cg, setParam],
  );

  const commit = useCallback(
    (label: string) => commitEdit(`Color Grading – ${label}`),
    [commitEdit],
  );

  return (
    <Panel title="Color Grading" defaultOpen={false}>
      {/* 2×2 grid of wheels */}
      <div className="grid grid-cols-2 gap-x-2 gap-y-3">
        <ColorWheel
          label="Shadows"
          lightness={0.35}
          range={cg.shadows}
          onChange={(p) => updateRange("shadows", p)}
          onCommit={commit}
        />
        <ColorWheel
          label="Midtones"
          lightness={0.5}
          range={cg.midtones}
          onChange={(p) => updateRange("midtones", p)}
          onCommit={commit}
        />
        <ColorWheel
          label="Highlights"
          lightness={0.65}
          range={cg.highlights}
          onChange={(p) => updateRange("highlights", p)}
          onCommit={commit}
        />
        <ColorWheel
          label="Global"
          lightness={0.5}
          range={cg.global}
          onChange={(p) => updateRange("global", p)}
          onCommit={commit}
        />
      </div>

      {/* Blend range sliders + reset */}
      <div className="mt-3 border-t border-border-subtle pt-3 space-y-0.5">
        <Slider
          label="Shadow Range"
          value={cg.shadowRange}
          min={0}
          max={100}
          step={1}
          defaultValue={50}
          onChange={(v) =>
            setParam("colorGrading", { ...cg, shadowRange: v })
          }
          onCommit={() => commitEdit("Color Grading – Shadow Range")}
        />
        <Slider
          label="Highlight Range"
          value={cg.highlightRange}
          min={0}
          max={100}
          step={1}
          defaultValue={50}
          onChange={(v) =>
            setParam("colorGrading", { ...cg, highlightRange: v })
          }
          onCommit={() => commitEdit("Color Grading – Highlight Range")}
        />
      </div>
    </Panel>
  );
}
