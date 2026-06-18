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

    peaks.push({
      rho: bestR - rhoMax,
      theta: bestT * THETA_STEP,
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

function classifyLines(lines: DetectedLine[]) {
  if (lines.length === 0) return { horizontal: [], vertical: [] };

  const maxVotes = Math.max(...lines.map((l) => l.votes));
  const voteThreshold = maxVotes * 0.15;
  const strong = lines.filter((l) => l.votes >= voteThreshold);

  const HORIZ_RANGE = 30 * (Math.PI / 180);
  const VERT_RANGE = 30 * (Math.PI / 180);

  const horizontal: DetectedLine[] = [];
  const vertical: DetectedLine[] = [];

  for (const line of strong) {
    const t = line.theta;
    if (Math.abs(t - Math.PI / 2) < HORIZ_RANGE) {
      horizontal.push(line);
    } else if (t < VERT_RANGE || t > Math.PI - VERT_RANGE) {
      vertical.push(line);
    }
  }

  return { horizontal, vertical };
}

function weightedMedianAngle(lines: DetectedLine[], refAngle: number): number {
  if (lines.length === 0) return 0;

  const entries = lines.map((l) => ({
    deviation: l.theta - refAngle,
    weight: l.votes,
  }));
  entries.sort((a, b) => a.deviation - b.deviation);

  const totalWeight = entries.reduce((s, e) => s + e.weight, 0);
  let cumWeight = 0;
  for (const e of entries) {
    cumWeight += e.weight;
    if (cumWeight >= totalWeight / 2) return e.deviation;
  }
  return entries[entries.length - 1].deviation;
}

// ── Vanishing point → perspective coefficient ───────────────────────────────

function vanishingPointPerspective(
  verticals: DetectedLine[],
  _w: number,
  h: number,
): number {
  if (verticals.length < 2) return 0;

  const sorted = [...verticals].sort((a, b) => b.votes - a.votes).slice(0, 8);

  let sumX = 0, sumY = 0, count = 0;
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i], b = sorted[j];
      const sinA = Math.sin(a.theta), cosA = Math.cos(a.theta);
      const sinB = Math.sin(b.theta), cosB = Math.cos(b.theta);
      const det = cosA * sinB - sinA * cosB;
      if (Math.abs(det) < 1e-6) continue;
      const ix = (a.rho * sinB - b.rho * sinA) / det;
      const iy = (b.rho * cosA - a.rho * cosB) / det;
      sumX += ix;
      sumY += iy;
      count++;
    }
  }

  if (count === 0) return 0;

  const vpY = sumY / count;
  const imgCenterY = h / 2;
  const relVP = (vpY - imgCenterY) / h;

  const maxCoeff = 0.6;
  const sensitivity = 2.0;
  const raw = Math.tanh(relVP * sensitivity) * maxCoeff;
  return (raw / maxCoeff) * 100;
}

function vanishingPointPerspectiveH(
  horizontals: DetectedLine[],
  w: number,
  _h: number,
): number {
  if (horizontals.length < 2) return 0;

  const sorted = [...horizontals].sort((a, b) => b.votes - a.votes).slice(0, 8);

  let sumX = 0, count = 0;
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i], b = sorted[j];
      const sinA = Math.sin(a.theta), cosA = Math.cos(a.theta);
      const sinB = Math.sin(b.theta), cosB = Math.cos(b.theta);
      const det = cosA * sinB - sinA * cosB;
      if (Math.abs(det) < 1e-6) continue;
      const ix = (a.rho * sinB - b.rho * sinA) / det;
      sumX += ix;
      count++;
    }
  }

  if (count === 0) return 0;

  const vpX = sumX / count;
  const imgCenterX = w / 2;
  const relVP = (vpX - imgCenterX) / w;

  const maxCoeff = 0.6;
  const sensitivity = 2.0;
  const raw = Math.tanh(relVP * sensitivity) * maxCoeff;
  return (raw / maxCoeff) * 100;
}

// ── Upright correction computation ──────────────────────────────────────────

