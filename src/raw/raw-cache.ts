// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Develop-preview cache: store decoded RAW files in IndexedDB so subsequent
// Develop opens load fast instead of re-running libraw (~50ms vs 3-8s).
//
// Cache key = relPath + fileSize + baked rotation. Derived entirely from the
// catalog record so the prefetch skip-check needs no getFile (which reads the
// whole RAW off disk in Electron). A size-changing edit misses automatically; an
// in-place edit that preserves byte size (e.g. EXIF/metadata rewrite) keeps the
// stale entry until Reimport drops it (see reimportPhotos in import-photos.ts).
//
// Format: scene-linear RGBA as IEEE 754 half floats, gzip-compressed. The first
// cache stored an 8-bit JPEG, which only has ~256 levels/channel — a +5 exposure
// push (×32) then stretched the bright sky into visible posterising bands (and
// JPEG's lossy chroma made it rainbow). The next stored 16-bit sRGB: smooth
// under a push, but clamped to [0, 1], so a reopened RAW lost the highlight
// headroom and the camera matrix's small negatives its first open rendered
// from. Half floats keep both at ~11 bits of relative precision in the same
// 2 bytes/channel; gzip keeps the blob near a large JPEG's size. On load the
// renderer decodes them and takes the same scene-linear float path as a fresh
// decode; see WebGLRenderer.setImage.
//
// All heavy I/O (gzip/gunzip, IndexedDB transactions, filesystem reads/writes,
// downsample + half-float encoding for writes) runs in a dedicated cache worker
// so the main thread is never blocked.

import { getSettings } from "@/state/settings-store";
import {
  setCacheDirOnWorker,
  workerReadCachedPreview,
  workerWriteCachedPreview,
  workerDeleteCachedPreview,
  workerClearRawCache,
  workerCachedKeys,
} from "./cache-bridge";

// ─── Key helpers ─────────────────────────────────────────────────────────────

// The version prefix is the cache contract: bump it whenever the float decode
// or the stored encoding changes (v6: half-float entries that keep headroom and
// negatives; v5: libraw output linearised, white point restored, Fujifilm
// exposure bias applied).
export function rawCacheKey(
  relPath: string,
  fileSize: number,
  rotation = 0,
): string {
  return `v6:${relPath}:${fileSize}:${rotation}`;
}

// ─── Project-folder cache ────────────────────────────────────────────────────

export function setRawCacheDir(dir: FileSystemDirectoryHandle | null): void {
  setCacheDirOnWorker(dir);
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function readCachedPreview(
  key: string,
): Promise<{ data: Uint16Array; width: number; height: number } | null> {
  if (!getSettings().rawCacheEnabled) return null;
  try {
    return await workerReadCachedPreview(key);
  } catch {
    return null;
  }
}

export async function cachedKeys(): Promise<Set<string>> {
  if (!getSettings().rawCacheEnabled) return new Set();
  try {
    const keys = await workerCachedKeys();
    return new Set(keys);
  } catch {
    return new Set();
  }
}

export async function writeCachedPreview(
  key: string,
  data: Float32Array,
  width: number,
  height: number,
): Promise<void> {
  if (!getSettings().rawCacheEnabled) return;
  try {
    await workerWriteCachedPreview(key, data, width, height, getSettings().rawCacheMaxEdge);
  } catch {
    // Cache write failure is non-fatal — the next load will just re-decode.
  }
}

export async function deleteCachedPreview(key: string): Promise<void> {
  try {
    await workerDeleteCachedPreview(key);
  } catch {}
}

export async function clearRawCache(): Promise<void> {
  try {
    await workerClearRawCache();
  } catch {}
}
