// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Opening a catalogue from its records alone, and opening it read-only, as `slu`
// does: the real ProjectStorage over the desktop fs bridge on temp folders.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EditState, StoredPhoto } from "@/catalog/types";
import type { NativeFsBridge } from "@/extensions/types";
import { createFsBridge } from "../../electron/fs-bridge.cjs";

const h = vi.hoisted(() => ({ fs: null as NativeFsBridge | null }));

vi.mock("@/native/privileged", () => ({ privilegedFs: () => h.fs }));
vi.mock("@/state/settings-store", () => ({
  getSettings: () => ({
    persistPreviews: true,
    thumbMaxEdge: 768,
    catalogLocation: "in-folder",
    externalCatalogDir: "",
  }),
}));

import { NoCatalogError, ProjectStorage, type ProjectStorageDeps } from "./project-storage";
import { nativeDirectoryHandle } from "./native-fs";

class FakeChannel {
  postMessage(message: unknown): void {
    structuredClone(message);
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}

let temp: string;
let project: string;
let userData: string;
const storages: ProjectStorage[] = [];

const writer = {
  write: async (file: string, data: Uint8Array) => {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, data);
  },
};

const deps = () =>
  ({
    isSupportedName: (name: string) => /\.jpe?g$/i.test(name),
    importPhoto: vi.fn(async () => null),
    buildPreviewBlob: vi.fn(async () => null),
    persistPreviews: () => true,
    emitPhotoImport: async () => null,
  }) satisfies ProjectStorageDeps;

const record = (id: string, relPath: string): StoredPhoto => ({
  id,
  filename: relPath,
  relPath,
  folder: "",
  width: 4000,
  height: 3000,
  fileSize: 1,
  mimeType: "image/jpeg",
  rating: 0,
  colorLabel: "none",
  flag: "none",
  rotation: 0,
  keywords: [],
  dateCreated: 1,
  dateImported: 2,
  exif: {},
});

const edit = (photoId: string, label: string): EditState => ({
  photoId,
  stack: [{ timestamp: 1, label, params: {} as EditState["stack"][0]["params"] }],
  currentIndex: 0,
});

/** A catalogue of a.jpg, b.jpg and c.jpg (whose file is gone), with an edit of
 *  each of the first two, in `slDir`; d.jpg is on disk and in no record. */
function seedProject(slDir: string): void {
  for (const name of ["a.jpg", "b.jpg", "d.jpg"]) fs.writeFileSync(path.join(project, name), "A");
  fs.mkdirSync(slDir, { recursive: true });
  const catalog = {
    version: 2,
    id: "cat-1",
    photos: [record("a", "a.jpg"), record("b", "b.jpg"), record("c", "c.jpg")],
    edits: [edit("a", "Exposure"), edit("c", "Contrast")],
    removed: [],
  };
  fs.writeFileSync(path.join(slDir, "catalog.json"), JSON.stringify(catalog));
}

