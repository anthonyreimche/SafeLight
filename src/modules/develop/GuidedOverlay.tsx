import { useRef, useCallback } from "react";
import type { GuidedLine } from "@/catalog/types";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const HIT = 14;
const LINE_COLOR = "rgba(255,255,255,0.85)";
const HANDLE_COLOR = "#ffffff";

interface GuidedOverlayProps {
  rect: Rect;
  lines: GuidedLine[];
  onChange: (lines: GuidedLine[]) => void;
  onCommit: () => void;
}

function toScreen(nx: number, ny: number, rect: Rect): { sx: number; sy: number } {
  return { sx: rect.x + nx * rect.w, sy: rect.y + ny * rect.h };
}

function toNorm(sx: number, sy: number, rect: Rect): { nx: number; ny: number } {
  return {
    nx: Math.max(0, Math.min(1, (sx - rect.x) / rect.w)),
    ny: Math.max(0, Math.min(1, (sy - rect.y) / rect.h)),
  };
}

export function GuidedOverlay({ rect, lines, onChange, onCommit }: GuidedOverlayProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<{
    lineIdx: number;
    endpoint: "p1" | "p2";
    svgRect: DOMRect;
    origLine: GuidedLine;
  } | null>(null);

  const handleSize = 6;

  const getLocalCoords = useCallback(
    (e: React.PointerEvent) => {
      const dr = dragRef.current;
      if (dr) {
        return { sx: e.clientX - dr.svgRect.left, sy: e.clientY - dr.svgRect.top };
      }
      const svg = svgRef.current;
      if (!svg) return { sx: 0, sy: 0 };
      const r = svg.getBoundingClientRect();
      return { sx: e.clientX - r.left, sy: e.clientY - r.top };
    },
    [],
  );

  const hitTest = useCallback(
    (sx: number, sy: number): { lineIdx: number; endpoint: "p1" | "p2" } | null => {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const p1 = toScreen(line.x1, line.y1, rect);
        const p2 = toScreen(line.x2, line.y2, rect);
        if (Math.hypot(sx - p1.sx, sy - p1.sy) < HIT) return { lineIdx: i, endpoint: "p1" };
        if (Math.hypot(sx - p2.sx, sy - p2.sy) < HIT) return { lineIdx: i, endpoint: "p2" };
      }
      return null;
    },
    [lines, rect],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);

      const svg = svgRef.current;
      if (!svg) return;
      const svgRect = svg.getBoundingClientRect();
      const sx = e.clientX - svgRect.left;
      const sy = e.clientY - svgRect.top;
      const hit = hitTest(sx, sy);

      if (hit) {
        const line = lines[hit.lineIdx];
        dragRef.current = {
          lineIdx: hit.lineIdx,
          endpoint: hit.endpoint,
          svgRect,
          origLine: { ...line },
        };
      } else {
        const norm = toNorm(sx, sy, rect);
        const newLine: GuidedLine = {
          x1: norm.nx,
          y1: norm.ny,
          x2: norm.nx,
          y2: norm.ny,
        };
        const newLines = [...lines, newLine];
        onChange(newLines);
        dragRef.current = {
          lineIdx: newLines.length - 1,
          endpoint: "p2",
          svgRect,
          origLine: newLine,
        };
      }
    },
    [lines, rect, hitTest, onChange],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragRef.current) return;
      e.preventDefault();

      const { lineIdx, endpoint } = dragRef.current;
      const { sx, sy } = getLocalCoords(e);
      const norm = toNorm(sx, sy, rect);
      const updated = [...lines];
      const line = { ...updated[lineIdx] };

      if (endpoint === "p1") {
        line.x1 = norm.nx;
        line.y1 = norm.ny;
      } else {
        line.x2 = norm.nx;
        line.y2 = norm.ny;
      }

      updated[lineIdx] = line;
      onChange(updated);
    },
    [lines, rect, onChange, getLocalCoords],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!dragRef.current) return;
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);

      const { lineIdx } = dragRef.current;
      const line = lines[lineIdx];
      if (line) {
        const len = Math.hypot(
          (line.x2 - line.x1) * rect.w,
          (line.y2 - line.y1) * rect.h,
        );
        if (len < 10) {
          onChange(lines.filter((_, i) => i !== lineIdx));
        }
      }
      dragRef.current = null;
      onCommit();
    },
    [lines, rect, onChange, onCommit],
  );

  const removeLine = useCallback(
    (idx: number) => {
      onChange(lines.filter((_, i) => i !== idx));
      onCommit();
    },
    [lines, onChange, onCommit],
  );

  return (
    <svg
      ref={svgRef}
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "all",
        cursor: "crosshair",
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      {lines.map((line, i) => {
        const p1 = toScreen(line.x1, line.y1, rect);
        const p2 = toScreen(line.x2, line.y2, rect);
        const midX = (p1.sx + p2.sx) / 2;
        const midY = (p1.sy + p2.sy) / 2;

        return (
          <g key={i}>
            <line
              x1={p1.sx}
              y1={p1.sy}
              x2={p2.sx}
              y2={p2.sy}
              stroke={LINE_COLOR}
              strokeWidth={2}
              strokeLinecap="round"
              style={{ pointerEvents: "none" }}
            />
            <circle
              cx={p1.sx}
              cy={p1.sy}
              r={handleSize}
              fill={HANDLE_COLOR}
              stroke="rgba(0,0,0,0.4)"
              strokeWidth={1.5}
              style={{ cursor: "grab", pointerEvents: "all" }}
            />
            <circle
              cx={p2.sx}
              cy={p2.sy}
              r={handleSize}
              fill={HANDLE_COLOR}
              stroke="rgba(0,0,0,0.4)"
              strokeWidth={1.5}
              style={{ cursor: "grab", pointerEvents: "all" }}
            />
            {/* Delete button */}
            <g
              style={{ cursor: "pointer" }}
              onClick={(e) => {
                e.stopPropagation();
                removeLine(i);
              }}
              onPointerDown={(e) => e.stopPropagation()}
            >
              <circle
                cx={midX}
                cy={midY - 14}
                r={7}
                fill="rgba(0,0,0,0.6)"
                stroke="white"
                strokeWidth={0.5}
              />
              <text
                x={midX}
                y={midY - 10.5}
                textAnchor="middle"
                fill="white"
                fontSize={10}
                fontWeight={500}
                style={{ pointerEvents: "none", userSelect: "none" }}
              >
                ×
              </text>
            </g>
          </g>
        );
      })}

      {lines.length === 0 && (
        <text
          x={rect.x + rect.w / 2}
          y={rect.y + rect.h / 2}
          textAnchor="middle"
          fill="rgba(255,255,255,0.6)"
          fontSize={12}
          style={{ pointerEvents: "none", userSelect: "none" }}
        >
          Click and drag to draw guide lines
        </text>
      )}
    </svg>
  );
}
