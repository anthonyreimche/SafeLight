// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Per-channel + luma histograms (256 bins each), sampled from a drawable source
// at a small size — plenty of resolution for a histogram and cheap enough to
// recompute live on every develop render.

export interface HistogramData {
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  luma: Uint32Array;
  extended?: ExtendedHistogramData;
}

export interface ExtendedHistogramData {
  r: Uint32Array;
  g: Uint32Array;
  b: Uint32Array;
  luma: Uint32Array;
  rangeMin: number;
  rangeMax: number;
  clipLow: number;
  clipHigh: number;
}

type Source = HTMLCanvasElement | OffscreenCanvas | ImageBitmap;

let scratch: HTMLCanvasElement | null = null;
let scratchCtx: CanvasRenderingContext2D | null = null;

function getCtx(w: number, h: number): CanvasRenderingContext2D | null {
  if (!scratch) {
    scratch = document.createElement("canvas");
    scratchCtx = scratch.getContext("2d", { willReadFrequently: true });
  }
  if (!scratchCtx) return null;
  if (scratch.width !== w) scratch.width = w;
  if (scratch.height !== h) scratch.height = h;
  return scratchCtx;
}

export function computeHistogram(source: Source): HistogramData {
  const r = new Uint32Array(256);
  const g = new Uint32Array(256);
  const b = new Uint32Array(256);
  const luma = new Uint32Array(256);

  const sw = source.width;
  const sh = source.height;
  if (!sw || !sh) return { r, g, b, luma };

  const scale = Math.min(1, 256 / Math.max(sw, sh));
  const w = Math.max(1, Math.round(sw * scale));
  const h = Math.max(1, Math.round(sh * scale));
  const ctx = getCtx(w, h);
  if (!ctx) return { r, g, b, luma };

  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(source, 0, 0, w, h);

  let pixels: Uint8ClampedArray;
  try {
    pixels = ctx.getImageData(0, 0, w, h).data;
  } catch {
    return { r, g, b, luma }; // e.g. a tainted canvas
  }

  for (let i = 0; i < pixels.length; i += 4) {
    const R = pixels[i];
    const G = pixels[i + 1];
    const B = pixels[i + 2];
    r[R]++;
    g[G]++;
    b[B]++;
    luma[(0.2126 * R + 0.7152 * G + 0.0722 * B) | 0]++;
  }
  return { r, g, b, luma };
}
