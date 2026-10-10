// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  /** What reached the cache worker, in the order it was sent. */
  sent: [] as string[],
}));

vi.mock("./cache-bridge", () => ({
  setCacheDirOnWorker: (dir: FileSystemDirectoryHandle | null) => {
    h.sent.push(`folder ${dir?.name ?? "none"}`);
  },
  workerWriteCachedPreview: async (key: string) => {
    h.sent.push(`write ${key}`);
  },
  workerReadCachedPreview: async () => null,
  workerDeleteCachedPreview: async () => {},
  workerClearRawCache: async () => {},
  workerCachedKeys: async () => [],
}));

vi.mock("@/state/settings-store", () => ({
  getSettings: () => ({ rawCacheEnabled: true, rawCacheMaxEdge: 3072 }),
}));

import {
  rawCacheGeneration,
  rawCacheKey,
  setRawCacheDir,
  writeCachedPreview,
} from "./raw-cache";

const folder = (name: string) => ({ name }) as FileSystemDirectoryHandle;
const pixels = () => new Float32Array(4);

beforeEach(() => {
  h.sent = [];
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
    // An open sets it as soon as the catalog is read and again after the walk.
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
