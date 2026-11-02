// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The IndexedDB raw cache is keyed by absolute path and outlives the project
// that filled it, so it is bounded: past its cap the least recently used
// pictures go, and a hit counts as a use.

import { afterEach, describe, expect, it, vi } from "vitest";
import { scopedKey } from "./cache-keys";
import { FakeIndexedDB, startCacheWorker } from "./cache-worker.test-support";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const DAY = 24 * 60 * 60 * 1000;
const pixels = (w: number, h: number) => new Float32Array(w * h * 4).map((_, i) => (i % 7) * 0.25);

interface Row {
  key: string;
  blob?: Blob;
  width?: number;
  height?: number;
  bytes?: number;
  usedAt?: number;
  marker?: boolean;
}

/** A stored picture and its meta record, as v7 writes them. */
function addPicture(idb: FakeIndexedDB, key: string, bytes: number, usedAt: number) {
  const row: Row = { key, blob: new Blob([new Uint8Array(bytes)]), width: 4, height: 4 };
  idb.rows.set(key, row);
  idb.meta.set(key, { key, bytes, usedAt, marker: false } as Row);
}

async function connect(idb: FakeIndexedDB): Promise<IDBDatabase> {
  return new Promise((resolve) => {
    const req = idb.open("safelight-raw-cache", 7) as unknown as IDBOpenDBRequest;
    req.onsuccess = () => resolve(req.result);
  });
}

