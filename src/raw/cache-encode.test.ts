// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, expect, it } from "vitest";
import {
  cacheFileName,
  ENTRY_HEADER_BYTES,
  ENTRY_LAYOUT,
  ENTRY_MAGIC,
  decodeEntryHeader,
  encodeCacheEntry,
  encodeCachedPreview,
  encodeEntryHeader,
} from "./cache-encode";
import { halfToFloat32 } from "./half-float";
import { cutSourceSample } from "@/rendering/source-sample";

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

describe("encodeCacheEntry", () => {
  /** A 6 × 4 frame whose red channel counts its pixels. */
  const frame = () => new Float32Array(6 * 4 * 4).map((_, i) => (i % 4 === 0 ? i / 4 : 1));

  it("holds the downsampled preview beside the frame's own size", () => {
    const entry = encodeCacheEntry(frame(), 6, 4, 3);
    expect([entry.preview.width, entry.preview.height]).toEqual([3, 2]);
    expect(entry.preview.data).toEqual(encodeCachedPreview(frame(), 6, 4, 3).data);
    expect([entry.fullWidth, entry.fullHeight]).toEqual([6, 4]);
  });

  // The live path cuts its sample in setImage with the same function, so a
  // photo opened from the cache measures exactly what a fresh decode would.
  it("cuts the centre sample the live path cuts, from the frame before the downsample", () => {
    const entry = encodeCacheEntry(frame(), 6, 4, 3);
    expect(entry.sample).toEqual(cutSourceSample(frame(), 6, 4));
    expect(entry.sample).toMatchObject({ width: 6, height: 4, x: 0, y: 0, sourceWidth: 6, sourceHeight: 4 });
    expect(halfToFloat32(entry.sample.data)[4 * 7]).toBe(7);
  });
});

describe("entry headers", () => {
  const header = {
    width: 3072,
    height: 2048,
    fullWidth: 6000,
    fullHeight: 4000,
    sample: { width: 1024, height: 1024, x: 2488, y: 1488 },
    previewBytes: 36_000_000,
    keyBytes: 412,
  };

  it("round-trips the layout in 48 bytes behind the magic word, with the length of the key that follows", () => {
    const words = encodeEntryHeader(header);
    expect(words.byteLength).toBe(ENTRY_HEADER_BYTES);
    expect([words[0], words[1]]).toEqual([ENTRY_MAGIC, ENTRY_LAYOUT]);
    expect(decodeEntryHeader(words.buffer)).toEqual(header);
  });

  it("reads a header longer than it needs", () => {
    const bytes = new Uint8Array(100);
    bytes.set(new Uint8Array(encodeEntryHeader(header).buffer));
    expect(decodeEntryHeader(bytes.buffer)).toEqual(header);
  });

  it("is null for an entry from before the key was kept, too short for a header, the magic without its header, and an unknown layout", () => {
    expect(decodeEntryHeader(new Uint32Array([3072, 2048]).buffer)).toBeNull();
    expect(decodeEntryHeader(new Uint8Array(7).buffer)).toBeNull();
    expect(decodeEntryHeader(new Uint32Array([ENTRY_MAGIC, ENTRY_LAYOUT, 3, 2, 0]).buffer)).toBeNull();
    const unknown = encodeEntryHeader(header);
    unknown[1] = ENTRY_LAYOUT + 1;
    expect(decodeEntryHeader(unknown.buffer)).toBeNull();
  });
});

describe("cacheFileName", () => {
  it("is a fixed-length name however long or non-ASCII the key", async () => {
    const deep = `v6:${"写真/".repeat(200)}IMG_0001.NEF:52428800:90`;
    for (const key of ["k", deep]) {
      expect(await cacheFileName(key)).toMatch(/^[0-9a-f]{64}\.bin$/);
    }
  });

  it("names different keys differently and the same key the same", async () => {
    const a = `v6:${"x".repeat(300)}a:1:0`;
    const b = `v6:${"x".repeat(300)}b:1:0`;
    expect(await cacheFileName(a)).not.toBe(await cacheFileName(b));
    expect(await cacheFileName(a)).toBe(await cacheFileName(a));
  });
});
