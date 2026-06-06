// Content-aware fill (PatchMatch-based texture synthesis).
//
// Removes a masked region by synthesising it from real texture taken elsewhere
// in the same image, rather than smoothly interpolating from the boundary (which
// only yields a blurry blob). This is the approach Photoshop/Lightroom heal use:
// for every hole patch find the most similar patch in the known area, then vote
// the centre pixels back in, iterating coarse estimates into sharp texture.
//
// Runs on a small RGBA8 buffer (the caller downscales) so it stays fast; the GPU
// upsamples the result and re-develops it with the rest of the frame.

// Small deterministic PRNG so results are stable between identical calls.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Seed the hole: flood it with the mean of the known pixels, then relax a few
// Jacobi passes so PatchMatch starts from a smooth gradient instead of a flat block.
function diffuseInit(col: Float32Array, hole: Uint8Array, W: number, H: number) {
  const N = W * H;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < N; i++) {
    if (!hole[i]) { r += col[i * 3]; g += col[i * 3 + 1]; b += col[i * 3 + 2]; n++; }
  }
  if (n === 0) return;
  r /= n; g /= n; b /= n;
  for (let i = 0; i < N; i++) {
    if (hole[i]) { col[i * 3] = r; col[i * 3 + 1] = g; col[i * 3 + 2] = b; }
  }
  const tmp = new Float32Array(col.length);
  for (let pass = 0; pass < 12; pass++) {
    tmp.set(col);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (!hole[i]) continue;
        let sr = 0, sg = 0, sb = 0, c = 0;
        if (x > 0) { const j = (i - 1) * 3; sr += tmp[j]; sg += tmp[j + 1]; sb += tmp[j + 2]; c++; }
        if (x < W - 1) { const j = (i + 1) * 3; sr += tmp[j]; sg += tmp[j + 1]; sb += tmp[j + 2]; c++; }
        if (y > 0) { const j = (i - W) * 3; sr += tmp[j]; sg += tmp[j + 1]; sb += tmp[j + 2]; c++; }
        if (y < H - 1) { const j = (i + W) * 3; sr += tmp[j]; sg += tmp[j + 1]; sb += tmp[j + 2]; c++; }
        if (c > 0) { col[i * 3] = sr / c; col[i * 3 + 1] = sg / c; col[i * 3 + 2] = sb / c; }
      }
    }
  }
}

export interface FillOptions {
  patch?: number; // patch radius (window = 2*patch+1)
  iters?: number; // EM iterations
}

