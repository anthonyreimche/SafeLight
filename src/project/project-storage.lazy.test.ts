// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Saves of data a pass can derive again (lazy puts) wait for the bulk delay; a
// normal put or an edit still saves on its own cadence and carries them along.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CatalogPhoto, EditState } from "@/catalog/types";
import type { WorkingDir } from "./working-dir";
import { MemoryFs, fsaDirectoryHandle } from "./memory-fs.test-support";

const h = vi.hoisted(() => ({ wd: null as WorkingDir | null }));

vi.mock("@/native/privileged", () => ({ privilegedFs: () => null }));
vi.mock("./working-dir", () => ({
  resolveWorkingDir: async () => {
    if (!h.wd) throw new Error("no working dir configured");
    return h.wd;
  },
}));
vi.mock("@/state/settings-store", () => ({
  getSettings: () => ({ persistPreviews: true, thumbMaxEdge: 768 }),
}));
vi.mock("@/extensions/registry", () => ({ emitPhotoImport: async () => null }));
vi.mock("@/modules/library/import-photos", () => ({
  isSupportedName: (name: string) => /\.jpe?g$/i.test(name),
  importPhoto: async (
    fileHandle: FileSystemFileHandle,
    directoryHandle: FileSystemDirectoryHandle | null,
  ): Promise<CatalogPhoto | null> => {
    const file = await fileHandle.getFile();
    return {
      id: `id:${file.name}`,
      filename: file.name,
      relPath: "",
      folder: "",
      directoryHandle,
      fileHandle,
      thumbnailBlob: new Blob([`thumb:${file.name}`]),
      thumbnailUrl: null,
      width: 4000,
      height: 3000,
      fileSize: file.size,
      mimeType: "image/jpeg",
      rating: 0,
      colorLabel: "none",
      flag: "none",
      rotation: 0,
      keywords: [],
      dateCreated: 1,
      dateImported: 2,
      exif: {},
    };
  },
  buildPreviewBlob: async () => null,
}));

import { ProjectStorage, type OpenedProject } from "./project-storage";
import { storageDeps } from "./storage-deps";
import { onBroadcast, type CatalogRecords } from "@/state/broadcast";

const ROOT = "/home/u/photos";
const SL = `${ROOT}/.safelight`;

