// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// api.library's kept-originals members, for a source's own settings: the space
// its library's kept originals take, clearing them, and a lowered limit taking
// effect at once. Only for a source the extension registered itself.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeFsBridge } from "@/extensions/types";

const h = vi.hoisted(() => ({ fs: null as NativeFsBridge | null }));

vi.mock("@/native/privileged", () => ({ privilegedFs: () => h.fs }));

import { librarySourcesAPI } from "./library-sources-api";
import { dropLibrarySources, settleKeptOriginals, sourceRoot } from "@/project/library-sources";
import { resolveWorkingDir } from "@/project/working-dir";
import { MemoryFs } from "@/project/memory-fs.test-support";
import type { LibrarySourceContribution } from "./api/sources";

const SL = "/data/source-catalogs/Server-1/.safelight";

const source = (keptOriginalsLimit?: number | null): LibrarySourceContribution => ({
  id: "test.server",
  name: "Server",
  library: "https://photos.example/#u1",
  list: async () => ({ items: ["a", "b", "c"].map((key) => ({ key, name: `${key}.NEF`, size: 4 })) }),
  readPreview: async () => new Blob(),
  readOriginal: async () => new Blob(["1234"]),
  ...(keptOriginalsLimit === undefined ? {} : { keptOriginalsLimit }),
});

beforeEach(() => {
  const mem = new MemoryFs("/data");
  h.fs = Object.assign(mem, {
    sourceCatalogDir: async () => {
      mem.mkdirp(SL);
      return SL;
    },
  });
});

afterEach(() => {
  dropLibrarySources("ext.a");
});

/** Open the source's photos `keys` in Develop, as the project open on it would. */
async function openAll(keys: string[]) {
  const root = sourceRoot("test.server")!;
  await resolveWorkingDir(root);
  for (const key of keys) await (await root.getFileHandle(`${key}.NEF`)).getFile();
  await settleKeptOriginals();
}

describe("api.library kept originals", () => {
  it("tells the space they take and clears them", async () => {
    const api = librarySourcesAPI("ext.a");
    api.registerSource(source(null));
    expect(await api.keptOriginals("test.server")).toEqual({ count: 0, bytes: 0 });
    await openAll(["a", "b", "c"]);
    expect(await api.keptOriginals("test.server")).toEqual({ count: 3, bytes: 12 });
    expect(await api.clearKeptOriginals("test.server")).toEqual({ removed: 3, kept: 0 });
    expect(await api.keptOriginals("test.server")).toEqual({ count: 0, bytes: 0 });
  });

  it("keeps a lowered limit at once", async () => {
    const api = librarySourcesAPI("ext.a");
    api.registerSource(source(null));
    await openAll(["a", "b", "c"]);
    api.registerSource(source(4));
    expect(await api.keptOriginals("test.server")).toEqual({ count: 1, bytes: 4 });
  });

  it("is only for the extension's own sources", async () => {
    librarySourcesAPI("ext.a").registerSource(source());
    const other = librarySourcesAPI("ext.b");
    await expect(other.keptOriginals("test.server")).rejects.toThrow(/isn't a source/);
    await expect(other.clearKeptOriginals("test.server")).rejects.toThrow(/isn't a source/);
  });
});
