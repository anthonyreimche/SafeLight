// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Shared R/G/B channel palette so the histogram curves and the tone-curve
// editor stay in sync. Neutral (RGB/luma) swatches live with their component.
export const CHANNEL_RGB: Record<"red" | "green" | "blue", [number, number, number]> = {
  red: [231, 76, 60],
  green: [46, 204, 113],
  blue: [74, 163, 255],
};

const hex = (c: number) => c.toString(16).padStart(2, "0");

export const channelHex = (ch: "red" | "green" | "blue"): string => {
  const [r, g, b] = CHANNEL_RGB[ch];
  return `#${hex(r)}${hex(g)}${hex(b)}`;
};

export const channelRgba = (ch: "red" | "green" | "blue", alpha: number): string => {
  const [r, g, b] = CHANNEL_RGB[ch];
  return `rgba(${r},${g},${b},${alpha})`;
};
