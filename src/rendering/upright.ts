import type { UprightMode, GuidedLine } from "@/catalog/types";

interface DetectedLine {
  rho: number;
  theta: number; // radians, 0 = vertical, π/2 = horizontal
  votes: number;
}

export interface UprightResult {
  straighten: number; // degrees
  perspectiveV: number; // -100..100
  perspectiveH: number; // -100..100
  aspect?: number; // only set by Full mode
}

// ── Grayscale + blur ────────────────────────────────────────────────────────

function toGrayscale(rgba: Uint8Array | Uint8ClampedArray, w: number, h: number): Float32Array {
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    gray[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  return gray;
}

function gaussianBlur3x3(src: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h);
  const k = [1, 2, 1, 2, 4, 2, 1, 2, 1];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let sum = 0;
      for (let ky = -1; ky <= 1; ky++) {
        for (let kx = -1; kx <= 1; kx++) {
          sum += src[(y + ky) * w + (x + kx)] * k[(ky + 1) * 3 + (kx + 1)];
        }
      }
      out[y * w + x] = sum / 16;
    }
  }
  return out;
}

// ── Sobel edge detection ────────────────────────────────────────────────────

interface EdgeMap {
  magnitude: Float32Array;
  angle: Float32Array;
  w: number;
  h: number;
}

function sobelEdges(gray: Float32Array, w: number, h: number): EdgeMap {
  const mag = new Float32Array(w * h);
  const ang = new Float32Array(w * h);

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const tl = gray[(y - 1) * w + (x - 1)];
      const tc = gray[(y - 1) * w + x];
      const tr = gray[(y - 1) * w + (x + 1)];
      const ml = gray[y * w + (x - 1)];
      const mr = gray[y * w + (x + 1)];
      const bl = gray[(y + 1) * w + (x - 1)];
      const bc = gray[(y + 1) * w + x];
      const br = gray[(y + 1) * w + (x + 1)];

      const gx = -tl + tr - 2 * ml + 2 * mr - bl + br;
      const gy = -tl - 2 * tc - tr + bl + 2 * bc + br;

      mag[y * w + x] = Math.sqrt(gx * gx + gy * gy);
      ang[y * w + x] = Math.atan2(gy, gx);
    }
  }

  return { magnitude: mag, angle: ang, w, h };
}

// ── Non-maximum suppression ─────────────────────────────────────────────────

function nonMaxSuppression(edges: EdgeMap): Float32Array {
  const { magnitude: mag, angle: ang, w, h } = edges;
  const out = new Float32Array(w * h);

  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const m = mag[i];
      if (m === 0) continue;

      let a = ang[i];
      if (a < 0) a += Math.PI;

      let n1: number, n2: number;
      if (a < Math.PI / 8 || a >= (7 * Math.PI) / 8) {
        n1 = mag[y * w + (x - 1)];
        n2 = mag[y * w + (x + 1)];
      } else if (a < (3 * Math.PI) / 8) {
        n1 = mag[(y - 1) * w + (x + 1)];
        n2 = mag[(y + 1) * w + (x - 1)];
      } else if (a < (5 * Math.PI) / 8) {
        n1 = mag[(y - 1) * w + x];
        n2 = mag[(y + 1) * w + x];
      } else {
        n1 = mag[(y - 1) * w + (x - 1)];
        n2 = mag[(y + 1) * w + (x + 1)];
      }

      out[i] = m >= n1 && m >= n2 ? m : 0;
    }
  }

  return out;
}

// ── Adaptive threshold ──────────────────────────────────────────────────────

