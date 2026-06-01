// Crop composition guide overlays. Each guide is computed in the crop box's
// pixel space (w × h) so the SVG can draw it directly. Press "O" in crop mode
// to cycle; the active guide also has a button in the Crop panel.

export type CropGuide =
  | "thirds"
  | "golden"
  | "diagonal"
  | "triangle"
  | "grid"
  | "spiral";

export const CROP_GUIDES: { id: CropGuide; label: string }[] = [
  { id: "thirds", label: "Thirds" },
  { id: "golden", label: "Golden" },
  { id: "diagonal", label: "Diagonal" },
  { id: "triangle", label: "Triangle" },
  { id: "grid", label: "Grid" },
  { id: "spiral", label: "Spiral" },
];

export function nextGuide(g: CropGuide): CropGuide {
  const i = CROP_GUIDES.findIndex((x) => x.id === g);
  return CROP_GUIDES[(i + 1) % CROP_GUIDES.length].id;
}

export interface GuideShapes {
  lines: { x1: number; y1: number; x2: number; y2: number }[];
  paths: string[]; // SVG path "d" strings (for the spiral)
}

const PHI_LO = 0.5 - 0.5 / Math.sqrt(5); // 0.2764… → 1 - 0.618 (golden ratio)
const PHI_HI = 0.5 + 0.5 / Math.sqrt(5); // 0.7236…

// Foot of the perpendicular from point P to the line through A and B.
function footOnLine(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy);
  return { x: ax + t * dx, y: ay + t * dy };
}

// A golden spiral as a logarithmic-spiral polyline whose radius shrinks by the
// golden ratio every quarter turn, converging on a golden-section "eye". Drawn
// to fill the box; any overshoot is clipped by the SVG viewport.
function goldenSpiralPath(w: number, h: number): string {
  const phi = (1 + Math.sqrt(5)) / 2;
  const cx = w / phi; // eye ≈ 0.618·w
  const cy = h - h / phi; // eye ≈ 0.382·h
  const k = (2 / Math.PI) * Math.log(phi); // r shrinks by φ each quarter turn
  const r0 = Math.hypot(Math.max(cx, w - cx), Math.max(cy, h - cy)) * 1.15;
  const ang0 = Math.atan2(-cy, w - cx); // aim the outer end toward a corner
  const steps = 120;
  const total = 4.5 * (Math.PI / 2); // ~4.5 quarter turns inward
  let d = "";
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * total;
    const r = r0 * Math.exp(-k * t);
    const a = ang0 + t;
    const px = cx + r * Math.cos(a);
    const py = cy + r * Math.sin(a);
    d += `${i === 0 ? "M" : "L"} ${px.toFixed(2)} ${py.toFixed(2)} `;
  }
  return d.trim();
}

export function guideShapes(guide: CropGuide, w: number, h: number): GuideShapes {
  const lines: GuideShapes["lines"] = [];
  const paths: string[] = [];
  const vline = (fx: number) => lines.push({ x1: fx * w, y1: 0, x2: fx * w, y2: h });
  const hline = (fy: number) => lines.push({ x1: 0, y1: fy * h, x2: w, y2: fy * h });

  switch (guide) {
    case "thirds":
      vline(1 / 3);
      vline(2 / 3);
      hline(1 / 3);
      hline(2 / 3);
      break;
    case "golden":
      vline(PHI_LO);
      vline(PHI_HI);
      hline(PHI_LO);
      hline(PHI_HI);
      break;
    case "grid": {
      for (let i = 1; i < 8; i++) vline(i / 8);
      for (let j = 1; j < 8; j++) hline(j / 8);
      break;
    }
    case "diagonal": {
      // 45° lines in from each corner (the "diagonal method").
      const d = Math.min(w, h);
      lines.push({ x1: 0, y1: 0, x2: d, y2: d });
      lines.push({ x1: w, y1: 0, x2: w - d, y2: d });
      lines.push({ x1: 0, y1: h, x2: d, y2: h - d });
      lines.push({ x1: w, y1: h, x2: w - d, y2: h - d });
      break;
    }
    case "triangle": {
      // A main diagonal plus perpendiculars from the opposite corners.
      lines.push({ x1: 0, y1: 0, x2: w, y2: h });
      const f1 = footOnLine(w, 0, 0, 0, w, h);
      lines.push({ x1: w, y1: 0, x2: f1.x, y2: f1.y });
      const f2 = footOnLine(0, h, 0, 0, w, h);
      lines.push({ x1: 0, y1: h, x2: f2.x, y2: f2.y });
      break;
    }
    case "spiral": {
      // Golden phi grid as a reference, plus the spiral curve.
      vline(PHI_LO);
      vline(PHI_HI);
      hline(PHI_LO);
      hline(PHI_HI);
      paths.push(goldenSpiralPath(w, h));
      break;
    }
  }
  return { lines, paths };
}
