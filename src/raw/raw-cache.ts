// Develop-preview cache: store decoded RAW files as high-quality JPEGs in
// IndexedDB so subsequent Develop opens load in ~50ms instead of 3-8s.
//
// Cache key = filename + fileSize + lastModified. Any change to the source file
// automatically misses the cache without explicit invalidation.
//
// The cached JPEG is sRGB-gamma-encoded (same as a regular JPEG exported from
// the editor), so the shader's srgbToLinear path applies on load — identical to
// the live rendering path that now stores gamma-encoded uint8 in the texture.

const DB_NAME = "safelight-raw-cache";
const DB_VERSION = 1;
const STORE = "previews";

interface CacheEntry {
  key: string;   // "${name}:${size}:${lastModified}"
  blob: Blob;    // JPEG, gamma-encoded sRGB, develop resolution
  width: number;
  height: number;
}

// ─── IndexedDB plumbing ──────────────────────────────────────────────────────

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "key" });
    req.onsuccess = () => resolve(req.result);
    req.onerror  = () => reject(req.error);
  });
}

let _db: IDBDatabase | null = null;
async function getDB(): Promise<IDBDatabase> {
  if (!_db) _db = await openDB();
  return _db;
}

function idbReq<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror  = () => reject(req.error);
  });
}

// ─── Key helpers ─────────────────────────────────────────────────────────────

export function rawCacheKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Return a cached ImageBitmap for `file`, or null on cache miss / any error.
 * The bitmap is already rotated/oriented (stored post-rotation).
 */
export async function readCachedPreview(file: File): Promise<ImageBitmap | null> {
  try {
    const db = await getDB();
    const entry: CacheEntry | undefined = await idbReq(
      db.transaction(STORE, "readonly").objectStore(STORE).get(rawCacheKey(file)),
    );
    if (!entry) return null;
    return await createImageBitmap(entry.blob);
  } catch {
    return null;
  }
}

/**
 * Encode `data` (linear Float32 RGBA, already oriented) as a high-quality JPEG
 * and write it to the cache. Fire-and-forget: errors are silently discarded.
 *
 * The gamma encoding mirrors the renderer's float→uint8 path so the cached
 * JPEG round-trips through the same srgbToLinear shader decode.
 */
export async function writeCachedPreview(
  file: File,
  data: Float32Array,
  width: number,
  height: number,
): Promise<void> {
  try {
    const blob = await floatToJpeg(data, width, height);
    const entry: CacheEntry = { key: rawCacheKey(file), blob, width, height };
    const db = await getDB();
    await idbReq(db.transaction(STORE, "readwrite").objectStore(STORE).put(entry));
  } catch {
    // Cache write failure is non-fatal — the next load will just re-decode.
  }
}

/** Remove a single file's cached preview (e.g., after file replacement). */
export async function deleteCachedPreview(file: File): Promise<void> {
  try {
    const db = await getDB();
    await idbReq(
      db.transaction(STORE, "readwrite").objectStore(STORE).delete(rawCacheKey(file)),
    );
  } catch { /* ignore */ }
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Convert a linear Float32 RGBA buffer to a JPEG Blob.
 * Applies sRGB gamma so the result is a standard displayable JPEG, and the
 * shader's srgbToLinear path restores linear light on next load.
 * Quality 0.95 is visually lossless for editing; keeps file size ~5-15 MB.
 */
async function floatToJpeg(
  data: Float32Array,
  width: number,
  height: number,
): Promise<Blob> {
  const u8 = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i++) {
    const v = Math.max(0, data[i]);
    const enc = v <= 0.0031308
      ? v * 12.92
      : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    u8[i] = Math.round(Math.min(255, enc * 255));
  }
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d")!;
  ctx.putImageData(new ImageData(u8, width, height), 0, 0);
  return canvas.convertToBlob({ type: "image/jpeg", quality: 0.95 });
}
