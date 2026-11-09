// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

/**
 * Bytes that differ between two bakes. Compare bakes with this, not toEqual:
 * vitest's deep equality walks a typed array index by index and takes ~20 s
 * on a 1536² RGBA paint bake, past the browser suite's 15 s timeout.
 */
export function differingBytes(a: Uint8Array, b: Uint8Array): number {
  let differing = Math.abs(a.length - b.length);
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) differing++;
  return differing;
}
