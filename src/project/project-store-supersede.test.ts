// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// One rule for every open: opening another project while one is still opening
// leaves the first at once, as closing it would. Its walk is stopped (a library
// source's listing too, so its requests to the server stop), and nothing it
// finishes later reaches the window. Asking again for the very project that is
// opening (a double click) changes nothing. The open flow's stubs are the
// passes test's (project-store-passes.test.ts).

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
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
  requestThumbnail: () => {},
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
    }),
  },
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
    storage: { readPreview: async () => null, close: () => {} },
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
  h.open.mockReset();
  h.open.mockImplementation(async () => opened());
  vi.stubGlobal("window", {
    addEventListener: () => {},
    requestIdleCallback: (run: () => void) => run(),
  });
  vi.stubGlobal("requestAnimationFrame", () => 0);
  ({ useProjectStore } = await import("./project-store"));
});


interface Walked {
  storage: { readPreview: () => Promise<null>; close: ReturnType<typeof vi.fn> };
}

/** ProjectStorage.open for a walk that ends when the test says: it installs its
 *  catalogue first, as an open does once the catalogue is read. */
function slowWalk(before?: (root: FileSystemDirectoryHandle) => Promise<void>) {
  let finish: () => void = () => {};
  const done = new Promise<void>((resolve) => (finish = resolve));
  const result: Walked = { storage: { readPreview: async () => null, close: vi.fn() } };
  h.open.mockImplementationOnce(
    async (root: FileSystemDirectoryHandle, _deps: unknown, _onPhoto: unknown, paint: (...a: unknown[]) => void) => {
      paint(result.storage, {}, []);
      await before?.(root).catch(() => undefined);
      await done;
      return { ...opened(), storage: result.storage };
    },
  );
  return { finish, result };
}

/** ProjectStorage.open for a walk that ends at once. */
function quickWalk() {
  h.open.mockImplementationOnce(
    async (_root: unknown, _deps: unknown, _onPhoto: unknown, paint: (...a: unknown[]) => void) => {
      const storage = { readPreview: async () => null, close: vi.fn() };
      paint(storage, {}, []);
      return { ...opened(), storage };
    },
  );
}

describe("an open while another is under way", () => {
  it("leaves a folder still opening, and nothing the folder's walk finishes later shows", async () => {
    const a = slowWalk();
    const first = openProject("A");
    await settle();
    quickWalk();
    await openProject("B");
    expect(useProjectStore.getState()).toMatchObject({ name: "B", opening: false });

    a.finish();
    await first;
    await settle();
    expect(useProjectStore.getState()).toMatchObject({ name: "B", opening: false });
    expect(a.result.storage.close).toHaveBeenCalled();
  });

  it("stops a library source's listing, so its requests to the server stop", async () => {
    const sources = await import("./library-sources");
    let listing: AbortSignal | undefined;
    let lateList: (value: { items: { key: string; name: string }[] }) => void = () => {};
    sources.registerLibrarySource("ext.a", {
      id: "test.server",
      name: "Server",
      list: ({ signal }) => {
        listing = signal;
        return new Promise((resolve) => (lateList = resolve));
      },
      readPreview: async () => new Blob(),
      readOriginal: async () => new Blob(),
    });
    const server = slowWalk(async (root) => {
      for await (const entry of root.values()) void entry;
    });
    const first = useProjectStore.getState().openProject(sources.sourceRoot("test.server")!);
    await settle();
    expect(listing?.aborted).toBe(false);

    quickWalk();
    await openProject("B");
    expect(listing?.aborted).toBe(true);
    expect(useProjectStore.getState()).toMatchObject({ name: "B", opening: false });

    lateList({ items: [{ key: "k", name: "a.jpg" }] });
    server.finish();
    await first;
    await settle();
    expect(useProjectStore.getState()).toMatchObject({ name: "B", opening: false });
    sources.dropLibrarySources("ext.a");
  });

  it("changes nothing when it asks for the project already opening", async () => {
    const a = slowWalk();
    const first = openProject("A");
    await settle();
    await openProject("A");
    expect(h.open).toHaveBeenCalledTimes(1);
    a.finish();
    await first;
    expect(useProjectStore.getState()).toMatchObject({ name: "A", opening: false });
  });
});
