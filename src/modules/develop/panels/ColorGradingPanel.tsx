import { useCallback, useEffect, useRef } from "react";
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

const WHEEL_SIZE = 88; // canvas px
const WHEEL_RADIUS = (WHEEL_SIZE / 2) - 3;
// Sensitivity factor while Shift is held during a wheel drag (precise control).
const WHEEL_FINE = 0.25;

interface ColorWheelProps {
  label: string;
  range: ColorGradingRange;
  onChange: (partial: Partial<ColorGradingRange>) => void;
  onCommit: (label: string) => void;
}

function ColorWheel({ label, range, onChange, onCommit }: ColorWheelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // Separate ref for the background image so we only compute it once.
  const bgRef = useRef<ImageData | null>(null);
  const dragging = useRef(false);
  // Drag anchor: pointer (rx,ry) and value-vector (vx,vy) at drag start / shift toggle.
  const anchor = useRef<{
    rx: number;
    ry: number;
    vx: number;
    vy: number;
    shift: boolean;
  } | null>(null);

  // Build the wheel background once on mount.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const size = WHEEL_SIZE;
    const radius = WHEEL_RADIUS;
    const cx = size / 2;
    const cy = size / 2;
    const img = ctx.createImageData(size, size);

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x - cx;
        const dy = y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > radius) continue;
        const h = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
        const s = dist / radius;
        const [r, g, b] = hslToRgb(h / 360, s, 0.5);
        const i = (y * size + x) * 4;
        img.data[i] = r;
        img.data[i + 1] = g;
        img.data[i + 2] = b;
        img.data[i + 3] = 255;
      }
    }
    bgRef.current = img;
    ctx.putImageData(img, 0, 0);
  }, []); // runs once

  // Redraw handle whenever hue/sat changes.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !bgRef.current) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.putImageData(bgRef.current, 0, 0);

    // Draw a thin border ring on the wheel edge.
    const cx = WHEEL_SIZE / 2;
    const cy = WHEEL_SIZE / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, WHEEL_RADIUS, 0, 2 * Math.PI);
    ctx.strokeStyle = "rgba(0,0,0,0.4)";
    ctx.lineWidth = 1;
    ctx.stroke();

    // Handle position.
    const hRad = (range.hue * Math.PI) / 180;
    const hx = cx + (range.sat / 100) * WHEEL_RADIUS * Math.cos(hRad);
    const hy = cy + (range.sat / 100) * WHEEL_RADIUS * Math.sin(hRad);

    // White outer ring.
    ctx.beginPath();
    ctx.arc(hx, hy, 5, 0, 2 * Math.PI);
    ctx.fillStyle = "white";
    ctx.fill();
    // Black inner dot.
    ctx.beginPath();
    ctx.arc(hx, hy, 3, 0, 2 * Math.PI);
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fill();
  }, [range.hue, range.sat]);

  // Pointer position in canvas space, relative to the wheel center.
  const relPointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      rx: (e.clientX - rect.left) * (WHEEL_SIZE / rect.width) - WHEEL_SIZE / 2,
      ry: (e.clientY - rect.top) * (WHEEL_SIZE / rect.height) - WHEEL_SIZE / 2,
    };
  };

  // Current handle vector (center-relative) derived from hue + saturation.
  const valueVec = () => {
    const r = (range.sat / 100) * WHEEL_RADIUS;
    const a = (range.hue * Math.PI) / 180;
    return { vx: Math.cos(a) * r, vy: Math.sin(a) * r };
  };

  // Push a center-relative vector back out as hue + saturation.
  const applyVec = (vx: number, vy: number) => {
    const dist = Math.sqrt(vx * vx + vy * vy);
    const newHue = ((Math.atan2(vy, vx) * 180) / Math.PI + 360) % 360;
    const newSat = Math.min(dist / WHEEL_RADIUS, 1) * 100;
    onChange({ hue: newHue, sat: newSat });
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragging.current = true;
    const { rx, ry } = relPointer(e);
    const { vx, vy } = valueVec();
    anchor.current = { rx, ry, vx, vy, shift: e.shiftKey };
    // Fine: keep the current value and move relative to it (no jump). Coarse: jump
    // the handle straight to the pointer.
    if (e.shiftKey) applyVec(vx, vy);
    else applyVec(rx, ry);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragging.current || !anchor.current) return;
    const a = anchor.current;
    const { rx, ry } = relPointer(e);
    // Re-anchor when Shift toggles mid-drag so the sensitivity change is seamless.
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

  const onPointerUp = (_e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    anchor.current = null;
    onCommit(label);
  };

  // Double-click resets hue+sat to zero.
  const onDoubleClick = () => {
    onChange({ hue: 0, sat: 0 });
    onCommit(label);
  };

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
      <div className="w-full">
        <Slider
          label="Luma"
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
          range={cg.shadows}
          onChange={(p) => updateRange("shadows", p)}
          onCommit={commit}
        />
        <ColorWheel
          label="Midtones"
          range={cg.midtones}
          onChange={(p) => updateRange("midtones", p)}
          onCommit={commit}
        />
        <ColorWheel
          label="Highlights"
          range={cg.highlights}
          onChange={(p) => updateRange("highlights", p)}
          onCommit={commit}
        />
        <ColorWheel
          label="Global"
          range={cg.global}
          onChange={(p) => updateRange("global", p)}
          onCommit={commit}
        />
      </div>

      {/* Blend range sliders */}
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
          label="Hi Range"
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
