// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What `slu import` asks of ProjectStorage.open (storage-options): an import of
// only the files it names, a writer that stops once the app takes its lock over,
// a backup kept outside the main window, the photos the walk found moved or gone,
// and previews no record names cleared away. The real storage over the desktop fs
// bridge, on temp folders.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPhoto, EditState } from "@/catalog/types";
import type { NativeFsBridge } from "@/extensions/types";
import { photo as photoRecord } from "@/catalog/stored-edit.fixtures";
import { createFsBridge } from "../../electron/fs-bridge.cjs";

const h = vi.hoisted(() => ({
  fs: null as NativeFsBridge | null,
  /** Runs as each file's import starts, by file name. */
  beforeImport: null as ((name: string) => Promise<void> | void) | null,
  built: 0,
}));

vi.mock("@/native/privileged", () => ({ privilegedFs: () => h.fs }));
vi.mock("@/state/settings-store", () => ({
  getSettings: () => ({
    persistPreviews: true,
    thumbMaxEdge: 768,
    catalogLocation: "in-folder",
    externalCatalogDir: "",
  }),
}));

import { ProjectStorage, type OpenedProject, type ProjectStorageDeps } from "./project-storage";
import { LockLostError, type StorageOpenOptions } from "./storage-options";
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
let workingDir: string;
const storages: ProjectStorage[] = [];

const writer = {
  write: async (file: string, data: Uint8Array) => {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, data);
  },
};

const deps: ProjectStorageDeps = {
  isSupportedName: (name) => /\.jpe?g$/i.test(name),
  importPhoto: async (fileHandle, directoryHandle) => {
    const file = await fileHandle.getFile();
    await h.beforeImport?.(file.name);
    return {
      ...photoRecord(`p${++h.built}:${file.name}`),
      filename: file.name,
      fileHandle,
      directoryHandle,
      fileSize: file.size,
      dateCreated: file.lastModified,
      thumbnailBlob: new Blob([`thumb:${file.name}`]),
    };
  },
  buildPreviewBlob: async () => null,
  persistPreviews: () => true,
  emitPhotoImport: async () => null,
};

const SLU_LOCK = { owner: "slu", whenHeld: "fail", waitMs: 0 } as const;

function put(rel: string, body = rel): void {
  const file = path.join(project, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

const catalogFile = () => path.join(workingDir, "catalog.json");
const saved = () =>
  JSON.parse(fs.readFileSync(catalogFile(), "utf8")) as { photos: CatalogPhoto[]; removed?: string[] };
const rels = (photos: CatalogPhoto[]) => photos.map((p) => p.relPath);
const at = (photos: CatalogPhoto[], rel: string) => photos.find((p) => p.relPath === rel)!;

const edit = (photoId: string): EditState => ({
  photoId,
  stack: [{ timestamp: 1, label: "Exposure", params: {} as EditState["stack"][0]["params"] }],
  currentIndex: 0,
});

async function open(
  options: StorageOpenOptions = {},
  extra: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {},
): Promise<OpenedProject> {
  const opened = await ProjectStorage.open(
    nativeDirectoryHandle(project),
    deps,
    undefined,
    undefined,
    extra.onProgress,
    extra.signal,
    options,
  );
  storages.push(opened.storage);
  return opened;
}

/** Open, save and let go, as a run of `slu` does before the next. */
async function openAndSave(options: StorageOpenOptions = {}): Promise<OpenedProject> {
  const opened = await open(options);
  await opened.storage.flush();
  await closeAll();
  return opened;
}

async function closeAll() {
  for (const storage of storages.splice(0)) {
    storage.close();
    await storage.released();
  }
}

beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "safelight-import-"));
  project = path.join(temp, "shoot");
  workingDir = path.join(project, ".safelight");
  fs.mkdirSync(project, { recursive: true });
  h.beforeImport = null;
  h.built = 0;
  h.fs = {
    ...createFsBridge({ userData: path.join(temp, "userData"), writer }),
    pickDirectory: async () => null,
    reveal: async () => false,
  };
  vi.stubGlobal("BroadcastChannel", FakeChannel);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  await closeAll();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fs.rmSync(temp, { recursive: true, force: true });
});

