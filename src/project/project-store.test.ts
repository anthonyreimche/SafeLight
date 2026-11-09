// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Which catalogue the app writes through while a project opens and once it closes.
// A change made while the folder is walked, a first import's included, goes into
// the opening project's catalogue, never into the one open before it, and a closed
// project's catalogue takes no more. ProjectStorage.open and what the open paints
// are stubs; project-store.ts and the installed storage (@/catalog/storage) are real.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPhoto, EditState } from "@/catalog/types";
import { photo } from "@/catalog/stored-edit.fixtures";
import type { CatalogHooksContribution, NativeOsOpenBridge } from "@/extensions/types";
import { CatalogUnreadableError } from "./catalog-errors";
import type { FolderNode } from "./folder-node";

const h = vi.hoisted(() => ({
  open: vi.fn(),
  finalizeCatalog: vi.fn(),
  reconcileCatalog: vi.fn(),
  /** The window's beforeunload listeners. */
  unload: [] as Array<() => void>,
  /** What project-store hears how each catalogue save ended through. */
  saveStatus: null as
    | null
    | ((
        status: { ok: true } | { ok: false; reason: string; gaveUp?: true },
        storage: object,
      ) => void),
  flushLeftCopies: vi.fn(),
  /** The grid's display order, as the shared derive hands it out. */
  visible: [] as CatalogPhoto[],
  /** The catalogue the window shows, and the selection call. */
  photos: [] as CatalogPhoto[],
  select: vi.fn(),
  /** What the preload offers for opening what the OS hands the app. */
  osOpen: null as null | NativeOsOpenBridge,
  /** How the catalogue store reaches the last project, as project-store set it. */
  lastProject: null as null | { openLast(): Promise<void>; reconnectLast(): Promise<boolean> },
  /** The grid-preview requests the idle prefill makes, and the loaders installed. */
  requestThumbnail: vi.fn<(id: string) => void>(),
  setThumbnailLoader: vi.fn<(read: unknown, opts?: { onEvict?: (ids: string[]) => void }) => number>(() => 1),
  /** The recent projects' paths, newest first. */
  recents: [] as string[],
  /** Fails the next read of the recent projects when set. */
  recentsError: null as Error | null,
  /** The handle a recent card resolves to, and the removals asked of the list. */
  recentHandle: null as null | { name: string },
  removeRecent: vi.fn(async (_id: string) => {}),
  /** The folder walk a tree refresh runs. */
  scan: vi.fn<typeof import("./scan").scanProject>(),
}));