describe("raw cache eviction", () => {
  it("drops the least recently used pictures until the store fits, and spares markers", async () => {
    const idb = new FakeIndexedDB();
    await startCacheWorker(idb);
    const { evictLeastRecentlyUsed } = await import("./cache-worker");
    const db = await connect(idb);
    addPicture(idb, "old", 100, 1);
    addPicture(idb, "mid", 100, 5);
    addPicture(idb, "new", 100, 9);
    const strike: Row = { key: "mark", blob: new Blob(["strike"]), width: 0, height: 0 };
    idb.rows.set("mark", strike);
    idb.meta.set("mark", { key: "mark", bytes: 0, usedAt: 0, marker: true } as Row);

    await evictLeastRecentlyUsed(db, 200);

    expect([...idb.rows.keys()].sort()).toEqual(["mark", "mid", "new"]);
    expect([...idb.meta.keys()].sort()).toEqual(["mark", "mid", "new"]);
  });

  it("never reads a picture's value, only keys and the meta records", async () => {
    const idb = new FakeIndexedDB();
    await startCacheWorker(idb);
    const { evictLeastRecentlyUsed } = await import("./cache-worker");
    const db = await connect(idb);
    addPicture(idb, "old", 100, 1);
    addPicture(idb, "new", 100, 9);
    idb.readLog.length = 0;

    await evictLeastRecentlyUsed(db, 100);

    expect([...idb.rows.keys()]).toEqual(["new"]);
    expect(idb.readLog.filter((r) => r.startsWith("previews."))).toEqual([]);
  });

  it("leaves a store under its cap alone", async () => {
    const idb = new FakeIndexedDB();
    await startCacheWorker(idb);
    const { evictLeastRecentlyUsed } = await import("./cache-worker");
    const db = await connect(idb);
    addPicture(idb, "a", 100, 1);

    await evictLeastRecentlyUsed(db, 100);

    expect([...idb.rows.keys()]).toEqual(["a"]);
  });

  it("evicts pictures from before v7 first, drops stray metas, and spares old markers", async () => {
    const idb = new FakeIndexedDB();
    await startCacheWorker(idb);
    const { evictLeastRecentlyUsed } = await import("./cache-worker");
    const db = await connect(idb);
    const legacy: Row = { key: "legacy", blob: new Blob([new Uint8Array(100)]), width: 4, height: 4 };
    const strike: Row = { key: "mark", blob: new Blob(["strike"]), width: 0, height: 0 };
    idb.rows.set("legacy", legacy);
    idb.rows.set("mark", strike);
    addPicture(idb, "fresh", 100, 9);
    idb.meta.set("gone", { key: "gone", bytes: 5, usedAt: 3, marker: false } as Row);

    await evictLeastRecentlyUsed(db, 100);

    expect([...idb.rows.keys()].sort()).toEqual(["fresh", "mark"]);
    expect([...idb.meta.keys()].sort()).toEqual(["fresh", "mark"]);
    expect(idb.meta.get("mark")).toMatchObject({ marker: true, bytes: 6 });
  });

  it("saves a pre-v7 picture's real size and age 0 when nothing needs evicting", async () => {
    const idb = new FakeIndexedDB();
    await startCacheWorker(idb);
    const { evictLeastRecentlyUsed } = await import("./cache-worker");
    const db = await connect(idb);
    const legacy: Row = { key: "legacy", blob: new Blob([new Uint8Array(100)]), width: 4, height: 4 };
    idb.rows.set("legacy", legacy);

    await evictLeastRecentlyUsed(db, 1024 ** 4);

    expect(idb.meta.get("legacy")).toMatchObject({ bytes: 100, usedAt: 0, marker: false });
  });

  it("keeps a just-written entry over a stale one from a gone project", async () => {
    const idb = new FakeIndexedDB();
    const { send } = await startCacheWorker(idb);
    await send({ cmd: "setCacheDir", dir: null, scope: "/p" });
    await send({ cmd: "write", id: 1, key: "warm.nef", data: pixels(4, 4), width: 4, height: 4, maxEdge: 4096 });
    const { evictLeastRecentlyUsed } = await import("./cache-worker");
    const db = await connect(idb);
    const warmKey = scopedKey("/p", "warm.nef");
    const size = (idb.meta.get(warmKey) as Row).bytes!;
    addPicture(idb, "stale", size, 1);

    await evictLeastRecentlyUsed(db, size);

    expect([...idb.rows.keys()]).toEqual([warmKey]);
  });

  it("deletes an entry's meta with it, and clears both stores", async () => {
    const idb = new FakeIndexedDB();
    const { send } = await startCacheWorker(idb);
    await send({ cmd: "setCacheDir", dir: null, scope: "/p" });
    await send({ cmd: "write", id: 1, key: "a.nef", data: pixels(4, 4), width: 4, height: 4, maxEdge: 4096 });
    await send({ cmd: "write", id: 2, key: "b.nef", data: pixels(4, 4), width: 4, height: 4, maxEdge: 4096 });
    await send({ cmd: "mark", id: 3, key: "c.nef", value: "strike" });
    expect(idb.meta.get(scopedKey("/p", "c.nef"))).toMatchObject({ marker: true });

    await send({ cmd: "delete", id: 4, key: "a.nef" });
    expect([...idb.meta.keys()].sort()).toEqual([scopedKey("/p", "b.nef"), scopedKey("/p", "c.nef")].sort());

    await send({ cmd: "clear", id: 5 });
    expect(idb.rows.size + idb.meta.size).toBe(0);
  });

  it("stamps a written entry with the time of the write", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const idb = new FakeIndexedDB();
    const { send } = await startCacheWorker(idb);
    await send({ cmd: "setCacheDir", dir: null, scope: "/p" });

    await send({ cmd: "write", id: 1, key: "a.nef", data: pixels(4, 4), width: 4, height: 4, maxEdge: 4096 });

    expect(idb.meta.get(scopedKey("/p", "a.nef"))).toMatchObject({ usedAt: 1_000_000 });
  });

  it("counts a read as a use, once a day at most", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const idb = new FakeIndexedDB();
    const { send } = await startCacheWorker(idb);
    await send({ cmd: "setCacheDir", dir: null, scope: "/p" });
    await send({ cmd: "write", id: 1, key: "a.nef", data: pixels(4, 4), width: 4, height: 4, maxEdge: 4096 });
    const key = scopedKey("/p", "a.nef");

    vi.setSystemTime(1_000_000 + 1000);
    await send({ cmd: "read", id: 2, key: "a.nef", sample: false });
    await new Promise((r) => setTimeout(r, 0));
    expect(idb.meta.get(key)).toMatchObject({ usedAt: 1_000_000 });

    vi.setSystemTime(1_000_000 + 2 * DAY);
    await send({ cmd: "read", id: 3, key: "a.nef", sample: false });
    await vi.waitFor(() => expect(idb.meta.get(key)).toMatchObject({ usedAt: 1_000_000 + 2 * DAY }));
  });
});
