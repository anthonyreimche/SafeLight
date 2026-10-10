// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Dedicated worker for all cache I/O: gzip/gunzip, IndexedDB get/put, and
// filesystem reads/writes. Keeps the main thread free of compression stalls
// and IDB transaction blocking.

import { encodeCachedPreview } from "./cache-encode";
import { scopeBounds, scopedKey, unscopedKey } from "./cache-keys";

const DB_NAME = "safelight-raw-cache";
// v6: keys are scoped to their project. The upgrade drops the unscoped entries,
// any of which could be another project's picture under the same name and size.
const DB_VERSION = 6;
const STORE = "previews";

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

export type CacheRequest =
  | { cmd: "setCacheDir"; dir: FileSystemDirectoryHandle | null; scope: string | null }
  | { cmd: "read"; id: number; key: string }
  | { cmd: "write"; id: number; key: string; data: Float32Array; width: number; height: number; maxEdge: number }
  // A negative marker: an entry holding a short text instead of pixels.
  | { cmd: "mark"; id: number; key: string; value: string }
  | { cmd: "peek"; id: number; key: string }
  | { cmd: "delete"; id: number; key: string }
  | { cmd: "clear"; id: number }
  | { cmd: "keys"; id: number };

export type CacheResponse =
  | { type: "ready" }
  | { type: "read"; id: number; data: Uint16Array | null; width: number; height: number }
  | { type: "write"; id: number; ok: boolean }
  | { type: "mark"; id: number }
  | { type: "peek"; id: number; value: string | null }
  | { type: "delete"; id: number }
  | { type: "clear"; id: number }
  | { type: "keys"; id: number; keys: string[] }
  | { type: "error"; id: number; message: string };

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let cacheDir: FileSystemDirectoryHandle | null = null;
// Without a folder, entries go to IndexedDB under this scope. null: the project
// has nothing to scope by, so nothing is cached rather than mixing projects.
let scope: string | null = "";

// ---------------------------------------------------------------------------
// IndexedDB
// ---------------------------------------------------------------------------

interface CacheEntry {
  key: string;
  blob: Blob;
  width: number;
  height: number;
}

let _db: IDBDatabase | null = null;
// IndexedDB queues opens per database and tells only the first that it is
// blocked; a later open waits silently behind it. So one open at a time, shared
// by every caller.
let opening: Promise<IDBDatabase> | null = null;
let blocked = false;
const HELD_OPEN = "raw cache is held open by another window";

function adopt(db: IDBDatabase): IDBDatabase {
  // Close for another window's upgrade, which would otherwise block on us.
  db.onversionchange = () => {
    db.close();
    if (_db === db) _db = null;
  };
  _db = db;
  return db;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
      db.createObjectStore(STORE, { keyPath: "key" });
    };
    // Another window still holds an older version open. Until it lets go,
    // every request fails as a miss rather than waiting on it; the open stays
    // queued, and its connection is kept once it goes through.
    req.onblocked = () => {
      blocked = true;
      reject(new Error(HELD_OPEN));
    };
    req.onsuccess = () => {
      blocked = false;
      opening = null;
      resolve(adopt(req.result));
    };
    req.onerror = () => {
      blocked = false;
      opening = null;
      reject(req.error);
    };
  });
}

