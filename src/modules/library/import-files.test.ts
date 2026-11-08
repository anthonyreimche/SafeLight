// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { CatalogPhoto } from "@/catalog/types";
import { fsaDirectoryHandle, MemoryFs } from "@/project/memory-fs.test-support";

const h = vi.hoisted(() => ({ bridge: null as unknown }));

vi.mock("@/native/privileged", () => ({
  privilegedFs: () => h.bridge,
}));

vi.mock("./import-record", () => ({
  isSupportedName: (name: string) => /\.(jpe?g|png|nef)$/i.test(name),
  importPhoto: vi.fn(
    async (fileHandle: FileSystemFileHandle, directoryHandle: FileSystemDirectoryHandle | null) =>
      ({
        id: `id-${fileHandle.name}`,
        filename: fileHandle.name,
        relPath: "",
        folder: "",
        keywords: ["from-xmp"],
        fileHandle,
        directoryHandle,
      }) as unknown as CatalogPhoto,
  ),
}));

import { useCatalogStore } from "@/state/catalog-store";
import { useProjectStore } from "@/project/project-store";
import { nativeDirectoryHandle } from "@/project/native-fs";
import { importFiles, MAX_IMPORT_BYTES } from "./import-files";

const jpeg = (bytes = [0xff, 0xd8, 0xff, 0xd9]) =>
  new Blob([new Uint8Array(bytes)], { type: "image/jpeg" });

let fs: MemoryFs;
let refreshTree: Mock<() => Promise<void>>;

function openProject(mode: "fsa" | "native" = "fsa") {
  fs = new MemoryFs("/proj");
  h.bridge = mode === "native" ? fs : null;
  refreshTree = vi.fn(async (): Promise<void> => {});
  useProjectStore.setState({
    root: mode === "native" ? nativeDirectoryHandle("/proj") : fsaDirectoryHandle(fs, "/proj"),
    refreshTree,
  });
}

beforeEach(() => {
  useCatalogStore.setState({ photos: [] });
  openProject();
});

