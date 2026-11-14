// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What a catalogue save costs: one that follows a single change writes the text
// of that record anew, not the whole catalogue, and tombstones another window
// sends are checked against the photos held without copying them per file.

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
import { broadcast, onBroadcast } from "@/state/broadcast";

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

const onDisk = () =>
  JSON.parse(fs.text(`${SL}/catalog.json`) ?? "{}") as { photos: CatalogPhoto[]; removed?: string[] };

async function openProject(names = ["a.jpg", "b.jpg", "c.jpg"]): Promise<OpenedProject> {
  fs = new MemoryFs(ROOT);
  for (const name of names) fs.put(`${ROOT}/${name}`, name);
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

/** The catalogue key the storage's messages name. */
async function catalogOf(storage: ProjectStorage, photo: CatalogPhoto): Promise<string> {
  let key = "";
  const stop = onBroadcast((message) => {
    if (message.type === "catalog-records") key = message.payload.catalog;
  });
  await storage.putPhoto({ ...photo, keywords: ["probe"] });
  stop();
  return key;
}

/** Whether JSON.stringify was handed the whole catalogue as one value. */
const wholeCatalogue = (value: unknown): boolean =>
  typeof value === "object" && value !== null && "photos" in value;

const edit = (photoId: string, label: string): EditState => ({
  photoId,
  stack: [{ timestamp: 1, label, params: {} as EditState["stack"][0]["params"] }],
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
  vi.unstubAllGlobals();
});

describe("a catalogue save after one change", () => {
  it("writes the changed record anew and no other, nor the catalogue as one value", async () => {
    const { storage, photos } = await openProject();
    const stringify = vi.spyOn(JSON, "stringify");

    await storage.putPhoto({ ...photos[0], rating: 4 });
    await storage.flush();

    const values = stringify.mock.calls.map(([value]) => value as Record<string, unknown> | null);
    const records = values.filter((value) => typeof value?.relPath === "string");
    expect(values.filter(wholeCatalogue)).toEqual([]);
    expect(new Set(records.map((value) => value?.id))).toEqual(new Set([photos[0].id]));
    stringify.mockRestore();
    expect(onDisk().photos.find((p) => p.id === photos[0].id)?.rating).toBe(4);
    expect(onDisk().photos.map((p) => p.id)).toEqual(photos.map((p) => p.id));
  });

  it("after an edit writes the history it holds, and no photo record", async () => {
    const { storage, photos } = await openProject();
    const stringify = vi.spyOn(JSON, "stringify");

    await storage.putEditState(edit(photos[1].id, "Warmer"));

    const values = stringify.mock.calls.map(([value]) => value as Record<string, unknown> | null);
    expect(values.filter((value) => typeof value?.relPath === "string" || wholeCatalogue(value))).toEqual([]);
    stringify.mockRestore();
    const saved = JSON.parse(fs.text(`${SL}/catalog.json`) ?? "{}") as { edits: EditState[] };
    expect(saved.edits.map((e) => e.stack[0].label)).toEqual(["Warmer"]);
  });

  it("writes a history step changed in place and handed back, as an extension may", async () => {
    const { storage, photos } = await openProject();
    const state = edit(photos[1].id, "Warmer");
    await storage.putEditState(state);
    await storage.flush();

    state.stack[0].label = "Cooler";
    await storage.putEditState(state);
    await storage.flush();

    const saved = JSON.parse(fs.text(`${SL}/catalog.json`) ?? "{}") as { edits: EditState[] };
    expect(saved.edits.map((e) => e.stack[0].label)).toEqual(["Cooler"]);
  });
});

describe("tombstones another window sends", () => {
  it("are checked against the photos held once per message, not once per file", async () => {
    const { storage, photos } = await openProject();
    const catalog = await catalogOf(storage, photos[0]);
    const gone = Array.from({ length: 50 }, (_, i) => `gone-${i}.jpg`);
    const values = vi.spyOn(Map.prototype, "values");

    broadcast({
      type: "catalog-records",
      payload: {
        catalog,
        origin: "other-window:1",
        since: Date.now(),
        photos: [],
        edits: [],
        deletedIds: [],
        removed: [...gone, "a.jpg"],
      },
    });

    expect(values.mock.calls.length).toBeLessThan(10);
    values.mockRestore();
    await storage.flush();
    expect(onDisk().removed).toEqual(gone);
  });
});
