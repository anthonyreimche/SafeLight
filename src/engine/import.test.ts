// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import { catalogStorage, setCatalogStorage } from "@/catalog/storage";
import type { CatalogPhoto, EditState } from "@/catalog/types";
import type { OpenedProject, ProjectStorage, ProjectStorageDeps } from "@/project/project-storage";
import { LockLostError, ProjectLockedError, type StorageOpenOptions } from "@/project/storage-options";
import { useCatalogStore } from "@/state/catalog-store";
import type { EngineEvent, ImportScope } from "./protocol";
import type { ImportRequest, PortMessage, RequestOut } from "./rpc";
import { runImport, type ImportDeps } from "./import";

const ROOT = "D:\\shoot";

function photo(relPath: string, over: Partial<CatalogPhoto> = {}): CatalogPhoto {
  const filename = relPath.split("/").pop() ?? relPath;
  const folder = relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "";
  return {
    id: `id-${filename}`,
    filename,
    relPath,
    folder,
    directoryHandle: null,
    fileHandle: null,
    thumbnailBlob: null,
    thumbnailUrl: null,
    width: 600,
    height: 400,
    fileSize: 8,
    mimeType: "image/jpeg",
    rating: 0,
    colorLabel: "none",
    flag: "none",
    rotation: 0,
    keywords: [],
    dateCreated: 0,
    dateImported: 0,
    exif: {},
    ...over,
  };
}

const fileAt = (relPath: string) =>
  ({ kind: "file", name: relPath.split("/").pop(), path: `${ROOT}\\${relPath.replace(/\//g, "\\")}` }) as unknown as FileSystemFileHandle;

const pathOf = (handle: unknown): string | null => (handle as { path?: string }).path ?? null;

const edit = (photoId: string, currentIndex: number): EditState => ({ photoId, stack: [], currentIndex });

interface Walk {
  /** Files the walk finds new, each with what importPhoto makes of it. */
  files?: { relPath: string; built: Partial<CatalogPhoto> | null | Error }[];
  /** Photos already in the catalogue. */
  known?: CatalogPhoto[];
  savedEdits?: EditState[];
  moved?: OpenedProject["moved"];
  dropped?: OpenedProject["dropped"];
  /** What the open throws instead of opening. */
  fails?: Error;
  /** Called as the walk reaches each file, before it is imported. */
  beforeFile?: (relPath: string) => void;
  catalogExisted?: boolean;
  workingDir?: string;
}

/** ProjectStorage.open as the import drives it, over a walk described by `walk`. */
function fakeOpen(walk: Walk) {
  const order: string[] = [];
  let release = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  const storage = {
    putPhoto: vi.fn(async () => {}),
    putPhotos: vi.fn(async () => {}),
    deletePhotos: vi.fn(async () => {}),
    putEditState: vi.fn(async () => {}),
    putEditStates: vi.fn(async () => {}),
    putPhotoBlob: vi.fn(async () => {}),
    getEditState: async () => undefined,
    getAllEditStates: vi.fn(async () => walk.savedEdits ?? []),
    flush: vi.fn(async () => void order.push("flush")),
    close: vi.fn(() => void order.push("close")),
    released: vi.fn(() => released.then(() => void order.push("released"))),
  };
  const workingDir = walk.workingDir ?? `${ROOT}\\.safelight`;
  const rawCacheDir = { kind: "directory", name: "raw", path: `${workingDir}\\raw` } as unknown as FileSystemDirectoryHandle;
  const open = vi.fn(
    async (
      _root: FileSystemDirectoryHandle,
      deps: ProjectStorageDeps,
      onPhoto?: (photo: CatalogPhoto) => void,
      onSkeletons?: (storage: ProjectStorage, rawCacheDir: FileSystemDirectoryHandle, skeletons: CatalogPhoto[]) => void,
      onProgress?: (done: number, total: number) => void,
      signal?: AbortSignal,
      _options?: StorageOpenOptions,
    ): Promise<OpenedProject> => {
      if (walk.fails) throw walk.fails;
      const known = walk.known ?? [];
      onSkeletons?.(storage as unknown as ProjectStorage, rawCacheDir, known);
      const files = walk.files ?? [];
      onProgress?.(0, files.length);
      const photos = [...known];
      let done = 0;
      for (const { relPath } of files) {
        walk.beforeFile?.(relPath);
        if (signal?.aborted) {
          onProgress?.(++done, files.length);
          continue;
        }
        try {
          const record = await deps.importPhoto(fileAt(relPath), null);
          if (record) {
            const p = { ...record, relPath };
            photos.push(p);
            onPhoto?.(p);
          }
        } catch {
          // the walk skips a file that can't be read
        }
        onProgress?.(++done, files.length);
      }
      return {
        storage: storage as unknown as ProjectStorage,
        tree: { name: "shoot", path: "", children: [], count: 0 },
        unreadable: [],
        skipped: {},
        photos,
        newPhotos: [],
        rawCacheDir,
        storageLocation: "in-folder",
        externalPath: null,
        promotedFromExternal: null,
        recovered: null,
        moved: walk.moved ?? [],
        dropped: walk.dropped ?? [],
      };
    },
  );
  return { open, storage, order, release };
}

