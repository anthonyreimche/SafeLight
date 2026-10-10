// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, expect, it } from "vitest";
import { encodeCachedPreview } from "./cache-encode";
import { halfToFloat32 } from "./half-float";

describe("encodeCachedPreview", () => {
  // A fresh decode renders from these values directly, so a cached reopen
  // must hand the renderer the same ones: a camera-matrix negative and two
  // highlight channels above 1.0 that Highlights / Exposure pull back.
  it("keeps negative and above-white components through the cache", () => {
    const pixel = new Float32Array([-0.05, 1.5, 1.85, 1]);
    const entry = encodeCachedPreview(pixel, 1, 1, 3072);
    const back = halfToFloat32(entry.data);
    expect(back[0]).toBeCloseTo(-0.05, 3);
    expect(back[1]).toBeCloseTo(1.5, 3);
    expect(back[2]).toBeCloseTo(1.85, 3);
    expect(back[3]).toBe(1);
  });

  it("box-downsamples to the cache's long-edge cap before encoding", () => {
    const data = new Float32Array([
      1.5, -0.1, 0.2, 1,   2.5, 0.1, 0.4, 1,
    ]);
    const entry = encodeCachedPreview(data, 2, 1, 1);
    expect([entry.width, entry.height]).toEqual([1, 1]);
    const back = halfToFloat32(entry.data);
    expect(back[0]).toBeCloseTo(2, 3);
    expect(back[1]).toBeCloseTo(0, 3);
    expect(back[2]).toBeCloseTo(0.3, 3);
  });

  it("stores a source that already fits at its own size", () => {
    const data = new Float32Array(3 * 2 * 4).fill(0.25);
    const entry = encodeCachedPreview(data, 3, 2, 3072);
    expect([entry.width, entry.height]).toEqual([3, 2]);
    expect(entry.data).toHaveLength(24);
  });
});