async function getDB(): Promise<IDBDatabase> {
  if (_db) return _db;
  if (blocked) throw new Error(HELD_OPEN);
  opening ??= openDB();
  return opening;
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
// File helpers
// ---------------------------------------------------------------------------

function cacheFileName(key: string): string {
  return `${encodeURIComponent(key)}.bin`;
}

async function readFromDir(
  dir: FileSystemDirectoryHandle,
  key: string,
): Promise<{ data: Uint16Array; width: number; height: number } | null> {
  try {
    const fh = await dir.getFileHandle(cacheFileName(key));
    const buf = await (await fh.getFile()).arrayBuffer();
    if (buf.byteLength < 8) {
      // Too short for a preview: a write that never closed left it (see landed).
      await dir.removeEntry(cacheFileName(key));
      return null;
    }
    const [width, height] = new Uint32Array(buf.slice(0, 8));
    const body = await gunzip(new Blob([buf.slice(8)]));
    return { data: new Uint16Array(body), width, height };
  } catch {
    return null;
  }
}

async function writeToDir(
  dir: FileSystemDirectoryHandle,
  key: string,
  u16: Uint16Array,
  width: number,
  height: number,
): Promise<void> {
  const header = new Uint32Array([width, height]);
  const gz = await gzip(u16 as unknown as ArrayBuffer);
  const fh = await dir.getFileHandle(cacheFileName(key), { create: true });
  const w = await fh.createWritable();
  await w.write(new Blob([header, gz]));
  await w.close();
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function handleRead(key: string): Promise<{ data: Uint16Array | null; width: number; height: number }> {
  if (cacheDir) {
    const result = await readFromDir(cacheDir, key);
    return result ?? { data: null, width: 0, height: 0 };
  }
  const s = scope;
  if (s === null) return { data: null, width: 0, height: 0 };
  const db = await getDB();
  const entry: CacheEntry | undefined = await idbReq(
    db.transaction(STORE, "readonly").objectStore(STORE).get(scopedKey(s, key)),
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
  // Taken as the write arrives: a folder set while it compresses is the next
  // project's, and the write must not land there.
  const dir = cacheDir;
  const s = scope;
  const enc = encodeCachedPreview(data, width, height, maxEdge);
  if (dir) {
    await writeToDir(dir, key, enc.data, enc.width, enc.height);
    return;
  }
  if (s === null) return;
  const blob = await gzip(enc.data);
  const entry: CacheEntry = { key: scopedKey(s, key), blob, width: enc.width, height: enc.height };
  const db = await getDB();
  await idbReq(db.transaction(STORE, "readwrite").objectStore(STORE).put(entry));
}

async function handleMark(key: string, value: string): Promise<void> {
  const dir = cacheDir;
  const s = scope;
  if (dir) {
    const fh = await dir.getFileHandle(cacheFileName(key), { create: true });
    const w = await fh.createWritable();
    await w.write(new Blob([value]));
    await w.close();
    return;
  }
  if (s === null) return;
  const blob = new Blob([value]);
  const entry: CacheEntry = { key: scopedKey(s, key), blob, width: 0, height: 0 };
  const db = await getDB();
  await idbReq(db.transaction(STORE, "readwrite").objectStore(STORE).put(entry));
}

async function handlePeek(key: string): Promise<string | null> {
  const dir = cacheDir;
  const s = scope;
  if (dir) {
    try {
      const fh = await dir.getFileHandle(cacheFileName(key));
      // A folder marker is created empty and gets its text as its file
      // closes. Until then it isn't one: read as a marker, its empty text
      // would pass for another session's strike.
      return (await (await fh.getFile()).text()) || null;
    } catch {
      return null;
    }
  }
  if (s === null) return null;
  const db = await getDB();
  const entry: CacheEntry | undefined = await idbReq(
    db.transaction(STORE, "readonly").objectStore(STORE).get(scopedKey(s, key)),
  );
  return entry ? await entry.blob.text() : null;
}

async function handleDelete(key: string): Promise<void> {
  if (cacheDir) {
    try { await cacheDir.removeEntry(cacheFileName(key)); } catch {}
    return;
  }
  const s = scope;
  if (s === null) return;
  const db = await getDB();
  await idbReq(db.transaction(STORE, "readwrite").objectStore(STORE).delete(scopedKey(s, key)));
}

async function handleClear(): Promise<void> {
  // As for a write: a folder set while this clears belongs to the next project.
  const dir = cacheDir;
  if (dir) {
    try {
      for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
        try { await dir.removeEntry(name); } catch {}
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
    const s = scope;
    if (s === null) return [];
    try {
      const db = await getDB();
      const keys = await idbReq(
        db.transaction(STORE, "readonly").objectStore(STORE)
          .getAllKeys(IDBKeyRange.bound(...scopeBounds(s))),
      );
      return keys.flatMap((k) => unscopedKey(s, String(k)) ?? []);
    } catch {
      return [];
    }
  }
  const dir = cacheDir;
  const out: string[] = [];
  try {
    for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
      if (!name.endsWith(".bin") || !(await landed(dir, name))) continue;
      try { out.push(decodeURIComponent(name.slice(0, -4))); } catch {}
    }
  } catch {}
  return out;
}

// A folder entry is created empty and gets its bytes as its file closes, so an
// empty one is a write that hasn't landed: a quit or a failed close leaves it
// so for good.
async function landed(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    return (await (await dir.getFileHandle(name)).getFile()).size > 0;
  } catch {
    return false;
  }
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
        scope = msg.scope;
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

      case "mark":
        await handleMark(msg.key, msg.value);
        respond({ type: "mark", id: msg.id });
        break;

      case "peek":
        respond({ type: "peek", id: msg.id, value: await handlePeek(msg.key) });
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
