import { useEffect, useRef, useState } from "react";
import type { HistogramData, ExtendedHistogramData } from "@/rendering/histogram";

type Mode = "luma" | "rgb" | "red" | "green" | "blue";

const MODES: { key: Mode; label: string; active: string }[] = [
  { key: "luma", label: "Lum", active: "#d0d0d0" },
  { key: "rgb", label: "RGB", active: "#d0d0d0" },
  { key: "red", label: "R", active: "#e74c3c" },
  { key: "green", label: "G", active: "#2ecc71" },
  { key: "blue", label: "B", active: "#4aa3ff" },
];

// Tonal zones across the histogram, left (dark) to right (light).
export type HistogramZone =
  | "blacks"
  | "shadows"
  | "exposure"
  | "highlights"
  | "whites";

type Phase = "start" | "move" | "end";


const HIST_MODE_KEY = "sl_histogram_mode";
const HIST_EXT_KEY = "sl_histogram_extended";
const VALID_MODES = new Set<string>(["luma", "rgb", "red", "green", "blue"]);

function readHistMode(): Mode {
  try {
    const v = localStorage.getItem(HIST_MODE_KEY);
    if (v && VALID_MODES.has(v)) return v as Mode;
  } catch {}
  return "luma";
}

function writeHistMode(mode: Mode) {
  try { localStorage.setItem(HIST_MODE_KEY, mode); } catch {}
}

function readHistExtended(): boolean {
  try { return localStorage.getItem(HIST_EXT_KEY) === "1"; } catch { return false; }
}

function writeHistExtended(v: boolean) {
  try { localStorage.setItem(HIST_EXT_KEY, v ? "1" : "0"); } catch {}
}

const ZONES: { zone: HistogramZone; to: number; label: string }[] = [
  { zone: "blacks", to: 0.1, label: "Blacks" },
  { zone: "shadows", to: 0.3, label: "Shadows" },
  { zone: "exposure", to: 0.7, label: "Exposure" },
  { zone: "highlights", to: 0.9, label: "Highlights" },
  { zone: "whites", to: 1.0, label: "Whites" },
];

function zoneAt(frac: number) {
  return ZONES.find((z) => frac < z.to) ?? ZONES[ZONES.length - 1];
}

const H = 76;

export function Histogram({
  data,
  onAdjust,
  onReset,
}: {
  data: HistogramData | null;
  onAdjust?: (zone: HistogramZone, deltaPx: number, phase: Phase) => void;
  onReset?: (zone: HistogramZone) => void;
}) {
  const interactive = !!onAdjust;
  const [mode, setMode] = useState<Mode>(readHistMode);
  const [extended, setExtended] = useState(readHistExtended);
  const [hoverZone, setHoverZone] = useState<HistogramZone | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(220);
  const dragRef = useRef<{ startX: number; zone: HistogramZone } | null>(null);

  useEffect(() => {
    if (!wrapRef.current) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0].contentRect.width;
      if (w > 0) setWidth(Math.round(w));
    });
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = H * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (extended && data?.extended) {
      drawExtendedHistogram(ctx, width, H, data.extended, mode);
    } else {
      drawHistogram(ctx, width, H, data, mode, interactive, hoverZone);
    }
  }, [data, mode, width, interactive, hoverZone, extended]);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!onAdjust || e.button !== 0 || extended) return;
    const frac = e.nativeEvent.offsetX / width;
    const { zone } = zoneAt(frac);
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { startX: e.clientX, zone };
    setHoverZone(zone);
    onAdjust(zone, 0, "start");
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!onAdjust) return;
    const d = dragRef.current;
    if (d) {
      onAdjust(d.zone, e.clientX - d.startX, "move");
    } else if (!extended) {
      setHoverZone(zoneAt(e.nativeEvent.offsetX / width).zone);
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!onAdjust) return;
    const d = dragRef.current;
    dragRef.current = null;
    if (d) onAdjust(d.zone, e.clientX - d.startX, "end");
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!onReset || extended) return;
    onReset(zoneAt(e.nativeEvent.offsetX / width).zone);
  };

  return (
    <div className="border-b border-border-subtle px-3 py-2">
      <div ref={wrapRef} className="w-full">
        <canvas
          ref={canvasRef}
          style={{ width, height: H, cursor: interactive && !extended ? "ew-resize" : "default" }}
          className="w-full rounded bg-surface-0"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onDoubleClick={onDoubleClick}
          onPointerLeave={() => {
            if (!dragRef.current) setHoverZone(null);
          }}
        />
      </div>
      <div className="mt-1.5 flex gap-1">
        {MODES.map((m) => (
          <button
            key={m.key}
            onClick={() => { setMode(m.key); writeHistMode(m.key); }}
            className={`flex-1 rounded py-0.5 text-[9px] font-medium uppercase tracking-wider ${
              mode === m.key
                ? "bg-surface-3"
                : "text-text-muted hover:text-text-secondary"
            }`}
            style={mode === m.key ? { color: m.active } : undefined}
          >
            {m.label}
          </button>
        ))}
        <button
          onClick={() => { const next = !extended; setExtended(next); writeHistExtended(next); }}
          className={`flex-1 rounded py-0.5 text-[9px] font-medium uppercase tracking-wider ${
            extended
              ? "bg-surface-3 text-text-primary"
              : "text-text-muted hover:text-text-secondary"
          }`}
        >
          Ext
        </button>
      </div>
    </div>
  );
}

