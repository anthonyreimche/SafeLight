// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The official brush ring (api.develop.BrushCursor): the brush's edge and its
// feathered core, drawn by a canvas tool's overlay at the pointer, or at the
// view's centre while a size slider is dragged. A crop's Aspect or
// Perspective stretches the photo on screen, so a dab that paints round in the
// photo can be an ellipse there: the ring is that ellipse.

import { useMemo } from "react";
import { useDevelopOverlay, type DevelopOverlayState } from "@/extensions/develop-host";

/** A disc as drawn on screen: semi-axes in px, turn in degrees. */
interface ScreenDisc {
  rx: number;
  ry: number;
  angle: number;
}

// A small radius to measure the transform's local scale with; the ring scales
// it to the brush size, so resizing the brush maps nothing.
const PROBE = 0.01;

// The screen ellipse the photo's disc of radius r (photo-height units) at
// (u, v) maps to: its axes are the singular values of the map the disc's two
// radii go through.
function discOnScreen(toScreen: NonNullable<DevelopOverlayState["toScreen"]>, u: number, v: number, r: number, aspect: number): ScreenDisc {
  const c = toScreen(u, v);
  const ex = toScreen(u + r / aspect, v);
  const ey = toScreen(u, v + r);
  const m00 = ex.x - c.x, m01 = ey.x - c.x, m10 = ex.y - c.y, m11 = ey.y - c.y;
  const e = (m00 + m11) / 2, f = (m00 - m11) / 2, g = (m10 + m01) / 2, h = (m10 - m01) / 2;
  const q = Math.hypot(e, h), w = Math.hypot(f, g);
  const angle = ((Math.atan2(g, f) + Math.atan2(h, e)) / 2) * (180 / Math.PI);
  return { rx: q + w, ry: Math.abs(q - w), angle };
}

export interface BrushCursorProps {
  /** The pointer in the overlay's layout px (api.develop.framePoint), or
   *  "centre" for the reference ring a size slider shows; null draws nothing. */
  at: { x: number; y: number } | "centre" | null;
  /** The brush's radius, a share of the photo's height. */
  size: number;
  /** 0 to 1: how much of the radius fades. */
  feather: number;
  /** An erasing (subtracting) brush, drawn red and dashed. */
  erase?: boolean;
}

export function BrushCursor({ at, size, feather, erase = false }: BrushCursorProps) {
  const { rect, toScreen, toImage, imageAspect } = useDevelopOverlay();
  // Px per photo-height unit of a dab at the view's centre: the ring keeps it
  // while it follows the pointer, so a hover maps nothing.
  const scale = useMemo(() => {
    if (!rect || !toScreen || !toImage) return null;
    const c = toImage(rect.x + rect.w / 2, rect.y + rect.h / 2);
    const d = discOnScreen(toScreen, c.x, c.y, PROBE, imageAspect);
    return { rx: d.rx / PROBE, ry: d.ry / PROBE, angle: d.angle };
  }, [rect, toScreen, toImage, imageAspect]);
  if (!at || !rect || !scale) return null;

  const centre = at === "centre";
  const { x, y } = centre ? { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 } : at;
  const ring = (share: number, min: number) => ({
    cx: x,
    cy: y,
    rx: Math.max(min, scale.rx * size * share),
    ry: Math.max(min, scale.ry * size * share),
    transform: `rotate(${scale.angle} ${x} ${y})`,
    fill: "none",
  });
  const colour = erase && !centre ? "#ff6b6b" : "#fff";

  return (
    <svg
      aria-hidden
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", overflow: "visible", pointerEvents: "none" }}
    >
      <g opacity={centre ? 0.8 : 1}>
        <ellipse
          {...ring(1, 3)}
          stroke={colour}
          strokeWidth={1.2}
          strokeDasharray={erase && !centre ? "4 3" : undefined}
          opacity={centre ? 1 : 0.9}
        />
        <ellipse {...ring(1 - feather, 1)} stroke={colour} strokeWidth={0.6} opacity={centre ? 0.5 : 0.4} />
      </g>
    </svg>
  );
}