function adaptiveThreshold(suppressed: Float32Array, w: number, h: number): Uint8Array {
  let maxMag = 0;
  for (let i = 0; i < suppressed.length; i++) {
    if (suppressed[i] > maxMag) maxMag = suppressed[i];
  }

  const highThresh = maxMag * 0.1;
  const lowThresh = highThresh * 0.3;

  const edges = new Uint8Array(w * h);
  for (let i = 0; i < suppressed.length; i++) {
    edges[i] = suppressed[i] >= highThresh ? 2 : suppressed[i] >= lowThresh ? 1 : 0;
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (edges[i] !== 1) continue;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (edges[(y + dy) * w + (x + dx)] === 2) {
              edges[i] = 2;
              changed = true;
              break;
            }
          }
          if (edges[i] === 2) break;
        }
      }
    }
  }

  for (let i = 0; i < edges.length; i++) {
    edges[i] = edges[i] === 2 ? 1 : 0;
  }

  return edges;
}

// ── Hough line transform ────────────────────────────────────────────────────

const THETA_STEP = 0.5 * (Math.PI / 180); // 0.5° bins
const THETA_BINS = Math.ceil(Math.PI / THETA_STEP);

function houghLines(
  edges: Uint8Array,
  w: number,
  h: number,
  maxLines: number,
): DetectedLine[] {
  const diag = Math.sqrt(w * w + h * h);
  const rhoMax = Math.ceil(diag);
  const rhoSize = 2 * rhoMax + 1;

  const sinTable = new Float32Array(THETA_BINS);
  const cosTable = new Float32Array(THETA_BINS);
  for (let ti = 0; ti < THETA_BINS; ti++) {
    const t = ti * THETA_STEP;
    sinTable[ti] = Math.sin(t);
    cosTable[ti] = Math.cos(t);
  }

  const acc = new Int32Array(rhoSize * THETA_BINS);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!edges[y * w + x]) continue;
      for (let ti = 0; ti < THETA_BINS; ti++) {
        const rho = Math.round(x * cosTable[ti] + y * sinTable[ti]) + rhoMax;
        acc[rho * THETA_BINS + ti]++;
      }
    }
  }

  const peaks: DetectedLine[] = [];
  const suppressRadius = 10;

  for (let n = 0; n < maxLines; n++) {
    let bestVal = 0, bestR = 0, bestT = 0;
    for (let ri = 0; ri < rhoSize; ri++) {
      for (let ti = 0; ti < THETA_BINS; ti++) {
        if (acc[ri * THETA_BINS + ti] > bestVal) {
          bestVal = acc[ri * THETA_BINS + ti];
          bestR = ri;
          bestT = ti;
        }
      }
    }

    const minVotes = Math.max(10, Math.round(Math.sqrt(w * h) * 0.03));
    if (bestVal < minVotes) break;

    // Sub-bin refinement: fit a parabola to the peak and its two neighbors in
    // each axis. Keystone correction hinges on sub-degree convergence angles,
    // far finer than the 0.5° bin; without this the angle snaps to the bin
    // centre and the vanishing point (and its sign) can be wrong. Offsets are
    // bounded to ±0.5 bin.
    const parabolicOffset = (a: number, b: number, c: number): number => {
      const denom = a - 2 * b + c;
      if (denom === 0) return 0;
      return Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom));
    };
    let dT = 0;
    if (bestT > 0 && bestT < THETA_BINS - 1) {
      dT = parabolicOffset(
        acc[bestR * THETA_BINS + bestT - 1],
        bestVal,
        acc[bestR * THETA_BINS + bestT + 1],
      );
    }
    let dR = 0;
    if (bestR > 0 && bestR < rhoSize - 1) {
      dR = parabolicOffset(
        acc[(bestR - 1) * THETA_BINS + bestT],
        bestVal,
        acc[(bestR + 1) * THETA_BINS + bestT],
      );
    }

    peaks.push({
      rho: bestR + dR - rhoMax,
      theta: (bestT + dT) * THETA_STEP,
      votes: bestVal,
    });

    for (let ri = Math.max(0, bestR - suppressRadius); ri <= Math.min(rhoSize - 1, bestR + suppressRadius); ri++) {
      for (let ti = Math.max(0, bestT - suppressRadius); ti <= Math.min(THETA_BINS - 1, bestT + suppressRadius); ti++) {
        acc[ri * THETA_BINS + ti] = 0;
      }
    }
  }

  return peaks;
}

