// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Which catalog the app writes through while a project opens and once it closes.
// A change made while the folder is walked, a first import's included, goes into
// the opening project's catalog, never into the one open before it, and a closed
// project's catalog takes no more. ProjectStorage.open and what the open paints
// are stubs; project-store.ts and the installed storage (@/catalog/storage) are real.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPhoto } from "@/catalog/types";
import { photo } from "@/catalog/stored-edit.fixtures";
import { CatalogUnreadableError } from "./catalog-errors";

const h = vi.hoisted(() => ({
  open: vi.fn(),
  finalizeCatalog: vi.fn(),
  reconcileCatalog: vi.fn(),
  /** The window's beforeunload listeners. */
  unload: [] as Array<() => void>,
  /** What project-store hears how each catalog save ended through. */
  saveStatus: null as
    | null
    | ((
        status: { ok: true } | { ok: false; reason: string; gaveUp?: true },
        storage: object,
      ) => void),
  flushLeftCopies: vi.fn(),
}));

vi.mock("@/state/detach", () => ({ detachedModule: () => null }));
vi.mock("@/raw/decode-pool", () => ({ warmDecodePool: async () => {} }));
vi.mock("@/modules/library/import-photos", () => ({
  preDecodeRawsForCache: async () => {},
  repairMissingPreviews: async () => {},
}));
vi.mock("./project-storage", () => ({
  ProjectStorage: { open: h.open },
  onSaveStatus: (listener: NonNullable<typeof h.saveStatus>) => {
    h.saveStatus = listener;
    return () => {};
  },
  flushLeftCopies: h.flushLeftCopies,
}));
vi.mock("./recent", () => ({
  addRecentProject: async () => {},
  getLastProject: async () => null,
  recentHandle: () => null,
}));
vi.mock("@/raw/raw-cache", () => ({ setRawCacheDir: () => {} }));
vi.mock("@/state/thumbnail-loader", () => ({
  requestThumbnail: () => {},
  setThumbnailLoader: () => 1,
  thumbnailGen: () => 1,
}));
vi.mock("@/state/settings-store", () => ({ getSettings: () => ({}) }));
vi.mock("@/state/catalog-store", () => ({
  useCatalogStore: {
    getState: () => ({
      replaceCatalog: () => {},
      finalizeCatalog: h.finalizeCatalog,
      reconcileCatalog: h.reconcileCatalog,
      appendPhotos: () => {},
      mergeRebuiltPhoto: () => {},
    }),
    setState: () => {},
  },
}));
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

/** Stands for the ProjectStorage an open hands over: what project-store calls. */
function projectStorage() {
  return {
    readPreview: async () => null,
    flush: vi.fn(async (_options?: { unloading?: boolean }) => {}),
    close: vi.fn(),
  };
}
type FakeStorage = ReturnType<typeof projectStorage>;
type OnPhoto = (photo: CatalogPhoto) => void;
type OnSkeletons = (storage: FakeStorage, rawCacheDir: object, skeletons: CatalogPhoto[]) => void;

/** What ProjectStorage.open resolves to once the walk has found `photos`. */
function opened(storage: FakeStorage, photos: CatalogPhoto[] = []) {
  return {
    storage,
    rawCacheDir: {},
    tree: null,
    photos,
    newPhotos: [],
    storageLocation: "in-folder",
    externalPath: null,
    promotedFromExternal: null,
    recovered: null,
  };
}

const folder = (name: string) => ({ name }) as FileSystemDirectoryHandle;

/** A walk the test lets finish. */
function walk() {
  let finish: () => void = () => {};
  const done = new Promise<void>((resolve) => (finish = resolve));
  return { done, finish };
}

// Lets the open flow run until it is waiting on something the test controls.
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

let useProjectStore: typeof import("./project-store").useProjectStore;
let catalogStorage: typeof import("@/catalog/storage").catalogStorage;

const openProject = (name: string) => useProjectStore.getState().openProject(folder(name));

