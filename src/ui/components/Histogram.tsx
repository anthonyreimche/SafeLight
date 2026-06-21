import { useEffect, useRef, useState, useCallback } from "react";
import type { HistogramData } from "@/rendering/histogram";

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
  showClipping = 0,
  onToggleClipping,
  onSetClipping,
}: {
  data: HistogramData | null;
  onAdjust?: (zone: HistogramZone, deltaPx: number, phase: Phase) => void;
  onReset?: (zone: HistogramZone) => void;
  showClipping?: 0 | 1 | 2 | 3;
  onToggleClipping?: () => void;
  onSetClipping?: (mode: 0 | 1 | 2 | 3) => void;
}) {
  const interactive = !!onAdjust;
  const [mode, setMode] = useState<Mode>(readHistMode);
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

  // Smooth animation: lerp displayed bins toward incoming data so the
  // histogram glides rather than jumping. The animation runs at display
  // refresh rate and settles within ~6 frames.
  const displayRef = useRef<{
    r: Float32Array; g: Float32Array; b: Float32Array; luma: Float32Array;
  } | null>(null);
  const targetRef = useRef<HistogramData | null>(null);
  const animRef = useRef<number | null>(null);
  const prevSizeRef = useRef({ w: 0, h: 0 });

  const LERP_RATE = 0.35;

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    if (prevSizeRef.current.w !== width || prevSizeRef.current.h !== H) {
      canvas.width = width * dpr;
      canvas.height = H * dpr;
      prevSizeRef.current = { w: width, h: H };
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const d = displayRef.current;
    const clip = targetRef.current?.extended;
    if (!d) {
      drawHistogram(ctx, width, H, null, mode, interactive, hoverZone, showClipping);
      return;
    }

    const snap: HistogramData = {
      r: u32From(d.r), g: u32From(d.g), b: u32From(d.b), luma: u32From(d.luma),
    };
    drawHistogram(ctx, width, H, snap, mode, interactive, hoverZone, showClipping,
      clip?.clipLow, clip?.clipHigh);
  }, [width, mode, interactive, hoverZone, showClipping]);

  // When new data arrives, set it as the animation target.
  useEffect(() => {
    targetRef.current = data;
    if (data && !displayRef.current) {
      displayRef.current = {
        r: Float32Array.from(data.r),
        g: Float32Array.from(data.g),
        b: Float32Array.from(data.b),
        luma: Float32Array.from(data.luma),
      };
    }
  }, [data]);

  // Animation loop: lerp display toward target, redraw, stop when settled.
  useEffect(() => {
    let running = true;

    const tick = () => {
      if (!running) return;
      const d = displayRef.current;
      const t = targetRef.current;

      if (d && t) {
        const settled =
          lerpBins(d.r, t.r, LERP_RATE) &
          lerpBins(d.g, t.g, LERP_RATE) &
          lerpBins(d.b, t.b, LERP_RATE) &
          lerpBins(d.luma, t.luma, LERP_RATE);
        draw();
        if (!settled) {
          animRef.current = requestAnimationFrame(tick);
          return;
        }
      } else {
        draw();
      }
      animRef.current = null;
    };

    if (animRef.current != null) cancelAnimationFrame(animRef.current);
    animRef.current = requestAnimationFrame(tick);

    return () => {
      running = false;
      if (animRef.current != null) {
        cancelAnimationFrame(animRef.current);
        animRef.current = null;
      }
    };
  }, [data, draw]);

  // Pointer position relative to the canvas, with the live displayed width.
  // Uses clientX/Y + the element rect instead of offsetX/offsetY, which
  // Chromium/Electron mis-scale under non-100% Windows display scaling; `w` is
  // the real on-screen width so fractions are correct even before the
  // ResizeObserver-tracked `width` catches up.
  const localXY = (
    e: React.PointerEvent<HTMLCanvasElement> | React.MouseEvent<HTMLCanvasElement>,
  ) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width || width };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y, w } = localXY(e);
    if (onSetClipping && e.button === 0 && data?.extended) {
      if (y < 16) {
        if (x < w * 0.3 && data.extended.clipLow > 0.001) {
          onSetClipping(((showClipping ^ 1) & 3) as 0 | 1 | 2 | 3);
          return;
        }
        if (x > w * 0.7 && data.extended.clipHigh > 0.001) {
          onSetClipping(((showClipping ^ 2) & 3) as 0 | 1 | 2 | 3);
          return;
        }
      }
    }
    if (!onAdjust || e.button !== 0) return;
    const { zone } = zoneAt(x / w);
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
    } else {
      const { x, w } = localXY(e);
      setHoverZone(zoneAt(x / w).zone);
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!onAdjust) return;
    const d = dragRef.current;
    dragRef.current = null;
    if (d) onAdjust(d.zone, e.clientX - d.startX, "end");
  };

  const onDoubleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!onReset) return;
    const { x, w } = localXY(e);
    onReset(zoneAt(x / w).zone);
  };

  return (
    <div className="border-b border-border-subtle px-3 py-2">
      <div ref={wrapRef} className="w-full">
        <canvas
          ref={canvasRef}
          style={{ width, height: H, cursor: interactive ? "ew-resize" : "default" }}
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
        {onToggleClipping && (
          <button
            onClick={onToggleClipping}
            className={`flex-1 rounded py-0.5 text-[9px] font-medium uppercase tracking-wider ${
              showClipping
                ? "bg-surface-3"
                : "text-text-muted hover:text-text-secondary"
            }`}
            style={showClipping ? { color: "#ff6b6b" } : undefined}
            title="Toggle clipping overlay (J)"
          >
            Clip
          </button>
        )}
      </div>
    </div>
  );
}