// ── Line classification ─────────────────────────────────────────────────────

export function detectLines(
  rgba: Uint8Array | Uint8ClampedArray,
  w: number,
  h: number,
): DetectedLine[] {
  const gray = toGrayscale(rgba, w, h);
  const blurred = gaussianBlur3x3(gray, w, h);
  const edges = sobelEdges(blurred, w, h);
  const suppressed = nonMaxSuppression(edges);
  const edgeMask = adaptiveThreshold(suppressed, w, h);
  return houghLines(edgeMask, w, h, 40);
}

function classifyLines(lines: DetectedLine[], w: number, h: number) {
  if (lines.length === 0) return { horizontal: [], vertical: [] };

  const maxVotes = Math.max(...lines.map((l) => l.votes));
  const voteThreshold = maxVotes * 0.15;
  const strong = lines.filter((l) => l.votes >= voteThreshold);

  const HORIZ_RANGE = 30 * (Math.PI / 180);
  const VERT_RANGE = 30 * (Math.PI / 180);
  // The render buffer is flush to the image edge, so the frame itself shows up
  // as four strong axis-aligned lines (x≈0/w, y≈0/h). Two such lines with a
  // sub-degree θ difference fabricate a far-off vanishing point and a phantom
  // keystone. Drop any line that runs along the image border.
  const marginX = Math.max(3, w * 0.02);
  const marginY = Math.max(3, h * 0.02);

  const horizontal: DetectedLine[] = [];
  const vertical: DetectedLine[] = [];

  for (const line of strong) {
    const t = line.theta;
    const sin = Math.sin(t), cos = Math.cos(t);
    if (Math.abs(t - Math.PI / 2) < HORIZ_RANGE) {
      // y where the line crosses the vertical centerline (x = w/2).
      const y = (line.rho - (w / 2) * cos) / sin;
      if (y < marginY || y > h - marginY) continue;
      horizontal.push(line);
    } else if (t < VERT_RANGE || t > Math.PI - VERT_RANGE) {
      // x where the line crosses the horizontal centerline (y = h/2).
      const x = (line.rho - (h / 2) * sin) / cos;
      if (x < marginX || x > w - marginX) continue;
      vertical.push(line);
    }
  }

  return { horizontal, vertical };
}

// ── Vanishing point → perspective coefficient ───────────────────────────────

// Convert a Hough line (ρ, θ in pixels) to the normalized [0,1] endpoint form
// used by the guided pipeline, so detected and hand-drawn lines run through the
// exact same vanishing-point math. Each axis is normalized independently
// (x/w, y/h); the guided gh formula reapplies the aspect ratio.
function houghToGuidedLine(l: DetectedLine, w: number, h: number): GuidedLine {
  const c = Math.cos(l.theta), s = Math.sin(l.theta);
  const px = l.rho * c, py = l.rho * s; // foot of the perpendicular
  const dx = -s, dy = c;                // direction along the line
  const len = Math.hypot(w, h);
  return {
    x1: (px - len * dx) / w, y1: (py - len * dy) / h,
    x2: (px + len * dx) / w, y2: (py + len * dy) / h,
  };
}

// Theil–Sen slope of (x → y) samples: the median of all pairwise slopes. Robust
// to a misdetected line (one bad slope can't drag the median the way it drags a
// least-squares fit), which matters because a single outlier among the detected
// lines would otherwise fabricate a keystone. Null if no pair has x-spread.
function regressionSlope(pts: { x: number; y: number }[]): number | null {
  const slopes: number[] = [];
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[j].x - pts[i].x;
      if (Math.abs(dx) < 1e-6) continue;
      slopes.push((pts[j].y - pts[i].y) / dx);
    }
  }
  if (slopes.length === 0) return null;
  slopes.sort((a, b) => a - b);
  const m = Math.floor(slopes.length / 2);
  return slopes.length % 2 ? slopes[m] : (slopes[m - 1] + slopes[m]) / 2;
}

