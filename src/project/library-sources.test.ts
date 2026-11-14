// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A library source (api.library.registerSource) opens as a project folder: its
// folders and photos are read through handles that behave like a folder's, the
// originals are fetched once and kept in the catalogue's working folder, and the
// last listing stands in while the source can't be reached.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bindSourceCache,
  dropLibrarySources,
  isSourceFile,
  isSourceRoot,
  listLibrarySources,
  readSourceFileSlice,
  registerLibrarySource,
  sourceItemOf,
  sourceOffline,
  sourceOriginalHeld,
  sourceRefOf,
  sourceRoot,
  SourceUnavailableError,
  type LibrarySourceContribution,
  type LibrarySourceItem,
} from "./library-sources";
import { MemoryFs, fsaDirectoryHandle } from "./memory-fs.test-support";
import { readFileSlice } from "./native-fs";
import { scanProject } from "./scan";

const item = (key: string, name: string, extra: Partial<LibrarySourceItem> = {}): LibrarySourceItem => ({
  key,
  name,
  size: 4,
  modified: 1_700_000_000_000,
  ...extra,
});

function source(over: Partial<LibrarySourceContribution> = {}): LibrarySourceContribution {
  return {
    id: "test.server",
    name: "Server",
    library: "https://photos.example/#user-1",
    list: vi.fn(async () => ({
      folders: [
        { name: "Trip", items: [item("a1", "IMG_0001.CR3"), item("a2", "IMG_0002.JPG")] },
        { name: "Family", items: [item("b1", "DSC_1.NEF"), item("b2", "clip.MOV")] },
      ],
    })),
    readPreview: vi.fn(async () => new Blob(["prev"])),
    readOriginal: vi.fn(async () => new Blob(["orig"])),
    ...over,
  };
}

async function entries(dir: FileSystemDirectoryHandle): Promise<FileSystemHandle[]> {
  const out: FileSystemHandle[] = [];
  for await (const e of dir.values()) out.push(e);
  return out;
}

const cacheDir = (fs = new MemoryFs("/sl")) => ({ fs, sl: fsaDirectoryHandle(fs, "/sl") });

afterEach(() => {
  dropLibrarySources("ext.a");
  dropLibrarySources("ext.b");
});