class FakeChannel {
  postMessage(message: unknown): void {
    structuredClone(message);
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

let fs: MemoryFs;
const opened: ProjectStorage[] = [];

const writes = () => fs.writeCount(`${SL}/catalog.json`);
const onDisk = () =>
  JSON.parse(fs.text(`${SL}/catalog.json`) ?? "{}") as {
    photos: CatalogPhoto[];
    edits: EditState[];
  };

async function openProject(): Promise<OpenedProject> {
  fs = new MemoryFs(ROOT);
  fs.put(`${ROOT}/a.jpg`, "A");
  fs.put(`${ROOT}/b.jpg`, "B");
  h.wd = {
    sl: fsaDirectoryHandle(fs, SL),
    location: "in-folder",
    externalPath: null,
    promotedFromExternal: null,
  };
  const project = await ProjectStorage.open(fsaDirectoryHandle(fs, ROOT), storageDeps);
  opened.push(project.storage);
  await project.storage.flush();
  return project;
}

const edit = (photoId: string): EditState => ({
  photoId,
  stack: [{ timestamp: 1, label: "Edit", params: {} as EditState["stack"][0]["params"] }],
  currentIndex: 0,
});

beforeEach(() => {
  vi.stubGlobal("BroadcastChannel", FakeChannel);
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  for (const storage of opened.splice(0)) storage.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("lazy puts", () => {
  it("write nothing for 9 s of puts, then one catalogue write at the bulk delay", async () => {
    const { storage, photos } = await openProject();
    const before = writes();

    for (let i = 1; i <= 5; i++) {
      await storage.putPhoto({ ...photos[0], width: 100 + i }, { lazy: true });
      await vi.advanceTimersByTimeAsync(1800);
    }
    expect(writes() - before).toBe(0);

    await vi.advanceTimersByTimeAsync(1000);
    expect(writes() - before).toBe(1);
    expect(onDisk().photos.find((p) => p.id === photos[0].id)?.width).toBe(105);
  });

  it("let a normal put save on the normal cadence, carrying the lazy changes", async () => {
    const { storage, photos } = await openProject();
    const before = writes();

    await storage.putPhoto({ ...photos[0], width: 111 }, { lazy: true });
    await vi.advanceTimersByTimeAsync(3000);
    expect(writes() - before).toBe(0);
    await storage.putPhoto({ ...photos[1], rating: 4 });
    await vi.advanceTimersByTimeAsync(800);

    expect(writes() - before).toBe(1);
    const saved = onDisk().photos;
    expect(saved.find((p) => p.id === photos[0].id)?.width).toBe(111);
    expect(saved.find((p) => p.id === photos[1].id)?.rating).toBe(4);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(writes() - before).toBe(1);
  });

  it("never push back a normal save already armed", async () => {
    const { storage, photos } = await openProject();
    const before = writes();

    await storage.putPhoto({ ...photos[1], rating: 4 });
    await storage.putPhoto({ ...photos[0], width: 111 }, { lazy: true });
    await vi.advanceTimersByTimeAsync(800);

    expect(writes() - before).toBe(1);
    expect(onDisk().photos.find((p) => p.id === photos[0].id)?.width).toBe(111);
  });

  it("leave an edit state saving at once, with the lazy changes in the write", async () => {
    const { storage, photos } = await openProject();
    const before = writes();

    await storage.putPhoto({ ...photos[0], width: 111 }, { lazy: true });
    await storage.putEditState(edit(photos[1].id));

    expect(writes() - before).toBe(1);
    expect(onDisk().edits).toHaveLength(1);
    expect(onDisk().photos.find((p) => p.id === photos[0].id)?.width).toBe(111);
  });

  it.each([
    ["flush()", (s: ProjectStorage) => s.flush()],
    ["flush({ unloading })", (s: ProjectStorage) => s.flush({ unloading: true })],
    ["close()", async (s: ProjectStorage) => s.close()],
  ])("are written by %s", async (_label, leave) => {
    const { storage, photos } = await openProject();
    const before = writes();
    await storage.putPhoto({ ...photos[0], width: 111 }, { lazy: true });
    expect(writes() - before).toBe(0);

    await leave(storage);
    await vi.advanceTimersByTimeAsync(0);

    expect(writes() - before).toBe(1);
    expect(onDisk().photos.find((p) => p.id === photos[0].id)?.width).toBe(111);
  });

  it("still tell the other windows at once", async () => {
    const { storage, photos } = await openProject();
    const sent: CatalogRecords[] = [];
    const stop = onBroadcast((message) => {
      if (message.type === "catalog-records") sent.push(message.payload);
    });

    await storage.putPhoto({ ...photos[0], width: 111 }, { lazy: true });

    expect(sent).toHaveLength(1);
    expect(sent[0].photos?.[0]).toMatchObject({ id: photos[0].id, width: 111 });
    stop();
  });
});

describe("the edited preview landing", () => {
  it("doesn't write the catalogue within the normal window", async () => {
    const { storage, photos } = await openProject();
    let land = (): void => {};
    const landed = new Promise<void>((resolve) => (land = resolve));
    const write = fs.write.bind(fs);
    vi.spyOn(fs, "write").mockImplementation(async (path, data) => {
      if (/[\\/]previews[\\/]/.test(path)) await landed;
      return write(path, data);
    });
    const before = writes();

    const put = storage.putPhoto({
      ...photos[0],
      thumbnailBlob: new Blob(["edited"]),
      previewEdit: "edit-1",
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(writes() - before).toBe(1);

    land();
    await put;
    await vi.advanceTimersByTimeAsync(2600);
    expect(writes() - before).toBe(1);

    await storage.flush();
    expect(writes() - before).toBe(2);
    expect(onDisk().photos.find((p) => p.id === photos[0].id)?.previewEdit).toBe("edit-1");
  });
});
