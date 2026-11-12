// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A library source has no folder of its own to hold .safelight: its catalogue
// always lives in the app's data, one per source and library, and the source's
// kept listing and originals go with it.

import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  nativeFs: vi.fn(),
  nativeDirectoryHandle: vi.fn(),
}));

vi.mock("@/state/settings-store", () => ({
  getSettings: () => ({ catalogLocation: "in-folder", externalCatalogDir: "" }),
}));
vi.mock("./native-fs", () => ({
  isNativeFS: () => h.nativeFs() !== null,
  nativeFs: h.nativeFs,
  nativeDirectoryHandle: h.nativeDirectoryHandle,
  nativePathOf: () => null,
}));

import { resolveWorkingDir, ReadOnlyProjectError } from "./working-dir";
import { dropLibrarySources, registerLibrarySource, sourceRoot } from "./library-sources";
import { MemoryFs, fsaDirectoryHandle } from "./memory-fs.test-support";

function root(): FileSystemDirectoryHandle {
  registerLibrarySource("ext.a", {
    id: "test.server",
    name: "Server",
    library: "https://photos.example/#u1",
    list: async () => ({ folders: [{ name: "Trip", items: [{ key: "a1", name: "a.jpg" }] }] }),
    readPreview: async () => new Blob(),
    readOriginal: async () => new Blob(),
  });
  return sourceRoot("test.server")!;
}

afterEach(() => {
  dropLibrarySources("ext.a");
  vi.unstubAllGlobals();
  h.nativeFs.mockReset();
  h.nativeDirectoryHandle.mockReset();
});

describe("the working folder of a library source", () => {
  it("is the app data's catalogue for the source and its library, on the desktop", async () => {
    const mem = new MemoryFs("/data/source-catalogs/Server-1/.safelight");
    const sourceCatalogDir = vi.fn(async () => "/data/source-catalogs/Server-1/.safelight");
    h.nativeFs.mockReturnValue({ sourceCatalogDir, list: vi.fn(), exists: vi.fn() });
    h.nativeDirectoryHandle.mockImplementation((p: string) => fsaDirectoryHandle(mem, p));

    const r = root();
    const wd = await resolveWorkingDir(r);
    // Keyed by the extension too: another extension's source of the same id and
    // library has a catalogue of its own.
    expect(sourceCatalogDir).toHaveBeenCalledWith("ext.a\ntest.server\nhttps://photos.example/#u1", "Server");
    expect(wd.location).toBe("source");
    expect(wd.externalPath).toBeNull();

    // Bound to the root: the listing the scan reads is kept there.
    for await (const _ of r.values()) void _;
    expect(mem.text("/data/source-catalogs/Server-1/.safelight/source-listing.json")).toContain('"a1"');
  });

  it("is in the browser's private storage without the desktop bridge", async () => {
    h.nativeFs.mockReturnValue(null);
    const mem = new MemoryFs("/opfs");
    vi.stubGlobal("navigator", { storage: { getDirectory: async () => fsaDirectoryHandle(mem, "/opfs") } });
    const wd = await resolveWorkingDir(root());
    expect(wd.location).toBe("source");
    expect(wd.sl.name).toBe(".safelight");
    const wd2 = await resolveWorkingDir(root());
    expect(wd2.sl.name).toBe(".safelight");
  });

  it("can't be made where neither is there", async () => {
    h.nativeFs.mockReturnValue(null);
    vi.stubGlobal("navigator", {});
    await expect(resolveWorkingDir(root())).rejects.toBeInstanceOf(ReadOnlyProjectError);
  });
});
