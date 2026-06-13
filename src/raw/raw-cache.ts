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

const DB_NAME = "safelight-raw-cache";
// v2: old entries were 8-bit JPEG, incompatible.
// v3: decode settings changed (noAutoBright off, highlight blend) — entries decoded
//     with the old settings have clipped highlights baked in; drop them.
// v4: libraw-wasm upgraded to 1.3.x; stale broken decodes from unrecognised camera
//     bodies must be dropped so the new decoder gets a clean run.
const DB_VERSION = 4;
const STORE = "previews";
// The cached-resolution cap and the cache on/off switch are preferences
// (Preferences ▸ Performance). The live (cache-miss) decode still renders
// full-res, so only re-opens use the cap.
import { getSettings } from "@/state/settings-store";

interface CacheEntry {
  key: string;    // "${name}:${size}:${lastModified}"
  blob: Blob;     // gzip(Uint16 RGBA, sRGB-encoded), capped resolution
  width: number;
  height: number;
}

// ─── IndexedDB plumbing ──────────────────────────────────────────────────────

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      // Drop the old (8-bit JPEG) store so stale entries can't be misread.
      if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
      db.createObjectStore(STORE, { keyPath: "key" });
    };
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

// ─── Project-folder cache ────────────────────────────────────────────────────
// With a project open, decoded previews live in <project>/.safelight/raw/ so
// they travel with the folder (and dodge browser storage quotas). IndexedDB
// remains the fallback when no directory is set.
//
// File format: 8-byte header (Uint32 LE width, height) + gzipped Uint16 RGBA.

let cacheDir: FileSystemDirectoryHandle | null = null;

export function setRawCacheDir(dir: FileSystemDirectoryHandle | null): void {
  cacheDir = dir;
}

function cacheFileName(key: string): string {
  return `${encodeURIComponent(key)}.bin`; // ":" etc. are not filename-safe
}

async function readFromDir(
  key: string,
): Promise<{ data: Uint16Array; width: number; height: number } | null> {
  try {
    const fh = await cacheDir!.getFileHandle(cacheFileName(key));
    const buf = await (await fh.getFile()).arrayBuffer();
    if (buf.byteLength < 8) return null;
    const [width, height] = new Uint32Array(buf.slice(0, 8));
    const body = await gunzip(new Blob([buf.slice(8)]));
    return { data: new Uint16Array(body), width, height };
  } catch {
    return null;
  }
}

async function writeToDir(
  key: string,
  u16: Uint16Array<ArrayBuffer>,
  width: number,
  height: number,
): Promise<void> {
  const header = new Uint32Array([width, height]);
  const gz = await gzip(u16);
  const fh = await cacheDir!.getFileHandle(cacheFileName(key), { create: true });
  const w = await fh.createWritable();
  await w.write(new Blob([header, gz]));
  await w.close();
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Return the cached develop preview for `file` as raw 16-bit sRGB RGBA (already
 * rotated/oriented), or null on cache miss / any error. The sRGB->linear decode
 * is done on the GPU (shader), so the read is just a gunzip + typed-array view —
 * no per-sample CPU math, half the bytes of the old Float32 buffer.
 */
export async function readCachedPreview(
  file: File,
): Promise<{ data: Uint16Array; width: number; height: number } | null> {
  if (!getSettings().rawCacheEnabled) return null;
  if (cacheDir) return readFromDir(rawCacheKey(file));
  try {
    const db = await getDB();
    const entry: CacheEntry | undefined = await idbReq(
      db.transaction(STORE, "readonly").objectStore(STORE).get(rawCacheKey(file)),
    );
    if (!entry) return null;
    const buf = await gunzip(entry.blob);
    return { data: new Uint16Array(buf), width: entry.width, height: entry.height };
  } catch {
    return null;
  }
}

/**
 * Encode `data` (linear Float32 RGBA, already oriented) as a 16-bit sRGB,
 * gzip-compressed blob and write it to the cache. Fire-and-forget: errors are
 * silently discarded. Downsampled to CACHE_MAX_EDGE to bound the blob size.
 */
export async function writeCachedPreview(
  file: File,
  data: Float32Array,
  width: number,
  height: number,
): Promise<void> {
  if (!getSettings().rawCacheEnabled) return;
  try {
    const ds = downsampleFloatRGBA(data, width, height, getSettings().rawCacheMaxEdge);
    const u16 = new Uint16Array(ds.data.length);
    for (let i = 0; i < ds.data.length; i++) {
      u16[i] = Math.round(linearToSrgb(ds.data[i]) * 65535);
    }
    if (cacheDir) {
      await writeToDir(rawCacheKey(file), u16, ds.width, ds.height);
      return;
    }
    const blob = await gzip(u16);
    const entry: CacheEntry = { key: rawCacheKey(file), blob, width: ds.width, height: ds.height };
    const db = await getDB();
    await idbReq(db.transaction(STORE, "readwrite").objectStore(STORE).put(entry));
  } catch {
    // Cache write failure is non-fatal — the next load will just re-decode.
  }
}

/** Remove a single file's cached preview (e.g., after file replacement). */
export async function deleteCachedPreview(file: File): Promise<void> {
  if (cacheDir) {
    try {
      await cacheDir.removeEntry(cacheFileName(rawCacheKey(file)));
    } catch {}
    return;
  }
  try {
    const db = await getDB();
    await idbReq(
      db.transaction(STORE, "readwrite").objectStore(STORE).delete(rawCacheKey(file)),
    );
  } catch { /* ignore */ }
}

/** Wipe every cached preview (Preferences ▸ Performance ▸ Clear cache).
 *  Clears both the project-folder cache (when set) and IndexedDB. */
export async function clearRawCache(): Promise<void> {
  if (cacheDir) {
    try {
      for await (const name of (cacheDir as unknown as { keys(): AsyncIterable<string> }).keys()) {
        try {
          await cacheDir.removeEntry(name);
        } catch {}
      }
    } catch {}
  }
  try {
    const db = await getDB();
    await idbReq(db.transaction(STORE, "readwrite").objectStore(STORE).clear());
  } catch {}
}

// ─── Internal helpers ────────────────────────────────────────────────────────

// sRGB transfer functions (clamped to [0,1]; HDR headroom is recreated by the
// in-shader exposure multiply, so the cache only needs the displayable range).
function linearToSrgb(v: number): number {
  v = v < 0 ? 0 : v > 1 ? 1 : v;
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

// Box-average downsample a linear Float32 RGBA buffer so the long edge ≤ maxEdge.
// Returns the input unchanged when it already fits.
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

// gzip / gunzip an ArrayBuffer via the platform Compression Streams API.
async function gzip(buf: BufferSource): Promise<Blob> {
  const stream = new Blob([buf]).stream().pipeThrough(new CompressionStream("gzip"));
  return await new Response(stream).blob();
}
async function gunzip(blob: Blob): Promise<ArrayBuffer> {
  const stream = blob.stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).arrayBuffer();
}