/** Open project A, saved before, to the end of its walk. */
async function openA(): Promise<FakeStorage> {
  const a = projectStorage();
  h.open.mockImplementationOnce(async (_root: unknown, _onPhoto: OnPhoto, paint: OnSkeletons) => {
    paint(a, {}, [photo("a")]);
    return opened(a, [photo("a")]);
  });
  await openProject("A");
  return a;
}

beforeEach(async () => {
  vi.resetModules();
  h.open.mockReset();
  h.finalizeCatalog.mockReset();
  h.reconcileCatalog.mockReset();
  h.unload = [];
  h.saveStatus = null;
  h.flushLeftCopies.mockReset();
  vi.stubGlobal("window", {
    addEventListener: (type: string, listener: () => void) => {
      if (type === "beforeunload") h.unload.push(listener);
    },
    requestIdleCallback: () => {},
  });
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.spyOn(console, "error").mockImplementation(() => {});
  ({ useProjectStore } = await import("./project-store"));
  ({ catalogStorage } = await import("@/catalog/storage"));
});

describe("the catalog a change goes into while a project opens", () => {
  it("is the new project's while its first import runs", async () => {
    const s = projectStorage();
    let during: unknown = null;
    h.open.mockImplementation(async (_root: unknown, onPhoto: OnPhoto, paint: OnSkeletons) => {
      paint(s, {}, []); // the catalog was read: there is none yet
      onPhoto(photo("new"));
      during = catalogStorage();
      return opened(s, [photo("new")]);
    });

    await openProject("New");

    expect(during).toBe(s);
  });

  it("is no project's while the next catalog is read, the last one saved and closed", async () => {
    const a = await openA();
    const b = projectStorage();
    const flushesOfA = a.flush.mock.calls.length;
    let reading: unknown = null;
    let aWhileReading = { flushed: false, closed: false };
    h.open.mockImplementationOnce(async (_root: unknown, _onPhoto: OnPhoto, paint: OnSkeletons) => {
      reading = catalogStorage();
      aWhileReading = {
        flushed: a.flush.mock.calls.length > flushesOfA,
        closed: a.close.mock.calls.length > 0,
      };
      paint(b, {}, []);
      return opened(b);
    });

    await openProject("B");

    expect(reading).not.toBe(a);
    expect(aWhileReading).toEqual({ flushed: true, closed: true });
    expect(catalogStorage()).toBe(b);
  });

  it("reaches the importing project's catalog when the window closes mid-import", async () => {
    const s = projectStorage();
    const { done, finish } = walk();
    h.open.mockImplementation(async (_root: unknown, _onPhoto: OnPhoto, paint: OnSkeletons) => {
      paint(s, {}, []);
      await done;
      return opened(s);
    });
    const opening = openProject("New");
    await settle();

    for (const listener of h.unload) listener();
    finish();
    await opening;

    expect(s.flush).toHaveBeenCalledWith({ unloading: true });
  });

  it("is written last as the window closes, after the catalogs the window left", async () => {
    // The desktop app lands writes to one file in the order they were asked for.
    const a = await openA();
    const order: string[] = [];
    h.flushLeftCopies.mockImplementation(() => void order.push("left"));
    a.flush.mockImplementation(async () => void order.push("open"));

    for (const listener of h.unload) listener();

    expect(order).toEqual(["left", "open"]);
  });

  it("paints a first import from the photos found, with no saved photos to reconcile", async () => {
    const s = projectStorage();
    h.open.mockImplementation(async (_root: unknown, _onPhoto: OnPhoto, paint: OnSkeletons) => {
      paint(s, {}, []);
      return opened(s, [photo("new")]);
    });

    await openProject("New");

    expect(h.reconcileCatalog).not.toHaveBeenCalled();
    expect(h.finalizeCatalog).toHaveBeenLastCalledWith([photo("new")]);
  });
});

