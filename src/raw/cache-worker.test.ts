// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryFs, fsaDirectoryHandle } from "@/project/memory-fs.test-support";
import { encodeCachedPreview } from "./cache-encode";
import type { CacheRequest, CacheResponse } from "./cache-worker";
import { FakeIndexedDB, startCacheWorker } from "./cache-worker.test-support";

afterEach(() => {
  vi.unstubAllGlobals();
});

const pixels = (w: number, h: number) =>
  new Float32Array(w * h * 4).map((_, i) => (i % 7) * 0.25 - 0.25);

describe("cache worker, project folder", () => {
  const RAW = "/p/.safelight/raw";

  async function withFolder(fs = new MemoryFs(RAW)) {
    const worker = await startCacheWorker();
    await worker.send({ cmd: "setCacheDir", dir: fsaDirectoryHandle(fs, RAW), scope: "" });
    return { ...worker, fs };
  }

  it("round-trips a preview whose key needs escaping", async () => {
    const { send } = await withFolder();
    const data = pixels(3, 2);

    await send({ cmd: "write", id: 1, key: "a/b c", data, width: 3, height: 2, maxEdge: 4096 });
    const reply = await send({ cmd: "read", id: 2, key: "a/b c" });

    expect(reply).toEqual({
      type: "read",
      id: 2,
      width: 3,
      height: 2,
      data: encodeCachedPreview(pixels(3, 2), 3, 2, 4096).data,
    });
  });

  it("treats a file too short for its header as a miss", async () => {
    const fs = new MemoryFs(RAW).put(`${RAW}/short.bin`, "abc");
    const { send } = await withFolder(fs);

    expect(await send({ cmd: "read", id: 3, key: "short" })).toEqual({
      type: "read", id: 3, data: null, width: 0, height: 0,
    });
  });

  // A folder entry is created empty and gets its bytes as its file closes. A
  // quit or a failed close before then leaves it empty for good: it must not
  // count as cached, or the pass would skip the photo while Develop misses.
  it("doesn't list an entry whose write hasn't closed, which reads as a miss", async () => {
    const KEY = "v6:DSC_0001.NEF:64:0";
    const file = `${RAW}/${encodeURIComponent(KEY)}.bin`;
    const fs = new MemoryFs(RAW);
    const { post, send } = await withFolder(fs);
    const writes = fs.holdWrites();
    void post({
      cmd: "write", id: 1, key: KEY, data: pixels(2, 2), width: 2, height: 2, maxEdge: 3072,
    });
    await vi.waitFor(() => expect(fs.mostConcurrentWrites(file)).toBe(1));
    writes.landNext(); // the file is created, empty; its close() is still held
    await vi.waitFor(() => expect(fs.has(file)).toBe(true));

    expect(await send({ cmd: "keys", id: 2 })).toEqual({ type: "keys", id: 2, keys: [] });
    expect(await send({ cmd: "read", id: 3, key: KEY })).toMatchObject({ data: null });
  });

  it("removes an entry too short for its header once it reads as a miss", async () => {
    const fs = new MemoryFs(RAW).put(`${RAW}/short.bin`, "abc");
    const { send } = await withFolder(fs);

    await send({ cmd: "read", id: 1, key: "short" });

    expect(fs.has(`${RAW}/short.bin`)).toBe(false);
    expect(await send({ cmd: "keys", id: 2 })).toEqual({ type: "keys", id: 2, keys: [] });
  });

  it("lists decoded keys, skipping other files and malformed names", async () => {
    const fs = new MemoryFs(RAW)
      .put(`${RAW}/${encodeURIComponent("v6:2026/a b.ARW:10:0")}.bin`, "x")
      .put(`${RAW}/notes.txt`, "x")
      .put(`${RAW}/%E0%A4%A.bin`, "x");
    const { send } = await withFolder(fs);

    expect(await send({ cmd: "keys", id: 4 })).toEqual({
      type: "keys", id: 4, keys: ["v6:2026/a b.ARW:10:0"],
    });
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

  it("keeps same-named RAWs from different projects apart", async () => {
    const { send } = await startCacheWorker(new FakeIndexedDB());
    const fromA = new Float32Array([0.25, 0.5, 0.75, 1]);
    const fromB = new Float32Array([1, 0.75, 0.5, 0.25]);

    await send(scopeTo(A));
    await send(write(1, fromA));
    await send(scopeTo(B));
    expect(await send({ cmd: "read", id: 2, key: KEY })).toMatchObject({ data: null });
    expect(await send({ cmd: "keys", id: 3 })).toEqual({ type: "keys", id: 3, keys: [] });

    await send(write(4, fromB));
    await send(scopeTo(A));
    expect(await send({ cmd: "read", id: 5, key: KEY })).toMatchObject({
      data: encodeCachedPreview(fromA, 1, 1, 64).data,
    });
    expect(await send({ cmd: "keys", id: 6 })).toEqual({ type: "keys", id: 6, keys: [KEY] });
  });

  it("deletes only the current project's entry", async () => {
    const { send } = await startCacheWorker(new FakeIndexedDB());
    await send(scopeTo(A));
    await send(write(1, pixels(1, 1)));
    await send(scopeTo(B));
    await send(write(2, pixels(1, 1)));

    await send({ cmd: "delete", id: 3, key: KEY });

    expect(await send({ cmd: "keys", id: 4 })).toMatchObject({ keys: [] });
    await send(scopeTo(A));
    expect(await send({ cmd: "keys", id: 5 })).toMatchObject({ keys: [KEY] });
  });

  it("clears every project's entries", async () => {
    const idb = new FakeIndexedDB();
    const { send } = await startCacheWorker(idb);
    await send(scopeTo(A));
    await send(write(1, pixels(1, 1)));
    await send(scopeTo(B));
    await send(write(2, pixels(1, 1)));

    expect(await send({ cmd: "clear", id: 3 })).toEqual({ type: "clear", id: 3 });
    expect(idb.rows.size).toBe(0);
  });

  it("caches nothing when the project has no scope", async () => {
    const idb = new FakeIndexedDB();
    const { send } = await startCacheWorker(idb);
    await send(scopeTo(A));
    await send(write(1, pixels(1, 1)));
    await send(scopeTo(null));

    expect(await send({ cmd: "read", id: 2, key: KEY })).toMatchObject({ data: null });
    expect(await send({ cmd: "keys", id: 3 })).toMatchObject({ keys: [] });
    expect(await send(write(4, pixels(1, 1)))).toEqual({ type: "write", id: 4, ok: true });
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

    void post({ cmd: "read", id: 1, key: KEY });
    await vi.waitFor(() => expect(failed(replies())).toEqual([1]), { timeout: 1000 });
    void post({ cmd: "read", id: 2, key: KEY });
    await vi.waitFor(() => expect(failed(replies())).toEqual([1, 2]), { timeout: 1000 });

    expect(idb.opens).toBe(1);
  });

  it("fails reads that arrive together fast while another window holds the cache open", async () => {
    const idb = new FakeIndexedDB();
    idb.blockOpens = true;
    const { send, post, replies } = await startCacheWorker(idb);
    await send(scopeTo(A));

    void post({ cmd: "read", id: 1, key: KEY });
    void post({ cmd: "read", id: 2, key: KEY });

    await vi.waitFor(() => expect(failed(replies())).toEqual([1, 2]), { timeout: 1000 });
    expect(idb.opens).toBe(1);
  });

  it("keeps the connection once the other window lets go", async () => {
    const idb = new FakeIndexedDB();
    idb.blockOpens = true;
    const { send } = await startCacheWorker(idb);
    await send(scopeTo(A));
    expect(await send({ cmd: "read", id: 1, key: KEY })).toMatchObject({ type: "error", id: 1 });

    idb.release();
    await vi.waitFor(() => expect(idb.connections).toHaveLength(1));

    expect(await send(write(2, pixels(1, 1)))).toEqual({ type: "write", id: 2, ok: true });
    expect(await send({ cmd: "keys", id: 3 })).toEqual({ type: "keys", id: 3, keys: [KEY] });
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
      post({ cmd: "read", id: 1, key: KEY }),
      post({ cmd: "read", id: 2, key: KEY }),
    ]);

    expect(replies()).toEqual(expect.arrayContaining([
      { type: "read", id: 1, data: null, width: 0, height: 0 },
      { type: "read", id: 2, data: null, width: 0, height: 0 },
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
    expect(await send({ cmd: "keys", id: 2 })).toEqual({ type: "keys", id: 2, keys: [KEY] });
    expect(idb.connections).toHaveLength(2);
  });
});