export function computeUprightCorrection(
  lines: DetectedLine[],
  mode: UprightMode,
  w: number,
  h: number,
): UprightResult {
  const { horizontal, vertical } = classifyLines(lines);

  const clampS = (v: number) => Math.max(-20, Math.min(20, v));
  const clampP = (v: number) => Math.max(-100, Math.min(100, v));

  switch (mode) {
    case "level": {
      const deviation = weightedMedianAngle(horizontal, Math.PI / 2);
      return {
        straighten: clampS((deviation * 180) / Math.PI),
        perspectiveV: 0,
        perspectiveH: 0,
      };
    }

    case "vertical": {
      const vertAngle = weightedMedianAngle(vertical, 0);
      const perspV = vanishingPointPerspective(vertical, w, h);
      return {
        straighten: clampS((vertAngle * 180) / Math.PI),
        perspectiveV: clampP(-perspV),
        perspectiveH: 0,
      };
    }

    case "full": {
      const horizDev = weightedMedianAngle(horizontal, Math.PI / 2);
      const vertAngle = weightedMedianAngle(vertical, 0);
      const perspV = vanishingPointPerspective(vertical, w, h);
      const perspH = vanishingPointPerspectiveH(horizontal, w, h);
      const straightenH = (horizDev * 180) / Math.PI;
      const straightenV = (vertAngle * 180) / Math.PI;
      const pV = clampP(-perspV);
      const pH = clampP(-perspH);
      const gv = (pV / 100) * 0.6;
      const gh = (pH / 100) * 0.6;
      const stretchV = 1 / (1 - 0.25 * gv * gv);
      const stretchH = 1 / (1 - 0.25 * gh * gh);
      const distortion = stretchV / stretchH;
      const aspectCorr = (100 * Math.log(1 / distortion)) / Math.log(1.5);
      return {
        straighten: clampS((straightenH + straightenV) / 2),
        perspectiveV: pV,
        perspectiveH: pH,
        aspect: clampP(aspectCorr),
      };
    }

    case "auto": {
      const horizDev = weightedMedianAngle(horizontal, Math.PI / 2);
      const vertAngle = weightedMedianAngle(vertical, 0);
      const perspV = vanishingPointPerspective(vertical, w, h);
      const perspH = vanishingPointPerspectiveH(horizontal, w, h);
      const dampening = 0.75;
      const straightenH = (horizDev * 180) / Math.PI;
      const straightenV = (vertAngle * 180) / Math.PI;
      return {
        straighten: clampS(((straightenH + straightenV) / 2) * dampening),
        perspectiveV: clampP(-perspV * dampening),
        perspectiveH: clampP(-perspH * dampening),
      };
    }

    default:
      return { straighten: 0, perspectiveV: 0, perspectiveH: 0 };
  }
}

// ── Guided mode correction ──────────────────────────────────────────────────

function guidedLineIntersect(
  a: GuidedLine,
  b: GuidedLine,
): { x: number; y: number } | null {
  const dxa = a.x2 - a.x1, dya = a.y2 - a.y1;
  const dxb = b.x2 - b.x1, dyb = b.y2 - b.y1;
  const det = dxa * dyb - dya * dxb;
  if (Math.abs(det) < 1e-10) return null;
  const t = ((b.x1 - a.x1) * dyb - (b.y1 - a.y1) * dxb) / det;
  return { x: a.x1 + t * dxa, y: a.y1 + t * dya };
}

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

  let straighten = 0;
  let perspectiveV = 0;
  let perspectiveH = 0;

  // Straighten from horizontal lines (normalize direction → rightward)
  if (hLines.length >= 1) {
    let totalAngle = 0;
    for (const line of hLines) {
      let dx = (line.x2 - line.x1) * imageAspect;
      let dy = line.y2 - line.y1;
      if (dx < 0) { dx = -dx; dy = -dy; }
      totalAngle += Math.atan2(dy, dx);
    }
    straighten = ((totalAngle / hLines.length) * 180) / Math.PI;
  }

  // Straighten from vertical lines (normalize direction → upward)
  if (vLines.length === 1) {
    let dx = (vLines[0].x2 - vLines[0].x1) * imageAspect;
    let dy = vLines[0].y2 - vLines[0].y1;
    if (dy > 0) { dx = -dx; dy = -dy; }
    const tilt = Math.atan2(dx, -dy);
    straighten += ((tilt * 180) / Math.PI) * 0.5;
  }

  // Vertical perspective: compute VP from vertical line pairs.
  // VP above image center → lines converge upward → perspectiveV > 0 corrects.
  if (vLines.length >= 2) {
    let vpYSum = 0, vpCount = 0;
    for (let i = 0; i < vLines.length; i++) {
      for (let j = i + 1; j < vLines.length; j++) {
        const vp = guidedLineIntersect(vLines[i], vLines[j]);
        if (vp) { vpYSum += vp.y; vpCount++; }
      }
    }
    if (vpCount > 0) {
      const vpY = vpYSum / vpCount;
      const rel = vpY - 0.5;
      if (Math.abs(rel) > 0.01) {
        // gv = 1/(0.5 - vpY) makes top wider when VP is above center
        const gv = 1 / (0.5 - vpY);
        perspectiveV = Math.max(-100, Math.min(100, (gv / 0.6) * 100));
      }
    }

    // Average tilt of vertical lines for straighten contribution
    let totalTilt = 0;
    for (const line of vLines) {
      let dx = (line.x2 - line.x1) * imageAspect;
      let dy = line.y2 - line.y1;
      if (dy > 0) { dx = -dx; dy = -dy; }
      totalTilt += Math.atan2(dx, -dy);
    }
    straighten += ((totalTilt / vLines.length) * 180) / Math.PI * 0.5;
  }

  // Horizontal perspective: compute VP from horizontal line pairs.
  // VP to the right → lines converge right → perspectiveH < 0 corrects.
  if (hLines.length >= 2) {
    let vpXSum = 0, vpCount = 0;
    for (let i = 0; i < hLines.length; i++) {
      for (let j = i + 1; j < hLines.length; j++) {
        const vp = guidedLineIntersect(hLines[i], hLines[j]);
        if (vp) { vpXSum += vp.x; vpCount++; }
      }
    }
    if (vpCount > 0) {
      const vpX = vpXSum / vpCount;
      const rel = vpX - 0.5;
      if (Math.abs(rel) > 0.01) {
        const gh = -1 / ((vpX - 0.5) * imageAspect);
        perspectiveH = Math.max(-100, Math.min(100, (gh / 0.6) * 100));
      }
    }
  }

  return {
    straighten: Math.max(-45, Math.min(45, straighten)),
    perspectiveV,
    perspectiveH,
  };
}