vi.mock("@/native/privileged", () => ({ privilegedOsOpen: () => h.osOpen }));
vi.mock("./native-fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./native-fs")>()),
  nativeDirectoryHandle: (path: string) => ({ name: path.split("/").pop(), path }),
  nativePathOf: (handle: { path?: string } | null) => handle?.path ?? null,
}));
vi.mock("@/state/detach", () => ({ detachedModule: () => null }));
vi.mock("@/raw/decode-pool", () => ({ warmDecodePool: async () => {} }));
vi.mock("@/modules/library/import-photos", () => ({
  preDecodeRawsForCache: async () => {},
  readPendingMetadata: async () => {},
  repairMissingPreviews: async () => {},
  isSupportedName: () => true,
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
  recentHandle: () => h.recentHandle,
  removeRecentProject: (id: string) => h.removeRecent(id),
  listRecentProjects: async () => {
    const error = h.recentsError;
    h.recentsError = null;
    if (error) throw error;
    return h.recents.map((path, i) => ({ id: path, name: path, path, handle: null, openedAt: -i, cover: null }));
  },
}));
vi.mock("./scan", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./scan")>()),
  scanProject: h.scan,
}));
vi.mock("@/raw/raw-cache", () => ({ setRawCacheDir: () => {} }));
vi.mock("@/state/thumbnail-loader", () => ({
  requestThumbnail: h.requestThumbnail,
  setThumbnailLoader: h.setThumbnailLoader,
  thumbnailGen: () => 1,
}));
vi.mock("@/state/settings-store", () => ({ getSettings: () => ({}) }));
vi.mock("@/state/catalog-store", () => ({
  useCatalogStore: {
    getState: () => ({
      replaceCatalog: (photos: CatalogPhoto[]) => void (h.photos = photos),
      finalizeCatalog: h.finalizeCatalog,
      reconcileCatalog: h.reconcileCatalog,
      appendPhotos: () => {},
      mergeRebuiltPhoto: () => {},
      photos: h.photos,
      select: h.select,
    }),
    setState: () => {},
  },
  setLastProjectOpener: (opener: NonNullable<typeof h.lastProject>) => void (h.lastProject = opener),
}));
vi.mock("@/modules/library/photo-navigation", () => ({ visibleList: () => h.visible }));
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
    forgetPreviews: vi.fn(),
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
    unreadable: [],
    skipped: {},
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
  h.open.mockImplementationOnce(async (_root: unknown, _deps: unknown, _onPhoto: OnPhoto, paint: OnSkeletons) => {
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
  h.photos = [];
  h.visible = [];
  h.select.mockReset();
  h.osOpen = null;
  h.lastProject = null;
  h.requestThumbnail.mockClear();
  h.setThumbnailLoader.mockClear();
  h.recents = [];
  h.recentsError = null;
  h.recentHandle = null;
  h.removeRecent.mockClear();
  h.scan.mockReset();
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

describe("the catalogue store's startup load and reconnect", () => {
  it("reopen and re-grant the last project through this store", async () => {
    const openLast = vi.fn(async () => {});
    const reconnectLast = vi.fn(async () => true);
    useProjectStore.setState({ openLast, reconnectLast });

    await h.lastProject?.openLast();
    const reconnected = await h.lastProject?.reconnectLast();

    expect(openLast).toHaveBeenCalledOnce();
    expect(reconnectLast).toHaveBeenCalledOnce();
    expect(reconnected).toBe(true);
  });
});

describe("the catalogue a change goes into while a project opens", () => {
  it("is the new project's while its first import runs", async () => {
    const s = projectStorage();
    let during: unknown = null;
    h.open.mockImplementation(async (_root: unknown, _deps: unknown, onPhoto: OnPhoto, paint: OnSkeletons) => {
      paint(s, {}, []); // the catalogue was read: there is none yet
      onPhoto(photo("new"));
      during = catalogStorage();
      return opened(s, [photo("new")]);
    });

    await openProject("New");

    expect(during).toBe(s);
  });

  it("is no project's while the next catalogue is read, the last one saved and closed", async () => {
    const a = await openA();
    const b = projectStorage();
    const flushesOfA = a.flush.mock.calls.length;
    let reading: unknown = null;
    let aWhileReading = { flushed: false, closed: false };
    h.open.mockImplementationOnce(async (_root: unknown, _deps: unknown, _onPhoto: OnPhoto, paint: OnSkeletons) => {
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

  it("reaches the importing project's catalogue when the window closes mid-import", async () => {
    const s = projectStorage();
    const { done, finish } = walk();
    h.open.mockImplementation(async (_root: unknown, _deps: unknown, _onPhoto: OnPhoto, paint: OnSkeletons) => {
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

  it("is written last as the window closes, after the catalogues the window left", async () => {
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
    h.open.mockImplementation(async (_root: unknown, _deps: unknown, _onPhoto: OnPhoto, paint: OnSkeletons) => {
      paint(s, {}, []);
      return opened(s, [photo("new")]);
    });

    await openProject("New");

    expect(h.reconcileCatalog).not.toHaveBeenCalled();
    expect(h.finalizeCatalog).toHaveBeenLastCalledWith([photo("new")]);
  });
});

describe("a recent project whose drive is gone", () => {
  const entry = { id: "/gone/shoot", name: "shoot", path: "/gone/shoot", handle: null, openedAt: 0, cover: null };
  // The store is re-imported per spec (resetModules), so its error classes are too.
  let FolderUnavailableError: typeof import("./catalog-errors").FolderUnavailableError;
  beforeEach(async () => {
    ({ FolderUnavailableError } = await import("./catalog-errors"));
  });

  it("remembers which recent failed, so the banner can offer to remove it", async () => {
    h.recentHandle = folder("shoot");
    h.open.mockRejectedValueOnce(new FolderUnavailableError("ENOENT"));

    await useProjectStore.getState().openRecent(entry);

    expect(useProjectStore.getState()).toMatchObject({
      openError: expect.stringContaining("isn't available"),
      openErrorRecentId: "/gone/shoot",
    });
  });

  it("offers no removal for a folder opened some other way", async () => {
    h.open.mockRejectedValueOnce(new FolderUnavailableError("ENOENT"));

    await openProject("shoot");

    expect(useProjectStore.getState().openErrorRecentId).toBeNull();
  });

  it("offers no removal when the recent failed for another reason", async () => {
    h.recentHandle = folder("shoot");
    h.open.mockRejectedValueOnce(new CatalogUnreadableError(new Error("EBUSY")));

    await useProjectStore.getState().openRecent(entry);

    expect(useProjectStore.getState().openErrorRecentId).toBeNull();
  });

  it("removeFailedRecent drops it from the recents and clears the banner", async () => {
    h.recentHandle = folder("shoot");
    h.open.mockRejectedValueOnce(new FolderUnavailableError("ENOENT"));
    await useProjectStore.getState().openRecent(entry);
    const revision = useProjectStore.getState().recentsRevision;

    await useProjectStore.getState().removeFailedRecent();

    expect(h.removeRecent).toHaveBeenCalledWith("/gone/shoot");
    expect(useProjectStore.getState()).toMatchObject({ openError: null, openErrorRecentId: null });
    expect(useProjectStore.getState().recentsRevision).toBe(revision + 1);
  });
});

describe("the catalogue a change goes into after an open fails", () => {
  it("is no project's when the catalogue couldn't be read", async () => {
    const a = await openA();
    h.open.mockRejectedValueOnce(new CatalogUnreadableError(new Error("EBUSY")));

    await openProject("B");

    expect(catalogStorage()).not.toBe(a);
    await expect(catalogStorage().getEditState("any")).resolves.toBeUndefined();
  });

  it("is no project's when the walk failed after the saved photos were painted", async () => {
    const b = projectStorage();
    h.open.mockImplementationOnce(async (_root: unknown, _deps: unknown, _onPhoto: OnPhoto, paint: OnSkeletons) => {
      paint(b, {}, [photo("b")]);
      throw new Error("the folder is gone");
    });

    await openProject("B");

    expect(catalogStorage()).not.toBe(b);
    expect(b.flush).not.toHaveBeenCalled();
  });
});

describe("the catalogue a change goes into once a project is closed", () => {
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
    h.open.mockImplementationOnce(async (_root: unknown, _deps: unknown, _onPhoto: OnPhoto, paint: OnSkeletons) => {
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

  it("is no project's when the project closes before its catalogue was read", async () => {
    const b = projectStorage();
    const { done, finish } = walk();
    h.open.mockImplementationOnce(async (_root: unknown, _deps: unknown, _onPhoto: OnPhoto, paint: OnSkeletons) => {
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
    h.open.mockImplementationOnce(async (_root: unknown, _deps: unknown, _onPhoto: OnPhoto, paint: OnSkeletons) => {
      paint(a, {}, [photo("a")]);
      return { ...opened(a, [photo("a")]), tree: treeOfA };
    });
    await openProject("A");
    expect(useProjectStore.getState().tree).toBe(treeOfA);
    const b = projectStorage();
    const { done, finish } = walk();
    h.open.mockImplementationOnce(async (_root: unknown, _deps: unknown, _onPhoto: OnPhoto, paint: OnSkeletons) => {
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

describe("refreshing the folder tree", () => {
  const tree = (name: string): FolderNode => ({ name, path: "", children: [], count: 0 });
  const scanned = (found: FolderNode) => ({
    files: [],
    tree: found,
    sidecars: new Set<string>(),
    unreadable: [],
    skipped: {},
  });

  /** The next refresh's walk, which the test lands with the tree it found. */
  function heldScan(): (found: FolderNode) => void {
    let land: (found: FolderNode) => void = () => {};
    h.scan.mockImplementationOnce(
      () => new Promise((resolve) => (land = (found) => resolve(scanned(found)))),
    );
    return (found) => land(found);
  }

  it("keeps the next project's tree when the last project's walk lands late", async () => {
    await openA();
    const land = heldScan();
    const refreshing = useProjectStore.getState().refreshTree();
    const treeOfB = tree("B");
    h.open.mockImplementationOnce(async () => ({ ...opened(projectStorage()), tree: treeOfB }));
    await openProject("B");

    land(tree("A"));
    await refreshing;

    expect(useProjectStore.getState().tree).toBe(treeOfB);
  });

  it("installs no tree once the project it walked has closed", async () => {
    await openA();
    const land = heldScan();
    const refreshing = useProjectStore.getState().refreshTree();
    useProjectStore.getState().closeProject();

    land(tree("A"));
    await refreshing;

    expect(useProjectStore.getState().tree).toBeNull();
  });

  it("keeps the latest refresh's tree when an earlier walk lands after it", async () => {
    await openA();
    const land = heldScan();
    const first = useProjectStore.getState().refreshTree();
    const latest = tree("latest");
    h.scan.mockResolvedValueOnce(scanned(latest));
    await useProjectStore.getState().refreshTree();

    land(tree("earlier"));
    await first;

    expect(useProjectStore.getState().tree).toBe(latest);
  });

  it("settles and keeps the tree when the walk fails", async () => {
    await openA();
    const kept = tree("A");
    useProjectStore.setState({ tree: kept });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    h.scan.mockRejectedValueOnce(new Error("drive gone"));

    await expect(useProjectStore.getState().refreshTree()).resolves.toBeUndefined();

    expect(useProjectStore.getState().tree).toBe(kept);
  });
});

describe("reading the catalogue of the next project", () => {
  // Reopening a folder reads its catalog.json, which the last save of the copy
  // the window left may not have reached yet.
  function heldFlush(storage: FakeStorage): () => void {
    let land: () => void = () => {};
    storage.flush.mockImplementationOnce(() => new Promise<void>((resolve) => (land = resolve)));
    return () => land();
  }

  function nextOpen() {
    const b = projectStorage();
    h.open.mockImplementationOnce(async (_root: unknown, _deps: unknown, _onPhoto: OnPhoto, paint: OnSkeletons) => {
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

describe("a save of the catalogue that failed", () => {
  // The storage keeps trying a save that failed, and says how each one ended.
  const failed = (reason: string) => ({ ok: false as const, reason });

  /** `storage` reports how one of its saves ended. */
  function saveEnded(status: Parameters<NonNullable<typeof h.saveStatus>>[0], storage: object) {
    if (!h.saveStatus) throw new Error("project-store doesn't hear how saves end");
    h.saveStatus(status, storage);
  }

  const saveError = () => useProjectStore.getState().saveError;

  it("is shown for the open project's catalogue", async () => {
    const a = await openA();

    saveEnded(failed("the disk is full"), a);

    expect(saveError()).toBe(
      "Couldn't save the catalogue: the disk is full. Your latest changes aren't saved yet.",
    );
  });

  it("isn't shown for a catalogue the window doesn't have open", async () => {
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
    h.open.mockImplementationOnce(async (_root: unknown, _deps: unknown, _onPhoto: OnPhoto, paint: OnSkeletons) => {
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

  it("is told in this window when a catalogue it left gives up saving a change", async () => {
    const a = await openA();
    const b = projectStorage();
    h.open.mockImplementationOnce(async (_root: unknown, _deps: unknown, _onPhoto: OnPhoto, paint: OnSkeletons) => {
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

  it("goes when the open fails after the project's catalogue failed to save", async () => {
    // No project is left open to save, so the message could never go by itself.
    const b = projectStorage();
    h.open.mockImplementationOnce(async (_root: unknown, _deps: unknown, _onPhoto: OnPhoto, paint: OnSkeletons) => {
      paint(b, {}, [photo("b")]);
      saveEnded(failed("the disk is full"), b);
      throw new Error("the folder is gone");
    });

    await openProject("B");

    expect(saveError()).toBeNull();
  });
});

// "Open with Safelight" from the file manager: a folder opens as the project, a
// photo opens its folder and is selected once the catalogue has it.
describe("opening what the OS hands the app", () => {
  /** An open that finds `photos` in the folder. */
  function openFinds(...photos: CatalogPhoto[]) {
    h.open.mockImplementationOnce(async (_root: unknown, _deps: unknown, _onPhoto: OnPhoto, paint: OnSkeletons) => {
      const s = projectStorage();
      paint(s, {}, photos);
      h.photos = photos;
      return opened(s, photos);
    });
  }

  const openFromOs = (target: { folder: string; file: string | null }) =>
    useProjectStore.getState().openFromOs(target);

  it("opens the folder as the project and selects the named photo", async () => {
    openFinds(photo("a"), photo("b"));

    await openFromOs({ folder: "/photos/trip", file: "b.NEF" });

    expect(useProjectStore.getState().name).toBe("trip");
    expect(h.select).toHaveBeenCalledTimes(1);
    expect(h.select).toHaveBeenCalledWith("b");
  });

  it("matches the file name whatever its case where names fold case", async () => {
    onPlatform("win32");
    openFinds(photo("b"));

    await openFromOs({ folder: "/photos/trip", file: "B.nef" });

    expect(h.select).toHaveBeenCalledWith("b");
  });

  it("selects nothing when given a folder", async () => {
    openFinds(photo("a"));

    await openFromOs({ folder: "/photos/trip", file: null });

    expect(useProjectStore.getState().name).toBe("trip");
    expect(h.select).not.toHaveBeenCalled();
  });

  it("opens the folder and selects nothing when the photo is not in the catalogue", async () => {
    openFinds(photo("a"));

    await openFromOs({ folder: "/photos/trip", file: "missing.NEF" });

    expect(useProjectStore.getState().name).toBe("trip");
    expect(h.select).not.toHaveBeenCalled();
  });

  it("selects nothing when the folder fails to open", async () => {
    h.open.mockImplementationOnce(async () => {
      throw new Error("the folder is gone");
    });
    h.photos = [photo("a")];

    await openFromOs({ folder: "/photos/trip", file: "a.NEF" });

    expect(h.select).not.toHaveBeenCalled();
  });

  it("keeps the project that is already open and selects in it", async () => {
    openFinds(photo("a"), photo("b"));
    await openFromOs({ folder: "/photos/trip", file: null });

    await openFromOs({ folder: "/photos/trip", file: "a.NEF" });

    expect(h.open).toHaveBeenCalledTimes(1);
    expect(h.select).toHaveBeenCalledWith("a");
  });

  /** A photo at `relPath` in the project. */
  const photoAt = (id: string, relPath: string): CatalogPhoto => ({ ...photo(id), relPath });

  /** The window on `platform`, as beforeEach stubs it otherwise. */
  const onPlatform = (platform: string) =>
    vi.stubGlobal("window", { addEventListener: () => {}, requestIdleCallback: () => {}, safelightNative: { platform } });

  it("keeps the open project for a photo in one of its subfolders and selects it there", async () => {
    openFinds(photoAt("a", "a.NEF"), photoAt("x", "trip/day 1/x.NEF"));
    await openFromOs({ folder: "/photos", file: null });

    await openFromOs({ folder: "/photos/trip/day 1", file: "x.NEF" });

    expect(h.open).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState().name).toBe("photos");
    expect(h.select).toHaveBeenCalledWith("x");
  });

  it("matches the subfolder whatever its case and separators on Windows", async () => {
    onPlatform("win32");
    openFinds(photoAt("x", "Trip/x.NEF"));
    await openFromOs({ folder: "D:/Photos", file: null });

    await openFromOs({ folder: "d:\\photos\\TRIP", file: "X.nef" });

    expect(h.open).toHaveBeenCalledTimes(1);
    expect(h.select).toHaveBeenCalledWith("x");
  });

  it("opens a subfolder that differs in case as its own project on Linux", async () => {
    onPlatform("linux");
    openFinds(photoAt("x", "Trip/x.NEF"));
    await openFromOs({ folder: "/photos", file: null });
    openFinds(photoAt("x", "x.NEF"));

    await openFromOs({ folder: "/Photos/Trip", file: "x.NEF" });

    expect(h.open).toHaveBeenCalledTimes(2);
    expect(useProjectStore.getState().name).toBe("Trip");
  });

  it("does not take a sibling folder sharing the project's name as a prefix for a subfolder", async () => {
    openFinds(photoAt("x", "x.NEF"));
    await openFromOs({ folder: "/photos", file: null });
    openFinds(photoAt("y", "y.NEF"));

    await openFromOs({ folder: "/photos-2024", file: "y.NEF" });

    expect(h.open).toHaveBeenCalledTimes(2);
    expect(useProjectStore.getState().name).toBe("photos-2024");
    expect(h.select).toHaveBeenCalledWith("y");
  });

  it("opens the recent project that holds the photo's folder rather than a project of its own", async () => {
    h.recents = ["/elsewhere", "/photos", "/photos/trip"];
    openFinds(photoAt("x", "day 1/x.NEF"));

    await openFromOs({ folder: "/photos/trip/day 1", file: "x.NEF" });

    expect(h.open).toHaveBeenCalledTimes(1);
    expect(useProjectStore.getState().name).toBe("trip");
    expect(h.select).toHaveBeenCalledWith("x");
  });

  it("selects by the photo's exact case where names keep their case", async () => {
    onPlatform("linux");
    openFinds(photoAt("upper", "trip/X.NEF"), photoAt("lower", "trip/x.nef"));
    await openFromOs({ folder: "/photos", file: null });

    await openFromOs({ folder: "/photos/trip", file: "x.nef" });

    expect(h.select).toHaveBeenCalledWith("lower");
  });

  it("does not take a recent drive root or home folder as the project for a photo in it", async () => {
    onPlatform("win32");
    h.recents = ["D:\\", "C:\\Users\\anthony", "/home/anthony"];
    openFinds(photoAt("x", "x.NEF"));

    await openFromOs({ folder: "D:\\Trip", file: "x.NEF" });
    expect(useProjectStore.getState().name).toBe("D:\\Trip");

    openFinds(photoAt("y", "y.NEF"));
    await openFromOs({ folder: "C:\\Users\\anthony\\Pictures", file: "y.NEF" });
    expect(h.open).toHaveBeenCalledTimes(2);
    expect(h.select).toHaveBeenLastCalledWith("y");
  });

  it("does not take a recent network share root as the project for a photo in it", async () => {
    onPlatform("win32");
    h.recents = ["\\\\nas\\photos"];
    openFinds(photoAt("x", "x.NEF"));

    await openFromOs({ folder: "\\\\nas\\photos\\trip", file: "x.NEF" });

    expect(useProjectStore.getState().name).not.toBe("photos");
    expect(h.select).toHaveBeenCalledWith("x");
  });

  it("does not take a recent removable drive as the project on Linux", async () => {
    onPlatform("linux");
    h.recents = ["/run/media/anthony/EOS_DIGITAL"];
    openFinds(photoAt("x", "x.NEF"));

    await openFromOs({ folder: "/run/media/anthony/EOS_DIGITAL/DCIM", file: "x.NEF" });

    expect(useProjectStore.getState().name).toBe("DCIM");
    expect(h.select).toHaveBeenCalledWith("x");
  });

  it("does not take a recent home folder as the project on Linux either", async () => {
    onPlatform("linux");
    h.recents = ["/home/anthony", "/"];
    openFinds(photoAt("x", "x.NEF"));

    await openFromOs({ folder: "/home/anthony/trip", file: "x.NEF" });

    expect(useProjectStore.getState().name).toBe("trip");
    expect(h.select).toHaveBeenCalledWith("x");
  });

  it("waits for the project that is opening, then opens its own", async () => {
    const { done, finish } = walk();
    h.open.mockImplementationOnce(async (_root: unknown, _deps: unknown, _onPhoto: OnPhoto, paint: OnSkeletons) => {
      const s = projectStorage();
      paint(s, {}, []);
      await done;
      return opened(s);
    });
    const last = openProject("last");
    await settle();
    openFinds(photo("a"));

    const requested = openFromOs({ folder: "/photos/trip", file: "a.NEF" });
    await settle();
    expect(h.open).toHaveBeenCalledTimes(1);
    finish();
    await Promise.all([last, requested]);

    expect(h.open).toHaveBeenCalledTimes(2);
    expect(useProjectStore.getState().name).toBe("trip");
    expect(h.select).toHaveBeenCalledWith("a");
  });
});

describe("two requests from the OS during an open", () => {
  it("opens only the latest once the open in progress ends", async () => {
    const { done, finish } = walk();
    h.open.mockImplementationOnce(async (_root: unknown, _deps: unknown, _onPhoto: OnPhoto, paint: OnSkeletons) => {
      const s = projectStorage();
      paint(s, {}, []);
      await done;
      return opened(s);
    });
    const last = openProject("last");
    await settle();
    const photos = [photo("a")];
    h.open.mockImplementationOnce(async (_root: unknown, _deps: unknown, _onPhoto: OnPhoto, paint: OnSkeletons) => {
      const s = projectStorage();
      paint(s, {}, photos);
      h.photos = photos;
      return opened(s, photos);
    });

    const first = useProjectStore.getState().openFromOs({ folder: "/photos/first", file: null });
    const second = useProjectStore.getState().openFromOs({ folder: "/photos/second", file: "a.NEF" });
    await settle();
    finish();
    await Promise.all([last, first, second]);

    expect(h.open).toHaveBeenCalledTimes(2);
    expect(useProjectStore.getState().name).toBe("second");
    expect(h.select).toHaveBeenCalledWith("a");
  });
});

describe("watching for what the OS hands the app", () => {
  function bridge(waiting: Array<{ folder: string; file: string | null } | null>) {
    let request: () => void = () => {};
    const osOpen: NativeOsOpenBridge = {
      take: vi.fn(async () => waiting.shift() ?? null),
      onRequest: (listener) => {
        request = listener;
        return () => {};
      },
    };
    return { osOpen, request: () => request() };
  }

  it("puts a request it couldn't take on the error banner", async () => {
    const { osOpen } = bridge([]);
    vi.mocked(osOpen.take).mockRejectedValueOnce(new Error("bridge closed"));
    h.osOpen = osOpen;

    const { watchOsOpen } = await import("./project-store");
    watchOsOpen();
    await settle();

    expect(useProjectStore.getState().openError).toBe(
      "Couldn't open what was sent to Safelight. Try opening it again.",
    );
    expect(console.error).toHaveBeenCalledWith(
      "[project] opening what the OS asked for failed:",
      expect.any(Error),
    );
  });

  it("puts a failure before the open on the banner and still opens the next request", async () => {
    const { osOpen, request } = bridge([
      { folder: "/photos/trip", file: null },
      { folder: "/photos/later", file: null },
    ]);
    h.osOpen = osOpen;
    h.recentsError = new Error("recents unreadable");
    h.open.mockImplementationOnce(async (_root: unknown, _deps: unknown, _onPhoto: OnPhoto, paint: OnSkeletons) => {
      const s = projectStorage();
      paint(s, {}, []);
      return opened(s);
    });

    const { watchOsOpen } = await import("./project-store");
    watchOsOpen();
    await settle();

    expect(useProjectStore.getState().openError).toMatch(/^Couldn't open “trip”/);
    expect(h.open).not.toHaveBeenCalled();

    request();
    await settle();

    expect(useProjectStore.getState().name).toBe("later");
    expect(useProjectStore.getState().openError).toBeNull();
  });

  it("opens what was waiting when the window came up", async () => {
    const { osOpen } = bridge([{ folder: "/photos/trip", file: null }]);
    h.osOpen = osOpen;
    h.open.mockImplementationOnce(async (_root: unknown, _deps: unknown, _onPhoto: OnPhoto, paint: OnSkeletons) => {
      const s = projectStorage();
      paint(s, {}, []);
      return opened(s);
    });

    const { watchOsOpen } = await import("./project-store");
    watchOsOpen();
    await settle();

    expect(useProjectStore.getState().name).toBe("trip");
  });

  it("opens what the OS asks for while the app runs", async () => {
    const { osOpen, request } = bridge([null, { folder: "/photos/later", file: null }]);
    h.osOpen = osOpen;
    h.open.mockImplementationOnce(async (_root: unknown, _deps: unknown, _onPhoto: OnPhoto, paint: OnSkeletons) => {
      const s = projectStorage();
      paint(s, {}, []);
      return opened(s);
    });
    const { watchOsOpen } = await import("./project-store");
    watchOsOpen();
    await settle();
    expect(h.open).not.toHaveBeenCalled();

    request();
    await settle();

    expect(useProjectStore.getState().name).toBe("later");
  });

  it("does nothing outside the desktop app", async () => {
    const { watchOsOpen } = await import("./project-store");

    expect(() => watchOsOpen()).not.toThrow();
  });
});

describe("the grid previews an open reads ahead", () => {
  const photosNamed = (count: number) => Array.from({ length: count }, (_, i) => photo(`p${i}`));

  async function openWith(skeletons: CatalogPhoto[]): Promise<FakeStorage> {
    const s = projectStorage();
    vi.stubGlobal("window", {
      addEventListener: () => {},
      requestIdleCallback: (cb: () => void) => cb(),
    });
    h.open.mockImplementationOnce(async (_root: unknown, _deps: unknown, _onPhoto: OnPhoto, paint: OnSkeletons) => {
      paint(s, {}, skeletons);
      return opened(s, skeletons);
    });
    await openProject("Big");
    return s;
  }

  it("are the first 2000 photos of a big catalogue; the grid reads the rest as they scroll into view", async () => {
    await openWith(photosNamed(5000));

    const requested = h.requestThumbnail.mock.calls.map(([id]) => id);
    expect(requested).toHaveLength(2000);
    expect(new Set(requested).size).toBe(2000);
  });

  it("start with the photos the grid shows, in its order, ahead of the rest", async () => {
    const photos = photosNamed(5);
    h.visible = [photos[3], photos[1]];

    await openWith(photos);

    expect(h.requestThumbnail.mock.calls.map(([id]) => id)).toEqual(["p3", "p1", "p0", "p2", "p4"]);
  });

  it("are every photo of a small catalogue", async () => {
    await openWith(photosNamed(300));

    expect(h.requestThumbnail).toHaveBeenCalledTimes(300);
  });

  it("are forgotten by the project's storage once the grid lets them go", async () => {
    const s = await openWith(photosNamed(3));

    const [, opts] = h.setThumbnailLoader.mock.calls[0];
    opts?.onEvict?.(["p0", "p2"]);

    expect(s.forgetPreviews).toHaveBeenCalledWith(["p0", "p2"]);
  });
});

describe("the photo open in Develop when its project is left", () => {
  /** A project storage that holds edits, and what it was asked to store. */
  function editable() {
    const putEditState = vi.fn(async (_state: unknown) => {});
    return Object.assign(projectStorage(), {
      getEditState: async () => undefined,
      putEditState,
      putEditStates: async () => {},
      putPhoto: async () => {},
      putPhotos: async () => {},
      deletePhotos: async () => {},
    });
  }
  type Editable = ReturnType<typeof editable>;

  async function open(storage: Editable, name: string): Promise<void> {
    h.open.mockImplementationOnce(async (_root: unknown, _deps: unknown, _onPhoto: OnPhoto, paint: OnSkeletons) => {
      paint(storage, {}, [photo("p")]);
      return opened(storage, [photo("p")]);
    });
    await openProject(name);
  }

  const stored = (storage: Editable) => storage.putEditState.mock.calls.map(([state]) => state as EditState);

  it("has its uncommitted change committed to the project being left", async () => {
    const { useDevelopStore } = await import("@/state/develop-store");
    const a = editable();
    await open(a, "A");
    await useDevelopStore.getState().loadEdit("p", 5000);
    useDevelopStore.getState().setParam("exposure", 1);

    useProjectStore.getState().closeProject();

    await vi.waitFor(() => expect(stored(a)).toHaveLength(1));
    expect(stored(a)[0].photoId).toBe("p");
    expect(stored(a)[0].stack.at(-1)?.params.exposure).toBe(1);
    expect(useDevelopStore.getState()).toMatchObject({ photoId: null, history: [] });
    await vi.waitFor(() => expect(a.flush.mock.calls.length).toBeGreaterThan(1));
  });

  it("reaches the catalogue hooks with the photo, though the grid is already cleared", async () => {
    const { useDevelopStore } = await import("@/state/develop-store");
    const { registerCatalogHooks } = await import("@/extensions/registry");
    const onEditCommit = vi.fn<NonNullable<CatalogHooksContribution["onEditCommit"]>>();
    registerCatalogHooks("test.sidecar", { id: "test.sidecar", onEditCommit });
    const a = editable();
    await open(a, "A");
    h.photos = [photo("p")];
    await useDevelopStore.getState().loadEdit("p", 5000);
    useDevelopStore.getState().setParam("exposure", 1);

    useProjectStore.getState().closeProject();

    await vi.waitFor(() => expect(onEditCommit).toHaveBeenCalledOnce());
    expect(onEditCommit.mock.calls[0][0].photo.id).toBe("p");
    expect(onEditCommit.mock.calls[0][0].editState.photoId).toBe("p");
  });

  it("is not written into the next project when a photo opens there", async () => {
    const { useDevelopStore } = await import("@/state/develop-store");
    const a = editable();
    await open(a, "A");
    await useDevelopStore.getState().loadEdit("p", 5000);
    useDevelopStore.getState().setParam("exposure", 1);
    const b = editable();

    await open(b, "B");
    await useDevelopStore.getState().loadEdit("q", 5000);

    expect(stored(b)).toEqual([]);
    expect(stored(a).map((state) => state.photoId)).toEqual(["p"]);
    expect(useDevelopStore.getState().photoId).toBe("q");
  });

  it("commits nothing anywhere for an Auto run cut short by closing the project", async () => {
    vi.useFakeTimers();
    try {
      const { useDevelopStore } = await import("@/state/develop-store");
      const { autoAdjust } = await import("@/hooks/use-auto-adjust");
      const a = editable();
      await open(a, "A");
      await useDevelopStore.getState().loadEdit("p", 5000);
      const luma = new Uint32Array(256);
      luma[30] = 1000;
      useDevelopStore.getState().setHistogram({ r: luma.slice(), g: luma.slice(), b: luma.slice(), luma });

      const running = autoAdjust.tone();
      useProjectStore.getState().closeProject();
      await vi.advanceTimersByTimeAsync(5000);
      await running;
      expect(useDevelopStore.getState()).toMatchObject({ photoId: null, history: [] });
      const b = editable();
      await open(b, "B");
      await useDevelopStore.getState().loadEdit("q", 5000);

      expect(stored(a)).toEqual([]);
      expect(stored(b)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
