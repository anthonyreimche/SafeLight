// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The originals a library source's catalogue keeps: within a size limit, the
// ones used longest ago go first, never one in use (open in Develop, being
// exported), and one that went downloads again when it is needed. How many and
// how much they take, and clearing them, for the source's own settings.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_KEPT_ORIGINALS_LIMIT,
  bindSourceCache,
  clearKeptOriginals,
  dropLibrarySources,
  holdSourceOriginals,
  keptOriginalsUsage,
  registerLibrarySource,
  settleKeptOriginals,
  sourceOriginalHeld,
  sourceRefOf,
  sourceRoot,
  trimKeptOriginals,
  type LibrarySourceContribution,
  type LibrarySourceItem,
} from "./library-sources";
import { MemoryFs, fsaDirectoryHandle } from "./memory-fs.test-support";

const KEYS = ["a", "b", "c", "d"];

function source(over: Partial<LibrarySourceContribution> = {}): LibrarySourceContribution {
  return {
    id: "test.server",
    name: "Server",
    library: "https://photos.example/#user-1",
    list: async () => ({ items: KEYS.map((key) => ({ key, name: `${key}.NEF`, size: 4 })) }),
    readPreview: async () => new Blob(["prev"]),
    readOriginal: vi.fn(async (item: LibrarySourceItem) => new Blob([`${item.key}${item.key}${item.key}${item.key}`])),
    ...over,
  };
}

function open(over: Partial<LibrarySourceContribution> = {}) {
  const src = source(over);
  registerLibrarySource("ext.a", src);
  const fs = new MemoryFs("/sl");
  const sl = fsaDirectoryHandle(fs, "/sl");
  const root = sourceRoot("test.server")!;
  bindSourceCache(root, sl);
  const handle = (key: string) => root.getFileHandle(`${key}.NEF`);
  const read = async (key: string) => {
    await (await handle(key)).getFile();
    await settleKeptOriginals();
  };
  const kept = async () => {
    const out: string[] = [];
    for (const key of KEYS) if (await sourceOriginalHeld(await handle(key))) out.push(key);
    return out;
  };
  return { src, fs, sl, root, handle, read, kept };
}

afterEach(() => dropLibrarySources("ext.a"));

describe("kept originals within the limit", () => {
  it("keep 10 GB unless the source says otherwise", () => {
    expect(DEFAULT_KEPT_ORIGINALS_LIMIT).toBe(10 * 1024 ** 3);
  });

  it("remove the ones used longest ago once the limit is passed", async () => {
    const { read, kept } = open({ keptOriginalsLimit: 12 });
    await read("a");
    await read("b");
    await read("c");
    await read("a"); // opened again: now b was used longest ago
    await read("d");
    expect(await kept()).toEqual(["a", "c", "d"]);
  });

  it("download one that went again when it is needed", async () => {
    const { src, read, kept } = open({ keptOriginalsLimit: 4 });
    await read("a");
    await read("b");
    expect(await kept()).toEqual(["b"]);
    await read("a");
    expect(src.readOriginal).toHaveBeenCalledTimes(3);
    expect(await kept()).toEqual(["a"]);
  });

  it("are all kept with no limit", async () => {
    const { read, kept } = open({ keptOriginalsLimit: null });
    for (const key of KEYS) await read(key);
    expect(await kept()).toEqual(KEYS);
  });

  it("never lose one in use, and go down to the limit once it is let go", async () => {
    const { read, kept, handle } = open({ keptOriginalsLimit: 4 });
    await read("a");
    const release = holdSourceOriginals([await handle("a")]);
    await read("b");
    expect(await kept()).toEqual(["a", "b"]);
    release();
    await settleKeptOriginals();
    expect(await kept()).toEqual(["b"]);
  });

  it("take a lower limit when trimmed to it", async () => {
    const { read, kept, root, sl } = open({ keptOriginalsLimit: null });
    for (const key of KEYS) await read(key);
    await trimKeptOriginals(sourceRefOf(root)!, sl, 8);
    expect(await kept()).toEqual(["c", "d"]);
  });
});

describe("the kept originals' space", () => {
  it("counts the originals kept and their bytes", async () => {
    const { read, sl } = open({ keptOriginalsLimit: null });
    expect(await keptOriginalsUsage(sl)).toEqual({ count: 0, bytes: 0 });
    await read("a");
    await read("b");
    expect(await keptOriginalsUsage(sl)).toEqual({ count: 2, bytes: 8 });
  });

  it("is cleared but for the originals in use", async () => {
    const { read, kept, root, sl, handle } = open({ keptOriginalsLimit: null });
    for (const key of KEYS) await read(key);
    const release = holdSourceOriginals([await handle("c")]);
    expect(await clearKeptOriginals(sourceRefOf(root)!, sl)).toEqual({ removed: 3, kept: 1 });
    expect(await kept()).toEqual(["c"]);
    expect(await keptOriginalsUsage(sl)).toEqual({ count: 1, bytes: 4 });
    release();
  });
});