// Keystone coefficient from a converging line family by regressing each line's
// normalized slope against its position. Converging lines have slope varying
// linearly with position, so the regression slope is exactly the keystone
// coefficient (1/(centre−VP)). Parallel lines → slope 0 → no correction, with
// per-line angle noise averaging out instead of fabricating a phantom VP.
// `axis` = "x" for horizontal lines (slope dy/dx vs. y) or "y" for vertical
// lines (slope dx/dy vs. x). All in normalized [0,1] coords.
function keystoneSlope(lines: GuidedLine[], axis: "x" | "y"): number | null {
  const pts: { x: number; y: number }[] = [];
  for (const l of lines) {
    const dx = l.x2 - l.x1, dy = l.y2 - l.y1;
    if (axis === "x") {
      if (Math.abs(dx) < 1e-9) continue;
      pts.push({ x: l.y1 + (dy * (0.5 - l.x1)) / dx, y: dy / dx }); // (y@x=.5, dy/dx)
    } else {
      if (Math.abs(dy) < 1e-9) continue;
      pts.push({ x: l.x1 + (dx * (0.5 - l.y1)) / dy, y: dx / dy }); // (x@y=.5, dx/dy)
    }
  }
  return pts.length === 0 ? null : regressionSlope(pts);
}

// Shared upright core. Computes straighten + keystone from already-classified
// horizontal and vertical lines (normalized endpoints). Both the guided mode
// and every auto mode call this; they differ only in which lines they feed it.
function guidedCore(
  hLines: GuidedLine[],
  vLines: GuidedLine[],
  imageAspect: number,
): UprightResult {
  const clamp100 = (v: number) => Math.max(-100, Math.min(100, v));
  let perspectiveV = 0;
  let perspectiveH = 0;

  // Rotation: both families estimate the SAME roll, so compute each from the
  // mean line tilt and AVERAGE — never sum, or modes that see both (Auto/Full)
  // double it relative to Level/Vert which see one. The mean tilt carries a mild
  // convergence bias, but it is stable on real, unevenly distributed detected
  // lines (unlike extrapolating a regression to image centre).
  let straightenH: number | null = null;
  let straightenV: number | null = null;

  // Straighten from horizontal lines (normalize direction → rightward).
  if (hLines.length >= 1) {
    let total = 0;
    for (const line of hLines) {
      let dx = (line.x2 - line.x1) * imageAspect;
      let dy = line.y2 - line.y1;
      if (dx < 0) { dx = -dx; dy = -dy; }
      total += Math.atan2(dy, dx);
    }
    straightenH = ((total / hLines.length) * 180) / Math.PI;
  }

  // Straighten from vertical lines (normalize direction → upward).
  if (vLines.length >= 1) {
    let total = 0;
    for (const line of vLines) {
      let dx = (line.x2 - line.x1) * imageAspect;
      let dy = line.y2 - line.y1;
      if (dy > 0) { dx = -dx; dy = -dy; }
      total += Math.atan2(dx, -dy);
    }
    straightenV = ((total / vLines.length) * 180) / Math.PI;
  }

  let straighten = 0;
  if (straightenH !== null && straightenV !== null) {
    straighten = (straightenH + straightenV) / 2;
  } else if (straightenH !== null) {
    straighten = straightenH;
  } else if (straightenV !== null) {
    straighten = straightenV;
  }

  // Vertical perspective: regression slope IS the gv keystone coefficient.
  if (vLines.length >= 2) {
    const gv = keystoneSlope(vLines, "y");
    if (gv !== null) perspectiveV = clamp100((gv / 0.6) * 100);
  }

  // Horizontal perspective: slope is gh in square space; /aspect normalizes it.
  if (hLines.length >= 2) {
    const sh = keystoneSlope(hLines, "x");
    if (sh !== null) perspectiveH = clamp100((sh / imageAspect / 0.6) * 100);
  }

  return {
    straighten: Math.max(-45, Math.min(45, straighten)),
    perspectiveV,
    perspectiveH,
  };
}