describe("an import of only some files (importOnly)", () => {
  it("imports the files it names, and leaves the others for a later open", async () => {
    put("a.jpg");
    put("b.jpg");
    const progress: [number, number][] = [];

    const first = await open(
      { importOnly: { files: ["a.jpg"], folders: [] } },
      { onProgress: (done, total) => progress.push([done, total]) },
    );
    await first.storage.flush();
    await closeAll();

    expect(rels(first.photos)).toEqual(["a.jpg"]);
    expect(rels(first.newPhotos)).toEqual(["a.jpg"]);
    expect(progress).toEqual([
      [0, 1],
      [1, 1],
    ]);
    expect(rels(saved().photos)).toEqual(["a.jpg"]);

    const second = await open();

    expect(rels(second.newPhotos)).toEqual(["b.jpg"]);
    expect(at(second.photos, "a.jpg").id).toBe(first.photos[0].id);
  });

  it("imports the new files of a folder it names, and those under it when recursive", async () => {
    for (const rel of ["top.jpg", "Day2/a.jpg", "Day2/Drone/b.jpg", "Day3/c.jpg"]) put(rel);

    const direct = await openAndSave({
      importOnly: { files: [], folders: [{ relPath: "Day2", recursive: false }] },
    });
    expect(rels(direct.newPhotos)).toEqual(["Day2/a.jpg"]);

    const deep = await openAndSave({
      importOnly: { files: [], folders: [{ relPath: "Day2", recursive: true }] },
    });
    expect(rels(deep.newPhotos)).toEqual(["Day2/Drone/b.jpg"]);
  });

  it("takes back a file removed from the catalogue when it names it", async () => {
    put("a.jpg");
    put("b.jpg");
    const first = await open();
    await first.storage.deletePhoto(at(first.photos, "a.jpg").id);
    await first.storage.flush();
    await closeAll();
    expect(saved().removed).toEqual(["a.jpg"]);

    const back = await openAndSave({ importOnly: { files: ["a.jpg"], folders: [] } });

    expect(rels(back.newPhotos)).toEqual(["a.jpg"]);
    expect(saved().removed).toEqual([]);
    expect(rels(saved().photos).sort()).toEqual(["a.jpg", "b.jpg"]);
  });

  it("follows a moved photo it names to its new path instead of importing it again", async () => {
    put("Old/x.jpg");
    const first = await openAndSave();
    fs.renameSync(path.join(project, "Old"), path.join(project, "New"));
    put("c.jpg");

    const moved = await openAndSave({ importOnly: { files: ["New/x.jpg"], folders: [] } });

    expect(moved.newPhotos).toEqual([]);
    expect(rels(moved.photos)).toEqual(["New/x.jpg"]);
    expect(moved.photos[0].id).toBe(first.photos[0].id);
    expect(rels(saved().photos)).toEqual(["New/x.jpg"]);
  });
});

describe("a writer that checks its lock before each write (verifyBeforeWrite)", () => {
  const lockFile = () => path.join(workingDir, "writer.lock");

  /** Another writer takes the lock over, as the app does after its wait. */
  function takeLockOver(): void {
    const held = JSON.parse(fs.readFileSync(lockFile(), "utf8")) as Record<string, unknown>;
    fs.writeFileSync(lockFile(), JSON.stringify({ ...held, app: "safelight", token: "the-app" }));
  }

  beforeEach(async () => {
    put("k.jpg");
    await openAndSave();
  });

  it("writes nothing once the lock is taken over during the walk, and the open rejects", async () => {
    put("a.jpg");
    put("b.jpg");
    let letB = () => {};
    const bMay = new Promise<void>((resolve) => (letB = resolve));
    const started: string[] = [];
    h.beforeImport = async (name) => {
      started.push(name);
      if (name === "b.jpg") await bMay;
    };
    const before = fs.readFileSync(catalogFile());

    const opening = open({ lock: { ...SLU_LOCK, verifyBeforeWrite: true } });
    const outcome = opening.then(
      () => null,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(started).toContain("b.jpg"));
    takeLockOver();
    // The walk's first save is due 800 ms after a.jpg was imported.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    letB();

    expect(await outcome).toBeInstanceOf(LockLostError);
    expect(fs.readFileSync(catalogFile()).equals(before)).toBe(true);
    expect(JSON.parse(fs.readFileSync(lockFile(), "utf8"))).toMatchObject({ token: "the-app" });
  });

  it("makes a flush reject once the lock is taken over after the open, writing nothing", async () => {
    const opened = await open({ lock: { ...SLU_LOCK, verifyBeforeWrite: true } });
    const before = fs.readFileSync(catalogFile());
    takeLockOver();

    await opened.storage.putPhoto({ ...opened.photos[0], rating: 4 });

    await expect(opened.storage.flush()).rejects.toBeInstanceOf(LockLostError);
    expect(fs.readFileSync(catalogFile()).equals(before)).toBe(true);
  });
});

