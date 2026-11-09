// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  /** What reached the cache worker, in the order it was sent. */
  sent: [] as string[],
  /** The worker cannot make a write: the disk or the storage quota is full. */
  refuseWrites: false,
  /** What the worker lists. */
  entries: [] as { key: string; complete: boolean }[],
  /** The entries handed to writes, which the worker takes as they are. */
  entriesWritten: [] as unknown[],
  /** The reads the worker was asked for: the key, and whether with the sample. */
  reads: [] as [string, boolean][],
  /** What the worker reports it could not clear, or why it was unreachable. */
  /** The worker has no folder or project scope to write to. */
  stores: true,
  clear: { failed: 0 } as { failed: number } | Error,
}));

vi.mock("./cache-bridge", () => ({
  setCacheDirOnWorker: (dir: FileSystemDirectoryHandle | null) => {
    h.sent.push(`folder ${dir?.name ?? "none"}`);
  },
  workerWriteCachedPreview: async (key: string, _data: Float32Array, _w: number, _h: number, _edge: number, entry?: unknown) => {
    h.entriesWritten.push(entry);
    if (h.refuseWrites) throw new Error("The quota has been exceeded.");
    h.sent.push(`write ${key}`);
    return h.stores;
  },
  workerReadCachedPreview: async (key: string, sample: boolean) => {
    h.reads.push([key, sample]);
    return null;
  },
  workerDeleteCachedPreview: async () => {},
  workerClearRawCache: async () => {
    if (h.clear instanceof Error) throw h.clear;
    return h.clear;
  },
  workerCachedKeys: async () => h.entries,
}));

vi.mock("@/state/settings-store", () => ({
  getSettings: () => ({ rawCacheEnabled: true, rawCacheMaxEdge: 3072 }),
}));

import { encodeCacheEntry } from "./cache-encode";
import {
  cacheListing,
  cachedKeys,
  clearRawCache,
  decodeMarkerKey,
  rawCacheGeneration,
  rawCacheKey,
  readCachedPreview,
  setRawCacheDir,
  writeCachedPreview,
} from "./raw-cache";

const folder = (name: string) => ({ name }) as FileSystemDirectoryHandle;
const pixels = () => new Float32Array(4);

beforeEach(() => {
  h.sent = [];
  h.refuseWrites = false;
  h.entries = [];
  h.entriesWritten = [];
  h.reads = [];
  h.clear = { failed: 0 };
  h.stores = true;
});

describe("rawCacheKey", () => {
  // Cached previews bake the decode and its encoding in, so the key carries
  // both: entries written as clamped 16-bit sRGB must miss, not be served
  // without their highlight headroom.
  it("versions the decode contract ahead of the file identity", () => {
    expect(rawCacheKey("2026/DSCF2946.RAF", 31_457_280, 90)).toBe(
      "v6:2026/DSCF2946.RAF:31457280:90",
    );
  });
});

// A key names a file by its path and size inside the project, so the same key
// in the next project's cache folder stands for another photo. A decode begun
// for one project must not land in the next one's folder.
describe("writeCachedPreview across a change of project", () => {
  it("drops a write begun before the cache folder changed", async () => {
    setRawCacheDir(folder("A"));
    const begun = rawCacheGeneration();
    setRawCacheDir(folder("B"));

    await writeCachedPreview("v6:a.NEF:64:0", pixels(), 1, 1, begun);

    expect(h.sent).toEqual(["folder A", "folder B"]);
  });

  it("writes one begun since the folder last changed", async () => {
    setRawCacheDir(folder("A"));
    const begun = rawCacheGeneration();

    await writeCachedPreview("v6:a.NEF:64:0", pixels(), 1, 1, begun);

    expect(h.sent).toEqual(["folder A", "write v6:a.NEF:64:0"]);
  });

  it("still writes when the open project's folder is set again", async () => {
    // An open sets it as soon as the catalogue is read and again after the walk.
    const a = folder("A");
    setRawCacheDir(a);
    const begun = rawCacheGeneration();
    setRawCacheDir(a);

    await writeCachedPreview("v6:a.NEF:64:0", pixels(), 1, 1, begun);

    expect(h.sent).toContain("write v6:a.NEF:64:0");
  });

  it("sends a write ahead of a folder change that follows it", async () => {
    // The worker takes messages in order, so the write goes to the folder that
    // was current when it was allowed.
    setRawCacheDir(folder("A"));
    const writing = writeCachedPreview("v6:a.NEF:64:0", pixels(), 1, 1, rawCacheGeneration());
    setRawCacheDir(folder("B"));
    await writing;

    expect(h.sent).toEqual(["folder A", "write v6:a.NEF:64:0", "folder B"]);
  });
});

