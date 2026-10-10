// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Once a project is open, the main window repairs missing previews and fills
// the RAW cache in the background. Both belong to that project: they get its
// signal, which stops them as soon as the next project starts opening or this
// one closes. A popped-out window shares the main window's project and runs
// neither. Everything the open flow touches is a leaf stub; only the wiring in
// project-store.ts is real.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  detached: null as string | null,
  /** The signal each repair pass was handed, in order. */
  repairs: [] as (AbortSignal | undefined)[],
  /** The signal each Cache all pre-decode was handed, in order. */
  preDecodes: [] as (AbortSignal | undefined)[],
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
  useCatalogStore: {
    getState: () => ({
      replaceCatalog: () => {},
      finalizeCatalog: () => {},
      reconcileCatalog: () => {},
      appendPhotos: () => {},
      mergeRebuiltPhoto: () => {},
    }),
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

const folder = (name: string) => ({ name }) as FileSystemDirectoryHandle;

let useProjectStore: typeof import("./project-store").useProjectStore;
let projectPassSignal: typeof import("./project-store").projectPassSignal;

const openProject = (name: string) => useProjectStore.getState().openProject(folder(name));

/** What ProjectStorage.open resolves to: a project saved before. */
function opened() {
  return {
    storage: { readPreview: async () => null, close: () => {} },
    rawCacheDir: {},
    tree: null,
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
  h.remembered = () => Promise.resolve();
  h.open.mockReset();
  h.open.mockImplementation(async () => opened());
  vi.stubGlobal("window", {
    addEventListener: () => {},
    requestIdleCallback: (run: () => void) => run(),
  });
  vi.stubGlobal("requestAnimationFrame", () => 0);
  ({ useProjectStore, projectPassSignal } = await import("./project-store"));
});

describe("the background passes of an open project", () => {
  it("run in the main window, both with the project's signal", async () => {
    await openProject("A");
    await settle();

    expect(h.repairs).toHaveLength(1);
    expect(h.preDecodes).toEqual(h.repairs);
    expect(h.repairs[0]?.aborted).toBe(false);
  });

  it.each(["library", "develop"])("don't run in a popped-out %s window", async (module) => {
    h.detached = module;

    await openProject("A");
    await settle();

    expect(h.repairs).toEqual([]);
    expect(h.preDecodes).toEqual([]);
  });

  it("stop as soon as the next project starts opening", async () => {
    await openProject("A");
    await settle();
    const passesOfA = h.repairs[0];
    let stoppedWhileBOpened: boolean | undefined;
    h.open.mockImplementationOnce(async () => {
      stoppedWhileBOpened = passesOfA?.aborted;
      return opened();
    });

    await openProject("B");
    await settle();

    expect(stoppedWhileBOpened).toBe(true);
    expect(h.repairs[1]?.aborted).toBe(false);
  });

  it("stop when the project closes", async () => {
    await openProject("A");
    await settle();

    useProjectStore.getState().closeProject();

    expect(h.repairs[0]?.aborted).toBe(true);
  });

  it("start stopped when the project closed during the last steps of its open", async () => {
    let remember: () => void = () => {};
    h.remembered = () => new Promise<void>((resolve) => (remember = resolve));
    const opening = openProject("A");
    await settle();

    useProjectStore.getState().closeProject();
    remember();
    await opening;
    await settle();

    expect(h.repairs.every((signal) => signal?.aborted)).toBe(true);
  });

  it("are joined by the passes the user starts, through projectPassSignal", async () => {
    expect(projectPassSignal()).toBeUndefined();

    await openProject("A");
    await settle();
    const ofA = projectPassSignal();
    expect(ofA).toBe(h.repairs[0]);

    await openProject("B");
    await settle();
    expect(ofA?.aborted).toBe(true);
    const ofB = projectPassSignal();
    expect(ofB).toBe(h.repairs[1]);

    useProjectStore.getState().closeProject();
    expect(ofB?.aborted).toBe(true);
    expect(projectPassSignal()).toBeUndefined();
  });

  it("leave no signal live after an open that fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    await openProject("A");
    await settle();
    let duringB: AbortSignal | undefined;
    h.open.mockImplementationOnce(async () => {
      duringB = projectPassSignal();
      throw new Error("the catalog can't be read");
    });

    await openProject("B");

    expect(duringB?.aborted).toBe(true);
    expect(projectPassSignal()).toBeUndefined();
  });
});
