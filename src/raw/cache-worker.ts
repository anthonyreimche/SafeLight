// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Dedicated worker for all cache I/O: gzip/gunzip, IndexedDB get/put, and
// filesystem reads/writes. Keeps the main thread free of compression stalls
// and IDB transaction blocking.

import {
  ENTRY_HEADER_BYTES,
  ENTRY_MAGIC,
  HASHED_FILE_NAME,
  cacheFileName,
  decodeEntryHeader,
  encodeCacheEntry,
  encodeEntryHeader,
  type CachedPreview,
  type EncodedEntry,
  type EntryHeader,
} from "./cache-encode";
import { scopeBounds, scopedKey, unscopedKey } from "./cache-keys";

const DB_NAME = "safelight-raw-cache";
// v6: keys are scoped to their project. The upgrade drops the unscoped entries,
// any of which could be another project's picture under the same name and size.
// v7: a small bookkeeping record per entry in its own store, so eviction never
// has to read the pictures.
const DB_VERSION = 7;
const STORE = "previews";
const META = "meta";

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
  // The entry already built from the frame (frame-job.ts), answered as a write.
  | { cmd: "store"; id: number; key: string; entry: EncodedEntry }
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
  | { type: "clear"; id: number; failed: number }
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

/** What eviction needs to know about an entry, kept apart from its pixels. */
interface CacheMeta {
  key: string; // the entry's key in STORE
  bytes: number; // 0 when unknown
  usedAt: number; // last written or read (day granularity on reads); 0 when unknown
  marker: boolean; // a marker weighs nothing and is never evicted
}

// Entries are keyed by absolute path, so a moved project or a changed drive
// letter strands its old ones; the oldest-used go once the store passes this.
const IDB_CAP_BYTES = 10 * 1024 ** 3;
// Listing the store costs a pass over every row, so it runs on the first write
// and then once per this many.
const EVICT_EVERY_WRITES = 25;
// A read rewrites the entry's meta to stamp it; skip that while the stamp is this fresh.
const TOUCH_AFTER_MS = 24 * 60 * 60 * 1000;
let writesSinceEvict = EVICT_EVERY_WRITES;

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
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (e.oldVersion < 6) {
        if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
        db.createObjectStore(STORE, { keyPath: "key" });
      }
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "key" });
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
function committed(db: IDBDatabase, run: (tx: IDBTransaction) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE, META], "readwrite");
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("the cache write was aborted"));
    run(tx);
  });
}

const putEntry = (db: IDBDatabase, entry: CacheEntry, meta: CacheMeta) =>
  committed(db, (tx) => {
    tx.objectStore(STORE).put(entry);
    tx.objectStore(META).put(meta);
  });

const dropEntry = (db: IDBDatabase, key: string) =>
  committed(db, (tx) => {
    tx.objectStore(STORE).delete(key);
    tx.objectStore(META).delete(key);
  });

const entryBytes = (row: CacheEntry) => row.blob.size + (row.sample?.blob.size ?? 0);

/** Meta for entries written before v7. Reading their rows gets the blobs by
 *  reference, not their bytes; each is dated 0 so it sorts oldest. */
async function measure(db: IDBDatabase, keys: string[]): Promise<CacheMeta[]> {
  if (!keys.length) return [];
  const store = db.transaction(STORE, "readonly").objectStore(STORE);
  const rows: (CacheEntry | undefined)[] = await Promise.all(keys.map((key) => idbReq(store.get(key))));
  return keys.flatMap((key, i) => {
    const row = rows[i];
    return row ? [{ key, bytes: entryBytes(row), usedAt: 0, marker: row.width === 0 }] : [];
  });
}

/** Delete the least recently used pictures until the store holds `limitBytes`
 *  or less. Only the meta records are read, never the pictures: they can total
 *  gigabytes. An entry with no meta (written before v7) is measured once and given one
 *  that sorts oldest, and a meta with no entry is dropped. */
export async function evictLeastRecentlyUsed(db: IDBDatabase, limitBytes: number): Promise<void> {
  const reader = db.transaction([STORE, META], "readonly");
  const [entryKeys, metas] = await Promise.all([
    idbReq(reader.objectStore(STORE).getAllKeys()),
    idbReq<CacheMeta[]>(reader.objectStore(META).getAll()),
  ]);
  const have = new Set(entryKeys as string[]);
  const known = new Set(metas.map((m) => m.key));
  const orphaned = metas.filter((m) => !have.has(m.key));
  const live = metas.filter((m) => have.has(m.key));
  const unmeasured = await measure(db, (entryKeys as string[]).filter((key) => !known.has(key)));
  const pictures = [...unmeasured, ...live].filter((m) => !m.marker);
  let total = pictures.reduce((sum, m) => sum + m.bytes, 0);
  const doomed: string[] = [];
  if (total > limitBytes) {
    pictures.sort((a, b) => a.usedAt - b.usedAt);
    for (const m of pictures) {
      if (total <= limitBytes) break;
      doomed.push(m.key);
      total -= m.bytes;
    }
  }
  const adopted = unmeasured.filter((m) => !doomed.includes(m.key));
  if (!doomed.length && !orphaned.length && !adopted.length) return;
  await committed(db, (tx) => {
    const entries = tx.objectStore(STORE);
    const metaStore = tx.objectStore(META);
    for (const key of doomed) {
      entries.delete(key);
      metaStore.delete(key);
    }
    for (const m of orphaned) metaStore.delete(m.key);
    for (const m of adopted) metaStore.put(m);
  });
}

