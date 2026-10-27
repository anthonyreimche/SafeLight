// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The develop-preview cache's write encoding and entry layout, kept apart from
// cache-worker.ts (whose module scope is the worker's message loop) so they can
// be tested directly. An entry holds the preview, scene-linear RGBA as half
// floats box-averaged to the cache's edge (the same values the fresh float
// decode renders from, headroom and negatives included), the decoded frame's
// size, and the frame's centre at native resolution (source-sample.ts), so a
// photo opened from the cache measures what a fresh decode would.

import { encodeHalf } from "./half-float";
import { cutSourceSample, type StoredSample } from "@/rendering/source-sample";

function downsampleFloatRGBA(
  data: Float32Array,
  W: number,
  H: number,
  maxEdge: number,
): { data: Float32Array; width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(W, H));
  if (scale >= 1) return { data, width: W, height: H };
  const w = Math.max(1, Math.round(W * scale));
  const h = Math.max(1, Math.round(H * scale));
  const out = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor((y * H) / h);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * H) / h));
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor((x * W) / w);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * W) / w));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const si = (sy * W + sx) * 4;
          r += data[si]; g += data[si + 1]; b += data[si + 2]; a += data[si + 3]; n++;
        }
      }
      const di = (y * w + x) * 4;
      out[di] = r / n; out[di + 1] = g / n; out[di + 2] = b / n; out[di + 3] = a / n;
    }
  }
  return { data: out, width: w, height: h };
}

export function encodeCachedPreview(
  data: Float32Array,
  width: number,
  height: number,
  maxEdge: number,
): { data: Uint16Array<ArrayBuffer>; width: number; height: number } {
  const ds = downsampleFloatRGBA(data, width, height, maxEdge);
  return { data: encodeHalf(ds.data), width: ds.width, height: ds.height };
}

export interface EncodedEntry {
  preview: { data: Uint16Array<ArrayBuffer>; width: number; height: number };
  /** The decoded frame's size, as handed to the write (after rotation). */
  fullWidth: number;
  fullHeight: number;
  sample: StoredSample;
}

/** Everything a cache entry holds, from the decoded frame. */
export function encodeCacheEntry(
  data: Float32Array,
  width: number,
  height: number,
  maxEdge: number,
): EncodedEntry {
  return {
    preview: encodeCachedPreview(data, width, height, maxEdge),
    fullWidth: width,
    fullHeight: height,
    sample: cutSourceSample(data, width, height),
  };
}

// A folder entry's header. Builds before 3.1.0 wrote [width, height] and one
// gzip stream; the magic word, a value no preview width can take, marks the
// layout that also keeps the frame's size and the sample, each stream on its
// own so a read that doesn't want the sample never decompresses it.
export const ENTRY_MAGIC = 0xffffffff;
export const ENTRY_LAYOUT = 1;
const ENTRY_HEADER_WORDS = 11;
export const ENTRY_HEADER_BYTES = ENTRY_HEADER_WORDS * 4;
export const LEGACY_HEADER_BYTES = 8;

export interface EntryHeader {
  width: number;
  height: number;
  fullWidth: number;
  fullHeight: number;
  sample: { width: number; height: number; x: number; y: number };
  /** The preview's gzip stream's length; the sample's runs to the end. */
  previewBytes: number;
}

export type DecodedHeader = EntryHeader | { legacy: { width: number; height: number } };

export function encodeEntryHeader(h: EntryHeader): Uint32Array<ArrayBuffer> {
  return new Uint32Array([
    ENTRY_MAGIC, ENTRY_LAYOUT,
    h.width, h.height,
    h.fullWidth, h.fullHeight,
    h.sample.width, h.sample.height, h.sample.x, h.sample.y,
    h.previewBytes,
  ]);
}

/** The header at a folder entry's start, from its first bytes (44 or more
 *  when available): the new layout, the one before 3.1.0, or null for a file
 *  too short for either, a magic word without its header, or a layout this
 *  build doesn't know (a later build's), all of which read as a miss. */
export function decodeEntryHeader(head: ArrayBuffer): DecodedHeader | null {
  if (head.byteLength < LEGACY_HEADER_BYTES) return null;
  const first = new Uint32Array(head.slice(0, LEGACY_HEADER_BYTES));
  if (first[0] !== ENTRY_MAGIC) return { legacy: { width: first[0], height: first[1] } };
  if (first[1] !== ENTRY_LAYOUT || head.byteLength < ENTRY_HEADER_BYTES) return null;
  const w = new Uint32Array(head.slice(0, ENTRY_HEADER_BYTES));
  return {
    width: w[2],
    height: w[3],
    fullWidth: w[4],
    fullHeight: w[5],
    sample: { width: w[6], height: w[7], x: w[8], y: w[9] },
    previewBytes: w[10],
  };
}

/** What a read of the cache hands back. */
export interface CachedPreview {
  data: Uint16Array;
  width: number;
  height: number;
  /** The decoded frame's size; null for an entry written before 3.1.0, which kept only the preview. */
  full: { width: number; height: number } | null;
  /** The frame's centre at native resolution, when asked for and the entry holds one. */
  sample: StoredSample | null;
}