// A caller filling the cache in bulk has to know when the cache stops taking
// writes, though the write itself stays non-fatal.
describe("writeCachedPreview's answer", () => {
  it("says the cache took the write", async () => {
    setRawCacheDir(folder("A"));

    const taken = await writeCachedPreview("v6:a.NEF:64:0", pixels(), 1, 1, rawCacheGeneration());

    expect(taken).toBe(true);
  });

  it("says the write failed when the cache could not make it", async () => {
    setRawCacheDir(folder("A"));
    h.refuseWrites = true;

    const taken = await writeCachedPreview("v6:a.NEF:64:0", pixels(), 1, 1, rawCacheGeneration());

    expect(taken).toBe(false);
  });

  it("does not call a write dropped for a change of project a failure", async () => {
    setRawCacheDir(folder("A"));
    const begun = rawCacheGeneration();
    setRawCacheDir(folder("B"));

    const taken = await writeCachedPreview("v6:a.NEF:64:0", pixels(), 1, 1, begun);

    expect(taken).toBe(true);
  });
});

describe("writeCachedPreview with an entry built off the main thread", () => {
  it("hands the entry on for the worker to store", async () => {
    setRawCacheDir(folder("A"));
    const entry = encodeCacheEntry(pixels(), 1, 1, 3072);

    await writeCachedPreview("v6:a.NEF:64:0", pixels(), 1, 1, rawCacheGeneration(), entry);

    expect(h.entriesWritten).toEqual([entry]);
  });
});

describe("cachedKeys", () => {
  // An entry from before 3.1.0 keeps neither the decoded size nor the centre
  // sample, so the cache pass should take its photo on again.
  it("names complete entries and marked photos, not entries from before 3.1.0", async () => {
    h.entries = [
      { key: "v6:a.NEF:1:0", complete: true },
      { key: "v6:b.NEF:1:0", complete: false },
      { key: decodeMarkerKey("v6:c.NEF:1:0", "unsupported"), complete: false },
    ];
    expect([...(await cachedKeys())].sort()).toEqual(["v6:a.NEF:1:0", "v6:c.NEF:1:0"]);
  });

  it("lists entries from before 3.1.0 apart from the keys nothing needs decoding for", async () => {
    h.entries = [
      { key: "v6:a.NEF:1:0", complete: true },
      { key: "v6:b.NEF:1:0", complete: false },
      { key: decodeMarkerKey("v6:c.NEF:1:0", "unsupported"), complete: false },
    ];
    const { done, stale } = await cacheListing();
    expect([...done].sort()).toEqual(["v6:a.NEF:1:0", "v6:c.NEF:1:0"]);
    expect([...stale]).toEqual(["v6:b.NEF:1:0"]);
  });

  // An entry from before 3.1.0 can outlive a later verdict on its photo; the
  // verdict would only come out the same if the photo were decoded again.
  it("lists a marked photo as done, not stale, beside an entry from before 3.1.0", async () => {
    h.entries = [
      { key: "v6:d.NEF:1:0", complete: false },
      { key: decodeMarkerKey("v6:d.NEF:1:0", "suspicious"), complete: false },
    ];
    const { done, stale } = await cacheListing();
    expect([...done]).toEqual(["v6:d.NEF:1:0"]);
    expect([...stale]).toEqual([]);
  });
});

describe("readCachedPreview", () => {
  it("asks the worker for the sample only when told to", async () => {
    await readCachedPreview("k");
    await readCachedPreview("k", { sample: true });
    expect(h.reads).toEqual([["k", false], ["k", true]]);
  });
});

describe("writeCachedPreview", () => {
  it("reports a write the worker had nowhere to put", async () => {
    h.stores = false;
    expect(await writeCachedPreview("k", pixels(), 1, 1, rawCacheGeneration())).toBe(false);
  });
});

describe("clearRawCache", () => {
  it("reports how many parts the worker could not clear", async () => {
    h.clear = { failed: 2 };
    expect(await clearRawCache()).toEqual({ failed: 2 });
  });

  it("reports a clear that went through as no failures", async () => {
    expect(await clearRawCache()).toEqual({ failed: 0 });
  });

  it("does not hide an unreachable worker", async () => {
    h.clear = new Error("worker gone");
    await expect(clearRawCache()).rejects.toThrow("worker gone");
  });
});