/** Every file and folder under `dir`, with each file's bytes. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath, entry.name);
    out[path.relative(dir, full)] = entry.isDirectory()
      ? "<dir>"
      : fs.readFileSync(full).toString("base64");
  }
  return out;
}

async function open(d: ProjectStorageDeps, options: Parameters<typeof ProjectStorage.open>[6]) {
  const opened = await ProjectStorage.open(
    nativeDirectoryHandle(project),
    d,
    undefined,
    undefined,
    undefined,
    undefined,
    options,
  );
  storages.push(opened.storage);
  return opened;
}

beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "safelight-records-"));
  project = path.join(temp, "shoot");
  userData = path.join(temp, "userData");
  fs.mkdirSync(project);
  fs.mkdirSync(userData);
  h.fs = {
    ...createFsBridge({ userData, writer }),
    pickDirectory: async () => null,
    reveal: async () => false,
  };
  vi.stubGlobal("BroadcastChannel", FakeChannel);
});

afterEach(async () => {
  for (const storage of storages.splice(0)) {
    storage.close();
    await storage.released();
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fs.rmSync(temp, { recursive: true, force: true });
});

describe("a records-only open", () => {
  it("keeps every record and edit, and walks and imports nothing", async () => {
    seedProject(path.join(project, ".safelight"));
    const d = deps();

    const opened = await open(d, { recordsOnly: true });

    expect(opened.photos.map((p) => p.id)).toEqual(["a", "b", "c"]);
    expect((await opened.storage.getAllPhotos()).map((p) => p.id)).toEqual(["a", "b", "c"]);
    expect((await opened.storage.getEditState("c"))?.stack[0].label).toBe("Contrast");
    expect(opened.newPhotos).toEqual([]);
    expect(d.importPhoto).not.toHaveBeenCalled();
    expect(d.buildPreviewBlob).not.toHaveBeenCalled();
  });

  it("saves an edit through the same catalogue write", async () => {
    seedProject(path.join(project, ".safelight"));
    const opened = await open(deps(), { recordsOnly: true, lock: false });

    await opened.storage.putEditState(edit("b", "Saturation"));

    const saved = JSON.parse(
      fs.readFileSync(path.join(project, ".safelight", "catalog.json"), "utf8"),
    ) as { photos: StoredPhoto[]; edits: EditState[] };
    expect(saved.photos.map((p) => p.id)).toEqual(["a", "b", "c"]);
    expect(saved.edits.map((e) => e.photoId).sort()).toEqual(["a", "b", "c"]);
  });
});

describe("a read-only open", () => {
  it("refuses every write and leaves the tree as it was", async () => {
    seedProject(path.join(project, ".safelight"));
    const before = snapshot(temp);

    const opened = await open(deps(), { recordsOnly: true, readOnly: true });
    const { storage } = opened;

    expect(opened.photos).toHaveLength(3);
    await expect(storage.putEditState(edit("a", "Saturation"))).rejects.toThrow(/read-only/);
    await expect(storage.putEditStates([edit("a", "Saturation")])).rejects.toThrow(/read-only/);
    await expect(storage.putPhoto({ ...opened.photos[0], rating: 3 })).rejects.toThrow(/read-only/);
    await expect(storage.putPhotos([{ ...opened.photos[0], rating: 3 }])).rejects.toThrow(
      /read-only/,
    );
    await expect(storage.deletePhoto("a")).rejects.toThrow(/read-only/);
    await expect(storage.deletePhotos(["a"])).rejects.toThrow(/read-only/);
    await expect(storage.flush()).rejects.toThrow(/read-only/);
    storage.close();
    await storage.released();

    expect((await storage.getEditState("a"))?.stack[0].label).toBe("Exposure");
    expect(snapshot(temp)).toEqual(before);
  });

  it("reads a separate catalogue where the folder has none of its own", async () => {
    const separate = await h.fs!.externalCatalogDir!(project, null, true);
    seedProject(separate!);
    const before = snapshot(temp);

    const opened = await open(deps(), { recordsOnly: true, readOnly: true });

    expect(opened.storageLocation).toBe("external");
    expect(opened.externalPath).toBe(separate);
    expect(opened.photos.map((p) => p.id)).toEqual(["a", "b", "c"]);
    opened.storage.close();
    await opened.storage.released();
    expect(snapshot(temp)).toEqual(before);
  });

  it("reads a catalogue with a damaged entry without keeping a copy aside", async () => {
    const slDir = path.join(project, ".safelight");
    seedProject(slDir);
    const file = path.join(slDir, "catalog.json");
    const catalog = JSON.parse(fs.readFileSync(file, "utf8")) as { photos: unknown[] };
    catalog.photos.push({ id: 42 });
    fs.writeFileSync(file, JSON.stringify(catalog));
    const before = snapshot(temp);

    const opened = await open(deps(), { recordsOnly: true, readOnly: true });

    expect(opened.photos.map((p) => p.id)).toEqual(["a", "b", "c"]);
    opened.storage.close();
    await opened.storage.released();
    expect(snapshot(temp)).toEqual(before);
  });

  it("throws NoCatalogError for a folder with no catalogue, and makes none", async () => {
    fs.writeFileSync(path.join(project, "a.jpg"), "A");
    const before = snapshot(temp);

    await expect(open(deps(), { readOnly: true })).rejects.toBeInstanceOf(NoCatalogError);

    expect(snapshot(temp)).toEqual(before);
  });
});