/** Stamp an entry as used now, unless it was stamped within the day. */
async function touch(db: IDBDatabase, key: string): Promise<void> {
  const store = db.transaction(META, "readwrite").objectStore(META);
  const meta: CacheMeta | undefined = await idbReq(store.get(key));
  if (!meta || meta.marker || Date.now() - meta.usedAt < TOUCH_AFTER_MS) return;
  store.put({ ...meta, usedAt: Date.now() });
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

const miss = (): ReadReply => ({ data: null, width: 0, height: 0, full: null, sample: null });

/** Four half floats a pixel. A damaged size, or a stream that decompresses
 *  cleanly to the wrong length, would otherwise be served on every read. */
const pixelsFit = (data: Uint16Array, width: number, height: number) => data.length === width * height * 4;

// A marker's file holds its key, a NUL (which no path contains), then its text.
const MARKER_SEPARATOR = "\u0000";

/** The key an entry keeps after its header; null when the file is cut short of it. */
async function entryKey(file: File, header: EntryHeader): Promise<string | null> {
  const bytes = await file.slice(ENTRY_HEADER_BYTES, ENTRY_HEADER_BYTES + header.keyBytes).arrayBuffer();
  return bytes.byteLength === header.keyBytes ? new TextDecoder().decode(bytes) : null;
}

async function readFromDir(
  dir: FileSystemDirectoryHandle,
  key: string,
  wantSample: boolean,
): Promise<CachedPreview | null> {
  try {
    const name = await cacheFileName(key);
    const file = await (await dir.getFileHandle(name)).getFile();
    const header = decodeEntryHeader(await file.slice(0, ENTRY_HEADER_BYTES).arrayBuffer());
    if (!header) {
      // Too short for its header (a write that never closed left it) or a
      // layout this build doesn't know: a miss either way.
      await dir.removeEntry(name);
      return null;
    }
    // The name is only a hash of the key.
    if ((await entryKey(file, header)) !== key) return null;
    const previewEnd = ENTRY_HEADER_BYTES + header.keyBytes + header.previewBytes;
    const full = { width: header.fullWidth, height: header.fullHeight };
    const preview = await gunzip(file.slice(previewEnd - header.previewBytes, previewEnd));
    const sample = wantSample
      ? {
          data: new Uint16Array(await gunzip(file.slice(previewEnd))),
          ...header.sample,
          sourceWidth: full.width,
          sourceHeight: full.height,
        }
      : null;
    const data = new Uint16Array(preview);
    if (
      !pixelsFit(data, header.width, header.height) ||
      (sample && !pixelsFit(sample.data, sample.width, sample.height))
    ) {
      await dir.removeEntry(name);
      return null;
    }
    return { data, width: header.width, height: header.height, full, sample };
  } catch {
    return null;
  }
}

async function writeToDir(dir: FileSystemDirectoryHandle, key: string, entry: EncodedEntry): Promise<void> {
  const [preview, sample] = await Promise.all([
    gzip(entry.preview.data as unknown as ArrayBuffer),
    gzip(entry.sample.data as unknown as ArrayBuffer),
  ]);
  const keyBytes = new TextEncoder().encode(key);
  const header = encodeEntryHeader({
    width: entry.preview.width,
    height: entry.preview.height,
    fullWidth: entry.fullWidth,
    fullHeight: entry.fullHeight,
    sample: { width: entry.sample.width, height: entry.sample.height, x: entry.sample.x, y: entry.sample.y },
    previewBytes: preview.size,
    keyBytes: keyBytes.length,
  });
  const fh = await dir.getFileHandle(await cacheFileName(key), { create: true });
  const w = await fh.createWritable();
  await w.write(new Blob([header, keyBytes, preview, sample]));
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
  if (entry.width > 0) touch(db, entry.key).catch(() => {});
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
  const data = new Uint16Array(preview);
  if (
    !pixelsFit(data, entry.width, entry.height) ||
    (sample && !pixelsFit(sample.data, sample.width, sample.height))
  ) {
    // Gone, so the next decode writes it afresh.
    await dropEntry(db, entry.key).catch(() => {});
    return miss();
  }
  return { data, width: entry.width, height: entry.height, full, sample };
}

const handleWrite = (key: string, data: Float32Array, width: number, height: number, maxEdge: number) =>
  handleStore(key, encodeCacheEntry(data, width, height, maxEdge));

async function handleStore(key: string, entry: EncodedEntry): Promise<boolean> {
  // Taken as the write arrives: a folder set while it compresses is the next
  // project's, and the write must not land there.
  const dir = cacheDir;
  const s = scope;
  if (dir) {
    await writeToDir(dir, key, entry);
    return true;
  }
  if (s === null) return false;
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
  const db = await getDB();
  await putEntry(db, row, { key: row.key, bytes: entryBytes(row), usedAt: Date.now(), marker: false });
  if (++writesSinceEvict >= EVICT_EVERY_WRITES) {
    writesSinceEvict = 0;
    await evictLeastRecentlyUsed(db, IDB_CAP_BYTES).catch(() => {});
  }
  return true;
}

async function handleMark(key: string, value: string): Promise<void> {
  const dir = cacheDir;
  const s = scope;
  if (dir) {
    const fh = await dir.getFileHandle(await cacheFileName(key), { create: true });
    const w = await fh.createWritable();
    await w.write(new Blob([key, MARKER_SEPARATOR, value]));
    await w.close();
    return;
  }
  if (s === null) return;
  const blob = new Blob([value]);
  const entry: CacheEntry = { key: scopedKey(s, key), blob, width: 0, height: 0 };
  const db = await getDB();
  await putEntry(db, entry, { key: entry.key, bytes: 0, usedAt: 0, marker: true });
}

async function handlePeek(key: string): Promise<string | null> {
  const dir = cacheDir;
  const s = scope;
  if (dir) {
    try {
      const fh = await dir.getFileHandle(await cacheFileName(key));
      // A folder marker is created empty and gets its text as its file
      // closes. Until then it isn't one: read as a marker, its empty text
      // would pass for another session's strike.
      const text = await (await fh.getFile()).text();
      const at = text.indexOf(MARKER_SEPARATOR);
      return at < 0 || text.slice(0, at) !== key ? null : text.slice(at + 1) || null;
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
    try { await cacheDir.removeEntry(await cacheFileName(key)); } catch {}
    return;
  }
  const s = scope;
  if (s === null) return;
  await dropEntry(await getDB(), scopedKey(s, key));
}

/** How many parts of the cache could not be cleared: each file left in the
 *  folder, and the folder's listing or the database when they failed whole. */
async function handleClear(): Promise<number> {
  let failed = 0;
  // As for a write: a folder set while this clears belongs to the next project.
  const dir = cacheDir;
  if (dir) {
    try {
      for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
        try { await dir.removeEntry(name); } catch { failed++; }
      }
    } catch { failed++; }
  }
  try {
    const db = await getDB();
    await committed(db, (tx) => {
      tx.objectStore(STORE).clear();
      tx.objectStore(META).clear();
    });
  } catch { failed++; }
  return failed;
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
    const names: string[] = [];
    for await (const name of (dir as unknown as { keys(): AsyncIterable<string> }).keys()) {
      if (name.endsWith(".bin")) names.push(name);
    }
    for (const name of names) {
      // A file named by its key, as earlier builds wrote them, can't be told
      // from another key's or read back: it goes, and its photo is filled again.
      if (!HASHED_FILE_NAME.test(name)) {
        try { await dir.removeEntry(name); } catch {}
        continue;
      }
      const listed = await listFolderEntry(dir, name);
      if (listed) out.push(listed);
    }
  } catch {}
  return out;
}

