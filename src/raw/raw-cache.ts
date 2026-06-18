// Develop-preview cache: store decoded RAW files in IndexedDB so subsequent
// Develop opens load fast instead of re-running libraw (~50ms vs 3-8s).
//
// Cache key = filename + fileSize + lastModified. Any change to the source file
// automatically misses the cache without explicit invalidation.
//
// Format: 16-bit sRGB-encoded RGBA, gzip-compressed. The previous cache stored an
// 8-bit JPEG, which only has ~256 levels/channel — a +5 exposure push (×32) then
// stretched the bright sky into visible posterising bands (and JPEG's lossy chroma
// made it rainbow). 16-bit gives 65536 levels so the push stays smooth; sRGB gamma
// keeps shadow precision; gzip keeps the blob near a large JPEG's size. On load the
// 16-bit sRGB data is uploaded straight to a normalized RGBA16 texture and decoded
// to linear in the shader (no per-sample CPU math); see WebGLRenderer.setImage.
//
// All heavy I/O (gzip/gunzip, IndexedDB transactions, filesystem reads/writes,
// downsample + sRGB conversion for writes) runs in a dedicated cache worker so
// the main thread is never blocked.

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

export function rawCacheKey(
  relPath: string,
  fileSize: number,
  rotation = 0,
): string {
  return `v3:${relPath}:${fileSize}:${rotation}`;
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
