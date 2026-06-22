// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Dedicated worker for all cache I/O: gzip/gunzip, IndexedDB get/put, and
// filesystem reads/writes. Keeps the main thread free of compression stalls
// and IDB transaction blocking.

const DB_NAME = "safelight-raw-cache";
const DB_VERSION = 4;
const STORE = "previews";

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

export type CacheRequest =
  | { cmd: "setCacheDir"; dir: FileSystemDirectoryHandle | null }
  | { cmd: "read"; id: number; key: string }
  | { cmd: "write"; id: number; key: string; data: Float32Array; width: number; height: number; maxEdge: number }
  | { cmd: "delete"; id: number; key: string }
  | { cmd: "clear"; id: number }
  | { cmd: "keys"; id: number };

export type CacheResponse =
  | { type: "ready" }
  | { type: "read"; id: number; data: Uint16Array | null; width: number; height: number }
  | { type: "write"; id: number; ok: boolean }
  | { type: "delete"; id: number }
  | { type: "clear"; id: number }
  | { type: "keys"; id: number; keys: string[] }
  | { type: "error"; id: number; message: string };

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let cacheDir: FileSystemDirectoryHandle | null = null;

// ---------------------------------------------------------------------------
// IndexedDB
// ---------------------------------------------------------------------------

interface CacheEntry {
  key: string;
  blob: Blob;
  width: number;
  height: number;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
      db.createObjectStore(STORE, { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
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
    req.onerror = () => reject(req.error);
  });
}

// ---------------------------------------------------------------------------
// Compression
// ---------------------------------------------------------------------------

async function gzip(buf: BufferSource): Promise<Blob> {
  const stream = new Blob([buf]).stream().pipeThrough(new CompressionStream("gzip"));
  return await new Response(stream).blob();
}

async function gunzip(blob: Blob): Promise<ArrayBuffer> {
  const stream = blob.stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).arrayBuffer();
}

// ---------------------------------------------------------------------------
// sRGB conversion + downsample (CPU-intensive, belongs in the worker)
// ---------------------------------------------------------------------------

function linearToSrgb(v: number): number {
  v = v < 0 ? 0 : v > 1 ? 1 : v;
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

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

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

function cacheFileName(key: string): string {
  return `${encodeURIComponent(key)}.bin`;
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
  u16: Uint16Array,
  width: number,
  height: number,
): Promise<void> {
  const header = new Uint32Array([width, height]);
  const gz = await gzip(u16 as unknown as ArrayBuffer);
  const fh = await cacheDir!.getFileHandle(cacheFileName(key), { create: true });
  const w = await fh.createWritable();
  await w.write(new Blob([header, gz]));
  await w.close();
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function handleRead(key: string): Promise<{ data: Uint16Array | null; width: number; height: number }> {
  if (cacheDir) {
    const result = await readFromDir(key);
    return result ?? { data: null, width: 0, height: 0 };
  }
  const db = await getDB();
  const entry: CacheEntry | undefined = await idbReq(
    db.transaction(STORE, "readonly").objectStore(STORE).get(key),
  );
  if (!entry) return { data: null, width: 0, height: 0 };
  const buf = await gunzip(entry.blob);
  return { data: new Uint16Array(buf), width: entry.width, height: entry.height };
}

async function handleWrite(
  key: string,
  data: Float32Array,
  width: number,
  height: number,
  maxEdge: number,
): Promise<void> {
  const ds = downsampleFloatRGBA(data, width, height, maxEdge);
  const u16 = new Uint16Array(ds.data.length);
  for (let i = 0; i < ds.data.length; i++) {
    u16[i] = Math.round(linearToSrgb(ds.data[i]) * 65535);
  }
  if (cacheDir) {
    await writeToDir(key, u16, ds.width, ds.height);
    return;
  }
  const blob = await gzip(u16);
  const entry: CacheEntry = { key, blob, width: ds.width, height: ds.height };
  const db = await getDB();
  await idbReq(db.transaction(STORE, "readwrite").objectStore(STORE).put(entry));
}

async function handleDelete(key: string): Promise<void> {
  if (cacheDir) {
    try { await cacheDir.removeEntry(cacheFileName(key)); } catch {}
    return;
  }
  const db = await getDB();
  await idbReq(db.transaction(STORE, "readwrite").objectStore(STORE).delete(key));
}

async function handleClear(): Promise<void> {
  if (cacheDir) {
    try {
      for await (const name of (cacheDir as unknown as { keys(): AsyncIterable<string> }).keys()) {
        try { await cacheDir!.removeEntry(name); } catch {}
      }
    } catch {}
  }
  try {
    const db = await getDB();
    await idbReq(db.transaction(STORE, "readwrite").objectStore(STORE).clear());
  } catch {}
}

async function handleKeys(): Promise<string[]> {
  // No directory handle (e.g. Electron, whose FS-Access polyfill can't be cloned
  // into the worker) → the cache lives in IndexedDB, so enumerate that instead.
  // Returning [] here would make preDecodeRawsForCache re-decode every RAW on
  // every open, since it would never see the entries write() actually stored.
  if (!cacheDir) {
    try {
      const db = await getDB();
      const keys = await idbReq(
        db.transaction(STORE, "readonly").objectStore(STORE).getAllKeys(),
      );
      return keys.map((k) => String(k));
    } catch {
      return [];
    }
  }
  const out: string[] = [];
  try {
    for await (const name of (cacheDir as unknown as { keys(): AsyncIterable<string> }).keys()) {
      if (!name.endsWith(".bin")) continue;
      try { out.push(decodeURIComponent(name.slice(0, -4))); } catch {}
    }
  } catch {}
  return out;
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

const workerScope = self as unknown as {
  postMessage(msg: unknown, transfer: Transferable[]): void;
  postMessage(msg: unknown): void;
};

function respond(msg: CacheResponse, transfer?: Transferable[]) {
  if (transfer) workerScope.postMessage(msg, transfer);
  else workerScope.postMessage(msg);
}

self.onmessage = async (e: MessageEvent<CacheRequest>) => {
  const msg = e.data;
  try {
    switch (msg.cmd) {
      case "setCacheDir":
        cacheDir = msg.dir;
        break;

      case "read": {
        const result = await handleRead(msg.key);
        const transfer: Transferable[] = result.data ? [result.data.buffer] : [];
        respond({ type: "read", id: msg.id, ...result }, transfer);
        break;
      }

      case "write":
        await handleWrite(msg.key, msg.data, msg.width, msg.height, msg.maxEdge);
        respond({ type: "write", id: msg.id, ok: true });
        break;

      case "delete":
        await handleDelete(msg.key);
        respond({ type: "delete", id: msg.id });
        break;

      case "clear":
        await handleClear();
        respond({ type: "clear", id: msg.id });
        break;

      case "keys": {
        const keys = await handleKeys();
        respond({ type: "keys", id: msg.id, keys });
        break;
      }
    }
  } catch (err) {
    const id = "id" in msg ? (msg as { id: number }).id : 0;
    respond({ type: "error", id, message: err instanceof Error ? err.message : String(err) });
  }
};

respond({ type: "ready" });
