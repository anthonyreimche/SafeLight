// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Auto-pick a heal source, plus the rotation, scale and colour shift that make
// the copied patch blend into the spot's surroundings.
//
// Stage 1 searches nearby centres for the one whose ring of surrounding pixels
// best matches the spot's ring (and whose interior is itself clean, so we don't
// drag a second blemish in). Stage 2 refines that centre over a small set of
// rotations and scales using a richer two-ring descriptor, so the source's
// texture/structure lines up with the destination's. Finally we measure the
// mean colour difference of the surroundings and return it as an additive offset
// so the patch is recoloured to match. Runs once per spot on the small
// downscaled source, so it's cheap.

let img: Uint8ClampedArray | null = null;
let iw = 0;
let ih = 0;

export function setHealSourceImage(data: Uint8ClampedArray, w: number, h: number) {
  img = data;
  iw = w;
  ih = h;
}

// Bilinear sample in UV space, clamped to the frame. Returns 0..255 RGB. Bilinear
// (not nearest) so rotation/scale matching is smooth rather than aliased.
function sample(uvx: number, uvy: number): [number, number, number] {
  const fx = Math.min(iw - 1, Math.max(0, uvx * iw - 0.5));
  const fy = Math.min(ih - 1, Math.max(0, uvy * ih - 0.5));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(iw - 1, x0 + 1);
  const y1 = Math.min(ih - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const i00 = (y0 * iw + x0) * 4;
  const i10 = (y0 * iw + x1) * 4;
  const i01 = (y1 * iw + x0) * 4;
  const i11 = (y1 * iw + x1) * 4;
  const out: [number, number, number] = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const a = img![i00 + c] + (img![i10 + c] - img![i00 + c]) * tx;
    const b = img![i01 + c] + (img![i11 + c] - img![i01 + c]) * tx;
    out[c] = a + (b - a) * ty;
  }
  return out;
}

export interface HealSource {
  x: number;
  y: number;
  angle: number; // radians; source rotation applied before copying
  scale: number; // source scale applied before copying
  r: number; // additive colour offset (encoded 0..1 space), source -> dest match
  g: number;
  b: number;
}

// Mean colour offset (encoded 0..1) that shifts a source's surroundings toward
// the destination's. Used when the user drags the source manually, so recolour
// keeps matching without re-running the full search.
export function healColorOffset(
  dstX: number,
  dstY: number,
  srcX: number,
  srcY: number,
  radius: number,
  aspect: number,
): { r: number; g: number; b: number } {
  if (!img || iw === 0 || ih === 0) return { r: 0, g: 0, b: 0 };
  const RING = 12;
  const ringR = Math.max(radius * 1.4, 0.01);
  let dR = 0, dG = 0, dB = 0, sR = 0, sG = 0, sB = 0;
  for (let k = 0; k < RING; k++) {
    const a = (k / RING) * Math.PI * 2;
    const cx = (Math.cos(a) * ringR) / aspect;
    const cy = Math.sin(a) * ringR;
    const [dr, dg, db] = sample(dstX + cx, dstY + cy);
    const [sr, sg, sb] = sample(srcX + cx, srcY + cy);
    dR += dr; dG += dg; dB += db;
    sR += sr; sG += sg; sB += sb;
  }
  const clamp = (v: number) => Math.max(-0.5, Math.min(0.5, v / RING / 255));
  return { r: clamp(dR - sR), g: clamp(dG - sG), b: clamp(dB - sB) };
}