// Normalize to the tallest bin, ignoring the pure-black/white spikes (0 and 255)
// that would otherwise flatten everything.
function robustMax(bins: Uint32Array): number {
  let m = 1;
  for (let i = 1; i < 255; i++) if (bins[i] > m) m = bins[i];
  return m;
}

function robustMaxFull(bins: Uint32Array): number {
  let m = 1;
  for (let i = 1; i < bins.length - 1; i++) if (bins[i] > m) m = bins[i];
  return m;
}

function fillCurve(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  bins: Uint32Array,
  max: number,
  color: string,
  additive: boolean,
) {
  ctx.fillStyle = color;
  ctx.globalCompositeOperation = additive ? "lighter" : "source-over";
  ctx.beginPath();
  ctx.moveTo(0, h);
  for (let i = 0; i < bins.length; i++) {
    const x = (i / (bins.length - 1)) * w;
    const y = h - Math.min(1, bins[i] / max) * (h - 1);
    ctx.lineTo(x, y);
  }
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fill();
  ctx.globalCompositeOperation = "source-over";
}

function drawHistogram(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  data: HistogramData | null,
  mode: Mode,
  interactive: boolean,
  hoverZone: HistogramZone | null,
) {
  ctx.clearRect(0, 0, w, h);

  // Highlight the hovered/active zone band behind the curves.
  if (interactive && hoverZone) {
    let from = 0;
    for (const z of ZONES) {
      if (z.zone === hoverZone) {
        ctx.fillStyle = "rgba(255,255,255,0.07)";
        ctx.fillRect(from * w, 0, (z.to - from) * w, h);
        break;
      }
      from = z.to;
    }
  }

  if (data) {
    if (mode === "rgb") {
      const max = Math.max(
        robustMax(data.r),
        robustMax(data.g),
        robustMax(data.b),
      );
      fillCurve(ctx, w, h, data.r, max, "rgba(231,76,60,0.7)", true);
      fillCurve(ctx, w, h, data.g, max, "rgba(46,204,113,0.7)", true);
      fillCurve(ctx, w, h, data.b, max, "rgba(74,163,255,0.7)", true);
    } else if (mode === "luma") {
      fillCurve(ctx, w, h, data.luma, robustMax(data.luma), "rgba(208,208,208,0.85)", false);
    } else if (mode === "red") {
      fillCurve(ctx, w, h, data.r, robustMax(data.r), "rgba(231,76,60,0.85)", false);
    } else if (mode === "green") {
      fillCurve(ctx, w, h, data.g, robustMax(data.g), "rgba(46,204,113,0.85)", false);
    } else {
      fillCurve(ctx, w, h, data.b, robustMax(data.b), "rgba(74,163,255,0.85)", false);
    }
  }

  // Zone dividers + label for the interactive control.
  if (interactive) {
    ctx.strokeStyle = "rgba(255,255,255,0.06)";
    ctx.lineWidth = 1;
    for (const z of ZONES) {
      if (z.to >= 1) continue;
      ctx.beginPath();
      ctx.moveTo(z.to * w, 0);
      ctx.lineTo(z.to * w, h);
      ctx.stroke();
    }
    if (hoverZone) {
      const z = ZONES.find((x) => x.zone === hoverZone);
      if (z) {
        ctx.fillStyle = "rgba(224,224,224,0.85)";
        ctx.font = "9px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        const from = ZONES[ZONES.indexOf(z) - 1]?.to ?? 0;
        ctx.fillText(z.label, ((from + z.to) / 2) * w, 3);
      }
    }
  }
}

