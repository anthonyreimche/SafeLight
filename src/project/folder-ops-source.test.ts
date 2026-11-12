// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A library source is read-only: the folder and photo operations leave it, and
// its catalogue, as they are.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPhoto } from "@/catalog/types";

const h = vi.hoisted(() => ({
  root: null as FileSystemDirectoryHandle | null,
  photos: [] as CatalogPhoto[],
  relocated: 0,
  removed: 0,
  refreshed: 0,
}));

vi.mock("./project-store", () => ({
  useProjectStore: {
    getState: () => ({
      root: h.root,
      refreshTree: async () => {
        h.refreshed++;
      },
    }),
  },
}));
vi.mock("@/state/catalog-store", () => ({
  useCatalogStore: {
    getState: () => ({
      photos: h.photos,
      relocatePhotos: async () => {
        h.relocated++;
      },
      removePhotos: async () => {
        h.removed++;
      },
    }),
  },
}));
vi.mock("@/state/ui-store", () => ({
  useUIStore: { getState: () => ({ activeFolder: null, setActiveFolder: () => {} }) },
}));

import { createFolder, deleteFolder, moveFolder, movePhotos, renameFolder, renamePhoto } from "./folder-ops";
import { dropLibrarySources, registerLibrarySource, sourceRoot } from "./library-sources";

beforeEach(() => {
  registerLibrarySource("ext.a", {
    id: "test.server",
    name: "Server",
    list: async () => ({ folders: [{ name: "Trip", items: [{ key: "k", name: "a.jpg" }] }, { name: "Home" }] }),
    readPreview: async () => new Blob(),
    readOriginal: async () => new Blob(),
  });
  h.root = sourceRoot("test.server");
  h.photos = [{ id: "p1", filename: "a.jpg", relPath: "Trip/a.jpg", folder: "Trip", copyOf: undefined } as CatalogPhoto];
  h.relocated = h.removed = h.refreshed = 0;
});

afterEach(() => dropLibrarySources("ext.a"));

describe("folder operations on a library source", () => {
  it("change nothing", async () => {
    expect(await createFolder("", "New")).toBeNull();
    await renameFolder("Trip", "Away");
    await moveFolder("Trip", "Home");
    await movePhotos(["p1"], "Home");
    await deleteFolder("Trip");
    expect([h.relocated, h.removed, h.refreshed]).toEqual([0, 0, 0]);
  });

  it("say why a photo can't be renamed", async () => {
    await expect(renamePhoto("p1", "b")).resolves.toEqual({
      ok: false,
      reason: "Photos from a library source can't be renamed from Safelight.",
    });
  });
});