// dstX/dstY/radius are in source-UV space (radius in image-height units); aspect
// is width/height so the search stays circular on screen. Returns the source
// transform, or null if no usable candidate (caller keeps its default).
export function findHealSource(
  dstX: number,
  dstY: number,
  radius: number,
  aspect: number,
): HealSource | null {
  if (!img || iw === 0 || ih === 0) return null;

  const RING = 12;
  const ringR = Math.max(radius * 1.4, 0.01); // just outside the spot
  const RR = [ringR, ringR * 1.85];           // two rings -> a richer match
  const n = RR.length * RING;

  // Destination descriptor (two rings of surrounding pixels) + its mean.
  const dDesc: number[] = [];
  let dMr = 0, dMg = 0, dMb = 0;
  for (const rr of RR) {
    for (let k = 0; k < RING; k++) {
      const a = (k / RING) * Math.PI * 2;
      const [r, g, b] = sample(dstX + (Math.cos(a) * rr) / aspect, dstY + Math.sin(a) * rr);
      dDesc.push(r, g, b);
      dMr += r; dMg += g; dMb += b;
    }
  }
  dMr /= n; dMg /= n; dMb /= n;

  // How structured the spot's surroundings are: the largest swing in the ring
  // around its mean. Small on flat skin, large when the spot sits on an edge.
  let dStruct = 0;
  for (let i = 0; i < dDesc.length; i += 3) {
    dStruct = Math.max(
      dStruct,
      Math.abs(dDesc[i] - dMr),
      Math.abs(dDesc[i + 1] - dMg),
      Math.abs(dDesc[i + 2] - dMb),
    );
  }
  // Reject a candidate only when its interior feature is *stronger* than the
  // structure already around the spot: a stray blemish on flat skin is avoided,
  // but the continuation of an edge the spot lies on is welcomed, not smeared.
  const featureThresh = Math.max(45, dStruct * 1.1);

  // ---- Joint search: centre + rotation + scale together ---------------------
  // Picking the centre first (best identity match) and only then trying rotation
  // is why rotation never engaged: the centre was already the best non-rotated
  // fit, so nothing could beat identity. Instead score every (centre, rotation,
  // scale) together, so a source that lines up only once rotated/scaled can win.
  // The patch is fetched with the inverse transform R(-angle)/scale, exactly as
  // the shader does. Distances start at 2.6x radius: close enough to match, far
  // enough that the copied disc (same radius) can't overlap the spot.
  const ANGLES = [-30, -20, -10, 0, 10, 20, 30].map((d) => (d * Math.PI) / 180);
  const SCALES = [0.85, 0.92, 1.0, 1.09, 1.18];
  const dirs = 24;
  const dists = [2.6, 3.3, 4.1, 5.1, 6.3, 7.8];
  const innerR = radius * 0.5;

  // Descriptor SSD + mean for a transformed source centred at (cx,cy).
  const descAt = (cx: number, cy: number, angle: number, scale: number) => {
    const ca = Math.cos(angle), sa = Math.sin(angle), inv = 1 / scale;
    let err = 0, mr = 0, mg = 0, mb = 0, idx = 0;
    for (const rr of RR) {
      for (let k = 0; k < RING; k++) {
        const a = (k / RING) * Math.PI * 2;
        const dax = Math.cos(a) * rr;
        const day = Math.sin(a) * rr;
        const rx = (ca * dax + sa * day) * inv;
        const ry = (-sa * dax + ca * day) * inv;
        const [r, g, b] = sample(cx + rx / aspect, cy + ry);
        const dr = r - dDesc[idx], dg = g - dDesc[idx + 1], db = b - dDesc[idx + 2];
        err += dr * dr + dg * dg + db * db;
        mr += r; mg += g; mb += b;
        idx += 3;
      }
    }
    return { err, mr: mr / n, mg: mg / n, mb: mb / n };
  };

  type Cand = {
    score: number; x: number; y: number; angle: number; scale: number;
    mr: number; mg: number; mb: number;
  };
  let gBest: Cand | null = null;  // best overall (possibly rotated/scaled)
  let gIdent: Cand | null = null; // best with no rotation/scale (pure copy)
  for (const dm of dists) {
    const dist = radius * dm;
    const prox = 1 + dm * 0.015; // mild preference for nearer sources
    for (let d = 0; d < dirs; d++) {
      const a = (d / dirs) * Math.PI * 2;
      const cx = dstX + (Math.cos(a) * dist) / aspect;
      const cy = dstY + (Math.sin(a) * dist);
      if (cx < 0.02 || cx > 0.98 || cy < 0.02 || cy > 0.98) continue;

      // Identity first; its mean is what the blemish-rejection compares against.
      const id0 = descAt(cx, cy, 0, 1);
      let outlier = 0;
      for (let k = 0; k <= 8; k++) {
        let r: number, g: number, b: number;
        if (k === 8) {
          [r, g, b] = sample(cx, cy);
        } else {
          const ra = (k / 8) * Math.PI * 2;
          [r, g, b] = sample(cx + (Math.cos(ra) * innerR) / aspect, cy + Math.sin(ra) * innerR);
        }
        outlier = Math.max(outlier, Math.abs(r - id0.mr), Math.abs(g - id0.mg), Math.abs(b - id0.mb));
      }
      const over = outlier - featureThresh;
      const penalty = over > 0 ? over * over * 30 : 0;

      const idScore = id0.err * prox + penalty;
      const idCand: Cand = { score: idScore, x: cx, y: cy, angle: 0, scale: 1, mr: id0.mr, mg: id0.mg, mb: id0.mb };
      if (!gIdent || idScore < gIdent.score) gIdent = idCand;
      if (!gBest || idScore < gBest.score) gBest = idCand;

      for (const angle of ANGLES) {
        for (const scale of SCALES) {
          if (angle === 0 && scale === 1) continue;
          const e = descAt(cx, cy, angle, scale);
          const score = e.err * prox + penalty;
          if (!gBest || score < gBest.score) {
            gBest = { score, x: cx, y: cy, angle, scale, mr: e.mr, mg: e.mg, mb: e.mb };
          }
        }
      }
    }
  }
  if (!gIdent || !gBest) return null;

  // Adopt rotation/scale only when it clearly beats the best pure copy (>10%),
  // so isotropic or already-aligned surroundings stay at identity.
  const chosen =
    (gBest.angle !== 0 || gBest.scale !== 1) && gBest.score < gIdent.score * 0.9
      ? gBest
      : gIdent;

  // ---- Recolour: nudge the source's mean toward the destination's ----------
  const clamp = (v: number) => Math.max(-0.5, Math.min(0.5, v));
  return {
    x: chosen.x,
    y: chosen.y,
    angle: chosen.angle,
    scale: chosen.scale,
    r: clamp((dMr - chosen.mr) / 255),
    g: clamp((dMg - chosen.mg) / 255),
    b: clamp((dMb - chosen.mb) / 255),
  };
}