function drawExtendedHistogram(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  ext: ExtendedHistogramData,
  mode: Mode,
) {
  ctx.clearRect(0, 0, w, h);
  const { rangeMin, rangeMax, clipLow, clipHigh } = ext;
  const range = rangeMax - rangeMin;

  // Position of the 0.0 and 1.0 boundaries in pixel space.
  const x0 = ((0 - rangeMin) / range) * w;
  const x1 = ((1 - rangeMin) / range) * w;

  // Dim the out-of-range regions.
  ctx.fillStyle = "rgba(255,255,255,0.03)";
  ctx.fillRect(0, 0, x0, h);
  ctx.fillRect(x1, 0, w - x1, h);

  if (mode === "rgb") {
    const max = Math.max(robustMaxFull(ext.r), robustMaxFull(ext.g), robustMaxFull(ext.b));
    fillCurve(ctx, w, h, ext.r, max, "rgba(231,76,60,0.7)", true);
    fillCurve(ctx, w, h, ext.g, max, "rgba(46,204,113,0.7)", true);
    fillCurve(ctx, w, h, ext.b, max, "rgba(74,163,255,0.7)", true);
  } else if (mode === "luma") {
    fillCurve(ctx, w, h, ext.luma, robustMaxFull(ext.luma), "rgba(208,208,208,0.85)", false);
  } else if (mode === "red") {
    fillCurve(ctx, w, h, ext.r, robustMaxFull(ext.r), "rgba(231,76,60,0.85)", false);
  } else if (mode === "green") {
    fillCurve(ctx, w, h, ext.g, robustMaxFull(ext.g), "rgba(46,204,113,0.85)", false);
  } else {
    fillCurve(ctx, w, h, ext.b, robustMaxFull(ext.b), "rgba(74,163,255,0.85)", false);
  }

  // Black-point (0.0) and white-point (1.0) boundary lines.
  ctx.strokeStyle = "rgba(255,255,255,0.2)";
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(x0, 0); ctx.lineTo(x0, h);
  ctx.moveTo(x1, 0); ctx.lineTo(x1, h);
  ctx.stroke();
  ctx.setLineDash([]);

  // Clipping indicators at the top corners.
  ctx.font = "8px system-ui, sans-serif";
  ctx.textBaseline = "top";
  if (clipLow > 0.001) {
    ctx.fillStyle = "rgba(100,180,255,0.9)";
    ctx.textAlign = "left";
    ctx.fillText(`${(clipLow * 100).toFixed(1)}%`, 2, 2);
  }
  if (clipHigh > 0.001) {
    ctx.fillStyle = "rgba(255,100,100,0.9)";
    ctx.textAlign = "right";
    ctx.fillText(`${(clipHigh * 100).toFixed(1)}%`, w - 2, 2);
  }
}