describe("the catalog a change goes into after an open fails", () => {
  it("is no project's when the catalog couldn't be read", async () => {
    const a = await openA();
    h.open.mockRejectedValueOnce(new CatalogUnreadableError(new Error("EBUSY")));

    await openProject("B");

    expect(catalogStorage()).not.toBe(a);
    await expect(catalogStorage().getAllPhotos()).resolves.toEqual([]);
  });

  it("is no project's when the walk failed after the saved photos were painted", async () => {
    const b = projectStorage();
    h.open.mockImplementationOnce(async (_root: unknown, _onPhoto: OnPhoto, paint: OnSkeletons) => {
      paint(b, {}, [photo("b")]);
      throw new Error("the folder is gone");
    });

    await openProject("B");

    expect(catalogStorage()).not.toBe(b);
    expect(b.flush).not.toHaveBeenCalled();
  });
});

describe("the catalog a change goes into once a project is closed", () => {
  it("is no project's, the closed one saved and closed", async () => {
    const a = await openA();
    const flushesOfA = a.flush.mock.calls.length;

    useProjectStore.getState().closeProject();

    expect(a.flush.mock.calls.length).toBe(flushesOfA + 1);
    expect(a.close).toHaveBeenCalled();
    expect(catalogStorage()).not.toBe(a);
  });

  it("is no project's when the project closes mid-walk, and the walk's end closes it", async () => {
    const b = projectStorage();
    const { done, finish } = walk();
    h.open.mockImplementationOnce(async (_root: unknown, _onPhoto: OnPhoto, paint: OnSkeletons) => {
      paint(b, {}, [photo("b")]);
      await done;
      return opened(b, [photo("b")]);
    });
    const opening = openProject("B");
    await settle();

    useProjectStore.getState().closeProject();
    finish();
    await opening;

    expect(b.close).toHaveBeenCalled();
    expect(catalogStorage()).not.toBe(b);
  });

  it("is no project's when the project closes before its catalog was read", async () => {
    const b = projectStorage();
    const { done, finish } = walk();
    h.open.mockImplementationOnce(async (_root: unknown, _onPhoto: OnPhoto, paint: OnSkeletons) => {
      await done;
      paint(b, {}, []);
      return opened(b);
    });
    const opening = openProject("B");
    await settle();

    useProjectStore.getState().closeProject();
    finish();
    await opening;

    expect(b.close).toHaveBeenCalled();
    expect(catalogStorage()).not.toBe(b);
  });
});

describe("the folder tree while a project opens", () => {
  it("is no longer the last project's once the next one is named", async () => {
    // Folder actions resolve the tree's paths against the open project's folder.
    const a = projectStorage();
    const treeOfA = { name: "A", path: "", children: [], count: 1 };
    h.open.mockImplementationOnce(async (_root: unknown, _onPhoto: OnPhoto, paint: OnSkeletons) => {
      paint(a, {}, [photo("a")]);
      return { ...opened(a, [photo("a")]), tree: treeOfA };
    });
    await openProject("A");
    expect(useProjectStore.getState().tree).toBe(treeOfA);
    const b = projectStorage();
    const { done, finish } = walk();
    h.open.mockImplementationOnce(async (_root: unknown, _onPhoto: OnPhoto, paint: OnSkeletons) => {
      paint(b, {}, []); // a first import names B at once
      await done;
      return opened(b);
    });

    const opening = openProject("B");
    await settle();

    expect(useProjectStore.getState()).toMatchObject({ name: "B", tree: null });
    finish();
    await opening;
  });
});

