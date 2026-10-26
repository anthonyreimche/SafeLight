// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Dedicated worker for all cache I/O: gzip/gunzip, IndexedDB get/put, and
// filesystem reads/writes. Keeps the main thread free of compression stalls
// and IDB transaction blocking.

import {
  ENTRY_HEADER_BYTES,
  ENTRY_LAYOUT,
  ENTRY_MAGIC,
  LEGACY_HEADER_BYTES,
  decodeEntryHeader,
  encodeCacheEntry,
  encodeEntryHeader,
  type CachedPreview,
  type EncodedEntry,
} from "./cache-encode";
import { scopeBounds, scopedKey, unscopedKey } from "./cache-keys";

const DB_NAME = "safelight-raw-cache";
// v6: keys are scoped to their project. The upgrade drops the unscoped entries,
// any of which could be another project's picture under the same name and size.
const DB_VERSION = 6;
const STORE = "previews";

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

/** One entry of the listing: `complete` says it keeps the decoded frame's size
 *  and the centre sample (3.1.0 and later); false for an entry written before,
 *  and for a marker. */
export interface CacheListing {
  key: string;
  complete: boolean;
}

export type CacheRequest =
  | { cmd: "setCacheDir"; dir: FileSystemDirectoryHandle | null; scope: string | null }
  // `sample`: also decompress the entry's centre sample (8 MB).
  | { cmd: "read"; id: number; key: string; sample: boolean }
  | { cmd: "write"; id: number; key: string; data: Float32Array; width: number; height: number; maxEdge: number }
  // A negative marker: an entry holding a short text instead of pixels.
  | { cmd: "mark"; id: number; key: string; value: string }
  | { cmd: "peek"; id: number; key: string }
  | { cmd: "delete"; id: number; key: string }
  | { cmd: "clear"; id: number }
  | { cmd: "keys"; id: number };

type ReadReply = Omit<CachedPreview, "data"> & { data: Uint16Array | null };

export type CacheResponse =
  | { type: "ready" }
  | ({ type: "read"; id: number } & ReadReply)
  | { type: "write"; id: number; ok: boolean }
  | { type: "mark"; id: number }
  | { type: "peek"; id: number; value: string | null }
  | { type: "delete"; id: number }
  | { type: "clear"; id: number }
  | { type: "keys"; id: number; entries: CacheListing[] }
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
  blob: Blob;          // gzip preview half floats, or a marker's text
  width: number;
  height: number;
  // 3.1.0: the decoded frame's size and its centre sample, gzip half floats.
  // Absent on entries written before, and on markers.
  fullWidth?: number;
  fullHeight?: number;
  sample?: { blob: Blob; width: number; height: number; x: number; y: number };
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

// IndexedDB answers a put before its transaction commits, and an exhausted
// storage quota fails the commit. So an entry counts as written only when the
// transaction completes.
function putCommitted(db: IDBDatabase, entry: CacheEntry): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("the cache write was aborted"));
    tx.objectStore(STORE).put(entry);
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

const miss = (): ReadReply => ({ data: null, width: 0, height: 0, full: null, sample: null });

async function readFromDir(
  dir: FileSystemDirectoryHandle,
  key: string,
  wantSample: boolean,
): Promise<CachedPreview | null> {
  try {
    const name = cacheFileName(key);
    const file = await (await dir.getFileHandle(name)).getFile();
    const header = decodeEntryHeader(await file.slice(0, ENTRY_HEADER_BYTES).arrayBuffer());
    if (!header) {
      // Too short for its header (a write that never closed left it; see
      // entryState) or a layout this build doesn't know: a miss either way.
      await dir.removeEntry(name);
      return null;
    }
    if ("legacy" in header) {
      const body = await gunzip(file.slice(LEGACY_HEADER_BYTES));
      return { data: new Uint16Array(body), ...header.legacy, full: null, sample: null };
    }
    const previewEnd = ENTRY_HEADER_BYTES + header.previewBytes;
    const full = { width: header.fullWidth, height: header.fullHeight };
    const preview = await gunzip(file.slice(ENTRY_HEADER_BYTES, previewEnd));
    const sample = wantSample
      ? {
          data: new Uint16Array(await gunzip(file.slice(previewEnd))),
          ...header.sample,
          sourceWidth: full.width,
          sourceHeight: full.height,
        }
      : null;
    return { data: new Uint16Array(preview), width: header.width, height: header.height, full, sample };
  } catch {
    return null;
  }
}

