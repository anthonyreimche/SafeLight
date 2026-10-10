// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The two-session rule for decode markers, end to end through the real cache
// worker on both of its stores: a definitive failure in one session leaves a
// tentative marker nothing honours (it may have been that session's lack of
// memory), a failure in a second session makes it final, and a decode that is
// accepted and cached starts the count over. Each session is a fresh load of
// the cache module and of the worker; the folder or database outlives them.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryFs, fsaDirectoryHandle } from "@/project/memory-fs.test-support";
import type { CacheRequest, CacheResponse } from "./cache-worker";
import { FakeIndexedDB, startCacheWorker } from "./cache-worker.test-support";

interface RunningWorker {
  post: (msg: CacheRequest) => Promise<void>;
  reply: (id: number) => CacheResponse | undefined;
}

const h = vi.hoisted(() => ({
  worker: null as RunningWorker | null,
  nextId: 1,
}));

// The bridge, minus the Worker: each request goes to this session's worker.
vi.mock("./cache-bridge", () => {
  async function ask(msg: CacheRequest): Promise<CacheResponse | undefined> {
    const worker = h.worker;
    if (!worker) throw new Error("no cache worker is running");
    await worker.post(msg);
    return "id" in msg ? worker.reply(msg.id) : undefined;
  }
  const id = () => h.nextId++;
  return {
    setCacheDirOnWorker: () => {},
    workerReadCachedPreview: async () => null,
    workerWriteCachedPreview: async (
      key: string,
      data: Float32Array,
      width: number,
      height: number,
      maxEdge: number,
    ) => {
      await ask({ cmd: "write", id: id(), key, data, width, height, maxEdge });
    },
    workerWriteMarker: async (key: string, value: string) => {
      await ask({ cmd: "mark", id: id(), key, value });
    },
    workerReadMarker: async (key: string) => {
      const reply = await ask({ cmd: "peek", id: id(), key });
      return reply?.type === "peek" ? reply.value : null;
    },
    workerDeleteCachedPreview: async (key: string) => {
      await ask({ cmd: "delete", id: id(), key });
    },
    workerClearRawCache: async () => {
      await ask({ cmd: "clear", id: id() });
    },
    workerCachedKeys: async () => {
      const reply = await ask({ cmd: "keys", id: id() });
      return reply?.type === "keys" ? reply.keys : [];
    },
  };
});

vi.mock("@/state/settings-store", () => ({
  getSettings: () => ({ rawCacheEnabled: true, rawCacheMaxEdge: 3072 }),
}));

const KEY = "v6:DSC00001.ARW:52428800:0";
const A = "/A/.safelight/raw";

interface Store {
  idb?: FakeIndexedDB;
  open: CacheRequest;
}

const stores: { name: string; make: () => Store }[] = [
  {
    name: "the project folder",
    make: () => ({
      open: { cmd: "setCacheDir", dir: fsaDirectoryHandle(new MemoryFs(A), A), scope: "" },
    }),
  },
  {
    name: "the shared database",
    make: () => ({
      idb: new FakeIndexedDB(),
      open: { cmd: "setCacheDir", dir: null, scope: "D:/A" },
    }),
  },
];

/** Resolve after every already-queued microtask chain has run to completion. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// A strike counts towards a final marker only when it came before the striking
// session loaded, so sessions here load a second apart on a fake clock.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe.each(stores)("decode markers in $name", ({ make }) => {
  let store: Store = make();

  beforeEach(() => {
    store = make();
  });

  /** A new page load: a fresh worker on the same store, a fresh cache module. */
  async function session() {
    vi.setSystemTime(Date.now() + 1000);
    const worker = await startCacheWorker(store.idb);
    h.worker = worker;
    await worker.post(store.open);
    return import("./raw-cache");
  }

  async function strikeInNewSession() {
    const cache = await session();
    await cache.markDecode(KEY, "unsupported", cache.rawCacheGeneration());
    return cache;
  }

  it("leaves one session's failure tentative, so the photo is still decoded", async () => {
    await strikeInNewSession();
    const later = await session();

    expect(await later.hasDecodeMarker(KEY, "unsupported")).toBe(false);
    expect((await later.cachedKeys()).has(KEY)).toBe(false);
  });

  it("keeps it tentative when the same session fails the photo twice", async () => {
    const cache = await strikeInNewSession();
    await cache.markDecode(KEY, "unsupported", cache.rawCacheGeneration());
    const later = await session();

    expect(await later.hasDecodeMarker(KEY, "unsupported")).toBe(false);
  });

  it("makes it final when a second session fails the photo too", async () => {
    await strikeInNewSession();
    await strikeInNewSession();
    const later = await session();

    expect(await later.hasDecodeMarker(KEY, "unsupported")).toBe(true);
    expect((await later.cachedKeys()).has(KEY)).toBe(true);
  });

  it("starts the count over once a decode is accepted and cached", async () => {
    const cache = await strikeInNewSession();
    await cache.writeCachedPreview(
      KEY, new Float32Array(4).fill(0.5), 1, 1, cache.rawCacheGeneration(),
    );
    await strikeInNewSession();
    const later = await session();

    expect(await later.hasDecodeMarker(KEY, "unsupported")).toBe(false);
  });

  it("ignores a final marker another decoder left", async () => {
    const cache = await session();
    const final = cache.decodeMarkerKey(KEY, "unsupported");
    const stale = final.replace(cache.DECODER_ID, "libraw-0.21.3+1");
    await h.worker?.post({ cmd: "mark", id: h.nextId++, key: stale, value: "earlier" });

    expect(await cache.hasDecodeMarker(KEY, "unsupported")).toBe(false);
    expect((await cache.cachedKeys()).has(KEY)).toBe(false);
  });
});

describe("decode markers in the project folder while a strike is written", () => {
  // The folder store creates a marker's file empty and fills it as the file
  // closes. "Cache all" and Develop can fail the same photo milliseconds apart.
  it("doesn't take a half-written marker for another session's strike", async () => {
    const fs = new MemoryFs(A);
    const worker = await startCacheWorker();
    h.worker = worker;
    await worker.post({ cmd: "setCacheDir", dir: fsaDirectoryHandle(fs, A), scope: "" });
    const cache = await import("./raw-cache");
    const begun = cache.rawCacheGeneration();
    const writes = fs.holdWrites();

    const first = cache.markDecode(KEY, "unsupported", begun);
    for (let i = 0; i < 20 && fs.tree(A).length === 0; i++) {
      writes.landNext();
      await settle();
    }
    const second = cache.markDecode(KEY, "unsupported", begun);
    await settle();
    writes.landAll();
    await Promise.all([first, second]);

    expect(fs.tree(A)).toHaveLength(1);
    expect(await cache.hasDecodeMarker(KEY, "unsupported")).toBe(false);
  });
});