describe("reading the catalog of the next project", () => {
  // Reopening a folder reads its catalog.json, which the last save of the copy
  // the window left may not have reached yet.
  function heldFlush(storage: FakeStorage): () => void {
    let land: () => void = () => {};
    storage.flush.mockImplementationOnce(() => new Promise<void>((resolve) => (land = resolve)));
    return () => land();
  }

  function nextOpen() {
    const b = projectStorage();
    h.open.mockImplementationOnce(async (_root: unknown, _onPhoto: OnPhoto, paint: OnSkeletons) => {
      paint(b, {}, [photo("a")]);
      return opened(b, [photo("a")]);
    });
  }

  it("waits for the save of the project it replaces", async () => {
    const a = await openA();
    const land = heldFlush(a);
    nextOpen();

    const opening = openProject("A");
    await settle();
    expect(h.open).toHaveBeenCalledTimes(1);
    land();
    await opening;

    expect(h.open).toHaveBeenCalledTimes(2);
  });

  it("opens it, and the projects after it, when that save failed", async () => {
    const a = await openA();
    a.flush.mockRejectedValueOnce(new Error("EBUSY"));
    nextOpen();
    await openProject("B");
    nextOpen();

    await openProject("C");

    expect(h.open).toHaveBeenCalledTimes(3);
    expect(useProjectStore.getState()).toMatchObject({ name: "C", openError: null });
  });

  it("waits for the save of the project closed before it", async () => {
    const a = await openA();
    const land = heldFlush(a);
    useProjectStore.getState().closeProject();
    nextOpen();

    const opening = openProject("A");
    await settle();
    expect(h.open).toHaveBeenCalledTimes(1);
    land();
    await opening;

    expect(h.open).toHaveBeenCalledTimes(2);
  });
});

describe("a save of the catalog that failed", () => {
  // The storage keeps trying a save that failed, and says how each one ended.
  const failed = (reason: string) => ({ ok: false as const, reason });

  /** `storage` reports how one of its saves ended. */
  function saveEnded(status: Parameters<NonNullable<typeof h.saveStatus>>[0], storage: object) {
    if (!h.saveStatus) throw new Error("project-store doesn't hear how saves end");
    h.saveStatus(status, storage);
  }

  const saveError = () => useProjectStore.getState().saveError;

  it("is shown for the open project's catalog", async () => {
    const a = await openA();

    saveEnded(failed("the disk is full"), a);

    expect(saveError()).toBe("Couldn't save the catalog: the disk is full");
  });

  it("isn't shown for a catalog the window doesn't have open", async () => {
    await openA();

    saveEnded(failed("the disk is full"), projectStorage());

    expect(saveError()).toBeNull();
  });

  it("goes once a save lands", async () => {
    const a = await openA();
    saveEnded(failed("the disk is full"), a);

    saveEnded({ ok: true }, a);

    expect(saveError()).toBeNull();
  });

  it("goes when another project opens", async () => {
    const a = await openA();
    saveEnded(failed("the disk is full"), a);
    const b = projectStorage();
    let whileOpening: string | null | undefined;
    h.open.mockImplementationOnce(async (_root: unknown, _onPhoto: OnPhoto, paint: OnSkeletons) => {
      whileOpening = saveError();
      paint(b, {}, []);
      return opened(b);
    });

    await openProject("B");

    expect(whileOpening).toBeNull();
  });

  it("goes when the project closes", async () => {
    const a = await openA();
    saveEnded(failed("the disk is full"), a);

    useProjectStore.getState().closeProject();

    expect(saveError()).toBeNull();
  });

  it("is told in this window when a catalog it left gives up saving a change", async () => {
    const a = await openA();
    const b = projectStorage();
    h.open.mockImplementationOnce(async (_root: unknown, _onPhoto: OnPhoto, paint: OnSkeletons) => {
      paint(b, {}, []);
      return opened(b);
    });
    await openProject("B");

    saveEnded({ ok: false, reason: "the disk is full", gaveUp: true }, a);

    expect(useProjectStore.getState().storageNotice).toBe(
      "Safelight couldn't save your last changes to “A” after you left it (the disk is full). " +
        "If “A” is open in another Safelight window, that window saves them.",
    );
    expect(saveError()).toBeNull();
  });

  it("goes when the open fails after the project's catalog failed to save", async () => {
    // No project is left open to save, so the message could never go by itself.
    const b = projectStorage();
    h.open.mockImplementationOnce(async (_root: unknown, _onPhoto: OnPhoto, paint: OnSkeletons) => {
      paint(b, {}, [photo("b")]);
      saveEnded(failed("the disk is full"), b);
      throw new Error("the folder is gone");
    });

    await openProject("B");

    expect(saveError()).toBeNull();
  });
});