async function writeToDir(dir: FileSystemDirectoryHandle, key: string, entry: EncodedEntry): Promise<void> {
  const [preview, sample] = await Promise.all([
    gzip(entry.preview.data as unknown as ArrayBuffer),
    gzip(entry.sample.data as unknown as ArrayBuffer),
  ]);
  const header = encodeEntryHeader({
    width: entry.preview.width,
    height: entry.preview.height,
    fullWidth: entry.fullWidth,
    fullHeight: entry.fullHeight,
    sample: { width: entry.sample.width, height: entry.sample.height, x: entry.sample.x, y: entry.sample.y },
    previewBytes: preview.size,
  });
  const fh = await dir.getFileHandle(cacheFileName(key), { create: true });
  const w = await fh.createWritable();
  await w.write(new Blob([header, preview, sample]));
  await w.close();
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function handleRead(key: string, wantSample: boolean): Promise<ReadReply> {
  if (cacheDir) return (await readFromDir(cacheDir, key, wantSample)) ?? miss();
  const s = scope;
  if (s === null) return miss();
  const db = await getDB();
  const entry: CacheEntry | undefined = await idbReq(
    db.transaction(STORE, "readonly").objectStore(STORE).get(scopedKey(s, key)),
  );
  if (!entry) return miss();
  const full =
    entry.fullWidth !== undefined && entry.fullHeight !== undefined
      ? { width: entry.fullWidth, height: entry.fullHeight }
      : null;
  const stored = wantSample && full ? entry.sample : undefined;
  const [preview, sampleBody] = await Promise.all([
    gunzip(entry.blob),
    stored ? gunzip(stored.blob) : null,
  ]);
  const sample =
    stored && sampleBody && full
      ? {
          data: new Uint16Array(sampleBody),
          width: stored.width,
          height: stored.height,
          x: stored.x,
          y: stored.y,
          sourceWidth: full.width,
          sourceHeight: full.height,
        }
      : null;
  return { data: new Uint16Array(preview), width: entry.width, height: entry.height, full, sample };
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
  const entry = encodeCacheEntry(data, width, height, maxEdge);
  if (dir) {
    await writeToDir(dir, key, entry);
    return;
  }
  if (s === null) return;
  const [blob, sampleBlob] = await Promise.all([
    gzip(entry.preview.data as unknown as ArrayBuffer),
    gzip(entry.sample.data as unknown as ArrayBuffer),
  ]);
  const row: CacheEntry = {
    key: scopedKey(s, key),
    blob,
    width: entry.preview.width,
    height: entry.preview.height,
    fullWidth: entry.fullWidth,
    fullHeight: entry.fullHeight,
    sample: {
      blob: sampleBlob,
      width: entry.sample.width,
      height: entry.sample.height,
      x: entry.sample.x,
      y: entry.sample.y,
    },
  };
  await putCommitted(await getDB(), row);
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

async function handleKeys(): Promise<CacheListing[]> {
  // No directory handle (e.g. Electron, whose FS-Access polyfill can't be cloned
  // into the worker) → the cache lives in IndexedDB, so enumerate that instead.
  // Returning [] here would make preDecodeRawsForCache re-decode every RAW on
  // every open, since it would never see the entries write() actually stored.
  // getAll hands the records back with their blobs as references, not bytes.
  if (!cacheDir) {
    const s = scope;
    if (s === null) return [];
    try {
      const db = await getDB();
      const rows: CacheEntry[] = await idbReq(
        db.transaction(STORE, "readonly").objectStore(STORE)
          .getAll(IDBKeyRange.bound(...scopeBounds(s))),
      );
      return rows.flatMap((row) => {
        const key = unscopedKey(s, row.key);
        return key === null ? [] : [{ key, complete: row.fullWidth !== undefined }];
      });
    } catch {
      return [];
    }
  }
  const dir = cacheDir;
  const out: CacheListing[] = [];
  try {
    for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
      if (!name.endsWith(".bin")) continue;
      const state = await entryState(dir, name);
      if (state === "unlanded") continue;
      try {
        out.push({ key: decodeURIComponent(name.slice(0, -4)), complete: state === "complete" });
      } catch {}
    }
  } catch {}
  return out;
}

type EntryState = "unlanded" | "incomplete" | "complete";

// A folder entry is created empty and gets its bytes as its file closes, so an
// empty one is a write that hasn't landed: a quit or a failed close leaves it
// so for good. A landed entry's first word tells its layout (cache-encode.ts):
// the magic word with the whole header marks one that keeps the decoded size
// and the sample; the magic word without it is another write that never
// landed; anything else is an entry from before 3.1.0, or a marker's text.
// The magic word with a layout this build doesn't know (a later build's) is
// left unlisted: this build can only miss it, so its photo counts as having no
// entry, and a read removes it.
async function entryState(dir: FileSystemDirectoryHandle, name: string): Promise<EntryState> {
  try {
    const file = await (await dir.getFileHandle(name)).getFile();
    if (file.size === 0) return "unlanded";
    if (file.size < 4) return "incomplete";
    const [magic] = new Uint32Array(await file.slice(0, 4).arrayBuffer());
    if (magic !== ENTRY_MAGIC) return "incomplete";
    if (file.size < ENTRY_HEADER_BYTES) return "unlanded";
    const [layout] = new Uint32Array(await file.slice(4, 8).arrayBuffer());
    return layout === ENTRY_LAYOUT ? "complete" : "unlanded";
  } catch {
    return "unlanded";
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
        const result = await handleRead(msg.key, msg.sample);
        const transfer: Transferable[] = [];
        if (result.data) transfer.push(result.data.buffer);
        if (result.sample) transfer.push(result.sample.data.buffer);
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
        respond({ type: "keys", id: msg.id, entries: await handleKeys() });
        break;
      }
    }
  } catch (err) {
    const id = "id" in msg ? (msg as { id: number }).id : 0;
    respond({ type: "error", id, message: err instanceof Error ? err.message : String(err) });
  }
};

respond({ type: "ready" });