describe("registering a source", () => {
  it("lists it with the extension that registered it", () => {
    registerLibrarySource("ext.a", source());
    expect(listLibrarySources()).toEqual([
      expect.objectContaining({ id: "test.server", name: "Server", extensionId: "ext.a" }),
    ]);
  });

  it("refuses an id another extension holds, and a contribution without its functions", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerLibrarySource("ext.a", source());
    registerLibrarySource("ext.b", source({ name: "Other" }));
    registerLibrarySource("ext.b", { ...source({ id: "x" }), list: undefined } as unknown as LibrarySourceContribution);
    expect(listLibrarySources().map((s) => [s.id, s.name])).toEqual([["test.server", "Server"]]);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("is dropped when its extension stops", () => {
    registerLibrarySource("ext.a", source());
    dropLibrarySources("ext.a");
    expect(listLibrarySources()).toEqual([]);
    expect(sourceRoot("test.server")).toBeNull();
  });
});

describe("the source as a folder", () => {
  it("is a directory named after the source, known as one", () => {
    registerLibrarySource("ext.a", source());
    const root = sourceRoot("test.server")!;
    expect(root.kind).toBe("directory");
    expect(root.name).toBe("Server");
    expect(isSourceRoot(root)).toBe(true);
    expect(sourceRefOf(root)).toEqual({
      id: "test.server",
      name: "Server",
      library: "https://photos.example/#user-1",
      extensionId: "ext.a",
    });
    expect(isSourceRoot({ kind: "directory", name: "x" })).toBe(false);
  });

  it("shows its folders and photos to the project scan", async () => {
    registerLibrarySource("ext.a", source());
    const root = sourceRoot("test.server")!;
    bindSourceCache(root, cacheDir().sl);
    const scan = await scanProject(root, (n) => !n.endsWith(".MOV"));
    expect(scan.files.map((f) => f.path).sort()).toEqual([
      "Family/DSC_1.NEF",
      "Trip/IMG_0001.CR3",
      "Trip/IMG_0002.JPG",
    ]);
    expect(scan.tree.children.map((c) => [c.name, c.count])).toEqual([
      ["Family", 1],
      ["Trip", 2],
    ]);
    const file = scan.files.find((f) => f.path === "Trip/IMG_0001.CR3")!;
    expect(isSourceFile(file.handle)).toBe(true);
    expect(sourceItemOf(file.handle)?.key).toBe("a1");
  });

  it("gives every entry a plain, unique name", async () => {
    registerLibrarySource(
      "ext.a",
      source({
        list: async () => ({
          folders: [
            { name: "a/b", items: [item("k2", "same.jpg"), item("k1", "SAME.jpg"), item("k3", ".hidden.jpg")] },
            { name: "a/b", items: [] },
            { name: "..", folders: [{ name: "Inner", items: [item("k4", "x.jpg")] }] },
          ],
        }),
      }),
    );
    const root = sourceRoot("test.server")!;
    bindSourceCache(root, cacheDir().sl);
    const top = await entries(root);
    expect(top.map((e) => e.name)).toEqual(["a-b", "a-b (2)", "_."]);
    const files = await entries(top[0] as FileSystemDirectoryHandle);
    expect(files.map((e) => e.name)).toEqual(["same (k2).jpg", "SAME.jpg", "_hidden.jpg"]);
    const inner = await entries(top[2] as FileSystemDirectoryHandle);
    expect(inner.map((e) => [e.kind, e.name])).toEqual([["directory", "Inner"]]);
  });

  it("refuses every change: the source is never written", async () => {
    registerLibrarySource("ext.a", source());
    const root = sourceRoot("test.server")!;
    bindSourceCache(root, cacheDir().sl);
    await expect(root.getDirectoryHandle("New", { create: true })).rejects.toMatchObject({
      name: "NoModificationAllowedError",
    });
    await expect(root.removeEntry("Trip", { recursive: true })).rejects.toMatchObject({
      name: "NoModificationAllowedError",
    });
    const trip = await root.getDirectoryHandle("Trip");
    await expect(trip.getFileHandle("missing.jpg")).rejects.toMatchObject({ name: "NotFoundError" });
    const file = await trip.getFileHandle("IMG_0002.JPG");
    await expect(file.createWritable()).rejects.toMatchObject({ name: "NoModificationAllowedError" });
  });
});

describe("originals", () => {
  async function fileOf(root: FileSystemDirectoryHandle, folder: string, name: string) {
    return (await root.getDirectoryHandle(folder)).getFileHandle(name);
  }

  it("are fetched once, named as the source names them, and kept in the working folder", async () => {
    const src = source();
    registerLibrarySource("ext.a", src);
    const { fs, sl } = cacheDir();
    const root = sourceRoot("test.server")!;
    bindSourceCache(root, sl);
    const handle = await fileOf(root, "Trip", "IMG_0001.CR3");
    expect(await sourceOriginalHeld(handle)).toBe(false);

    const [first, again] = await Promise.all([handle.getFile(), handle.getFile()]);
    expect(first.name).toBe("IMG_0001.CR3");
    expect(await first.text()).toBe("orig");
    expect(await again.text()).toBe("orig");
    expect(src.readOriginal).toHaveBeenCalledTimes(1);
    expect(await sourceOriginalHeld(handle)).toBe(true);

    // A later session (a new root over the same working folder) reads it from disk.
    const later = sourceRoot("test.server")!;
    bindSourceCache(later, fsaDirectoryHandle(fs, "/sl"));
    const cached = await (await fileOf(later, "Trip", "IMG_0001.CR3")).getFile();
    expect(await cached.text()).toBe("orig");
    expect(src.readOriginal).toHaveBeenCalledTimes(1);
  });

  it("are not kept when what arrived isn't the size the source listed", async () => {
    const src = source({ readOriginal: vi.fn(async () => new Blob(["cut"])) });
    registerLibrarySource("ext.a", src);
    const root = sourceRoot("test.server")!;
    bindSourceCache(root, cacheDir().sl);
    const handle = await fileOf(root, "Trip", "IMG_0002.JPG");
    await expect(handle.getFile()).rejects.toThrow(/incomplete/);
    expect(await sourceOriginalHeld(handle)).toBe(false);
  });

  it("fail when the source fails, so the photo falls back to its preview", async () => {
    const src = source({
      readOriginal: vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    });
    registerLibrarySource("ext.a", src);
    const root = sourceRoot("test.server")!;
    bindSourceCache(root, cacheDir().sl);
    await expect((await fileOf(root, "Trip", "IMG_0002.JPG")).getFile()).rejects.toThrow("Failed to fetch");
  });

  it("are not fetched for a slice: the size comes from the listing", async () => {
    const src = source();
    registerLibrarySource("ext.a", src);
    const root = sourceRoot("test.server")!;
    bindSourceCache(root, cacheDir().sl);
    const handle = await fileOf(root, "Trip", "IMG_0002.JPG");
    const slice = await readSourceFileSlice(handle, 0, 64 * 1024);
    expect(await readFileSlice(handle, 0, 64 * 1024)).toEqual(slice);
    expect(slice).toMatchObject({ size: 4, lastModified: 1_700_000_000_000 });
    expect(slice.data.length).toBe(0);
    expect(src.readOriginal).not.toHaveBeenCalled();

    await handle.getFile();
    const held = await readSourceFileSlice(handle, 1, 3);
    expect(new TextDecoder().decode(held.data)).toBe("ri");
  });
});

describe("a source that can't be reached", () => {
  it("shows its last listing, marked offline", async () => {
    let online = true;
    const src = source({
      list: vi.fn(async () => {
        if (!online) throw new TypeError("Failed to fetch");
        return { folders: [{ name: "Trip", items: [item("a1", "IMG_0001.CR3")] }] };
      }),
    });
    registerLibrarySource("ext.a", src);
    const { fs } = cacheDir();
    const first = sourceRoot("test.server")!;
    bindSourceCache(first, fsaDirectoryHandle(fs, "/sl"));
    await entries(first);
    expect(sourceOffline(first)).toBe(false);

    online = false;
    const later = sourceRoot("test.server")!;
    bindSourceCache(later, fsaDirectoryHandle(fs, "/sl"));
    const scan = await scanProject(later, () => true);
    expect(scan.files.map((f) => f.path)).toEqual(["Trip/IMG_0001.CR3"]);
    expect(sourceOffline(later)).toBe(true);
  });

  it("fails the open when there is no listing to show", async () => {
    registerLibrarySource(
      "ext.a",
      source({
        list: async () => {
          throw new TypeError("Failed to fetch");
        },
      }),
    );
    const root = sourceRoot("test.server")!;
    bindSourceCache(root, cacheDir().sl);
    await expect(scanProject(root, () => true)).rejects.toBeInstanceOf(SourceUnavailableError);
  });

  it("doesn't show another library's listing", async () => {
    const { fs } = cacheDir();
    registerLibrarySource("ext.a", source());
    const first = sourceRoot("test.server")!;
    bindSourceCache(first, fsaDirectoryHandle(fs, "/sl"));
    await entries(first);

    registerLibrarySource(
      "ext.a",
      source({
        library: "https://other.example/#user-2",
        list: async () => {
          throw new TypeError("Failed to fetch");
        },
      }),
    );
    const other = sourceRoot("test.server")!;
    bindSourceCache(other, fsaDirectoryHandle(fs, "/sl"));
    await expect(entries(other)).rejects.toBeInstanceOf(SourceUnavailableError);
  });
});

describe("folders of one name", () => {
  it("keep their names whatever order the source lists them in", async () => {
    let order = ["k2", "k1"];
    registerLibrarySource(
      "ext.a",
      source({
        list: async () => ({
          folders: order.map((key) => ({ name: "Trip", key, items: [item(`p-${key}`, `${key}.jpg`)] })),
        }),
      }),
    );
    const names = async () => {
      const root = sourceRoot("test.server")!;
      bindSourceCache(root, cacheDir().sl);
      const scan = await scanProject(root, () => true);
      return Object.fromEntries(scan.files.map((f) => [sourceItemOf(f.handle)!.key, f.path]));
    };
    const first = await names();
    expect(first).toEqual({ "p-k1": "Trip/k1.jpg", "p-k2": "Trip (k2)/k2.jpg" });
    order = ["k1", "k2"];
    expect(await names()).toEqual(first);
  });
});

describe("the scan of a source", () => {
  it("gives each photo the size the source listed", async () => {
    registerLibrarySource("ext.a", source());
    const root = sourceRoot("test.server")!;
    bindSourceCache(root, cacheDir().sl);
    const scan = await scanProject(root, () => true);
    expect(scan.files.every((f) => f.size === 4)).toBe(true);
  });
});

describe("a source project and the registration behind it", () => {
  async function keptRoot(library: string) {
    registerLibrarySource("ext.a", source({ library }));
    const { fs } = cacheDir();
    const root = sourceRoot("test.server")!;
    bindSourceCache(root, fsaDirectoryHandle(fs, "/sl"));
    await entries(root);
    return root;
  }

  it("never reaches another library the source was moved to", async () => {
    const root = await keptRoot("account-a");
    dropLibrarySources("ext.a");
    const other = source({ library: "account-b" });
    registerLibrarySource("ext.a", other);
    const trip = (await entries(root))[0] as FileSystemDirectoryHandle;
    expect(other.list).not.toHaveBeenCalled();
    expect(sourceOffline(root)).toBe(true);
    const file = await trip.getFileHandle("IMG_0001.CR3");
    await expect(file.getFile()).rejects.toThrow();
    expect(other.readOriginal).not.toHaveBeenCalled();
  });

  it("never reaches another extension's source of the same id", async () => {
    const root = await keptRoot("account-a");
    dropLibrarySources("ext.a");
    const impostor = source({ library: "account-a" });
    registerLibrarySource("ext.b", impostor);
    await entries(root);
    expect(impostor.list).not.toHaveBeenCalled();
  });
});

describe("kept originals", () => {
  it("are one file per key, whatever characters or length the keys have", async () => {
    const long = "k".repeat(300);
    const keys = ["a/b", "a:b", "Ab", "ab", long];
    registerLibrarySource(
      "ext.a",
      source({
        list: async () => ({ items: keys.map((key, i) => ({ key, name: `p${i}.jpg` })) }),
        readOriginal: vi.fn(async (it: LibrarySourceItem) => new Blob([`bytes of ${it.key}`])),
      }),
    );
    const fs = new MemoryFs("/sl");
    fs.foldCase = true;
    const first = sourceRoot("test.server")!;
    bindSourceCache(first, fsaDirectoryHandle(fs, "/sl"));
    for (const i of keys.keys()) await (await first.getFileHandle(`p${i}.jpg`)).getFile();

    const later = sourceRoot("test.server")!;
    bindSourceCache(later, fsaDirectoryHandle(fs, "/sl"));
    for (const [i, key] of keys.entries()) {
      const handle = await later.getFileHandle(`p${i}.jpg`);
      expect(await sourceOriginalHeld(handle)).toBe(true);
      expect(await (await handle.getFile()).text()).toBe(`bytes of ${key}`);
    }
    const names: string[] = [];
    for await (const name of (await fsaDirectoryHandle(fs, "/sl").getDirectoryHandle("originals")).keys()) names.push(name);
    expect(names).toHaveLength(keys.length);
    expect(names.every((n) => /^[0-9a-f]{64}$/.test(n))).toBe(true);
  });
});
