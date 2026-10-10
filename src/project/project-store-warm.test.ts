// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Decoding is warmed (three 256 MB libraw instances) when a project opens, not
// at boot, so the Welcome screen and the DevTools window never pay for it. The
// "Cache all" pre-decode sizes its concurrency from the warmed pool, so it must
// wait for the warm-up. Everything the open flow touches is replaced by a leaf
// stub; only the warm-up wiring in project-store.ts is real.

import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  detached: null as string | null,
  idle: [] as Array<() => void>,
  warm: vi.fn<() => Promise<void>>(),
  preDecode: vi.fn<() => Promise<void>>(),
  open: vi.fn(),
}));

vi.mock("@/state/detach", () => ({ detachedModule: () => h.detached }));
vi.mock("@/raw/decode-pool", () => ({ warmDecodePool: h.warm }));
vi.mock("@/modules/library/import-photos", () => ({
  preDecodeRawsForCache: h.preDecode,
  repairMissingPreviews: async () => {},
}));
vi.mock("./project-storage", () => ({
  ProjectStorage: { open: h.open },
  onSaveStatus: () => () => {},
}));
vi.mock("./recent", () => ({
  addRecentProject: async () => {},
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
      updatePhoto: () => {},
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

const handle = { name: "Shoot" } as FileSystemDirectoryHandle;

let startOpen: () => Promise<void>;

beforeEach(async () => {
  vi.resetModules();
  h.detached = null;
  h.idle = [];
  h.warm.mockReset();
  h.preDecode.mockReset();
  h.open.mockReset();
  h.warm.mockResolvedValue(undefined);
  h.preDecode.mockResolvedValue(undefined);
  h.open.mockImplementation(async (_h, _onPhoto, onSkeletons) => {
    onSkeletons({}, {}, []);
    return {
      storage: { readPreview: async () => null, close: () => {} },
      rawCacheDir: {},
      tree: null,
      photos: [],
      storageLocation: "project",
    };
  });
  vi.stubGlobal("window", {
    addEventListener: () => {},
    requestIdleCallback: (cb: () => void) => void h.idle.push(cb),
  });
  const { useProjectStore } = await import("./project-store");
  startOpen = () => useProjectStore.getState().openProject(handle);
});

// Lets the open flow run until it is waiting on something the test controls.
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("project-store decode warm-up", () => {
  it("warms the pool at idle once a project's catalog is installed", async () => {
    const opened = startOpen();
    await settle();
    expect(h.warm).not.toHaveBeenCalled();
    h.idle.splice(0).forEach((run) => run());
    expect(h.warm).toHaveBeenCalledTimes(1);
    await opened;
  });

  it("starts the Cache all pre-decode only after the pool is warm", async () => {
    let finishWarming: () => void = () => {};
    h.warm.mockReturnValue(new Promise<void>((res) => (finishWarming = res)));
    const opened = startOpen();
    await settle();
    h.idle.splice(0).forEach((run) => run());
    await settle();
    expect(h.preDecode).not.toHaveBeenCalled();
    finishWarming();
    await opened;
    await settle();
    expect(h.preDecode).toHaveBeenCalledTimes(1);
  });

  it("skips the pre-decode when the project was closed while the pool warmed", async () => {
    const { useProjectStore } = await import("./project-store");
    let finishWarming: () => void = () => {};
    h.warm.mockReturnValue(new Promise<void>((res) => (finishWarming = res)));
    const opened = startOpen();
    await settle();
    h.idle.splice(0).forEach((run) => run());
    await opened;
    useProjectStore.getState().closeProject();
    finishWarming();
    await settle();
    expect(h.preDecode).not.toHaveBeenCalled();
  });

  it("warms for a popped-out Develop window", async () => {
    h.detached = "develop";
    const opened = startOpen();
    await settle();
    h.idle.splice(0).forEach((run) => run());
    expect(h.warm).toHaveBeenCalledTimes(1);
    await opened;
  });

  it("leaves other pop-outs cold, with the pre-decode left to the main window", async () => {
    h.detached = "library";
    await startOpen();
    await settle();
    h.idle.splice(0).forEach((run) => run());
    expect(h.warm).not.toHaveBeenCalled();
    expect(h.preDecode).not.toHaveBeenCalled();
  });

  it("warms when no skeletons were painted first", async () => {
    h.open.mockImplementation(async () => ({
      storage: { readPreview: async () => null, close: () => {} },
      rawCacheDir: {},
      tree: null,
      photos: [],
      storageLocation: "project",
    }));
    const opened = startOpen();
    await settle();
    h.idle.splice(0).forEach((run) => run());
    expect(h.warm).toHaveBeenCalledTimes(1);
    await opened;
  });
});