export function contentAwareFill(
  rgba: Uint8ClampedArray,
  W: number,
  H: number,
  hole: Uint8Array, // 1 = synthesise this pixel
  opts: FillOptions = {},
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba);
  const P = opts.patch ?? 3;
  const emIters = opts.iters ?? 4;
  const N = W * H;

  const holeIdx: number[] = [];
  for (let i = 0; i < N; i++) if (hole[i]) holeIdx.push(i);
  if (holeIdx.length === 0 || holeIdx.length === N) return out;

  const col = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    col[i * 3] = out[i * 4];
    col[i * 3 + 1] = out[i * 4 + 1];
    col[i * 3 + 2] = out[i * 4 + 2];
  }
  diffuseInit(col, hole, W, H);

  const nnx = new Int32Array(N);
  const nny = new Int32Array(N);
  const rand = mulberry32(0x9e3779b1);

  const randomKnownCenter = (): [number, number] => {
    for (let t = 0; t < 48; t++) {
      const x = P + ((rand() * (W - 2 * P)) | 0);
      const y = P + ((rand() * (H - 2 * P)) | 0);
      if (!hole[y * W + x]) return [x, y];
    }
    return [Math.min(W - P - 1, Math.max(P, W >> 1)), Math.min(H - P - 1, Math.max(P, H >> 1))];
  };
  for (const i of holeIdx) {
    const [x, y] = randomKnownCenter();
    nnx[i] = x;
    nny[i] = y;
  }

  // SSD between the patch around target (tx,ty) and a candidate source (sx,sy),
  // early-out once it exceeds the running best.
  const patchDist = (tx: number, ty: number, sx: number, sy: number, best: number): number => {
    let sum = 0;
    for (let dy = -P; dy <= P; dy++) {
      for (let dx = -P; dx <= P; dx++) {
        const txx = tx + dx, tyy = ty + dy, sxx = sx + dx, syy = sy + dy;
        if (txx < 0 || tyy < 0 || txx >= W || tyy >= H ||
            sxx < 0 || syy < 0 || sxx >= W || syy >= H) { sum += 3 * 255 * 255; continue; }
        const ti = (tyy * W + txx) * 3, si = (syy * W + sxx) * 3;
        const r = col[ti] - col[si];
        const g = col[ti + 1] - col[si + 1];
        const b = col[ti + 2] - col[si + 2];
        sum += r * r + g * g + b * b;
        if (sum >= best) return sum;
      }
    }
    return sum;
  };

  const acc = new Float32Array(N * 3);
  const wgt = new Float32Array(N);

  for (let em = 0; em < emIters; em++) {
    // --- E-step: improve the nearest-neighbour field (PatchMatch) -------------
    for (let dir = 0; dir < 2; dir++) {
      const forward = dir === 0;
      const order = forward ? holeIdx : holeIdx.slice().reverse();
      for (const i of order) {
        const x = i % W, y = (i / W) | 0;
        if (x < P || y < P || x >= W - P || y >= H - P) continue;
        let bx = nnx[i], by = nny[i];
        let bd = patchDist(x, y, bx, by, Infinity);

        // Propagation: try the offset of the already-processed neighbour.
        const n1 = forward ? i - 1 : i + 1;
        const n2 = forward ? i - W : i + W;
        if (n1 >= 0 && n1 < N) {
          const cx = nnx[n1] + (forward ? 1 : -1), cy = nny[n1];
          if (cx >= P && cy >= P && cx < W - P && cy < H - P && !hole[cy * W + cx]) {
            const d = patchDist(x, y, cx, cy, bd);
            if (d < bd) { bd = d; bx = cx; by = cy; }
          }
        }
        if (n2 >= 0 && n2 < N) {
          const cx = nnx[n2], cy = nny[n2] + (forward ? 1 : -1);
          if (cx >= P && cy >= P && cx < W - P && cy < H - P && !hole[cy * W + cx]) {
            const d = patchDist(x, y, cx, cy, bd);
            if (d < bd) { bd = d; bx = cx; by = cy; }
          }
        }

        // Random search: exponentially shrinking window around the best.
        let radius = Math.max(W, H);
        while (radius >= 1) {
          const rx = bx + ((rand() * 2 - 1) * radius) | 0;
          const ry = by + ((rand() * 2 - 1) * radius) | 0;
          radius = (radius / 2) | 0;
          if (rx < P || ry < P || rx >= W - P || ry >= H - P) continue;
          if (hole[ry * W + rx]) continue;
          const d = patchDist(x, y, rx, ry, bd);
          if (d < bd) { bd = d; bx = rx; by = ry; }
        }
        nnx[i] = bx; nny[i] = by;
      }
    }

    // --- M-step: vote source patches back into the hole ----------------------
    acc.fill(0);
    wgt.fill(0);
    for (const i of holeIdx) {
      const x = i % W, y = (i / W) | 0;
      const sx = nnx[i], sy = nny[i];
      for (let dy = -P; dy <= P; dy++) {
        for (let dx = -P; dx <= P; dx++) {
          const txx = x + dx, tyy = y + dy;
          if (txx < 0 || tyy < 0 || txx >= W || tyy >= H) continue;
          const ti = tyy * W + txx;
          if (!hole[ti]) continue;
          const sxx = sx + dx, syy = sy + dy;
          if (sxx < 0 || syy < 0 || sxx >= W || syy >= H) continue;
          const si = (syy * W + sxx) * 3;
          acc[ti * 3] += col[si];
          acc[ti * 3 + 1] += col[si + 1];
          acc[ti * 3 + 2] += col[si + 2];
          wgt[ti] += 1;
        }
      }
    }
    for (const i of holeIdx) {
      const w = wgt[i];
      if (w > 0) {
        col[i * 3] = acc[i * 3] / w;
        col[i * 3 + 1] = acc[i * 3 + 1] / w;
        col[i * 3 + 2] = acc[i * 3 + 2] / w;
      }
    }
  }

  for (const i of holeIdx) {
    out[i * 4] = col[i * 3];
    out[i * 4 + 1] = col[i * 3 + 1];
    out[i * 4 + 2] = col[i * 3 + 2];
    out[i * 4 + 3] = 255;
  }
  return out;
}
