// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The colour maths behind ColourField: the default HSL model it shows a
// colour with, hex in and out, and the eyedropper's patch average.

/** Display-encoded sRGB, 0 to 1. */
export type Rgb = readonly [number, number, number];

export interface Hsl {
  /** Degrees, 0 to 360. */
  hue: number;
  /** Percent, 0 to 100. */
  saturation: number;
  /** Percent, 0 to 100. */
  lightness: number;
}

/** The side of the eyedropper's square sample, as core's other pickers take. */
export const PICK_PATCH = 5;

export function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const s = saturation / 100;
  const l = lightness / 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + hue / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

export function rgbToHsl([r, g, b]: Rgb): Hsl {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { hue: 0, saturation: 0, lightness: l * 100 };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { hue: h * 60, saturation: s * 100, lightness: l * 100 };
}

const byte = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);

export function toHex(rgb: Rgb): string {
  return `#${rgb.map((v) => byte(v).toString(16).padStart(2, "0")).join("")}`;
}

/** `#rrggbb`, `rrggbb` or `#rgb`; null for anything else. */
export function fromHex(text: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text.trim());
  if (!m) return null;
  const digits = m[1].length === 3 ? [...m[1]].map((c) => c + c).join("") : m[1];
  return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16) / 255) as [number, number, number];
}

export function cssRgb(rgb: Rgb): string {
  return `rgb(${rgb.map(byte).join(", ")})`;
}

/** The PICK_PATCH×PICK_PATCH average around (cx, cy) of an RGBA8 frame,
 *  clipped to the frame, as encoded values 0 to 1. */
export function patchAverage(
  data: ArrayLike<number>,
  width: number,
  height: number,
  cx: number,
  cy: number,
): [number, number, number] | null {
  const half = PICK_PATCH >> 1;
  const sum = [0, 0, 0];
  let n = 0;
  for (let y = Math.max(0, cy - half); y <= Math.min(height - 1, cy + half); y++) {
    for (let x = Math.max(0, cx - half); x <= Math.min(width - 1, cx + half); x++) {
      const o = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) sum[c] += data[o + c] / 255;
      n++;
    }
  }
  return n === 0 ? null : [sum[0] / n, sum[1] / n, sum[2] / n];
}