describe("importFiles", () => {
  it("rejects a path-traversing name and writes nothing", async () => {
    const results = await importFiles([{ name: "../x.jpg", data: jpeg() }]);
    expect(results).toEqual([{ name: "../x.jpg", error: expect.stringMatching(/name/i) }]);
    expect(fs.tree()).toEqual([]);
    expect(useCatalogStore.getState().photos).toHaveLength(0);
  });

  it("rejects separators, absolute paths and reserved names", async () => {
    const names = ["a/b.jpg", "a\\b.jpg", "/abs.jpg", "C:\\x.jpg", "..", ".", "", "bad?.jpg"];
    const results = await importFiles(names.map((name) => ({ name, data: jpeg() })));
    expect(results.every((r) => "error" in r)).toBe(true);
    expect(fs.tree()).toEqual([]);
  });

  it("rejects a folder that leaves the project", async () => {
    for (const folder of ["..", "a/../..", "/etc", "C:/x", "a\\b", ".safelight", "a//b"]) {
      const [r] = await importFiles([{ name: "x.jpg", data: jpeg() }], { folder });
      expect(r, folder).toMatchObject({ error: expect.any(String) });
    }
    expect(fs.tree()).toEqual([]);
  });

  it("rejects what the project scan skips, so a photo can't vanish on reopen", async () => {
    const [hidden] = await importFiles([{ name: ".hidden.jpg", data: jpeg() }]);
    expect(hidden).toMatchObject({ error: expect.stringMatching(/name/i) });
    const folders = [".git", "a/.b", "$RECYCLE.BIN", "System Volume Information", "x/Recycler", "lost+found"];
    for (const folder of folders) {
      const [r] = await importFiles([{ name: "x.jpg", data: jpeg() }], { folder });
      expect(r, folder).toMatchObject({ error: expect.any(String) });
    }
    expect(fs.tree()).toEqual([]);
  });

  it("rejects Windows device names as a file or a folder, with or without an extension", async () => {
    const names = ["con.jpg", "NUL.jpg", "Com1.nef", "lpt9.png", "aux.tar.jpg", "prn.JPG"];
    const results = await importFiles(names.map((name) => ({ name, data: jpeg() })));
    expect(results.every((r) => "error" in r)).toBe(true);
    for (const folder of ["CON", "a/prn", "nul.d", "Com9"]) {
      const [r] = await importFiles([{ name: "x.jpg", data: jpeg() }], { folder });
      expect(r, folder).toMatchObject({ error: expect.any(String) });
    }
    expect(fs.tree()).toEqual([]);
    const [ok] = await importFiles([{ name: "console.jpg", data: jpeg() }], { folder: "com10" });
    expect(ok).toMatchObject({ id: "id-console.jpg" });
  });

  it("rejects a name over 200 characters and takes one of exactly 200", async () => {
    const long = `${"a".repeat(196)}.jpg`;
    const [tooLong] = await importFiles([{ name: `b${long}`, data: jpeg() }]);
    expect(tooLong).toMatchObject({ error: expect.stringMatching(/name/i) });
    const [fits] = await importFiles([{ name: long, data: jpeg() }]);
    expect(fits).toMatchObject({ id: `id-${long}` });
  });

  it("resolves a non-array list to no results", async () => {
    for (const files of [null, undefined, "a.jpg", { length: 1 }, 7]) {
      expect(await importFiles(files as never), String(files)).toEqual([]);
    }
  });

  it("reports an entry with a bad name or data per file and imports the rest", async () => {
    const results = await importFiles([
      { name: 7, data: jpeg() },
      null,
      { name: "nodata.jpg" },
      { name: "fake.jpg", data: { size: 4 } },
      { name: "good.jpg", data: jpeg() },
    ] as never);
    expect(results).toHaveLength(5);
    expect(results.slice(0, 4).every((r) => "error" in r)).toBe(true);
    expect(results[2]).toMatchObject({ name: "nodata.jpg" });
    expect(results[4]).toEqual({ name: "good.jpg", id: "id-good.jpg" });
    expect(fs.tree()).toEqual(["/proj/good.jpg"]);
  });

  it("drops keywords that aren't strings", async () => {
    await importFiles([{ name: "k.jpg", data: jpeg() }], {
      keywords: ["cat", 3, null, { a: 1 }, " "] as never,
    });
    expect(useCatalogStore.getState().photos[0].keywords).toEqual(["from-xmp", "cat"]);
  });

  it("ignores keywords that aren't a list", async () => {
    await importFiles([{ name: "k.jpg", data: jpeg() }], { keywords: "cat" as never });
    expect(useCatalogStore.getState().photos[0].keywords).toEqual(["from-xmp"]);
  });

  it("refuses a folder that isn't a string like a bad folder", async () => {
    for (const folder of [7, {}, ["a"], null]) {
      const [r] = await importFiles([{ name: "x.jpg", data: jpeg() }], { folder: folder as never });
      expect(r, String(folder)).toMatchObject({ error: expect.stringMatching(/folder/i) });
    }
    expect(fs.tree()).toEqual([]);
  });

  it("lands a JPEG in the folder with its relPath and adds it to the store", async () => {
    const [r] = await importFiles([{ name: "a.jpg", data: jpeg() }], {
      folder: "Imports/2026",
      keywords: ["cat", " dog ", "cat"],
    });
    expect(r).toEqual({ name: "a.jpg", id: "id-a.jpg" });
    expect(fs.bytes("/proj/Imports/2026/a.jpg")).toEqual(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
    const photo = useCatalogStore.getState().photos.find((p) => p.id === "id-a.jpg");
    expect(photo).toMatchObject({
      relPath: "Imports/2026/a.jpg",
      folder: "Imports/2026",
      keywords: ["from-xmp", "cat", "dog"],
    });
    expect(refreshTree).toHaveBeenCalledTimes(1);
  });

  it("imports into the project root when no folder is given", async () => {
    await importFiles([{ name: "r.jpg", data: jpeg() }]);
    expect(useCatalogStore.getState().photos[0]).toMatchObject({ relPath: "r.jpg", folder: "" });
  });

  it("refuses an existing file name and leaves it untouched", async () => {
    fs.putBytes("/proj/a.jpg", new Uint8Array([1, 2, 3]));
    const [r] = await importFiles([{ name: "a.jpg", data: jpeg() }]);
    expect(r).toMatchObject({ name: "a.jpg", error: expect.stringMatching(/already exists/i) });
    expect(fs.bytes("/proj/a.jpg")).toEqual(new Uint8Array([1, 2, 3]));
    expect(useCatalogStore.getState().photos).toHaveLength(0);
  });

  it("refuses a name a catalogue record already holds, whatever its case", async () => {
    useCatalogStore.setState({
      photos: [{ id: "old", relPath: "A.JPG", folder: "" } as CatalogPhoto],
    });
    const [r] = await importFiles([{ name: "a.jpg", data: jpeg() }]);
    expect(r).toMatchObject({ error: expect.stringMatching(/already/i) });
    expect(fs.tree()).toEqual([]);
  });

  it("refuses the second of two files with one name in a call", async () => {
    const results = await importFiles([
      { name: "d.jpg", data: jpeg() },
      { name: "d.jpg", data: jpeg() },
    ]);
    expect(results[0]).toMatchObject({ id: "id-d.jpg" });
    expect(results[1]).toMatchObject({ error: expect.any(String) });
  });

  it("refuses a file type the catalogue doesn't import", async () => {
    const [r] = await importFiles([{ name: "notes.txt", data: new Blob(["x"]) }]);
    expect(r).toMatchObject({ error: expect.stringMatching(/type|supported/i) });
    expect(fs.tree()).toEqual([]);
  });

  it("refuses a blob over the size cap", async () => {
    const big = Object.defineProperty(new Blob([]), "size", { value: MAX_IMPORT_BYTES + 1 });
    const [r] = await importFiles([{ name: "big.jpg", data: big }]);
    expect(r).toMatchObject({ error: expect.stringMatching(/large|size/i) });
    expect(fs.tree()).toEqual([]);
  });

  it("refuses to import into a read-only folder, with a clear error", async () => {
    fs.freeze("/proj");
    const [r] = await importFiles([{ name: "a.jpg", data: jpeg() }]);
    expect(r).toMatchObject({ error: expect.stringMatching(/read-only/i) });
    expect(fs.tree()).toEqual([]);
    expect(useCatalogStore.getState().photos).toHaveLength(0);
  });

  it("reports no open project", async () => {
    useProjectStore.setState({ root: null });
    const [r] = await importFiles([{ name: "a.jpg", data: jpeg() }]);
    expect(r).toMatchObject({ error: expect.stringMatching(/project/i) });
  });

  it("writes natively through a temp file, then renames it into place", async () => {
    openProject("native");
    const [r] = await importFiles([{ name: "n.jpg", data: jpeg() }], { folder: "in" });
    expect(r).toEqual({ name: "n.jpg", id: "id-n.jpg" });
    expect(fs.tree()).toEqual(["/proj/in/n.jpg"]);
    expect(fs.writeCount("/proj/in/n.jpg")).toBe(0);
  });

  it("serializes overlapping calls", async () => {
    const order: string[] = [];
    const { importPhoto } = await import("./import-record");
    vi.mocked(importPhoto).mockImplementation(async (fh, dir) => {
      order.push(`start ${fh.name}`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`end ${fh.name}`);
      return { id: fh.name, filename: fh.name, keywords: [], fileHandle: fh, directoryHandle: dir } as unknown as CatalogPhoto;
    });
    await Promise.all([
      importFiles([{ name: "p.jpg", data: jpeg() }]),
      importFiles([{ name: "q.jpg", data: jpeg() }]),
    ]);
    expect(order).toEqual(["start p.jpg", "end p.jpg", "start q.jpg", "end q.jpg"]);
  });
});