function deps(walk: Walk, over: Partial<ImportDeps> = {}) {
  const fake = fakeOpen(walk);
  const importPhoto = vi.fn(async (handle: FileSystemFileHandle) => {
    const file = (walk.files ?? []).find((f) => pathOf(fileAt(f.relPath)) === pathOf(handle));
    if (!file || file.built === null) return null;
    if (file.built instanceof Error) throw file.built;
    return photo(file.relPath, file.built);
  });
  const importDeps: ImportDeps = {
    directory: (root) => ({ kind: "directory", name: root, path: root }) as unknown as FileSystemDirectoryHandle,
    open: fake.open as unknown as ImportDeps["open"],
    storageDeps: {
      isSupportedName: () => true,
      importPhoto,
      buildPreviewBlob: async () => null,
      persistPreviews: () => true,
      emitPhotoImport: async () => null,
    },
    readPendingMetadata: vi.fn(async (photos: CatalogPhoto[], onRead) => {
      for (const p of photos) onRead?.(p, { metadataPending: undefined, exif: { colorTemperature: 5000 } });
    }),
    repairMissingPreviews: vi.fn(async () => {}),
    pathOf,
    exists: vi.fn(async () => walk.catalogExisted ?? true),
    ...over,
  };
  return { ...fake, deps: importDeps, importPhoto };
}

function request(scope: ImportScope = { kind: "all" }, metadata = true): ImportRequest {
  return { id: 5, type: "import", project: { root: ROOT }, scope, metadata, keepBackup: true };
}

function recordingOut() {
  const sent: PortMessage[] = [];
  const out: RequestOut = {
    emit: (event) => sent.push(event),
    frame: () => {
      throw new Error("an import sends no frames");
    },
  };
  const events = () => sent.filter((m): m is EngineEvent => "type" in m);
  return { out, events };
}

const run = async (d: ReturnType<typeof deps>, req = request(), signal = new AbortController().signal) => {
  const { out, events } = recordingOut();
  const done = runImport(req, out, signal, d.deps);
  d.release();
  await done;
  return events();
};

beforeEach(() => {
  setCatalogStorage(null);
  useCatalogStore.getState().replaceCatalog([]);
});