describe("the backup kept outside the main window (keepBackup)", () => {
  const backupFile = () => path.join(workingDir, "catalog.bak.json");

  beforeEach(async () => {
    put("a.jpg");
    await openAndSave();
    vi.stubGlobal("location", { search: "?detached=engine" });
  });

  it("is written when asked for", async () => {
    const before = fs.readFileSync(catalogFile(), "utf8");
    const opened = await open({ lock: SLU_LOCK, keepBackup: true });

    await opened.storage.putPhoto({ ...opened.photos[0], rating: 4 });
    await opened.storage.flush();

    expect(fs.readFileSync(backupFile(), "utf8")).toBe(before);
  });

  it("isn't written by default", async () => {
    const opened = await open({ lock: SLU_LOCK });

    await opened.storage.putPhoto({ ...opened.photos[0], rating: 4 });
    await opened.storage.flush();

    expect(fs.existsSync(backupFile())).toBe(false);
  });
});

describe("what the walk reports", () => {
  it("names the photos it found moved and those whose file is gone", async () => {
    put("Old/x.jpg");
    put("gone.jpg");
    put("plain.jpg");
    const first = await open();
    const x = at(first.photos, "Old/x.jpg");
    const gone = at(first.photos, "gone.jpg");
    const plain = at(first.photos, "plain.jpg");
    await first.storage.putEditState(edit(gone.id));
    await first.storage.flush();
    await closeAll();
    fs.renameSync(path.join(project, "Old"), path.join(project, "New"));
    fs.rmSync(path.join(project, "gone.jpg"));
    fs.rmSync(path.join(project, "plain.jpg"));

    const opened = await open();

    expect(opened.moved).toEqual([{ id: x.id, from: "Old/x.jpg", to: "New/x.jpg" }]);
    expect(opened.dropped).toEqual(
      expect.arrayContaining([
        { id: gone.id, relPath: "gone.jpg" },
        { id: plain.id, relPath: "plain.jpg" },
      ]),
    );
    expect(opened.dropped).toHaveLength(2);
  });
});

describe("previews no record names", () => {
  const previews = () => path.join(workingDir, "previews");
  const orphan = () => path.join(previews(), "orphan.jpg");

  /** An orphan written `minutes` ago. */
  function orphanFrom(minutes: number): void {
    fs.writeFileSync(orphan(), "left by an import that was killed");
    const then = new Date(Date.now() - minutes * 60_000);
    fs.utimesSync(orphan(), then, then);
  }

  beforeEach(async () => {
    put("a.jpg");
    await openAndSave();
    orphanFrom(60);
  });

  it("are removed once a walk that holds the writer lock has finished", async () => {
    const opened = await open();

    expect(fs.existsSync(orphan())).toBe(false);
    expect(fs.existsSync(path.join(previews(), `${opened.photos[0].id}.jpg`))).toBe(true);
  });

  it("are kept while recent: another window's import may not have saved its record yet", async () => {
    orphanFrom(1);

    await open();

    expect(fs.existsSync(orphan())).toBe(true);
  });

  it("are kept by an open that holds no writer lock: a pop-out's", async () => {
    vi.stubGlobal("location", { search: "?detached=library" });

    await open();

    expect(fs.existsSync(orphan())).toBe(true);
  });

  it("are kept by a read-only open", async () => {
    await open({ readOnly: true });

    expect(fs.existsSync(orphan())).toBe(true);
  });

  it("are kept after a walk that was stopped", async () => {
    put("b.jpg");
    const stop = new AbortController();
    h.beforeImport = () => stop.abort();

    await open({}, { signal: stop.signal });

    expect(fs.existsSync(orphan())).toBe(true);
  });
});
