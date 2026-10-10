// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What the open flow tells the user about a catalog it couldn't use as saved: why
// an open failed, and how a catalog it opened was recovered. Everything the open
// flow touches is a leaf stub; the messages in project-store.ts are real.

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CatalogDamagedError,
  CatalogTooNewError,
  CatalogUnreadableError,
} from "./catalog-errors";
import type { CatalogRecovery } from "./project-storage";
import { useProjectStore } from "./project-store";
import { ReadOnlyProjectError, type WorkingDirLocation } from "./working-dir";

const h = vi.hoisted(() => ({
  open: vi.fn(),
}));

vi.mock("@/state/detach", () => ({ detachedModule: () => null }));
vi.mock("@/raw/decode-pool", () => ({ warmDecodePool: async () => {} }));
vi.mock("@/modules/library/import-photos", () => ({
  preDecodeRawsForCache: async () => {},
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
vi.mock("@/state/settings-store", () => ({
  getSettings: () => ({ catalogLocation: "in-folder", externalCatalogDir: "" }),
}));
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

const shoot = { name: "Shoot" } as FileSystemDirectoryHandle;
const tree = { name: "Shoot", path: "", children: [] };

/** What ProjectStorage.open resolves to, by default for a catalog opened as saved. */
function opened(
  over: {
    recovered?: CatalogRecovery | null;
    storageLocation?: WorkingDirLocation;
    externalPath?: string | null;
    promotedFromExternal?: string | null;
  } = {},
) {
  return {
    storage: { readPreview: async () => null, close: () => {} },
    rawCacheDir: {},
    tree,
    photos: [],
    newPhotos: [],
    storageLocation: "in-folder",
    externalPath: null,
    promotedFromExternal: null,
    recovered: null,
    ...over,
  };
}

beforeEach(() => {
  h.open.mockReset();
  vi.stubGlobal("window", { addEventListener: () => {}, requestIdleCallback: () => {} });
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("an open that fails on its catalog", () => {
  const ebusy = new Error("EBUSY: resource busy or locked, open 'D:\\Shoot\\catalog.json'");
  const eperm = new Error("EPERM: operation not permitted, open 'D:\\Shoot\\x.json'");

  it.each([
    [
      "can't be read",
      new CatalogUnreadableError(ebusy),
      "Couldn't open “Shoot”: its catalog can't be read right now (EBUSY). A sync or " +
        "antivirus program may be using it. Nothing was changed. Try again in a moment.",
    ],
    [
      "is damaged and can't be kept",
      new CatalogDamagedError(eperm),
      "Couldn't open “Shoot”: its catalog is damaged and Safelight couldn't keep a copy " +
        "of it (EPERM). Nothing was changed.",
    ],
    [
      "was saved by a newer version",
      new CatalogTooNewError(2),
      "“Shoot” was saved by a newer version of Safelight. Update Safelight to open it. " +
        "Nothing was changed.",
    ],
  ])("says so when the catalog %s, offering no Preferences", async (_label, error, message) => {
    h.open.mockRejectedValue(error);

    await useProjectStore.getState().openProject(shoot);

    expect(useProjectStore.getState().openError).toBe(message);
    expect(useProjectStore.getState().openErrorReadOnly).toBe(false);
  });

  it("offers Preferences for a folder it can't write to", async () => {
    h.open.mockRejectedValue(new ReadOnlyProjectError("Shoot", true, eperm));

    await useProjectStore.getState().openProject(shoot);

    expect(useProjectStore.getState().openErrorReadOnly).toBe(true);
  });

  it("leaves no project open behind it", async () => {
    // The previous project's name would otherwise stand over an empty grid.
    h.open.mockResolvedValueOnce(opened());
    await useProjectStore.getState().openProject({ name: "Before" } as FileSystemDirectoryHandle);
    expect(useProjectStore.getState().tree).toBe(tree);

    h.open.mockRejectedValueOnce(new CatalogUnreadableError(ebusy));
    await useProjectStore.getState().openProject(shoot);

    expect(useProjectStore.getState()).toMatchObject({ root: null, tree: null });
  });
});

describe("a catalog the open recovered", () => {
  it.each<[string, CatalogRecovery, string]>([
    [
      "restored a damaged catalog from",
      { from: "backup", kept: "catalog.corrupt-2026-10-06T09-15-00-000Z.json" },
      "The catalog of “Shoot” couldn't be used, so Safelight restored it from its backup. " +
        "Changes made since that backup may be missing. The damaged file was kept next to " +
        "the catalog as catalog.corrupt-2026-10-06T09-15-00-000Z.json.",
    ],
    [
      "restored a missing catalog from",
      { from: "backup", kept: null },
      "The catalog of “Shoot” couldn't be used, so Safelight restored it from its backup. " +
        "Changes made since that backup may be missing.",
    ],
    [
      "imported the folder again without",
      { from: "rescan", kept: "catalog.corrupt-2026-10-06T09-15-00-000Z.json" },
      "The catalog of “Shoot” couldn't be used and had no usable backup, so Safelight " +
        "imported the folder again. Earlier ratings and edits could not be recovered. The " +
        "damaged file was kept next to the catalog as " +
        "catalog.corrupt-2026-10-06T09-15-00-000Z.json.",
    ],
  ])("says it %s a backup", async (_label, recovered, notice) => {
    h.open.mockResolvedValue(opened({ recovered }));

    await useProjectStore.getState().openProject(shoot);

    expect(useProjectStore.getState().storageNotice).toBe(notice);
    expect(useProjectStore.getState().openError).toBeNull();
  });

  it("names the copy a fold of read-only edits kept, apart from the session backup", async () => {
    h.open.mockResolvedValue(opened({ promotedFromExternal: "C:\\Safelight\\catalogs\\shoot" }));

    await useProjectStore.getState().openProject(shoot);

    expect(useProjectStore.getState().storageNotice).toBe(
      "Edits you made to “Shoot” while it was read-only have been merged back into its " +
        "catalog. The catalog from before the merge was kept in .safelight as " +
        "catalog.before-merge- followed by the date and time, in case you need it.",
    );
  });

  it("says nothing of a catalog opened as saved", async () => {
    h.open.mockResolvedValue(opened());

    await useProjectStore.getState().openProject(shoot);

    expect(useProjectStore.getState().storageNotice).toBeNull();
  });

  it("tells both where a redirected catalog lives and how it was recovered", async () => {
    h.open.mockResolvedValue(
      opened({
        recovered: { from: "backup", kept: null },
        storageLocation: "external",
        externalPath: "C:\\Safelight\\catalogs\\shoot",
      }),
    );

    await useProjectStore.getState().openProject(shoot);

    const notice = useProjectStore.getState().storageNotice ?? "";
    expect(notice).toContain("restored it from its backup");
    expect(notice).toContain("C:\\Safelight\\catalogs\\shoot");
  });
});
