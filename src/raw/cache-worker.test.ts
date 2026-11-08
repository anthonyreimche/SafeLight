// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryFs, fsaDirectoryHandle } from "@/project/memory-fs.test-support";
import { type StoredSample, cutSourceSample } from "@/rendering/source-sample";
import {
  cacheFileName,
  ENTRY_HEADER_BYTES,
  ENTRY_LAYOUT,
  ENTRY_MAGIC,
  encodeCacheEntry,
  encodeCachedPreview,
  encodeEntryHeader,
} from "./cache-encode";
import { scopedKey } from "./cache-keys";
import type { CacheRequest, CacheResponse } from "./cache-worker";
import { FakeIndexedDB, startCacheWorker } from "./cache-worker.test-support";

afterEach(() => {
  vi.unstubAllGlobals();
});

const pixels = (w: number, h: number) =>
  new Float32Array(w * h * 4).map((_, i) => (i % 7) * 0.25 - 0.25);

/** A full-size sample compared in one pass: toEqual walks its 4M half floats
 *  one by one, which outlasts the test timeout on a CI runner. */
function expectSample(actual: StoredSample | null, expected: StoredSample): asserts actual is StoredSample {
  if (!actual) throw new Error("no sample");
  const { data, ...place } = actual;
  const { data: want, ...wantPlace } = expected;
  expect(place).toEqual(wantPlace);
  expect(data.length).toBe(want.length);
  expect(data.findIndex((v, i) => v !== want[i])).toBe(-1);
}