// ── Upright correction computation ──────────────────────────────────────────

export function computeUprightCorrection(
  lines: DetectedLine[],
  mode: UprightMode,
  w: number,
  h: number,
): UprightResult {
  const { horizontal, vertical } = classifyLines(lines, w, h);
  const aspect = w / h;
  // Keep only the strongest lines per axis. Detection emits echoes and raster
  // artifacts alongside the real architectural lines; those spurious peaks have
  // far fewer votes, and including them poisons the vanishing-point median.
  const strongest = (arr: DetectedLine[]) =>
    [...arr].sort((a, b) => b.votes - a.votes).slice(0, 8);
  const hLines = strongest(horizontal).map((l) => houghToGuidedLine(l, w, h));
  const vLines = strongest(vertical).map((l) => houghToGuidedLine(l, w, h));

  const clampS = (v: number) => Math.max(-20, Math.min(20, v));
  const clampP = (v: number) => Math.max(-100, Math.min(100, v));

  switch (mode) {
    case "level": {
      // Horizontal lines only — straighten to the horizon, no perspective.
      const c = guidedCore(hLines, [], aspect);
      return { straighten: clampS(c.straighten), perspectiveV: 0, perspectiveH: 0 };
    }

    case "vertical": {
      // Vertical lines only — correct vertical convergence and tilt.
      const c = guidedCore([], vLines, aspect);
      return {
        straighten: clampS(c.straighten),
        perspectiveV: clampP(c.perspectiveV),
        perspectiveH: 0,
      };
    }

    case "auto": {
      // Both axes — straighten plus vertical and horizontal keystone.
      const c = guidedCore(hLines, vLines, aspect);
      return {
        straighten: clampS(c.straighten),
        perspectiveV: clampP(c.perspectiveV),
        perspectiveH: clampP(c.perspectiveH),
      };
    }

    case "full": {
      // Auto plus aspect compensation for the keystone-induced stretch.
      const c = guidedCore(hLines, vLines, aspect);
      const pV = clampP(c.perspectiveV);
      const pH = clampP(c.perspectiveH);
      const gv = (pV / 100) * 0.6;
      const gh = (pH / 100) * 0.6;
      const stretchV = 1 / (1 - 0.25 * gv * gv);
      const stretchH = 1 / (1 - 0.25 * gh * gh);
      const distortion = stretchV / stretchH;
      const aspectCorr = (100 * Math.log(1 / distortion)) / Math.log(1.5);
      return {
        straighten: clampS(c.straighten),
        perspectiveV: pV,
        perspectiveH: pH,
        aspect: clampP(aspectCorr),
      };
    }

    default:
      return { straighten: 0, perspectiveV: 0, perspectiveH: 0 };
  }
}

// ── Guided mode correction ──────────────────────────────────────────────────

export function computeGuidedCorrection(
  guidedLines: GuidedLine[],
  imageAspect: number,
): UprightResult {
  if (guidedLines.length === 0) {
    return { straighten: 0, perspectiveV: 0, perspectiveH: 0 };
  }

  const HORIZ_THRESHOLD = Math.PI / 4;
  const hLines: GuidedLine[] = [];
  const vLines: GuidedLine[] = [];

  for (const line of guidedLines) {
    const dx = (line.x2 - line.x1) * imageAspect;
    const dy = line.y2 - line.y1;
    const angle = Math.abs(Math.atan2(dy, dx));
    if (angle < HORIZ_THRESHOLD || angle > Math.PI - HORIZ_THRESHOLD) {
      hLines.push(line);
    } else {
      vLines.push(line);
    }
  }

  return guidedCore(hLines, vLines, imageAspect);
}
