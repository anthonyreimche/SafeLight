// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Two windows on one library source's catalogue (the main window and a
// popped-out Develop), each its own module instance over one folder. An
// original one window holds (open in its Develop, being exported) is never
// removed by the other's limit; the hold is announced in the catalogue's folder
// and renewed while it lasts, so one left by a window that crashed lapses within
// minutes. Each window keeps its own record of when it used the originals, so
// neither loses the other's, and the oldest across both goes first.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryFs, fsaDirectoryHandle } from "./memory-fs.test-support";
import type { LibrarySourceItem } from "./library-sources";

type Sources = typeof import("./library-sources");

const KEYS = ["a", "b", "c"];

/** A window: its own copy of the module, the source registered in it, and the
 *  project open on the shared folder. */
async function openWindow(fs: MemoryFs, keptOriginalsLimit: number | null): Promise<{
  sources: Sources;
  read: (key: string) => Promise<void>;
  handle: (key: string) => Promise<FileSystemFileHandle>;
}> {
  vi.resetModules();
  const sources: Sources = await import("./library-sources");
  sources.registerLibrarySource("ext.a", {
    id: "test.server",
    name: "Server",
    library: "lib",
    list: async () => ({ items: KEYS.map((key) => ({ key, name: `${key}.NEF`, size: 4 })) }),
    readPreview: async () => new Blob(),
    readOriginal: async (item: LibrarySourceItem) => new Blob([item.key.repeat(4)]),
    keptOriginalsLimit,
  });
  const root = sources.sourceRoot("test.server")!;
  sources.bindSourceCache(root, fsaDirectoryHandle(fs, "/sl"));
  const handle = (key: string) => root.getFileHandle(`${key}.NEF`);
  const read = async (key: string) => {
    await (await handle(key)).getFile();
    await sources.settleKeptOriginals();
  };
  return { sources, read, handle };
}

async function kept(fs: MemoryFs, w: Awaited<ReturnType<typeof openWindow>>): Promise<string[]> {
  const out: string[] = [];
  for (const key of KEYS) if (await w.sources.sourceOriginalHeld(await w.handle(key))) out.push(key);
  void fs;
  return out;
}

const MINUTE = 60_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date(2026, 10, 11, 12, 0, 0));
});

afterEach(() => vi.useRealTimers());

describe("an original another window holds", () => {
  it("is never removed by this window's limit, and goes once that window lets it go", async () => {
    const fs = new MemoryFs("/sl");
    const develop = await openWindow(fs, null);
    await develop.read("a");
    const release = develop.sources.holdSourceOriginals([await develop.handle("a")]);
    await develop.sources.settleKeptOriginals();

    const main = await openWindow(fs, 4);
    await main.read("b");
    expect(await kept(fs, main)).toEqual(["a", "b"]);

    release();
    await develop.sources.settleKeptOriginals();
    await main.read("c");
    expect(await kept(fs, main)).toEqual(["c"]);
  });

  it("stays held past the lapse while the window holding it lives", async () => {
    const fs = new MemoryFs("/sl");
    const develop = await openWindow(fs, null);
    await develop.read("a");
    develop.sources.holdSourceOriginals([await develop.handle("a")]);
    await develop.sources.settleKeptOriginals();

    const main = await openWindow(fs, 4);
    vi.advanceTimersByTime(10 * MINUTE);
    await develop.sources.settleKeptOriginals();
    await main.read("b");
    expect(await kept(fs, main)).toEqual(["a", "b"]);
  });

  it("lapses within minutes when the window holding it crashed", async () => {
    const fs = new MemoryFs("/sl");
    const develop = await openWindow(fs, null);
    await develop.read("a");
    develop.sources.holdSourceOriginals([await develop.handle("a")]);
    await develop.sources.settleKeptOriginals();

    // The window is gone: nothing renews its hold any more.
    vi.clearAllTimers();
    const main = await openWindow(fs, 4);
    vi.setSystemTime(Date.now() + 11 * MINUTE);
    await main.read("b");
    expect(await kept(fs, main)).toEqual(["b"]);
  });

  it("outlasts renewals a hidden window's throttled timers make minutes late", async () => {
    const fs = new MemoryFs("/sl");
    const develop = await openWindow(fs, null);
    await develop.read("a");
    develop.sources.holdSourceOriginals([await develop.handle("a")]);
    await develop.sources.settleKeptOriginals();

    // Chromium runs a hidden window's timers about once a minute, sometimes later.
    vi.setSystemTime(Date.now() + 4 * MINUTE);
    const main = await openWindow(fs, 4);
    await main.read("b");
    expect(await kept(fs, main)).toEqual(["a", "b"]);
  });

  it("is renewed when it was taken while the last one's release was being announced", async () => {
    const failures: number[] = [];
    for (let n = 0; n < 40; n++) {
      vi.setSystemTime(new Date(2026, 10, 11, 12, 0, 0));
      const fs = new MemoryFs("/sl");
      const develop = await openWindow(fs, null);
      await develop.read("a");
      await develop.read("b");
      const b = await develop.handle("b");
      const release = develop.sources.holdSourceOriginals([await develop.handle("a")]);
      await develop.sources.settleKeptOriginals();
      release();
      for (let i = 0; i < n; i++) await Promise.resolve();
      develop.sources.holdSourceOriginals([b]); // an export starts
      await develop.sources.settleKeptOriginals();
      for (let m = 0; m < 15; m++) {
        vi.advanceTimersByTime(MINUTE);
        await develop.sources.settleKeptOriginals();
      }
      const main = await openWindow(fs, 4);
      await main.read("c");
      if (!(await main.sources.sourceOriginalHeld(await main.handle("b")))) failures.push(n);
      vi.clearAllTimers();
    }
    expect(failures).toEqual([]);
  });
});