/** gzip, as the worker writes it. */
async function gzipped(u16: Uint16Array): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([u16 as unknown as ArrayBuffer]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** An entry as builds before 3.1.0 wrote it: [width, height], then the gzip preview. */
async function legacyFile(data: Float32Array, w: number, h: number): Promise<Uint8Array> {
  const body = await gzipped(encodeCachedPreview(data, w, h, 4096).data);
  const out = new Uint8Array(8 + body.length);
  out.set(new Uint8Array(new Uint32Array([w, h]).buffer));
  out.set(body, 8);
  return out;
}

describe("cache worker, project folder", () => {
  const RAW = "/p/.safelight/raw";

  async function withFolder(fs = new MemoryFs(RAW)) {
    const worker = await startCacheWorker();
    await worker.send({ cmd: "setCacheDir", dir: fsaDirectoryHandle(fs, RAW), scope: "" });
    return { ...worker, fs };
  }

  const fileOf = async (key: string) => `${RAW}/${await cacheFileName(key)}`;
  const nameBytes = (path: string) => new TextEncoder().encode(path.slice(RAW.length + 1)).length;
  const headerWords = (bytes: Uint8Array) => new Uint32Array(bytes.slice(0, ENTRY_HEADER_BYTES).buffer);

  it("round-trips a preview whose key needs escaping, with the frame's size and its sample", async () => {
    const { send } = await withFolder();
    const data = pixels(3, 2);

    await send({ cmd: "write", id: 1, key: "a/b c", data, width: 3, height: 2, maxEdge: 4096 });
    const reply = await send({ cmd: "read", id: 2, key: "a/b c", sample: true });

    expect(reply).toEqual({
      type: "read",
      id: 2,
      width: 3,
      height: 2,
      data: encodeCachedPreview(pixels(3, 2), 3, 2, 4096).data,
      full: { width: 3, height: 2 },
      sample: cutSourceSample(pixels(3, 2), 3, 2),
    });
  });

  it("stores an entry built elsewhere exactly as it stores the one it builds from the frame", async () => {
    const { send } = await withFolder();

    await send({ cmd: "write", id: 1, key: "built", data: pixels(1026, 1028), width: 1026, height: 1028, maxEdge: 64 });
    const stored = await send({
      cmd: "store",
      id: 2,
      key: "given",
      entry: encodeCacheEntry(pixels(1026, 1028), 1026, 1028, 64),
    });

    expect(stored).toEqual({ type: "write", id: 2, ok: true });
    const built = await send({ cmd: "read", id: 3, key: "built", sample: true });
    const given = await send({ cmd: "read", id: 4, key: "given", sample: true });
    if (built?.type !== "read" || given?.type !== "read") throw new Error("not reads");
    expect(given.data).toEqual(built.data);
    expect([given.width, given.height, given.full]).toEqual([built.width, built.height, built.full]);
    expectSample(given.sample, built.sample as StoredSample);
  });

  it("reads the frame's size without the sample when not asked, leaving the sample's bytes alone", async () => {
    const KEY = "v6:DSC_0002.NEF:64:0";
    const { send, fs } = await withFolder();
    await send({ cmd: "write", id: 1, key: KEY, data: pixels(3, 2), width: 3, height: 2, maxEdge: 4096 });
    // Spoil the sample's stream: a read that touched it would fail.
    const file = await fileOf(KEY);
    const bytes = fs.bytes(file);
    if (!bytes) throw new Error("the write left no file");
    const words = headerWords(bytes);
    bytes.fill(0, ENTRY_HEADER_BYTES + words[11] + words[10]);
    fs.putBytes(file, bytes);

    expect(await send({ cmd: "read", id: 2, key: KEY, sample: false })).toEqual({
      type: "read",
      id: 2,
      width: 3,
      height: 2,
      data: encodeCachedPreview(pixels(3, 2), 3, 2, 4096).data,
      full: { width: 3, height: 2 },
      sample: null,
    });
    expect(await send({ cmd: "read", id: 3, key: KEY, sample: true })).toMatchObject({ data: null });
  });

  // A frame larger than the cache's edge, so the preview's size, the frame's
  // size and the sample's place in it are three different things.
  it("keeps the frame's size and the sample's place apart from the preview's size", async () => {
    const KEY = "v6:DSC_0004.NEF:64:0";
    const { send } = await withFolder();
    const data = pixels(1026, 1028);

    await send({ cmd: "write", id: 1, key: KEY, data, width: 1026, height: 1028, maxEdge: 64 });
    const reply = await send({ cmd: "read", id: 2, key: KEY, sample: true });

    if (reply?.type !== "read") throw new Error("not a read");
    const { sample, ...rest } = reply;
    const preview = encodeCachedPreview(pixels(1026, 1028), 1026, 1028, 64);
    expect(rest).toEqual({
      type: "read",
      id: 2,
      width: preview.width,
      height: preview.height,
      data: preview.data,
      full: { width: 1026, height: 1028 },
    });
    expectSample(sample, cutSourceSample(pixels(1026, 1028), 1026, 1028));
    expect([sample.width, sample.height, sample.x, sample.y]).toEqual([1024, 1024, 1, 2]);
  });

  // The file's name is a fixed-length hash of the key, so a deep or non-ASCII
  // path can't outgrow the 255 bytes a file name may take.
  it("keeps the file name under 255 bytes for a deep path of non-ASCII folders, and round-trips it", async () => {
    const KEY = `v6:${"写真/".repeat(120)}DSC_0100.NEF:52428800:90`;
    expect(encodeURIComponent(KEY).length).toBeGreaterThan(255);
    const { send, fs } = await withFolder();
    const data = pixels(3, 2);

    expect(await send({ cmd: "write", id: 1, key: KEY, data, width: 3, height: 2, maxEdge: 4096 })).toEqual({
      type: "write", id: 1, ok: true,
    });

    const names = fs.tree(RAW);
    expect(names).toHaveLength(1);
    expect(nameBytes(names[0])).toBeLessThanOrEqual(255);
    expect(await send({ cmd: "read", id: 2, key: KEY, sample: false })).toMatchObject({
      data: encodeCachedPreview(pixels(3, 2), 3, 2, 4096).data,
      full: { width: 3, height: 2 },
    });
    expect(await send({ cmd: "keys", id: 3 })).toEqual({
      type: "keys", id: 3, entries: [{ key: KEY, complete: true }],
    });
  });

  it("keeps a marker for a long key in a short file name, and reads it back", async () => {
    const MARKER = `unsupported@libraw#2:v6:${"写真/".repeat(120)}DSC_0100.NEF:52428800:0`;
    const { send, fs } = await withFolder();

    await send({ cmd: "mark", id: 1, key: MARKER, value: "s1 1700000000000" });

    expect(fs.tree(RAW).map(nameBytes).every((n) => n <= 255)).toBe(true);
    expect(await send({ cmd: "peek", id: 2, key: MARKER })).toEqual({
      type: "peek", id: 2, value: "s1 1700000000000",
    });
    expect(await send({ cmd: "keys", id: 3 })).toEqual({
      type: "keys", id: 3, entries: [{ key: MARKER, complete: false }],
    });
  });

  it("never lets two keys share a file, even with a long path in common", async () => {
    const stem = `v6:${"写真/".repeat(120)}DSC_0100`;
    const A = `${stem}.NEF:52428800:0`;
    const B = `${stem}.NEF:52428800:90`;
    const { send, fs } = await withFolder();

    await send({ cmd: "write", id: 1, key: A, data: pixels(3, 2), width: 3, height: 2, maxEdge: 4096 });
    await send({ cmd: "write", id: 2, key: B, data: pixels(2, 2), width: 2, height: 2, maxEdge: 4096 });

    expect(new Set(fs.tree(RAW)).size).toBe(2);
    expect(await send({ cmd: "read", id: 3, key: A, sample: false })).toMatchObject({ width: 3, height: 2 });
    expect(await send({ cmd: "read", id: 4, key: B, sample: false })).toMatchObject({ width: 2, height: 2 });
  });

  // The name is only a hash: the key inside the entry is what says whose it is.
  it("reads an entry stored under another key's name as a miss, and keeps it", async () => {
    const OWN = "v6:own.NEF:64:0";
    const OTHER = "v6:other.NEF:64:0";
    const { send, fs } = await withFolder();
    await send({ cmd: "write", id: 1, key: OWN, data: pixels(3, 2), width: 3, height: 2, maxEdge: 4096 });
    const bytes = fs.bytes(await fileOf(OWN));
    if (!bytes) throw new Error("the write left no file");
    fs.putBytes(await fileOf(OTHER), bytes);

    expect(await send({ cmd: "read", id: 2, key: OTHER, sample: false })).toEqual({
      type: "read", id: 2, data: null, width: 0, height: 0, full: null, sample: null,
    });
    expect(await send({ cmd: "read", id: 3, key: OWN, sample: false })).toMatchObject({ width: 3 });
  });

  it("reads a marker stored under another key's name as no marker", async () => {
    const OWN = "unsupported@libraw#2:v6:own.NEF:64:0";
    const OTHER = "unsupported@libraw#2:v6:other.NEF:64:0";
    const { send, fs } = await withFolder();
    await send({ cmd: "mark", id: 1, key: OWN, value: "s1" });
    const bytes = fs.bytes(await fileOf(OWN));
    if (!bytes) throw new Error("the mark left no file");
    fs.putBytes(await fileOf(OTHER), bytes);

    expect(await send({ cmd: "peek", id: 2, key: OTHER })).toEqual({ type: "peek", id: 2, value: null });
    expect(await send({ cmd: "peek", id: 3, key: OWN })).toEqual({ type: "peek", id: 3, value: "s1" });
  });

  // Files named by the key itself, from before the name was a hash, can't be
  // told apart from other keys' or read back: they go on the first listing, and
  // their photos are filled afresh.
  it("removes files named the old way when it lists, leaving other files alone", async () => {
    const KEY = "v6:DSC_0003.NEF:64:0";
    const fs = new MemoryFs(RAW)
      .putBytes(`${RAW}/${encodeURIComponent(KEY)}.bin`, await legacyFile(pixels(3, 2), 3, 2))
      .put(`${RAW}/${encodeURIComponent("unsupported@libraw#2:" + KEY)}.bin`, "s1")
      .put(`${RAW}/notes.txt`, "x");
    const { send } = await withFolder(fs);

    expect(await send({ cmd: "read", id: 1, key: KEY, sample: false })).toMatchObject({ data: null });
    expect(await send({ cmd: "keys", id: 2 })).toEqual({ type: "keys", id: 2, entries: [] });

    expect(fs.tree(RAW)).toEqual([`${RAW}/notes.txt`]);
  });

  it("treats a file too short for its header as a miss", async () => {
    const fs = new MemoryFs(RAW).put(await fileOf("short"), "abc");
    const { send } = await withFolder(fs);

    expect(await send({ cmd: "read", id: 3, key: "short", sample: false })).toEqual({
      type: "read", id: 3, data: null, width: 0, height: 0, full: null, sample: null,
    });
  });

  // A folder entry is created empty and gets its bytes as its file closes. A
  // quit or a failed close before then leaves it empty for good: it must not
  // count as cached, or the pass would skip the photo while Develop misses.
  it("doesn't list an entry whose write hasn't closed, which reads as a miss", async () => {
    const KEY = "v6:DSC_0001.NEF:64:0";
    const file = await fileOf(KEY);
    const fs = new MemoryFs(RAW);
    const { post, send } = await withFolder(fs);
    const writes = fs.holdWrites();
    void post({
      cmd: "write", id: 1, key: KEY, data: pixels(2, 2), width: 2, height: 2, maxEdge: 3072,
    });
    await vi.waitFor(() => expect(fs.mostConcurrentWrites(file)).toBe(1));
    writes.landNext(); // the file is created, empty; its close() is still held
    await vi.waitFor(() => expect(fs.has(file)).toBe(true));

    expect(await send({ cmd: "keys", id: 2 })).toEqual({ type: "keys", id: 2, entries: [] });
    expect(await send({ cmd: "read", id: 3, key: KEY, sample: false })).toMatchObject({ data: null });
  });

  it("removes an entry too short for its header once it reads as a miss", async () => {
    const file = await fileOf("short");
    const fs = new MemoryFs(RAW).put(file, "abc");
    const { send } = await withFolder(fs);

    await send({ cmd: "read", id: 1, key: "short", sample: false });

    expect(fs.has(file)).toBe(false);
    expect(await send({ cmd: "keys", id: 2 })).toEqual({ type: "keys", id: 2, entries: [] });
  });

  it("never lists a file shorter than its header, and removes it once it reads as a miss", async () => {
    const file = await fileOf("short");
    const short = new Uint8Array(new Uint32Array([ENTRY_MAGIC, ENTRY_LAYOUT, 3, 2, 0]).buffer);
    const fs = new MemoryFs(RAW).putBytes(file, short);
    const { send } = await withFolder(fs);

    expect(await send({ cmd: "keys", id: 1 })).toEqual({ type: "keys", id: 1, entries: [] });
    expect(await send({ cmd: "read", id: 2, key: "short", sample: false })).toMatchObject({ data: null });
    expect(fs.has(file)).toBe(false);
  });

  // A later build's layout serves nothing here: listed as complete, the pass
  // would skip a photo Develop can only miss; listed as incomplete, it would
  // pass for an old entry that still serves.
  it("never lists a file in a layout this build doesn't know, and removes it once it reads as a miss", async () => {
    const header = encodeEntryHeader({
      width: 3,
      height: 2,
      fullWidth: 3,
      fullHeight: 2,
      sample: { width: 3, height: 2, x: 0, y: 0 },
      previewBytes: 8,
      keyBytes: 5,
    });
    header[1] = ENTRY_LAYOUT + 1;
    const later = new Uint8Array(60);
    later.set(new Uint8Array(header.buffer));
    const file = await fileOf("later");
    const fs = new MemoryFs(RAW).putBytes(file, later);
    const { send } = await withFolder(fs);

    expect(await send({ cmd: "keys", id: 1 })).toEqual({ type: "keys", id: 1, entries: [] });
    expect(await send({ cmd: "read", id: 2, key: "later", sample: false })).toMatchObject({ data: null });
    expect(fs.has(file)).toBe(false);
  });

  it("lists the key kept inside each entry and marker, skipping other files", async () => {
    const ENTRY = "v6:2026/a b.ARW:10:0";
    const MARKER = `unsupported@libraw#2:${ENTRY}`;
    const fs = new MemoryFs(RAW).put(`${RAW}/notes.txt`, "x");
    const { send } = await withFolder(fs);
    await send({ cmd: "write", id: 1, key: ENTRY, data: pixels(1, 1), width: 1, height: 1, maxEdge: 64 });
    await send({ cmd: "mark", id: 2, key: MARKER, value: "s1" });

    const reply = await send({ cmd: "keys", id: 3 });
    const entries = reply?.type === "keys" ? [...reply.entries].sort((a, b) => a.key.localeCompare(b.key)) : null;
    expect(entries).toEqual([{ key: MARKER, complete: false }, { key: ENTRY, complete: true }]);
    expect(fs.has(`${RAW}/notes.txt`)).toBe(true);
  });

  it("replies with an error when a request fails", async () => {
    const { send } = await withFolder(new MemoryFs(RAW).freeze(RAW));
    const data = pixels(1, 1);

    expect(
      await send({ cmd: "write", id: 5, key: "k", data, width: 1, height: 1, maxEdge: 64 }),
    ).toEqual({ type: "error", id: 5, message: expect.stringContaining("EROFS") });
  });
});

describe("cache worker, no reachable folder", () => {
  const A = "D:/A/.safelight/raw";
  const B = "D:/B/.safelight/raw";
  const KEY = "v6:DSC0001.ARW:10:0";

  const write = (id: number, data: Float32Array): CacheRequest => ({
    cmd: "write", id, key: KEY, data, width: 1, height: 1, maxEdge: 64,
  });
  const scopeTo = (scope: string | null): CacheRequest => ({
    cmd: "setCacheDir", dir: null, scope,
  });

  // IndexedDB answers a put before its transaction commits, and an exhausted
  // quota fails the commit. The pass counts refused writes to know when to stop,
  // so a write is only reported once it has landed.
  it("replies with an error when the write's transaction does not commit", async () => {
    const idb = new FakeIndexedDB();
    idb.commitError = new DOMException("The quota has been exceeded.", "QuotaExceededError");
    const { send } = await startCacheWorker(idb);

    const reply = await send(write(1, new Float32Array([0.25, 0.5, 0.75, 1])));

    expect(reply).toEqual({ type: "error", id: 1, message: expect.stringContaining("quota") });
    expect(idb.rows.size).toBe(0);
  });

  it("keeps same-named RAWs from different projects apart", async () => {
    const { send } = await startCacheWorker(new FakeIndexedDB());
    const fromA = new Float32Array([0.25, 0.5, 0.75, 1]);
    const fromB = new Float32Array([1, 0.75, 0.5, 0.25]);

    await send(scopeTo(A));
    await send(write(1, fromA));
    await send(scopeTo(B));
    expect(await send({ cmd: "read", id: 2, key: KEY, sample: false })).toMatchObject({ data: null });
    expect(await send({ cmd: "keys", id: 3 })).toEqual({ type: "keys", id: 3, entries: [] });

    await send(write(4, fromB));
    await send(scopeTo(A));
    expect(await send({ cmd: "read", id: 5, key: KEY, sample: false })).toMatchObject({
      data: encodeCachedPreview(fromA, 1, 1, 64).data,
    });
    expect(await send({ cmd: "keys", id: 6 })).toEqual({
      type: "keys", id: 6, entries: [{ key: KEY, complete: true }],
    });
  });

  it("round-trips the frame's size and the sample", async () => {
    const { send } = await startCacheWorker(new FakeIndexedDB());
    await send(scopeTo(A));
    const data = new Float32Array([0.25, 0.5, 0.75, 1]);

    await send(write(1, data));

    expect(await send({ cmd: "read", id: 2, key: KEY, sample: true })).toEqual({
      type: "read",
      id: 2,
      width: 1,
      height: 1,
      data: encodeCachedPreview(data, 1, 1, 64).data,
      full: { width: 1, height: 1 },
      sample: cutSourceSample(data, 1, 1),
    });
    expect(await send({ cmd: "read", id: 3, key: KEY, sample: false })).toMatchObject({
      full: { width: 1, height: 1 },
      sample: null,
    });
  });

  it("reads the frame's size without the sample when not asked", async () => {
    const { send } = await startCacheWorker(new FakeIndexedDB());
    await send(scopeTo(A));
    await send({ cmd: "write", id: 1, key: KEY, data: pixels(3, 2), width: 3, height: 2, maxEdge: 4096 });

    expect(await send({ cmd: "read", id: 2, key: KEY, sample: false })).toEqual({
      type: "read",
      id: 2,
      width: 3,
      height: 2,
      data: encodeCachedPreview(pixels(3, 2), 3, 2, 4096).data,
      full: { width: 3, height: 2 },
      sample: null,
    });
    expect(await send({ cmd: "read", id: 3, key: KEY, sample: true })).toMatchObject({
      full: { width: 3, height: 2 },
      sample: cutSourceSample(pixels(3, 2), 3, 2),
    });
  });

  // A frame larger than the cache's edge, so the preview's size, the frame's
  // size and the sample's place in it are three different things.
  it("keeps the frame's size and the sample's place apart from the preview's size", async () => {
    const { send } = await startCacheWorker(new FakeIndexedDB());
    await send(scopeTo(A));
    const data = pixels(1026, 1028);

    await send({ cmd: "write", id: 1, key: KEY, data, width: 1026, height: 1028, maxEdge: 64 });
    const reply = await send({ cmd: "read", id: 2, key: KEY, sample: true });

    if (reply?.type !== "read") throw new Error("not a read");
    const { sample, ...rest } = reply;
    const preview = encodeCachedPreview(pixels(1026, 1028), 1026, 1028, 64);
    expect(rest).toEqual({
      type: "read",
      id: 2,
      width: preview.width,
      height: preview.height,
      data: preview.data,
      full: { width: 1026, height: 1028 },
    });
    expectSample(sample, cutSourceSample(pixels(1026, 1028), 1026, 1028));
    expect([sample.width, sample.height, sample.x, sample.y]).toEqual([1024, 1024, 1, 2]);
  });

  it("reads an entry stored before 3.1.0 as before, and lists it as incomplete", async () => {
    const idb = new FakeIndexedDB();
    // Already at the current version, so opening it runs no upgrade, which would drop the row.
    idb.version = 6;
    const u16 = encodeCachedPreview(new Float32Array([0.25, 0.5, 0.75, 1]), 1, 1, 64).data;
    // As a build before 3.1.0 stored it: no fullWidth, no sample.
    const row = { key: scopedKey(A, KEY), blob: new Blob([await gzipped(u16)]), width: 1, height: 1 };
    idb.rows.set(row.key, row);
    const { send } = await startCacheWorker(idb);
    await send(scopeTo(A));

    expect(await send({ cmd: "read", id: 1, key: KEY, sample: true })).toEqual({
      type: "read", id: 1, width: 1, height: 1, data: u16, full: null, sample: null,
    });
    expect(await send({ cmd: "keys", id: 2 })).toEqual({
      type: "keys", id: 2, entries: [{ key: KEY, complete: false }],
    });
  });

  it("deletes only the current project's entry", async () => {
    const { send } = await startCacheWorker(new FakeIndexedDB());
    await send(scopeTo(A));
    await send(write(1, pixels(1, 1)));
    await send(scopeTo(B));
    await send(write(2, pixels(1, 1)));

    await send({ cmd: "delete", id: 3, key: KEY });

    expect(await send({ cmd: "keys", id: 4 })).toMatchObject({ entries: [] });
    await send(scopeTo(A));
    expect(await send({ cmd: "keys", id: 5 })).toMatchObject({
      entries: [{ key: KEY, complete: true }],
    });
  });

  it("clears every project's entries", async () => {
    const idb = new FakeIndexedDB();
    const { send } = await startCacheWorker(idb);
    await send(scopeTo(A));
    await send(write(1, pixels(1, 1)));
    await send(scopeTo(B));
    await send(write(2, pixels(1, 1)));

    expect(await send({ cmd: "clear", id: 3 })).toEqual({ type: "clear", id: 3, failed: 0 });
    expect(idb.rows.size).toBe(0);
  });

  it("counts what it could not clear", async () => {
    const idb = new FakeIndexedDB();
    const { send } = await startCacheWorker(idb);
    await send(scopeTo(A));
    await send(write(1, pixels(1, 1)));
    idb.commitError = new Error("quota");

    expect(await send({ cmd: "clear", id: 3 })).toEqual({ type: "clear", id: 3, failed: 1 });
  });

  it("caches nothing when the project has no scope", async () => {
    const idb = new FakeIndexedDB();
    const { send } = await startCacheWorker(idb);
    await send(scopeTo(A));
    await send(write(1, pixels(1, 1)));
    await send(scopeTo(null));

    expect(await send({ cmd: "read", id: 2, key: KEY, sample: false })).toMatchObject({ data: null });
    expect(await send({ cmd: "keys", id: 3 })).toMatchObject({ entries: [] });
    expect(await send(write(4, pixels(1, 1)))).toEqual({ type: "write", id: 4, ok: false });
    expect(await send({ cmd: "delete", id: 5, key: KEY })).toEqual({ type: "delete", id: 5 });
    expect(idb.rows.size).toBe(1);
  });

  // Entries written before keys were scoped carry no project, so any of them
  // could be another project's picture: they go once, on the first open.
  it("drops the entries written before keys were scoped", async () => {
    const idb = new FakeIndexedDB();
    idb.version = 5;
    idb.rows.set(KEY, { key: KEY });
    const { send } = await startCacheWorker(idb);

    await send(scopeTo(A));
    await send({ cmd: "keys", id: 1 });

    expect(idb.rows.size).toBe(0);
  });

  const failed = (replies: CacheResponse[]) =>
    replies.flatMap((r) => (r.type === "error" ? [r.id] : [])).sort();

  // A Develop read has no timeout, so waiting on the other window would leave
  // the photo loading until that window closes.
  it("fails each read fast while another window holds the cache open", async () => {
    const idb = new FakeIndexedDB();
    idb.blockOpens = true;
    const { send, post, replies } = await startCacheWorker(idb);
    await send(scopeTo(A));

    void post({ cmd: "read", id: 1, key: KEY, sample: false });
    await vi.waitFor(() => expect(failed(replies())).toEqual([1]), { timeout: 1000 });
    void post({ cmd: "read", id: 2, key: KEY, sample: false });
    await vi.waitFor(() => expect(failed(replies())).toEqual([1, 2]), { timeout: 1000 });

    expect(idb.opens).toBe(1);
  });

  it("fails reads that arrive together fast while another window holds the cache open", async () => {
    const idb = new FakeIndexedDB();
    idb.blockOpens = true;
    const { send, post, replies } = await startCacheWorker(idb);
    await send(scopeTo(A));

    void post({ cmd: "read", id: 1, key: KEY, sample: false });
    void post({ cmd: "read", id: 2, key: KEY, sample: false });

    await vi.waitFor(() => expect(failed(replies())).toEqual([1, 2]), { timeout: 1000 });
    expect(idb.opens).toBe(1);
  });

  it("keeps the connection once the other window lets go", async () => {
    const idb = new FakeIndexedDB();
    idb.blockOpens = true;
    const { send } = await startCacheWorker(idb);
    await send(scopeTo(A));
    expect(await send({ cmd: "read", id: 1, key: KEY, sample: false })).toMatchObject({
      type: "error", id: 1,
    });

    idb.release();
    await vi.waitFor(() => expect(idb.connections).toHaveLength(1));

    expect(await send(write(2, pixels(1, 1)))).toEqual({ type: "write", id: 2, ok: true });
    expect(await send({ cmd: "keys", id: 3 })).toEqual({
      type: "keys", id: 3, entries: [{ key: KEY, complete: true }],
    });
    expect(idb.opens).toBe(1);
    expect(idb.connections[0].closed).toBe(false);
    idb.connections[0].onversionchange?.();
    expect(idb.connections[0].closed).toBe(true);
  });

  it("shares one open between requests that arrive together", async () => {
    const idb = new FakeIndexedDB();
    const { send, post, replies } = await startCacheWorker(idb);
    await send(scopeTo(A));

    await Promise.all([
      post({ cmd: "read", id: 1, key: KEY, sample: false }),
      post({ cmd: "read", id: 2, key: KEY, sample: false }),
    ]);

    expect(replies()).toEqual(expect.arrayContaining([
      { type: "read", id: 1, data: null, width: 0, height: 0, full: null, sample: null },
      { type: "read", id: 2, data: null, width: 0, height: 0, full: null, sample: null },
    ]));
    expect(idb.opens).toBe(1);
  });

  it("lets go of its connection when another window upgrades the cache", async () => {
    const idb = new FakeIndexedDB();
    const { send } = await startCacheWorker(idb);
    await send(scopeTo(A));
    await send(write(1, pixels(1, 1)));

    idb.connections[0].onversionchange?.();

    expect(idb.connections[0].closed).toBe(true);
    expect(await send({ cmd: "keys", id: 2 })).toEqual({
      type: "keys", id: 2, entries: [{ key: KEY, complete: true }],
    });
    expect(idb.connections).toHaveLength(2);
  });
});