// A folder file is created empty and gets its bytes as its file closes, so an
// empty one is a write that hasn't landed: a quit or a failed close leaves it
// so for good. A landed preview entry opens with the magic word and keeps its
// key after the header (cache-encode.ts); anything else is a marker's text,
// which holds its key ahead of a NUL. A header cut short, a layout this build
// doesn't know (a later build's) or text with no NUL is left unlisted: this
// build can only miss it, so its photo counts as having no entry, and a read
// removes what it can't use.
async function listFolderEntry(dir: FileSystemDirectoryHandle, name: string): Promise<CacheListing | null> {
  try {
    const file = await (await dir.getFileHandle(name)).getFile();
    if (file.size === 0) return null;
    const first = await file.slice(0, 4).arrayBuffer();
    if (first.byteLength === 4 && new Uint32Array(first)[0] === ENTRY_MAGIC) {
      const header = decodeEntryHeader(await file.slice(0, ENTRY_HEADER_BYTES).arrayBuffer());
      const key = header ? await entryKey(file, header) : null;
      return key ? { key, complete: true } : null;
    }
    const text = await file.text();
    const at = text.indexOf(MARKER_SEPARATOR);
    return at < 0 ? null : { key: text.slice(0, at), complete: false };
  } catch {
    return null;
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
        respond({
          type: "write",
          id: msg.id,
          ok: await handleWrite(msg.key, msg.data, msg.width, msg.height, msg.maxEdge),
        });
        break;

      case "store":
        respond({ type: "write", id: msg.id, ok: await handleStore(msg.key, msg.entry) });
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
        respond({ type: "clear", id: msg.id, failed: await handleClear() });
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
