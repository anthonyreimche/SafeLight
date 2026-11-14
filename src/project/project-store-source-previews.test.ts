// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What an open asks of a library source's previews: nothing before its cells
// show. A folder's previews are on the disk, so the idle prefill reads ahead of
// the scroll; a source's come over the network, so only the cells on screen ask
// for them, and the welcome card's cover is taken from the disk alone. The open
// flow's stubs are the passes test's (project-store-passes.test.ts).

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  /** Every preview the idle prefill asked the grid's reader for. */
  requested: [] as string[],
  /** Every read of the cover's preview: the photo and the options. */
  covers: [] as unknown[][],
  detached: null as string | null,
  /** The signal each repair pass was handed, in order. */
  repairs: [] as (AbortSignal | undefined)[],
  /** The signal each Cache all pre-decode was handed, in order. */
  preDecodes: [] as (AbortSignal | undefined)[],
  /** The signal each pending-metadata pass was handed, in order. */
  metadataReads: [] as (AbortSignal | undefined)[],
  /** Holds each pending-metadata pass until it settles. */
  metadataDone: (): Promise<void> => Promise.resolve(),
  /** What the pending-metadata pass reports for each photo it reads. */
  metadataRead: null as null | { id: string; change: Record<string, unknown> },
  /** Changes merged into the catalogue store, as [id, change]. */
  merged: [] as [string, unknown][],
  open: vi.fn(),
  /** Remembering the folder for the welcome grid, one of an open's last steps. */
  remembered: (): Promise<void> => Promise.resolve(),
}));

vi.mock("@/state/detach", () => ({ detachedModule: () => h.detached }));
vi.mock("@/raw/decode-pool", () => ({ warmDecodePool: async () => {} }));
vi.mock("@/modules/library/import-photos", () => ({
  repairMissingPreviews: async (_photos: unknown, _onRepaired: unknown, signal?: AbortSignal) => {
    h.repairs.push(signal);
  },
  preDecodeRawsForCache: async (_photos: unknown, opts?: { signal?: AbortSignal }) => {
    h.preDecodes.push(opts?.signal);
  },
  readPendingMetadata: async (
    _photos: unknown,
    onRead?: (photo: { id: string }, change: Record<string, unknown>) => void,
    signal?: AbortSignal,
  ) => {
    h.metadataReads.push(signal);
    if (h.metadataRead) onRead?.({ id: h.metadataRead.id }, h.metadataRead.change);
    await h.metadataDone();
  },
}));
vi.mock("./project-storage", () => ({
  ProjectStorage: { open: h.open },
  onSaveStatus: () => () => {},
  flushLeftCopies: () => {},
}));
vi.mock("./recent", () => ({
  addRecentProject: () => h.remembered(),
  getLastProject: async () => null,
  recentHandle: () => null,
}));
vi.mock("@/catalog/storage", () => ({
  catalogStorage: () => ({ flush: async () => {} }),
  setCatalogStorage: () => {},
}));
vi.mock("@/raw/raw-cache", () => ({ setRawCacheDir: () => {} }));
vi.mock("@/state/thumbnail-loader", () => ({
  requestThumbnail: (id: string) => h.requested.push(id),
  setThumbnailLoader: () => 1,
  thumbnailGen: () => 1,
}));
vi.mock("@/state/settings-store", () => ({ getSettings: () => ({}) }));
vi.mock("@/state/catalog-store", () => ({
  setLastProjectOpener: () => {},
  useCatalogStore: {
    getState: () => ({
      replaceCatalog: () => {},
      finalizeCatalog: () => {},
      reconcileCatalog: () => {},
      appendPhotos: () => {},
      mergeRebuiltPhoto: (id: string, change: unknown) => h.merged.push([id, change]),
      photos: [],
    }),
  },
  photoById: () => undefined,
}));
vi.mock("@/modules/library/photo-navigation", () => ({ visibleList: () => [] }));
vi.mock("@/state/ui-store", () => ({
  useUIStore: {
    subscribe: () => () => {},
    getState: () => ({
      setActiveFolder: () => {},
      filter: {},
      sortField: "name",
      sortDirection: "asc",
      activeFolder: null,
    }),
  },
}));

const folder = (name: string) => ({ name }) as FileSystemDirectoryHandle;

let useProjectStore: typeof import("./project-store").useProjectStore;

const openProject = (name: string) => useProjectStore.getState().openProject(folder(name));

/** What ProjectStorage.open resolves to: a project saved before. */
function opened() {
  return {
    storage: { readPreview: async () => null, heldPhoto: () => undefined, close: () => {} },
    rawCacheDir: {},
    tree: null,
    unreadable: [],
    skipped: {},
    photos: [],
    storageLocation: "in-folder",
  };
}

// Lets the open flow run until it is waiting on something the test controls.
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
  vi.resetModules();
  h.detached = null;
  h.repairs = [];
  h.preDecodes = [];
  h.metadataReads = [];
  h.metadataDone = () => Promise.resolve();
  h.metadataRead = null;
  h.merged = [];
  h.remembered = () => Promise.resolve();
  h.requested = [];
  h.covers = [];
  h.open.mockReset();
  h.open.mockImplementation(async () => opened());
  vi.stubGlobal("window", {
    addEventListener: () => {},
    requestIdleCallback: (run: () => void) => run(),
  });
  vi.stubGlobal("requestAnimationFrame", () => 0);
  ({ useProjectStore } = await import("./project-store"));
});


const photo = { id: "p1", thumbnailUrl: null, thumbnailBlob: null };

/** ProjectStorage.open's answer: one photo, its preview not loaded yet. */
function withPhoto() {
  return {
    ...opened(),
    photos: [photo],
    storage: {
      readPreview: async (...args: unknown[]) => {
        h.covers.push(args);
        return null;
      },
      heldPhoto: () => undefined,
      close: () => {},
    },
  };
}

describe("an open's previews", () => {
  it("are read ahead of the scroll for a folder", async () => {
    h.open.mockImplementation(async () => withPhoto());
    await openProject("A");
    await settle();
    expect(h.requested).toEqual(["p1"]);
    expect(h.covers).toEqual([["p1", { build: true }]]);
  });

  it("are left to the cells on screen for a library source, the cover read from disk only", async () => {
    const sources = await import("./library-sources");
    sources.registerLibrarySource("ext.a", {
      id: "test.server",
      name: "Server",
      list: async () => ({}),
      readPreview: async () => new Blob(),
      readOriginal: async () => new Blob(),
    });
    h.open.mockImplementation(async () => withPhoto());
    await useProjectStore.getState().openProject(sources.sourceRoot("test.server")!);
    await settle();
    expect(h.requested).toEqual([]);
    expect(h.covers).toEqual([["p1", { build: false }]]);
    sources.dropLibrarySources("ext.a");
  });
});