describe("an import", () => {
  it("opens the project as the GUI does, writing as slu, failing on a held lock, checking the lock before each write", async () => {
    const d = deps({});
    const signal = new AbortController().signal;
    await run(d, request({ kind: "some", files: ["a.jpg"], folders: [{ relPath: "Day 2", recursive: true }] }), signal);

    const [root, , , , , passed, options] = d.open.mock.calls[0];
    expect(pathOf(root)).toBe(ROOT);
    expect(passed).toBe(signal);
    expect(options).toEqual({
      lock: { owner: "slu", whenHeld: "fail", waitMs: 0, verifyBeforeWrite: true },
      keepBackup: true,
      importOnly: { files: ["a.jpg"], folders: [{ relPath: "Day 2", recursive: true }] },
    });
  });

  it("takes every new file when its scope is the whole project", async () => {
    const d = deps({});
    await run(d);
    expect(d.open.mock.calls[0][6]).not.toHaveProperty("importOnly");
  });

  it("says where the catalogue is, then each file as it lands, then how it ended", async () => {
    const d = deps({
      catalogExisted: false,
      files: [
        { relPath: "a.jpg", built: {} },
        { relPath: "Day 2/b.NEF", built: { width: 0, height: 0, decodeError: "no decoder" } },
        { relPath: "Day 2/c.NEF", built: new Error("EBUSY") },
        { relPath: "d.jpg", built: null },
      ],
    });
    const events = await run(d, request({ kind: "all" }, false));

    expect(events[0]).toEqual({ id: 5, type: "import-plan", workingDir: `${ROOT}\\.safelight`, location: "in-folder", created: true, newFiles: 4 });
    expect(events.filter((e) => e.type === "import-file")).toEqual([
      { id: 5, type: "import-file", relPath: "a.jpg", photoId: "id-a.jpg", state: "ok" },
      { id: 5, type: "import-file", relPath: "Day 2/b.NEF", photoId: "id-b.NEF", state: "no-preview" },
      { id: 5, type: "import-file", relPath: "Day 2/c.NEF", state: "failed", error: "EBUSY" },
      { id: 5, type: "import-file", relPath: "d.jpg", state: "failed", error: "couldn't be read" },
    ]);
    expect(events.filter((e) => e.type === "progress").map((e) => e.type === "progress" && [e.phase, e.done, e.total])).toEqual([
      ["files", 0, 4],
      ["files", 1, 4],
      ["files", 2, 4],
      ["files", 3, 4],
      ["files", 4, 4],
    ]);
    expect(events.at(-1)).toEqual({ id: 5, type: "import-done", moved: [], dropped: [], pending: 0, stopped: null });
  });

  it("names a catalogue kept outside the folder as external", async () => {
    const d = deps({ workingDir: "C:\\Users\\a\\external-catalogs\\shoot-3fa2" });
    const events = await run(d);
    expect(events[0]).toMatchObject({ type: "import-plan", workingDir: "C:\\Users\\a\\external-catalogs\\shoot-3fa2", location: "external", created: false });
  });

  it("reads the camera data of each pending photo in scope, and says how many are still pending", async () => {
    const pending = { metadataPending: true as const, mimeType: "image/x-nikon-nef" };
    const d = deps({
      known: [photo("old.NEF", pending), photo("Day 3/far.NEF", pending)],
      files: [
        { relPath: "Day 2/b.NEF", built: pending },
        { relPath: "Day 2/c.jpg", built: {} },
      ],
    });
    const events = await run(d, request({ kind: "some", files: ["old.NEF"], folders: [{ relPath: "Day 2", recursive: false }] }));

    const read = vi.mocked(d.deps.readPendingMetadata).mock.calls.flatMap(([photos]) => photos.map((p) => p.relPath));
    expect(read).toEqual(["old.NEF", "Day 2/b.NEF"]);
    expect(events.filter((e) => e.type === "progress" && e.phase === "camera-data").map((e) => e.type === "progress" && [e.done, e.total])).toEqual([
      [0, 2],
      [1, 2],
      [2, 2],
    ]);
    expect(events.at(-1)).toMatchObject({ type: "import-done", pending: 0, stopped: null });
  });

  it("leaves the camera data to read when asked not to read it, and counts it", async () => {
    const d = deps({ files: [{ relPath: "b.NEF", built: { metadataPending: true } }] });
    const events = await run(d, request({ kind: "all" }, false));
    expect(d.deps.readPendingMetadata).not.toHaveBeenCalled();
    expect(d.deps.repairMissingPreviews).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: "import-done", pending: 1 });
  });

  it("saves, closes and gives the lock back before it says it is done, and leaves no catalogue loaded", async () => {
    const d = deps({ files: [{ relPath: "a.jpg", built: {} }] });
    const { out, events } = recordingOut();
    const running = runImport(request(), out, new AbortController().signal, d.deps);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(d.order).toEqual(["flush", "flush", "close"]);
    expect(events().some((e) => e.type === "import-done")).toBe(false);
    d.release();
    await running;
    expect(d.order).toEqual(["flush", "flush", "close", "released"]);
    expect(events().at(-1)?.type).toBe("import-done");
    expect(useCatalogStore.getState().photos).toEqual([]);
    expect(catalogStorage()).not.toBe(d.storage);
  });

  it("reports moved photos, and dropped ones with whether they had edits", async () => {
    const d = deps({
      savedEdits: [edit("gone-1", 2), edit("gone-2", 0)],
      moved: [{ id: "m", from: "IMG_9.ARW", to: "Day 1/IMG_9.ARW" }],
      dropped: [
        { id: "gone-1", relPath: "DSC_0101.NEF" },
        { id: "gone-2", relPath: "DSC_0102.NEF" },
      ],
    });
    const events = await run(d);
    expect(events.at(-1)).toEqual({
      id: 5,
      type: "import-done",
      moved: [{ id: "m", from: "IMG_9.ARW", to: "Day 1/IMG_9.ARW" }],
      dropped: [
        { id: "gone-1", relPath: "DSC_0101.NEF", edited: true },
        { id: "gone-2", relPath: "DSC_0102.NEF", edited: false },
      ],
      pending: 0,
      stopped: null,
    });
  });

  it("stops at a cancel: the files in flight land, the passes don't run, and it still saves and lets go", async () => {
    const stop = new AbortController();
    const d = deps({
      files: [
        { relPath: "a.NEF", built: { metadataPending: true } },
        { relPath: "b.NEF", built: { metadataPending: true } },
      ],
      beforeFile: (relPath) => {
        if (relPath === "b.NEF") stop.abort();
      },
    });
    const events = await run(d, request(), stop.signal);
    expect(events.filter((e) => e.type === "import-file").map((e) => e.type === "import-file" && e.relPath)).toEqual(["a.NEF"]);
    expect(d.deps.readPendingMetadata).not.toHaveBeenCalled();
    expect(d.order).toEqual(["flush", "close", "released"]);
    expect(events.at(-1)).toMatchObject({ type: "import-done", pending: 1, stopped: "interrupted" });
  });

  it("stops when Safelight takes the lock over during the walk", async () => {
    const d = deps({ fails: new LockLostError() });
    const events = await run(d);
    expect(events.at(-1)).toEqual({ id: 5, type: "import-done", moved: [], dropped: [], pending: 0, stopped: "safelight-opened" });
    expect(useCatalogStore.getState().photos).toEqual([]);
  });

  it("stops when Safelight takes the lock over before a save", async () => {
    const d = deps({ files: [{ relPath: "a.jpg", built: {} }] });
    d.storage.flush.mockRejectedValueOnce(new LockLostError());
    const events = await run(d);
    expect(d.deps.readPendingMetadata).not.toHaveBeenCalled();
    expect(d.storage.close).toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: "import-done", stopped: "safelight-opened" });
  });

  it("fails as locked, naming the holder, when the project is held", async () => {
    const heldBy = { app: "safelight" as const, pid: 9, host: "h", since: 1, refreshedAt: 1 };
    const d = deps({ fails: new ProjectLockedError(heldBy) });
    await expect(run(d)).rejects.toMatchObject({ code: "locked", heldBy });
  });

  it("fails as a project error when the folder can't be opened", async () => {
    const d = deps({ fails: new Error("EACCES") });
    await expect(run(d)).rejects.toMatchObject({ code: "project", message: expect.stringContaining("EACCES") });
  });
});