describe("the hold files of windows long gone", () => {
  it("are removed, so the folder doesn't fill launch after launch", async () => {
    const fs = new MemoryFs("/sl");
    const crashed = await openWindow(fs, null);
    await crashed.read("a");
    crashed.sources.holdSourceOriginals([await crashed.handle("a")]);
    await crashed.sources.settleKeptOriginals();
    vi.clearAllTimers();
    expect(fs.tree("/sl/originals-held")).toHaveLength(1);

    vi.setSystemTime(Date.now() + 2 * 60 * MINUTE);
    const main = await openWindow(fs, 4);
    await main.read("b");
    expect(fs.tree("/sl/originals-held")).toEqual([]);
  });
});

describe("when the originals were used", () => {
  it("is kept by each window for itself, so the oldest across both goes first", async () => {
    const fs = new MemoryFs("/sl");
    const one = await openWindow(fs, 8);
    const two = await openWindow(fs, 8);
    await one.read("a");
    vi.setSystemTime(Date.now() + 1000);
    await two.read("b");
    vi.setSystemTime(Date.now() + 1000);
    await one.read("a"); // used again: b is now the oldest
    vi.setSystemTime(Date.now() + 1000);
    await two.read("c");
    expect(await kept(fs, two)).toEqual(["a", "c"]);
  });

  it("never has two windows write one file, and every file reads whole", async () => {
    const fs = new MemoryFs("/sl");
    const one = await openWindow(fs, null);
    const two = await openWindow(fs, null);
    await Promise.all([one.read("a"), two.read("b"), one.read("c")]);
    const files = fs.tree("/sl/originals-used").filter((p) => p.endsWith(".json"));
    expect(files).toHaveLength(2);
    const used = files.map((p) => Object.keys((JSON.parse(fs.text(p)!) as { used: object }).used).length);
    expect(used.sort()).toEqual([1, 2]);
  });
});

describe("an original another window is keeping right now", () => {
  it("is never taken for the oldest because its use isn't written yet", async () => {
    const fs = new MemoryFs("/sl");
    const main = await openWindow(fs, 8);
    const develop = await openWindow(fs, null);
    await main.read("a");
    await main.read("b");

    const turn = async () => {
      for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
    };
    const keptBytes = () => fs.tree("/sl/originals").reduce((sum, q) => sum + (fs.bytes(q)?.length ?? 0), 0);
    const writes = fs.holdWrites();
    const keeping = develop.read("c");
    // The develop window's writes land one at a time, up to the moment the main
    // window trims: once the original is down, or once its use is.
    let before = fs.tree("/sl/originals-used").map((p) => fs.text(p)).join();
    for (let i = 0; i < 10; i++) {
      await turn();
      const used = fs.tree("/sl/originals-used").map((p) => fs.text(p)).join();
      if (keptBytes() === 12 || used !== before) break;
      before = used;
      writes.landNext();
    }
    const root = main.sources.sourceRoot("test.server")!;
    const trimming = main.sources.trimKeptOriginals(main.sources.sourceRefOf(root)!, fsaDirectoryHandle(fs, "/sl"), 8);
    await turn();
    writes.landAll();
    await Promise.all([keeping, trimming, main.sources.settleKeptOriginals()]);
    expect(await kept(fs, develop)).toContain("c");
  });
});