// Lerp each bin toward the target. Returns 1 (settled) when all bins are close enough.
function lerpBins(display: Float32Array, target: Uint32Array, rate: number): number {
  let settled = 1;
  for (let i = 0; i < display.length; i++) {
    const d = display[i], t = target[i];
    if (Math.abs(d - t) < 1) {
      display[i] = t;
    } else {
      display[i] = d + (t - d) * rate;
      settled = 0;
    }
  }
  return settled;
}

function u32From(f: Float32Array): Uint32Array {
  const out = new Uint32Array(f.length);
  for (let i = 0; i < f.length; i++) out[i] = f[i];
  return out;
}

// Normalize to the tallest bin, ignoring the pure-black/white spikes (0 and 255)
// that would otherwise flatten everything.
function robustMax(bins: Uint32Array): number {
  let m = 1;
  for (let i = 1; i < 255; i++) if (bins[i] > m) m = bins[i];
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

// Clipping overlay colors (matching the shader).
const CLIP_SHADOW = "rgba(50,77,255,0.9)";
const CLIP_HIGHLIGHT = "rgba(255,50,50,0.9)";
const CLIP_SHADOW_ACTIVE = "rgba(100,140,255,1)";
const CLIP_HIGHLIGHT_ACTIVE = "rgba(255,120,120,1)";
const CLIP_SHADOW_BG = "rgba(50,77,255,0.35)";
const CLIP_HIGHLIGHT_BG = "rgba(255,50,50,0.35)";

function drawHistogram(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  data: HistogramData | null,
  mode: Mode,
  interactive: boolean,
  hoverZone: HistogramZone | null,
  showClipping = 0,
  clipLow?: number,
  clipHigh?: number,
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

  // Clipping percentages (lazy-loaded after params settle).
  const shadowActive = (showClipping & 1) !== 0;
  const highlightActive = (showClipping & 2) !== 0;
  ctx.font = "8px system-ui, sans-serif";
  ctx.textBaseline = "top";
  if (clipLow != null && clipLow > 0.001) {
    const text = `${(clipLow * 100).toFixed(1)}%`;
    if (shadowActive) {
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = CLIP_SHADOW_BG;
      ctx.fillRect(0, 0, tw + 6, 13);
    }
    ctx.fillStyle = shadowActive ? CLIP_SHADOW_ACTIVE : CLIP_SHADOW;
    ctx.textAlign = "left";
    ctx.fillText(text, 2, 2);
  }
  if (clipHigh != null && clipHigh > 0.001) {
    const text = `${(clipHigh * 100).toFixed(1)}%`;
    if (highlightActive) {
      const tw = ctx.measureText(text).width;
      ctx.fillStyle = CLIP_HIGHLIGHT_BG;
      ctx.fillRect(w - tw - 6, 0, tw + 6, 13);
    }
    ctx.fillStyle = highlightActive ? CLIP_HIGHLIGHT_ACTIVE : CLIP_HIGHLIGHT;
    ctx.textAlign = "right";
    ctx.fillText(text, w - 2, 2);
  }
}
