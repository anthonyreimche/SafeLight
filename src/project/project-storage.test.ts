// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CatalogPhoto, EditState } from "@/catalog/types";
import type { NativeFsBridge } from "@/extensions/types";
import type { WorkingDir } from "./working-dir";
import { FsError, MemoryFs, fsaDirectoryHandle } from "./memory-fs.test-support";

const h = vi.hoisted(() => ({
  fs: null as NativeFsBridge | null,
  wd: null as WorkingDir | null,
  persistPreviews: true,
  /** Overrides an extension contributes on import, or null for none. */
  importOverride: null as Partial<CatalogPhoto> | null,
  /** Bumped per buildPhoto call so a re-imported file gets a NEW id — which is
   *  how the tests tell "reused the saved record" from "decoded it again". */
  built: 0,
  /** While set, a preview built from a source file waits for it. */
  buildGate: null as Promise<void> | null,
}));

vi.mock("@/native/privileged", () => ({ privilegedFs: () => h.fs }));

vi.mock("./working-dir", () => ({
  resolveWorkingDir: async () => {
    if (!h.wd) throw new Error("no working dir configured");
    return h.wd;
  },
}));

vi.mock("@/state/settings-store", () => ({
  getSettings: () => ({ persistPreviews: h.persistPreviews, thumbMaxEdge: 768 }),
}));

vi.mock("@/extensions/registry", () => ({
  emitPhotoImport: async () => h.importOverride,
}));

vi.mock("@/modules/library/import-photos", () => ({
  isSupportedName: (name: string) => /\.(jpe?g|png|tiff?|nef|cr2|dng)$/i.test(name),
  buildPhoto: async (
    file: File,
    directoryHandle: FileSystemDirectoryHandle | null,
    fileHandle: FileSystemFileHandle | null,
  ): Promise<CatalogPhoto | null> => ({
    id: `p${++h.built}:${file.name}`,
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
  }),
  buildPreviewBlob: async (photo: CatalogPhoto) => {
    if (h.buildGate) await h.buildGate;
    return photo.fileHandle ? new Blob([`rebuilt:${photo.filename}`]) : null;
  },
}));

import {
  ProjectStorage,
  catalogKey,
  flushLeftCopies,
  onRemoteRecords,
  onSaveStatus,
  type OpenedProject,
  type SaveStatus,
} from "./project-storage";
import { nativeDirectoryHandle } from "./native-fs";
import { setCatalogStorage, type CatalogStorage } from "@/catalog/storage";
import { photo as photoRecord } from "@/catalog/stored-edit.fixtures";
import { onBroadcast, type CatalogRecords } from "@/state/broadcast";
import { CatalogDamagedError, CatalogTooNewError, CatalogUnreadableError } from "./catalog-errors";

/** A MemoryFs whose reads or writes of chosen files fail with an errno, as they
 *  do while a sync or antivirus program holds the file (EBUSY, EPERM). */
class FlakyFs extends MemoryFs {
  private failingReads: { path: RegExp; code: string; left: number } | null = null;
  private failingWrites: { path: RegExp; code: string; left: number } | null = null;

  /** Fail the next `times` reads of a path matching `path`. */
  failReads(path: RegExp, code: string, times = Infinity): void {
    this.failingReads = { path, code, left: times };
  }

  /** Fail the next `times` writes to a path matching `path` (every one by default). */
  failWrites(path: RegExp, code: string, times = Infinity): void {
    this.failingWrites = { path, code, left: times };
  }

  /** Let writes land again (the program holding the file let go). */
  stopFailingWrites(): void {
    this.failingWrites = null;
  }

  override async read(path: string): Promise<{ data: Uint8Array; mtimeMs: number; size: number }> {
    const failing = this.failingReads;
    if (failing && failing.left > 0 && failing.path.test(path)) {
      failing.left--;
      throw new FsError(failing.code, "open", path);
    }
    return super.read(path);
  }

  override async write(path: string, data: Uint8Array): Promise<void> {
    const failing = this.failingWrites;
    if (failing && failing.left > 0 && failing.path.test(path)) {
      failing.left--;
      throw new FsError(failing.code, "open", path);
    }
    return super.write(path, data);
  }
}

/** Stands in for the BroadcastChannel between windows. The storages a test opens
 *  share one window, so broadcast's same-window fan-out carries messages between
 *  them; posting only proves a message survives the copy a real channel makes. */
class FakeChannel {
  static current: FakeChannel | null = null;
  readonly listeners = new Set<unknown>();
  constructor() {
    FakeChannel.current = this;
  }
  postMessage(message: unknown): void {
    structuredClone(message);
  }
  addEventListener(_type: string, listener: unknown): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: string, listener: unknown): void {
    this.listeners.delete(listener);
  }
  /** How many subscriptions the window holds on the channel. */
  static listening(): number {
    return FakeChannel.current?.listeners.size ?? 0;
  }
}

// The catalog is adapter-agnostic — it derives everything from the one working-
// dir handle — so both builds must produce byte-identical catalogs.
const BUILDS = [
  { label: "electron · windows", rootPath: "D:\\DCIM", native: true },
  { label: "browser · FSA", rootPath: "/home/u/photos", native: false },
] as const;

interface Project {
  fs: FlakyFs;
  rootPath: string;
  slPath: string;
  root: FileSystemDirectoryHandle;
}

/** Mount a project folder holding `files` (relPath → contents) and point the
 *  working dir at `slPath` (default: the in-folder .safelight). */
function mount(
  cfg: { rootPath: string; native: boolean },
  files: Record<string, string> = {},
  slPath?: string,
): Project {
  const fs = new FlakyFs(cfg.rootPath);
  for (const [rel, body] of Object.entries(files)) fs.put(`${cfg.rootPath}/${rel}`, body);
  h.fs = cfg.native ? fs : null;
  const dir = (p: string) =>
    cfg.native ? nativeDirectoryHandle(p) : fsaDirectoryHandle(fs, p);
  const sl = slPath ?? `${cfg.rootPath}/.safelight`;
  h.wd = {
    sl: dir(sl),
    location: slPath ? "external" : "in-folder",
    externalPath: slPath ?? null,
    promotedFromExternal: null,
  };
  return { fs, rootPath: cfg.rootPath, slPath: sl, root: dir(cfg.rootPath) };
}

/** MemoryFs keys entries with forward slashes whatever shape went in. */
const key = (p: string) => p.replace(/\\/g, "/");

interface StoredCatalog {
  version: number;
  id?: string;
  photos: CatalogPhoto[];
  edits: EditState[];
  removed?: string[];
}

function catalog(p: Project): StoredCatalog | null {
  const raw = p.fs.text(`${p.slPath}/catalog.json`);
  return raw === null ? null : (JSON.parse(raw) as StoredCatalog);
}

/** How many times the app has written catalog.json. */
const catalogWrites = (p: Project) => p.fs.writeCount(`${p.slPath}/catalog.json`);

/** The catalog.json writes `fs` is asked for from now on, landed or failed. */
function catalogWriteAttempts(fs: FlakyFs): () => number {
  const write = vi.spyOn(fs, "write");
  return () => write.mock.calls.filter(([path]) => /[\\/]catalog\.json$/.test(path)).length;
}

const catalogText = (p: Project) => p.fs.text(`${p.slPath}/catalog.json`);
const backupText = (p: Project) => p.fs.text(`${p.slPath}/catalog.bak.json`);

/** The names of the damaged catalogs and backups kept beside catalog.json, and
 *  what each holds. */
function keptCopies(p: Project): { name: string; text: string | null }[] {
  return p.fs
    .tree(p.slPath)
    .map((path) => path.slice(path.lastIndexOf("/") + 1))
    .filter((name) => /^catalog(\.bak)?\.corrupt-/.test(name))
    .map((name) => ({ name, text: p.fs.text(`${p.slPath}/${name}`) }));
}

/** Each photo's first history label as catalog.json holds it. */
const labelsOnDisk = (p: Project) =>
  Object.fromEntries((catalog(p)?.edits ?? []).map((e) => [e.photoId, e.stack[0].label]));

const ids = (photos: CatalogPhoto[]) => photos.map((x) => x.id);
const rels = (photos: CatalogPhoto[]) => photos.map((x) => x.relPath);

const edit = (photoId: string, label: string): EditState => ({
  photoId,
  stack: [{ timestamp: 1, label, params: {} as EditState["stack"][0]["params"] }],
  currentIndex: 0,
});

/** Every catalog a test opened. Each follows the other windows' writes until it
 *  is closed, so a test's storages are closed before the next test writes. */
const openCatalogs: CatalogStorage[] = [];

async function open(
  p: Project,
  opts: {
    onPhoto?: (photo: CatalogPhoto) => void;
    onSkeletons?: (
      storage: ProjectStorage,
      rawCacheDir: FileSystemDirectoryHandle,
      skeletons: CatalogPhoto[],
    ) => void;
    onProgress?: (done: number, total: number) => void;
    signal?: AbortSignal;
  } = {},
): Promise<OpenedProject> {
  const opened = await ProjectStorage.open(
    p.root,
    opts.onPhoto,
    opts.onSkeletons,
    opts.onProgress,
    opts.signal,
  );
  openCatalogs.push(opened.storage);
  return opened;
}

beforeEach(() => {
  h.fs = null;
  h.wd = null;
  h.persistPreviews = true;
  h.importOverride = null;
  h.built = 0;
  h.buildGate = null;
  vi.stubGlobal("BroadcastChannel", FakeChannel);
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const storage of openCatalogs.splice(0)) storage.close?.();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.each(BUILDS)("ProjectStorage ($label)", (cfg) => {
  const THREE = {
    "a.jpg": "A",
    "trip/b.NEF": "B",
    "trip/day2/c.png": "C",
    "notes.txt": "not an image",
    ".hidden/d.jpg": "skipped",
  };

  it("imports every supported file, ignoring other extensions and dot-folders", async () => {
    const p = mount(cfg, THREE);

    const opened = await open(p);

    expect(rels(opened.photos)).toEqual(["a.jpg", "trip/b.NEF", "trip/day2/c.png"]);
    expect(opened.photos.map((x) => x.folder)).toEqual(["", "trip", "trip/day2"]);
    expect(ids(opened.newPhotos)).toEqual(ids(opened.photos));
    expect(opened.tree.children.map((c) => c.path)).toEqual(["trip"]);
  });

  it("saves a catalog that carries no handles, blobs or object URLs", async () => {
    const p = mount(cfg, THREE);
    const opened = await open(p);

    await opened.storage.flush();

    const saved = catalog(p)!;
    expect(saved.version).toBe(1);
    expect(rels(saved.photos)).toEqual(["a.jpg", "trip/b.NEF", "trip/day2/c.png"]);
    for (const rec of saved.photos)
      for (const dropped of [
        "directoryHandle",
        "fileHandle",
        "thumbnailBlob",
        "thumbnailUrl",
      ])
        expect(rec).not.toHaveProperty(dropped);
  });

  it("reopens from the saved catalog instead of re-importing", async () => {
    const p = mount(cfg, THREE);
    const first = await open(p);
    await first.storage.flush();

    const second = await open(p);

    expect(ids(second.photos)).toEqual(ids(first.photos)); // stable ids ⇒ records reused
    expect(second.newPhotos).toEqual([]);
    // Live handles are re-attached, so the files are readable again.
    for (const photo of second.photos) expect(photo.fileHandle).not.toBeNull();
    expect(await (await second.photos[0].fileHandle!.getFile()).text()).toBe("A");
  });

  it("imports only files that appeared since the last open", async () => {
    const p = mount(cfg, THREE);
    const first = await open(p);
    await first.storage.flush();
    p.fs.put(`${p.rootPath}/trip/new.jpg`, "N");

    const second = await open(p);

    expect(rels(second.newPhotos)).toEqual(["trip/new.jpg"]);
    expect(rels(second.photos)).toHaveLength(4);
    expect(ids(second.photos).filter((id) => ids(first.photos).includes(id))).toHaveLength(3);
  });

  it("drops records whose file left the folder, and their edit history with them", async () => {
    const p = mount(cfg, THREE);
    const first = await open(p);
    await first.storage.putEditState(edit(first.photos[1].id, "Exposure"));
    await first.storage.flush();

    await p.fs.remove(`${p.rootPath}/trip/b.NEF`);
    const second = await open(p);
    await second.storage.flush();

    expect(rels(second.photos)).toEqual(["a.jpg", "trip/day2/c.png"]);
    expect(catalog(p)!.edits).toEqual([]);
    await expect(second.storage.getEditState(first.photos[1].id)).resolves.toBeUndefined();
  });

  it("persists a develop edit immediately, without waiting for the debounce", async () => {
    // A commit made just before quitting must survive: the beforeunload flush can
    // be cut short, so edits can't ride the 800 ms save timer.
    const p = mount(cfg, THREE);
    const opened = await open(p);

    await opened.storage.putEditState(edit(opened.photos[0].id, "Contrast"));

    expect(catalog(p)!.edits).toEqual([edit(opened.photos[0].id, "Contrast")]);
  });

  it("saves a batch of edit states as one catalog write, without the debounce", async () => {
    // A bulk Library action stores one history per photo. A write each would
    // re-serialise the whole catalog once per photo.
    const p = mount(cfg, THREE);
    const opened = await open(p);
    await opened.storage.flush(); // the file exists from here, so a save is one write
    const before = catalogWrites(p);
    const states = opened.photos.map((photo) => edit(photo.id, "Exposure"));

    await opened.storage.putEditStates(states);

    expect(catalogWrites(p) - before).toBe(1);
    expect(catalog(p)!.edits).toEqual(states);
    await expect(opened.storage.getAllEditStates()).resolves.toEqual(states);
  });

  it("replaces a photo's history in a batch and leaves the other histories alone", async () => {
    const p = mount(cfg, THREE);
    const opened = await open(p);
    const [a, b, c] = opened.photos;
    await opened.storage.putEditState(edit(a.id, "Old"));
    await opened.storage.putEditState(edit(c.id, "Kept"));

    await opened.storage.putEditStates([edit(a.id, "New"), edit(b.id, "Fresh")]);

    const labels = Object.fromEntries(catalog(p)!.edits.map((e) => [e.photoId, e.stack[0].label]));
    expect(labels).toEqual({ [a.id]: "New", [b.id]: "Fresh", [c.id]: "Kept" });
  });

  it("writes nothing for an empty batch", async () => {
    const p = mount(cfg, THREE);
    const opened = await open(p);
    await opened.storage.flush();
    const before = catalogWrites(p);

    await opened.storage.putEditStates([]);

    expect(catalogWrites(p)).toBe(before);
  });

  it("flushes a debounced change without an explicit flush once the timer fires", async () => {
    const p = mount(cfg, THREE);
    const opened = await open(p);
    await opened.storage.putPhoto({ ...opened.photos[0], rating: 5 });
    expect(catalog(p)).toBeNull();

    await vi.advanceTimersByTimeAsync(1000);

    expect(catalog(p)!.photos[0].rating).toBe(5);
  });
});

describe("catalog recovery", () => {
  const cfg = BUILDS[1];

  it.each([
    ["truncated mid-write", '{"version":1,"photos":[{"id":"p1:a.jpg"'],
    ["not JSON at all", "\0\0\0\0"],
    ["empty", ""],
  ])("re-imports from disk when the catalog is %s", async (_label, contents) => {
    const p = mount(cfg, { "a.jpg": "A" });
    p.fs.put(`${p.slPath}/catalog.json`, contents);

    const opened = await open(p);
    await opened.storage.flush();

    expect(rels(opened.photos)).toEqual(["a.jpg"]);
    expect(catalog(p)!.photos).toHaveLength(1);
    // The damaged file is kept beside the new catalog; an empty one has nothing to keep.
    const kept = keptCopies(p);
    expect(kept.map((copy) => copy.text)).toEqual(contents ? [contents] : []);
    expect(opened.recovered).toEqual({ from: "rescan", kept: kept[0]?.name ?? null });
  });

  it("tolerates a catalog missing its photos/edits/removed arrays", async () => {
    const p = mount(cfg, { "a.jpg": "A" });
    p.fs.put(`${p.slPath}/catalog.json`, '{"version":1}');

    const opened = await open(p);

    expect(rels(opened.photos)).toEqual(["a.jpg"]);
    await expect(opened.storage.getAllEditStates()).resolves.toEqual([]);
  });

  it("swallows a save that the filesystem refuses", async () => {
    const p = mount(cfg, { "a.jpg": "A" });
    const opened = await open(p);
    p.fs.freeze(p.slPath);

    await expect(opened.storage.flush()).resolves.toBeUndefined();
  });
});

describe.each(BUILDS)("a catalog that can't be used as saved ($label)", (cfg) => {
  // Opened as an empty project, a catalog that couldn't be read would be replaced
  // within seconds by a fresh import under new ids, ratings and edits gone.
  const FILES = { "a.jpg": "A", "b.jpg": "B", "c.jpg": "C" };
  const CATALOG_FILE = /[\\/]catalog\.json$/;
  const KEPT_NAME = /^catalog\.corrupt-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z\.json$/;
  const KEPT_BACKUP_NAME = /^catalog\.bak\.corrupt-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z\.json$/;

  /** A project imported and saved once: its catalog's text, ids and writes. */
  async function savedProject() {
    const p = mount(cfg, FILES);
    const first = await open(p);
    await first.storage.flush();
    first.storage.close();
    return { p, saved: ids(first.photos), text: catalogText(p) ?? "", writes: catalogWrites(p) };
  }

  it("fails the open once it has waited a few seconds, and writes nothing", async () => {
    // e.g. another window's save, a sync client or a virus scanner holds the file
    const { p, text, writes } = await savedProject();
    p.fs.failReads(CATALOG_FILE, "EBUSY");
    const onSkeletons = vi.fn();

    const opening = open(p, { onSkeletons });
    let settled = false;
    const failed = expect(opening).rejects.toThrow(CatalogUnreadableError);
    opening.then(
      () => (settled = true),
      () => (settled = true),
    );
    await vi.advanceTimersByTimeAsync(3000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    await failed;

    await expect(opening).rejects.toMatchObject({ reason: "EBUSY" });
    expect(onSkeletons).not.toHaveBeenCalled();
    expect(catalogWrites(p)).toBe(writes);
    expect(catalogText(p)).toBe(text);
    expect(backupText(p)).toBeNull();
  });

  it("opens the saved catalog when it can be read again within those seconds", async () => {
    const { p, saved } = await savedProject();
    p.fs.failReads(CATALOG_FILE, "EBUSY", 2);

    const opening = open(p);
    await vi.advanceTimersByTimeAsync(1000);
    const opened = await opening;

    expect(ids(opened.photos)).toEqual(saved);
    expect(opened.newPhotos).toEqual([]);
    expect(opened.recovered).toBeNull();
  });

  it("imports at once when there is no catalog", async () => {
    const p = mount(cfg, FILES);

    const opened = await open(p); // fake timers: a wait would never end

    expect(rels(opened.newPhotos)).toEqual(["a.jpg", "b.jpg", "c.jpg"]);
    expect(opened.recovered).toBeNull();
  });

  it("keeps a damaged catalog aside and restores the photos from the backup", async () => {
    const { p, saved, text } = await savedProject();
    p.fs.put(`${p.slPath}/catalog.bak.json`, text);
    p.fs.put(`${p.slPath}/catalog.json`, text.slice(0, 40));

    const opened = await open(p);

    const kept = keptCopies(p);
    expect(kept.map((copy) => copy.text)).toEqual([text.slice(0, 40)]);
    expect(kept[0].name).toMatch(KEPT_NAME);
    expect(ids(opened.photos)).toEqual(saved);
    expect(opened.newPhotos).toEqual([]);
    expect(opened.recovered).toEqual({ from: "backup", kept: kept[0].name });
    // The restored catalog replaces the damaged one without being asked, and the
    // backup isn't overwritten with the damaged file on the way.
    await vi.advanceTimersByTimeAsync(5000);
    expect(ids(catalog(p)?.photos ?? [])).toEqual(saved);
    expect(backupText(p)).toBe(text);
  });

  it("restores a missing catalog from its backup", async () => {
    const { p, saved, text } = await savedProject();
    p.fs.put(`${p.slPath}/catalog.bak.json`, text);
    await p.fs.remove(`${p.slPath}/catalog.json`);

    const opened = await open(p);

    expect(ids(opened.photos)).toEqual(saved);
    expect(opened.newPhotos).toEqual([]);
    expect(opened.recovered).toEqual({ from: "backup", kept: null });
    await vi.advanceTimersByTimeAsync(5000);
    expect(ids(catalog(p)?.photos ?? [])).toEqual(saved);
    expect(keptCopies(p)).toEqual([]);
  });

  it.each([
    ["damaged", '{"version":1,"photos":[{"id"', true],
    ["empty", "", false],
  ])("says so, keeping a %s backup aside, when the catalog is missing", async (_l, text, keep) => {
    // Otherwise the folder opened as a new project without a word, and the next
    // session's backup wrote over the damaged one.
    const p = mount(cfg, FILES);
    p.fs.put(`${p.slPath}/catalog.bak.json`, text);

    const opened = await open(p);

    const kept = keptCopies(p);
    expect(kept.map((copy) => copy.text)).toEqual(keep ? [text] : []);
    if (keep) expect(kept[0].name).toMatch(KEPT_BACKUP_NAME);
    expect(opened.recovered).toEqual({ from: "rescan", kept: kept[0]?.name ?? null });
    expect(rels(opened.newPhotos)).toEqual(["a.jpg", "b.jpg", "c.jpg"]);
  });

  it("keeps both a damaged catalog and a damaged backup aside", async () => {
    const p = mount(cfg, FILES);
    p.fs.put(`${p.slPath}/catalog.json`, '{"version":1,"photos":[');
    p.fs.put(`${p.slPath}/catalog.bak.json`, '{"version":1,"edits":[');

    const opened = await open(p);

    const kept = keptCopies(p);
    expect(kept.map((copy) => copy.text).sort()).toEqual([
      '{"version":1,"edits":[',
      '{"version":1,"photos":[',
    ]);
    const ofCatalog = kept.find((copy) => copy.text === '{"version":1,"photos":[');
    expect(opened.recovered).toEqual({ from: "rescan", kept: ofCatalog?.name });
  });

  it.each([
    ["missing", null],
    ["damaged", "{ cut short"],
  ])("fails the open, importing nothing, when the catalog is %s and its backup is busy", async (
    _label,
    text,
  ) => {
    const p = mount(cfg, FILES);
    if (text !== null) p.fs.put(`${p.slPath}/catalog.json`, text);
    p.fs.put(`${p.slPath}/catalog.bak.json`, "{}");
    p.fs.failReads(/[\\/]catalog\.bak\.json$/, "EBUSY");

    const opening = open(p);
    const failed = expect(opening).rejects.toThrow(CatalogUnreadableError);
    await vi.advanceTimersByTimeAsync(4000);
    await failed;

    expect(h.built).toBe(0);
    expect(catalogText(p)).toBe(text);
    expect(backupText(p)).toBe("{}");
  });

  it("fails the open on a busy catalog in a folder whose name holds ENOENT", async () => {
    // Read for an errno anywhere in the message, the path made the busy catalog
    // look missing, and the folder opened as a new project.
    const p = mount({ ...cfg, rootPath: cfg.native ? "D:\\ENOENT" : "/home/u/ENOENT" }, FILES);
    const first = await open(p);
    await first.storage.flush();
    first.storage.close();
    p.fs.failReads(CATALOG_FILE, "EBUSY");

    const opening = open(p);
    const failed = expect(opening).rejects.toThrow(CatalogUnreadableError);
    await vi.advanceTimersByTimeAsync(4000);
    await failed;

    await expect(opening).rejects.toMatchObject({ reason: "EBUSY" });
  });

  it("treats a catalog holding JSON null as damaged", async () => {
    const p = mount(cfg, FILES);
    p.fs.put(`${p.slPath}/catalog.json`, "null");

    const opened = await open(p);

    const kept = keptCopies(p);
    expect(kept.map((copy) => copy.text)).toEqual(["null"]);
    expect(opened.recovered).toEqual({ from: "rescan", kept: kept[0].name });
    expect(rels(opened.newPhotos)).toEqual(["a.jpg", "b.jpg", "c.jpg"]);
  });

  it("stops rather than replace a damaged catalog it can't keep a copy of", async () => {
    const p = mount(cfg, FILES);
    p.fs.put(`${p.slPath}/catalog.json`, '{"version":1,"photos":[{"id":"p1');
    p.fs.failWrites(/[\\/]\.safelight[\\/]/, "EPERM");

    const opening = open(p);

    await expect(opening).rejects.toThrow(CatalogDamagedError);
    await expect(opening).rejects.toMatchObject({ reason: "EPERM" });
    expect(catalogText(p)).toBe('{"version":1,"photos":[{"id":"p1');
    expect(catalogWrites(p)).toBe(0);
  });
});

describe.each(BUILDS)("the backup a session keeps ($label)", (cfg) => {
  // Before its first save replaces catalog.json, a session that opened the catalog
  // as saved keeps a copy of the file as catalog.bak.json.
  const FILES = { "a.jpg": "A", "b.jpg": "B" };
  const backupWrites = (p: Project) => p.fs.writeCount(`${p.slPath}/catalog.bak.json`);

  async function reopened() {
    const p = mount(cfg, FILES);
    const first = await open(p);
    await first.storage.flush();
    first.storage.close();
    const before = catalogText(p);
    const again = await open(p);
    return { p, before, storage: again.storage, photos: again.photos };
  }

  it("copies the catalog as it stood before the session's first save, once", async () => {
    const { p, before, storage, photos } = await reopened();
    expect(backupText(p)).toBeNull(); // a new project had nothing to keep

    await storage.putEditState(edit(photos[0].id, "One"));
    expect(backupText(p)).toBe(before);
    const copied = backupWrites(p);
    await storage.putEditState(edit(photos[0].id, "Two"));

    expect(backupWrites(p)).toBe(copied);
    expect(backupText(p)).toBe(before);
    expect(labelsOnDisk(p)).toEqual({ [photos[0].id]: "Two" });
  });

  it("isn't taken by the flush of a window that is closing", async () => {
    const { p, storage, photos } = await reopened();
    void storage.putPhoto({ ...photos[0], rating: 2 });

    await storage.flush({ unloading: true });
    await vi.advanceTimersByTimeAsync(5000);

    expect(catalog(p)?.photos[0].rating).toBe(2);
    expect(backupText(p)).toBeNull();
  });

  it("stays apart from the copy a fold of read-only edits kept", async () => {
    // The fold keeps the catalog it replaced under its own name, so neither the
    // session that folded nor any session after it writes over that copy.
    const p = mount(cfg, FILES);
    const first = await open(p);
    await first.storage.flush();
    first.storage.close();
    const beforeMerge = `${p.slPath}/catalog.before-merge-2026-10-06T09-15-00-000Z.json`;
    p.fs.put(beforeMerge, "before the merge");
    const folded = catalogText(p);
    h.wd = { ...h.wd!, promotedFromExternal: "/data/catalogs/card/.safelight" };

    const promoted = await open(p);
    await promoted.storage.putPhoto({ ...promoted.photos[0], rating: 1 });
    await promoted.storage.flush();
    expect(backupText(p)).toBe(folded);
    promoted.storage.close();
    h.wd = { ...h.wd!, promotedFromExternal: null };
    const again = await open(p); // a pop-out, or the next launch
    await again.storage.putPhoto({ ...again.photos[1], rating: 2 });
    await again.storage.flush();

    expect(p.fs.text(beforeMerge)).toBe("before the merge");
  });

  it("isn't kept by a session that rebuilt a damaged catalog", async () => {
    const p = mount(cfg, FILES);
    p.fs.put(`${p.slPath}/catalog.json`, "{ cut short");

    const opened = await open(p);
    await opened.storage.putEditState(edit(opened.photos[0].id, "One"));
    await opened.storage.flush();

    expect(opened.recovered?.from).toBe("rescan");
    expect(backupText(p)).toBeNull();
  });
});

describe("the flush of a closing desktop window", () => {
  // The page unloads once beforeunload returns: the write must reach the bridge
  // in microtasks, with no wait for a timer or a backup on the way.
  const cfg = BUILDS[0];
  const FILES = { "a.jpg": "A", "b.jpg": "B" };

  it.each([
    ["a new project", false],
    ["a reopened project", true],
  ])("reaches the bridge before any timer runs, for %s", async (_label, reopen) => {
    const p = mount(cfg, FILES);
    let opened = await open(p);
    await opened.storage.flush();
    if (reopen) {
      opened.storage.close();
      opened = await open(p);
    }
    void opened.storage.putPhoto({ ...opened.photos[0], rating: 2 });
    const before = catalogWrites(p);

    void opened.storage.flush({ unloading: true });
    for (let i = 0; i < 20; i++) await Promise.resolve();

    expect(catalogWrites(p) - before).toBe(1);
  });

  it("reaches the bridge before any timer runs after a save that failed", async () => {
    // The failed save waits to be tried again; a closing page won't wait for it.
    const p = mount(cfg, FILES);
    const opened = await open(p);
    await opened.storage.flush();
    p.fs.failWrites(/[\\/]catalog\.json$/, "EBUSY", 1);
    await opened.storage.putEditState(edit(opened.photos[0].id, "Kept"));
    const before = catalogWrites(p);

    void opened.storage.flush({ unloading: true });
    for (let i = 0; i < 20; i++) await Promise.resolve();

    expect(catalogWrites(p) - before).toBe(1);
    expect(labelsOnDisk(p)).toEqual({ [opened.photos[0].id]: "Kept" });
  });

  it("writes a catalog the window left, still waiting to try a failed save again", async () => {
    // Its next try is due in seconds, after the page is gone.
    const p = mount(cfg, FILES);
    const left = await open(p);
    await left.storage.flush();
    p.fs.failWrites(/[\\/]catalog\.json$/, "EBUSY", 2);
    await left.storage.putEditState(edit(left.photos[0].id, "Kept"));
    left.storage.close(); // its write as it leaves fails too
    await vi.advanceTimersByTimeAsync(0);
    const before = catalogWrites(p);

    flushLeftCopies();
    for (let i = 0; i < 20; i++) await Promise.resolve();

    expect(catalogWrites(p) - before).toBe(1);
    expect(labelsOnDisk(p)).toEqual({ [left.photos[0].id]: "Kept" });
  });

  it("stops following the other windows once that write has landed", async () => {
    // A page whose unload is cancelled stays open; its left copy has nothing more to write.
    const p = mount(cfg, FILES);
    const left = await open(p);
    await left.storage.flush();
    const listening = FakeChannel.listening();
    p.fs.failWrites(/[\\/]catalog\.json$/, "EBUSY", 2);
    await left.storage.putEditState(edit(left.photos[0].id, "Kept"));
    left.storage.close();
    await vi.advanceTimersByTimeAsync(0);

    flushLeftCopies();
    await vi.advanceTimersByTimeAsync(0);

    expect(FakeChannel.listening()).toBe(listening - 1);
  });
});

describe("an open that fails after its window left", () => {
  it("stops following the other windows", async () => {
    const p = mount(BUILDS[1], { "a.jpg": "A" });
    const listening = FakeChannel.listening();

    const opening = open(p, {
      onSkeletons: (storage) => {
        storage.close(); // the window leaves while the folder opens
        throw new Error("the open failed");
      },
    });

    await expect(opening).rejects.toThrow("the open failed");
    expect(FakeChannel.listening()).toBe(listening);
  });
});

describe("a catalog this version can't wholly read", () => {
  const cfg = BUILDS[1];
  const at = (id: string, file: string) => ({ ...photoRecord(id), filename: file, relPath: file });

  it.each([
    ["a null edit", { photos: [at("x", "a.jpg")], edits: [null] }],
    ["a null photo", { photos: [null, at("x", "a.jpg")], edits: [] }],
    ["a photo without an id", { photos: [{ relPath: "b.jpg" }, at("x", "a.jpg")], edits: [] }],
    ["photos that aren't a list", { photos: {}, edits: [] }],
    ["a removed entry that isn't a name", { photos: [at("x", "a.jpg")], edits: [], removed: [1] }],
  ])("opens one holding %s, keeping the original aside first", async (_label, body) => {
    const p = mount(cfg, { "a.jpg": "A" });
    const text = JSON.stringify({ version: 1, ...body });
    p.fs.put(`${p.slPath}/catalog.json`, text);

    const opened = await open(p);

    expect(rels(opened.photos)).toEqual(["a.jpg"]);
    expect(keptCopies(p).map((copy) => copy.text)).toEqual([text]);
    await vi.advanceTimersByTimeAsync(5000); // and saves without what it couldn't open
    const saved = catalog(p);
    expect(saved?.photos.map((photo) => photo.relPath)).toEqual(["a.jpg"]);
    expect(saved?.edits).toEqual([]);
    expect(saved?.removed).toEqual([]);
  });

  it("refuses a catalog saved by a newer version, and writes nothing", async () => {
    const p = mount(cfg, { "a.jpg": "A" });
    const text = JSON.stringify({ version: 2, photos: [at("x", "a.jpg")], edits: [] });
    p.fs.put(`${p.slPath}/catalog.json`, text);

    const opening = open(p);

    await expect(opening).rejects.toThrow(CatalogTooNewError);
    await expect(opening).rejects.toMatchObject({ version: 2 });
    expect(catalogText(p)).toBe(text);
    expect(catalogWrites(p)).toBe(0);
    expect(keptCopies(p)).toEqual([]);
  });

  it("opens a catalog without a version as version 1", async () => {
    const p = mount(cfg, { "a.jpg": "A" });
    p.fs.put(`${p.slPath}/catalog.json`, JSON.stringify({ photos: [at("x", "a.jpg")], edits: [] }));

    const opened = await open(p);

    expect(ids(opened.photos)).toEqual(["x"]);
    expect(keptCopies(p)).toEqual([]);
  });

  it("keeps what it doesn't know of a catalog through a save", async () => {
    const p = mount(cfg, { "a.jpg": "A" });
    p.fs.put(
      `${p.slPath}/catalog.json`,
      JSON.stringify({ version: 1, future: { keep: true }, photos: [at("x", "a.jpg")], edits: [] }),
    );

    const opened = await open(p);
    await opened.storage.putPhoto({ ...opened.photos[0], rating: 5 });
    await opened.storage.flush();

    expect(catalog(p)).toMatchObject({ version: 1, future: { keep: true } });
    expect(catalog(p)?.photos[0].rating).toBe(5);
    expect(keptCopies(p)).toEqual([]);
  });
});

describe("removal tombstones", () => {
  const cfg = BUILDS[1];

  it("keeps a photo removed from the catalog out of the next scan", async () => {
    const p = mount(cfg, { "a.jpg": "A", "b.jpg": "B" });
    const first = await open(p);
    await first.storage.deletePhoto(first.photos[0].id);
    await first.storage.flush();

    expect(catalog(p)!.removed).toEqual(["a.jpg"]);

    const second = await open(p);

    expect(rels(second.photos)).toEqual(["b.jpg"]);
    expect(second.newPhotos).toEqual([]); // NOT re-imported as a new file
  });

  it("forgets the tombstone once the file itself leaves, so a fresh copy imports", async () => {
    const p = mount(cfg, { "a.jpg": "A", "b.jpg": "B" });
    const first = await open(p);
    await first.storage.deletePhoto(first.photos[0].id);
    await first.storage.flush();
    await vi.advanceTimersByTimeAsync(1000); // the file is deleted a while after

    await p.fs.remove(`${p.rootPath}/a.jpg`);
    const second = await open(p);
    await second.storage.flush();
    expect(catalog(p)!.removed).toEqual([]);

    p.fs.put(`${p.rootPath}/a.jpg`, "A again");
    const third = await open(p);

    expect(rels(third.newPhotos)).toEqual(["a.jpg"]);
  });

  it("removes the photo's cached preview and opaque blobs", async () => {
    const p = mount(cfg, { "a.jpg": "A" });
    const opened = await open(p);
    const id = opened.photos[0].id;
    await opened.storage.putPhotoBlob(id, "warp", new Uint8Array([1, 2, 3]));
    expect(p.fs.has(`${p.slPath}/previews/${id}.jpg`)).toBe(true);

    await opened.storage.deletePhoto(id);

    expect(p.fs.has(`${p.slPath}/previews/${id}.jpg`)).toBe(false);
    expect(p.fs.tree(`${p.slPath}/blobs`)).toEqual([]);
  });

  it("does not tombstone a virtual copy — the master still owns the file", async () => {
    const p = mount(cfg, { "a.jpg": "A" });
    const opened = await open(p);
    const master = opened.photos[0];
    await opened.storage.putPhoto({ ...master, id: "copy-1", copyOf: master.id, copyName: "copy" });

    await opened.storage.deletePhoto("copy-1");
    await opened.storage.flush();

    expect(catalog(p)!.removed).toEqual([]);
    const second = await open(p);
    expect(ids(second.photos)).toEqual([master.id]);
  });

  it("keeps a tombstone when a virtual copy carries its file's name", async () => {
    // A copy owns no file: only a master stored under a name puts that file back.
    const p = mount(cfg, { "a.jpg": "A", "b.jpg": "B" });
    const opened = await open(p);
    const [master, removed] = opened.photos;
    await opened.storage.deletePhoto(removed.id);

    await opened.storage.putPhoto({ ...master, id: "copy-1", copyOf: master.id, relPath: "b.jpg" });
    await opened.storage.flush();

    expect(catalog(p)?.removed).toEqual(["b.jpg"]);
  });

  it("opens a photo saved under a removed file's name, and forgets the removal", async () => {
    // A catalog an earlier version wrote after a photo took the name of one
    // removed before it.
    const p = mount(cfg, { "a.jpg": "A" });
    const keeper = { ...photoRecord("keeper"), filename: "a.jpg", relPath: "a.jpg" };
    p.fs.put(
      `${p.slPath}/catalog.json`,
      JSON.stringify({
        version: 1,
        photos: [keeper],
        edits: [edit("keeper", "Kept")],
        removed: ["a.jpg"],
      }),
    );

    const opened = await open(p);
    await opened.storage.flush();

    expect(ids(opened.photos)).toEqual(["keeper"]);
    expect((await opened.storage.getEditState("keeper"))?.stack[0].label).toBe("Kept");
    expect(catalog(p)?.removed).toEqual([]);
  });
});

describe.each(BUILDS)("a file name a removed photo left ($label)", (cfg) => {
  // Removing a photo tombstones its file's name. Another photo can take that name
  // later in the same session, and then it is in the catalog again.

  it("keeps a photo renamed onto it, with its rating and edit", async () => {
    // Delete from disk, then a rename (e.g. a sequence rename) onto the freed name.
    const p = mount(cfg, { "a.jpg": "A", "b.jpg": "B, a reject", "c.jpg": "C, a keeper" });
    const first = await open(p);
    const [, reject, keeper] = first.photos;
    await first.storage.putEditState(edit(keeper.id, "Kept look"));
    await p.fs.remove(`${p.rootPath}/b.jpg`);
    await first.storage.deletePhoto(reject.id);

    await p.fs.move(`${p.rootPath}/c.jpg`, `${p.rootPath}/b.jpg`);
    await first.storage.putPhotos([{ ...keeper, rating: 5, filename: "b.jpg", relPath: "b.jpg" }]);
    await first.storage.flush();
    first.storage.close();
    const again = await open(p);

    expect(catalog(p)?.removed).toEqual([]);
    expect(again.photos.map((x) => `${x.id}@${x.relPath}`)).toEqual([
      `${first.photos[0].id}@a.jpg`,
      `${keeper.id}@b.jpg`,
    ]);
    expect(again.photos[1].rating).toBe(5);
    expect((await again.storage.getEditState(keeper.id))?.stack[0].label).toBe("Kept look");
  });

  it("keeps a new photo stored under it", async () => {
    // An extension writing its output file again after the first one was removed.
    const p = mount(cfg, { "a.jpg": "A", "b.jpg": "first merge" });
    const first = await open(p);
    const [, merge] = first.photos;
    await first.storage.deletePhoto(merge.id); // removed from the catalog, file kept

    p.fs.put(`${p.rootPath}/b.jpg`, "second merge");
    await first.storage.putPhotos([{ ...merge, id: "second-merge", rating: 4 }]);
    await first.storage.putEditState(edit("second-merge", "Merge look"));
    await first.storage.flush();
    first.storage.close();
    const again = await open(p);

    expect(catalog(p)?.removed).toEqual([]);
    expect(ids(again.photos)).toEqual([first.photos[0].id, "second-merge"]);
    expect((await again.storage.getEditState("second-merge"))?.stack[0].label).toBe("Merge look");
  });
});

describe("virtual copies", () => {
  const cfg = BUILDS[1];

  it("re-attaches a saved copy right after its master, on the master's file", async () => {
    const p = mount(cfg, { "a.jpg": "A", "b.jpg": "B" });
    const first = await open(p);
    const master = first.photos[0];
    await first.storage.putPhoto({
      ...master,
      id: "copy-1",
      copyOf: master.id,
      copyName: "copy",
    });
    await first.storage.flush();

    const second = await open(p);

    expect(ids(second.photos)).toEqual([master.id, "copy-1", first.photos[1].id]);
    const copy = second.photos[1];
    expect(copy.relPath).toBe("a.jpg");
    expect(copy.fileHandle).toBe(second.photos[0].fileHandle);
    expect(copy.copyName).toBe("copy");
  });

  it("mirrors a master that was renamed on disk onto its copies", async () => {
    const p = mount(cfg, { "a.jpg": "A" });
    const first = await open(p);
    const master = first.photos[0];
    await first.storage.putPhoto({ ...master, id: "copy-1", copyOf: master.id });
    await first.storage.flush();

    // The master's record follows the file; the copy still holds the old name.
    await p.fs.move(`${p.rootPath}/a.jpg`, `${p.rootPath}/renamed.jpg`);
    const saved = catalog(p)!;
    saved.photos = saved.photos.map((rec) =>
      rec.id === master.id ? { ...rec, filename: "renamed.jpg", relPath: "renamed.jpg" } : rec,
    );
    p.fs.put(`${p.slPath}/catalog.json`, JSON.stringify(saved));

    const second = await open(p);

    expect(second.photos.map((x) => x.filename)).toEqual(["renamed.jpg", "renamed.jpg"]);
    expect(rels(second.photos)).toEqual(["renamed.jpg", "renamed.jpg"]);
  });

  it("drops a copy whose master's file is gone, along with its edits", async () => {
    const p = mount(cfg, { "a.jpg": "A", "b.jpg": "B" });
    const first = await open(p);
    const master = first.photos[0];
    await first.storage.putPhoto({ ...master, id: "copy-1", copyOf: master.id });
    await first.storage.putEditState(edit("copy-1", "Exposure"));
    await first.storage.flush();

    await p.fs.remove(`${p.rootPath}/a.jpg`);
    const second = await open(p);
    await second.storage.flush();

    expect(ids(second.photos)).toEqual([first.photos[1].id]);
    expect(catalog(p)!.edits).toEqual([]);
  });

  it("removes the copies it opened with along with their master, in every window", async () => {
    const p = mount(cfg, { "a.jpg": "A", "b.jpg": "B" });
    const first = await open(p);
    const master = first.photos[0];
    await first.storage.putPhoto({ ...master, id: "copy-1", copyOf: master.id });
    await first.storage.putEditState(edit("copy-1", "Exposure"));
    await first.storage.flush();
    first.storage.close();
    const a = await open(p);
    const b = await open(p);

    await a.storage.deletePhoto(master.id);
    await a.storage.flush();

    expect(ids(await a.storage.getAllPhotos())).toEqual([first.photos[1].id]);
    expect(ids(await b.storage.getAllPhotos())).toEqual([first.photos[1].id]);
    expect(ids(catalog(p)?.photos ?? [])).toEqual([first.photos[1].id]);
    expect(catalog(p)?.edits).toEqual([]);
  });
});

describe("removing photos from a large catalog", () => {
  // A removal finds the photo's virtual copies without looking through every
  // record, so removing many photos at once stays quick in every window.
  const cfg = BUILDS[1];

  /** How often removing ten photos from a catalog of `size` reads a record's
   *  copyOf. */
  async function looksToRemoveTen(size: number): Promise<number> {
    const p = mount(cfg);
    const { storage } = await open(p);
    let looks = 0;
    const records = Array.from({ length: size }, (_, i) => {
      const record = photoRecord(`p${i}`);
      Object.defineProperty(record, "copyOf", {
        enumerable: true,
        get: () => {
          looks++;
          return undefined;
        },
      });
      return record;
    });
    await storage.putPhotos(records);
    looks = 0;
    for (const record of records.slice(0, 10)) await storage.deletePhoto(record.id);
    return looks;
  }

  it("looks only at the photos it removes, however many the catalog holds", async () => {
    expect(await looksToRemoveTen(2000)).toBe(await looksToRemoveTen(200));
  });
});

describe("cancellation", () => {
  const cfg = BUILDS[1];
  const many = Object.fromEntries(
    Array.from({ length: 10 }, (_, i) => [`f${i}.jpg`, `pixels ${i}`]),
  );

  it("imports nothing — and writes nothing — when the open is cancelled up front", async () => {
    const p = mount(cfg, many);
    const progress: [number, number][] = [];

    const opened = await open(p, {
      signal: AbortSignal.abort(),
      onProgress: (done, total) => progress.push([done, total]),
    });

    expect(opened.photos).toEqual([]);
    expect(catalog(p)).toBeNull();
    expect(progress[0]).toEqual([0, 10]);
    expect(progress.at(-1)).toEqual([10, 10]);
  });

  it("keeps what it imported before the cancel and resumes on the next open", async () => {
    const p = mount(cfg, many);
    const abort = new AbortController();

    const first = await open(p, {
      signal: abort.signal,
      onPhoto: () => abort.abort(),
    });
    await first.storage.flush();

    // mapLimit runs 8 files at a time; the batch already in flight finishes, the
    // rest are skipped rather than half-written.
    expect(rels(first.photos)).toEqual([
      "f0.jpg",
      "f1.jpg",
      "f2.jpg",
      "f3.jpg",
      "f4.jpg",
      "f5.jpg",
      "f6.jpg",
      "f7.jpg",
    ]);
    expect(rels(catalog(p)!.photos)).toEqual(rels(first.photos));

    const second = await open(p);

    expect(rels(second.newPhotos)).toEqual(["f8.jpg", "f9.jpg"]);
    expect(second.photos).toHaveLength(10);
    expect(ids(second.photos).filter((id) => ids(first.photos).includes(id))).toHaveLength(8);
  });
});

describe("read-only source redirect", () => {
  // A memory card can't host .safelight, so the working dir is redirected into
  // app data. Nothing may be written back into the project folder.
  const cfg = BUILDS[0];
  const APP_DATA = "C:\\Users\\u\\AppData\\Safelight\\catalogs\\dcim-abc\\.safelight";

  it("keeps the whole catalog out of the frozen project folder", async () => {
    const p = mount(cfg, { "a.jpg": "A", "trip/b.NEF": "B" }, APP_DATA);
    p.fs.freeze(p.rootPath);

    const opened = await open(p);
    await opened.storage.flush();

    expect(opened.storageLocation).toBe("external");
    expect(opened.externalPath).toBe(APP_DATA);
    expect(p.fs.tree(p.rootPath)).toEqual([key(`${p.rootPath}/a.jpg`), key(`${p.rootPath}/trip/b.NEF`)]);
    expect(catalog(p)!.photos).toHaveLength(2);
    expect(p.fs.has(`${APP_DATA}/previews/${opened.photos[0].id}.jpg`)).toBe(true);
  });

  it("reports a promotion back into the project folder", async () => {
    const p = mount(cfg, { "a.jpg": "A" });
    h.wd = { ...h.wd!, promotedFromExternal: APP_DATA };

    await expect(open(p).then((o) => o.promotedFromExternal)).resolves.toBe(APP_DATA);
  });
});

describe("previews", () => {
  const cfg = BUILDS[1];

  it("caches a grid preview per photo and reads it back", async () => {
    const p = mount(cfg, { "a.jpg": "A" });
    const opened = await open(p);
    const id = opened.photos[0].id;

    expect(p.fs.text(`${p.slPath}/previews/${id}.jpg`)).toBe("thumb:a.jpg");
    await expect((await opened.storage.readPreview(id))!.text()).resolves.toBe("thumb:a.jpg");
  });

  it("keeps previews out of the working dir when the user turned them off", async () => {
    h.persistPreviews = false;
    const p = mount(cfg, { "a.jpg": "A" });

    const opened = await open(p);

    expect(p.fs.tree(`${p.slPath}/previews`)).toEqual([]);
    // …and rebuilds on demand from the source file instead.
    await expect(
      (await opened.storage.readPreview(opened.photos[0].id))!.text(),
    ).resolves.toBe("rebuilt:a.jpg");
  });

  it("rebuilds from the source file when the cached preview has gone missing", async () => {
    const p = mount(cfg, { "a.jpg": "A" });
    const opened = await open(p);
    const id = opened.photos[0].id;
    await p.fs.remove(`${p.slPath}/previews/${id}.jpg`);

    await expect((await opened.storage.readPreview(id))!.text()).resolves.toBe("rebuilt:a.jpg");
  });

  it("returns null for a photo the catalog has never heard of", async () => {
    const p = mount(cfg, { "a.jpg": "A" });
    const opened = await open(p);

    await expect(opened.storage.readPreview("nope")).resolves.toBeNull();
  });

  it("rewrites the cached preview only when the thumbnail actually changed", async () => {
    const p = mount(cfg, { "a.jpg": "A" });
    const opened = await open(p);
    const photo = opened.photos[0];
    const first = p.fs.bytes(`${p.slPath}/previews/${photo.id}.jpg`);

    await opened.storage.putPhoto({ ...photo, rating: 3 }); // same blob reference
    expect(p.fs.bytes(`${p.slPath}/previews/${photo.id}.jpg`)).toBe(first);

    await opened.storage.putPhoto({ ...photo, thumbnailBlob: new Blob(["rotated"]) });
    expect(p.fs.text(`${p.slPath}/previews/${photo.id}.jpg`)).toBe("rotated");
  });

  it("stores the record when its preview can't be written, and writes it with the next put", async () => {
    const p = mount(cfg, { "a.jpg": "A" });
    const opened = await open(p);
    const edited = { ...opened.photos[0], thumbnailBlob: new Blob(["edited"]) };
    p.fs.failWrites(/[\\/]previews[\\/]/, "ENOSPC", 1);

    await expect(opened.storage.putPhoto({ ...edited, rating: 2 })).resolves.toBeUndefined();
    expect((await opened.storage.getAllPhotos())[0].rating).toBe(2);
    expect(p.fs.text(`${p.slPath}/previews/${edited.id}.jpg`)).toBe("thumb:a.jpg");

    await opened.storage.putPhoto({ ...edited, rating: 3 });
    expect(p.fs.text(`${p.slPath}/previews/${edited.id}.jpg`)).toBe("edited");
  });
});

/** Hold each write of a preview until the test lands it, as a file system that may
 *  land writes in any order. `written` holds the text of each write that reached the
 *  file system, in order; landAll lands the held ones and stops holding. */
function holdEachPreviewWrite(fs: FlakyFs) {
  const held: (() => void)[] = [];
  const written: string[] = [];
  let holding = true;
  const write = fs.write.bind(fs);
  vi.spyOn(fs, "write").mockImplementation(async (path, data) => {
    if (/[\\/]previews[\\/]/.test(path)) {
      written.push(new TextDecoder().decode(data));
      if (holding) await new Promise<void>((land) => held.push(land));
    }
    return write(path, data);
  });
  return {
    written,
    landNewest: () => held.pop()?.(),
    landOldest: () => held.shift()?.(),
    landAll: () => {
      holding = false;
      for (const land of held.splice(0)) land();
    },
  };
}

describe("the edit a stored preview showed", () => {
  // The record names the edit of the preview on disk (previewEdit), and none once
  // that preview is missing, or Develop would draw a preview as an edit it doesn't show.
  const cfg = BUILDS[1];

  /** Mount a.jpg and save its catalog with its preview showing the edit "edit-1",
   *  as a session that edited it leaves it. */
  async function savedWithEditedPreview(): Promise<Project> {
    const p = mount(cfg, { "a.jpg": "A" });
    const first = await open(p);
    await first.storage.putPhoto({
      ...first.photos[0],
      thumbnailBlob: new Blob(["thumb:a.jpg"]),
      previewEdit: "edit-1",
    });
    await first.storage.flush();
    first.storage.close();
    return p;
  }

  const recordIn = async (storage: ProjectStorage) => (await storage.getAllPhotos())[0];

  /** Hold the writes of previews until the returned function lands them. */
  function holdPreviewWrites(fs: FlakyFs): () => void {
    let land = (): void => {};
    const landed = new Promise<void>((resolve) => (land = resolve));
    const write = fs.write.bind(fs);
    vi.spyOn(fs, "write").mockImplementation(async (path, data) => {
      if (/[\\/]previews[\\/]/.test(path)) await landed;
      return write(path, data);
    });
    return land;
  }

  /** Hold the reads of previews once they have the file's bytes: `reached` resolves
   *  then, and `deliver` hands the bytes on. */
  function holdPreviewReads(fs: FlakyFs): { reached: Promise<void>; deliver: () => void } {
    let reach = (): void => {};
    const reached = new Promise<void>((resolve) => (reach = resolve));
    let deliver = (): void => {};
    const delivered = new Promise<void>((resolve) => (deliver = resolve));
    const read = fs.read.bind(fs);
    vi.spyOn(fs, "read").mockImplementation(async (path) => {
      const file = await read(path);
      if (/[\\/]previews[\\/]/.test(path)) {
        reach();
        await delivered;
      }
      return file;
    });
    return { reached, deliver };
  }

  it("stays when the preview is built from the file because previews aren't stored", async () => {
    // It names the preview still on disk, which shows once previews are stored again.
    const p = await savedWithEditedPreview();
    h.persistPreviews = false;
    const reopened = await open(p);

    const preview = await reopened.storage.readPreview(reopened.photos[0].id);

    expect(preview?.previewEdit).toBeUndefined();
    await expect(preview!.text()).resolves.toBe("rebuilt:a.jpg");
    expect((await recordIn(reopened.storage)).previewEdit).toBe("edit-1");
  });

  it("goes when the preview is built from the file because the stored one is missing", async () => {
    const p = await savedWithEditedPreview();
    const reopened = await open(p);
    const id = reopened.photos[0].id;
    await p.fs.remove(`${p.slPath}/previews/${id}.jpg`);

    const preview = await reopened.storage.readPreview(id);

    await expect(preview!.text()).resolves.toBe("rebuilt:a.jpg");
    expect(preview?.previewEdit).toBeUndefined();
    expect((await recordIn(reopened.storage)).previewEdit).toBeUndefined();
  });

  it("stays when the preview is read from disk", async () => {
    const p = await savedWithEditedPreview();
    const reopened = await open(p);

    const preview = await reopened.storage.readPreview(reopened.photos[0].id);

    await expect(preview!.text()).resolves.toBe("thumb:a.jpg");
    expect(preview?.previewEdit).toBe("edit-1");
    expect((await recordIn(reopened.storage)).previewEdit).toBe("edit-1");
  });

  it("goes in this window only, as each window's previews are its own", async () => {
    const p = await savedWithEditedPreview();
    const a = await open(p);
    const b = await open(p);
    await p.fs.remove(`${p.slPath}/previews/${a.photos[0].id}.jpg`);

    await a.storage.readPreview(a.photos[0].id);
    await vi.advanceTimersByTimeAsync(5000);

    expect((await recordIn(a.storage)).previewEdit).toBeUndefined();
    expect((await recordIn(b.storage)).previewEdit).toBe("edit-1");
  });

  it("isn't taken from a preview stored while the file was being read", async () => {
    const p = await savedWithEditedPreview();
    const reopened = await open(p);
    const id = reopened.photos[0].id;
    await p.fs.remove(`${p.slPath}/previews/${id}.jpg`);
    let release = (): void => {};
    h.buildGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const reading = reopened.storage.readPreview(id);
    await vi.advanceTimersByTimeAsync(0);
    await reopened.storage.putPhoto({
      ...reopened.photos[0],
      thumbnailBlob: new Blob(["edited"]),
      previewEdit: "edit-2",
    });
    release();
    await reading;

    expect((await recordIn(reopened.storage)).previewEdit).toBe("edit-2");
  });

  // The record names the edit of the preview on disk, so Develop never draws a
  // stored preview as an edit it doesn't show.

  it("keeps naming the stored preview through edits made while previews aren't stored", async () => {
    const p = await savedWithEditedPreview();
    const session = await open(p);
    h.persistPreviews = false;
    await session.storage.putPhoto({
      ...session.photos[0],
      thumbnailBlob: new Blob(["edit 2"]),
      previewEdit: "edit-2",
    });
    await session.storage.flush();
    session.storage.close();
    h.persistPreviews = true;

    const reopened = await open(p);
    const preview = await reopened.storage.readPreview(reopened.photos[0].id);

    await expect(preview!.text()).resolves.toBe("thumb:a.jpg");
    expect(reopened.photos[0].previewEdit).toBe("edit-1");
    expect(preview?.previewEdit).toBe("edit-1");
  });

  it("isn't changed by a write that stores no preview", async () => {
    const p = await savedWithEditedPreview();
    const { storage, photos } = await open(p);
    const shown = { ...photos[0], thumbnailBlob: await storage.readPreview(photos[0].id) };

    await storage.putPhoto({ ...shown, rating: 3, previewEdit: undefined });
    expect((await recordIn(storage)).previewEdit).toBe("edit-1");
    await storage.putPhoto({ ...shown, rating: 4, previewEdit: "edit-9" });
    expect((await recordIn(storage)).previewEdit).toBe("edit-1");

    await storage.flush();
    expect(catalog(p)?.photos[0]).toMatchObject({ rating: 4, previewEdit: "edit-1" });
  });

  it("is the edit of a preview written with the record", async () => {
    const p = await savedWithEditedPreview();
    const { storage, photos } = await open(p);

    await storage.putPhoto({
      ...photos[0],
      thumbnailBlob: new Blob(["edited"]),
      previewEdit: "edit-2",
    });

    expect(p.fs.text(`${p.slPath}/previews/${photos[0].id}.jpg`)).toBe("edited");
    expect((await recordIn(storage)).previewEdit).toBe("edit-2");
    await storage.flush();
    expect(catalog(p)?.photos[0].previewEdit).toBe("edit-2");
  });

  it("is named only once its preview is on disk: here, in catalog.json and in the other windows", async () => {
    const p = await savedWithEditedPreview();
    const a = await open(p);
    const b = await open(p);
    const land = holdPreviewWrites(p.fs);

    const writing = a.storage.putPhoto({
      ...a.photos[0],
      thumbnailBlob: new Blob(["edited"]),
      rating: 2,
      previewEdit: "edit-2",
    });
    await vi.advanceTimersByTimeAsync(5000);

    expect(await recordIn(a.storage)).toMatchObject({ rating: 2, previewEdit: "edit-1" });
    expect(await recordIn(b.storage)).toMatchObject({ rating: 2, previewEdit: "edit-1" });
    expect(catalog(p)?.photos[0]).toMatchObject({ rating: 2, previewEdit: "edit-1" });

    land();
    await writing;
    await vi.advanceTimersByTimeAsync(5000);

    expect((await recordIn(a.storage)).previewEdit).toBe("edit-2");
    expect((await recordIn(b.storage)).previewEdit).toBe("edit-2");
    expect(catalog(p)?.photos[0].previewEdit).toBe("edit-2");
  });

  it("comes with a preview read from disk as its record named it before the read", async () => {
    // Another window's preview may land while this one reads: the edit named before
    // the read is never newer than the preview read.
    const p = await savedWithEditedPreview();
    const a = await open(p);
    const b = await open(p);
    const { reached, deliver } = holdPreviewReads(p.fs);

    const reading = b.storage.readPreview(b.photos[0].id);
    await reached;
    await a.storage.putPhoto({
      ...a.photos[0],
      thumbnailBlob: new Blob(["edited"]),
      previewEdit: "edit-2",
    });
    expect((await recordIn(b.storage)).previewEdit).toBe("edit-2");
    deliver();
    const preview = await reading;

    await expect(preview!.text()).resolves.toBe("thumb:a.jpg");
    expect(preview?.previewEdit).toBe("edit-1");
  });

  it("is saved by a copy the window has left without undoing another window's change", async () => {
    const p = mount(cfg, { "a.jpg": "A", "b.jpg": "B" });
    const first = await open(p);
    await first.storage.flush();
    first.storage.close();
    const a = await open(p);
    const b = await open(p);
    const byFile = (photos: CatalogPhoto[], relPath: string) =>
      photos.find((photo) => photo.relPath === relPath)!;
    const land = holdPreviewWrites(p.fs);

    const writing = a.storage.putPhoto({
      ...byFile(a.photos, "a.jpg"),
      thumbnailBlob: new Blob(["edited"]),
      previewEdit: "edit-2",
    });
    await vi.advanceTimersByTimeAsync(5000);
    a.storage.close();
    await b.storage.putPhoto({ ...byFile(b.photos, "b.jpg"), rating: 5 });
    await b.storage.flush();
    await vi.advanceTimersByTimeAsync(100);
    land();
    await writing;
    await vi.advanceTimersByTimeAsync(5000);

    const onDisk = catalog(p)!.photos;
    expect(byFile(onDisk, "b.jpg").rating).toBe(5);
    expect(byFile(onDisk, "a.jpg").previewEdit).toBe("edit-2");
  });

  // Writes of one <id>.jpg: the grid's reads, an edit's preview, a turn or a rating
  // pushing the store's preview, and a reimport can all meet.

  it("is named once its preview lands, though this window read the preview meanwhile", async () => {
    const p = await savedWithEditedPreview();
    const a = await open(p);
    const b = await open(p);
    const land = holdPreviewWrites(p.fs);

    const writing = a.storage.putPhoto({
      ...a.photos[0],
      thumbnailBlob: new Blob(["edited"]),
      previewEdit: "edit-2",
    });
    const read = await a.storage.readPreview(a.photos[0].id);
    land();
    await writing;
    await vi.advanceTimersByTimeAsync(5000);

    await expect(read!.text()).resolves.toBe("thumb:a.jpg");
    expect(read?.previewEdit).toBe("edit-1");
    expect((await recordIn(a.storage)).previewEdit).toBe("edit-2");
    expect((await recordIn(b.storage)).previewEdit).toBe("edit-2");
    expect(catalog(p)?.photos[0].previewEdit).toBe("edit-2");
  });

  it("names the newest preview when the file system would land an earlier write last", async () => {
    const p = await savedWithEditedPreview();
    const { storage, photos } = await open(p);
    const writes = holdEachPreviewWrite(p.fs);

    const earlier = storage.putPhoto({
      ...photos[0],
      thumbnailBlob: new Blob(["E2"]),
      previewEdit: "edit-2",
    });
    const later = storage.putPhoto({
      ...photos[0],
      thumbnailBlob: new Blob(["E3"]),
      previewEdit: "edit-3",
    });
    await vi.advanceTimersByTimeAsync(0);
    writes.landNewest();
    await vi.advanceTimersByTimeAsync(0);
    writes.landAll();
    await Promise.all([earlier, later]);
    await vi.advanceTimersByTimeAsync(5000);

    expect(p.fs.text(`${p.slPath}/previews/${photos[0].id}.jpg`)).toBe("E3");
    expect((await recordIn(storage)).previewEdit).toBe("edit-3");
    expect(catalog(p)?.photos[0].previewEdit).toBe("edit-3");
  });

  it("names the preview that landed when the write after it fails", async () => {
    const p = await savedWithEditedPreview();
    const { storage, photos } = await open(p);
    const writes = holdEachPreviewWrite(p.fs);

    const earlier = storage.putPhoto({
      ...photos[0],
      thumbnailBlob: new Blob(["E2"]),
      previewEdit: "edit-2",
    });
    const later = storage.putPhoto({
      ...photos[0],
      thumbnailBlob: new Blob(["E3"]),
      previewEdit: "edit-3",
    });
    await vi.advanceTimersByTimeAsync(0);
    writes.landNewest();
    await vi.advanceTimersByTimeAsync(0);
    p.fs.failWrites(/[\\/]previews[\\/]/, "EBUSY", 1);
    writes.landAll();
    await Promise.allSettled([earlier, later]);
    await vi.advanceTimersByTimeAsync(5000);

    expect(p.fs.text(`${p.slPath}/previews/${photos[0].id}.jpg`)).toBe("E2");
    expect((await recordIn(storage)).previewEdit).toBe("edit-2");
    expect(catalog(p)?.photos[0].previewEdit).toBe("edit-2");
  });

  it("skips writing a preview a newer one replaced while it waited", async () => {
    const p = await savedWithEditedPreview();
    const { storage, photos } = await open(p);
    const writes = holdEachPreviewWrite(p.fs);

    const puts = ["E2", "E3", "E4"].map((text, i) =>
      storage.putPhoto({
        ...photos[0],
        thumbnailBlob: new Blob([text]),
        previewEdit: `edit-${i + 2}`,
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    writes.landAll();
    await Promise.all(puts);
    await vi.advanceTimersByTimeAsync(5000);

    expect(writes.written).toEqual(["E2", "E4"]);
    expect(p.fs.text(`${p.slPath}/previews/${photos[0].id}.jpg`)).toBe("E4");
    expect((await recordIn(storage)).previewEdit).toBe("edit-4");
  });

  it("lands in its own project once the window has moved on, which then lets go", async () => {
    const p = await savedWithEditedPreview();
    const left = await open(p);
    const id = left.photos[0].id;
    const land = holdPreviewWrites(p.fs);
    const writing = Promise.all(
      ["E2", "E3"].map((text, i) =>
        left.storage.putPhoto({
          ...left.photos[0],
          thumbnailBlob: new Blob([text]),
          previewEdit: `edit-${i + 2}`,
        }),
      ),
    );
    await vi.advanceTimersByTimeAsync(5000);
    const listening = FakeChannel.listening();

    left.storage.close();
    const other = "/home/u/other";
    p.fs.mkdirp(other);
    h.wd = {
      sl: fsaDirectoryHandle(p.fs, `${other}/.safelight`),
      location: "in-folder",
      externalPath: null,
      promotedFromExternal: null,
    };
    const next = await ProjectStorage.open(fsaDirectoryHandle(p.fs, other));
    openCatalogs.push(next.storage);
    // The copy left behind still follows the other windows while its previews wait.
    expect(FakeChannel.listening()).toBe(listening + 1);
    land();
    await writing;
    await vi.advanceTimersByTimeAsync(5000);

    expect(p.fs.text(`${p.slPath}/previews/${id}.jpg`)).toBe("E3");
    expect(catalog(p)?.photos[0].previewEdit).toBe("edit-3");
    expect(p.fs.tree(`${other}/.safelight/previews`)).toEqual([]);
    expect(FakeChannel.listening()).toBe(listening);
  });

  it("isn't brought back for a photo removed while its preview was being written", async () => {
    const p = await savedWithEditedPreview();
    const { storage, photos } = await open(p);
    const land = holdPreviewWrites(p.fs);

    const writing = storage.putPhoto({
      ...photos[0],
      thumbnailBlob: new Blob(["edited"]),
      previewEdit: "edit-2",
    });
    await vi.advanceTimersByTimeAsync(0);
    const removing = storage.deletePhoto(photos[0].id);
    land();
    await Promise.all([writing, removing]);
    await vi.advanceTimersByTimeAsync(5000);

    expect(catalog(p)?.photos).toEqual([]);
    expect(await storage.getAllPhotos()).toEqual([]);
  });

  it("leaves no preview file for a photo removed while its preview was being written", async () => {
    const p = await savedWithEditedPreview();
    const { storage, photos } = await open(p);
    const jpg = `${p.slPath}/previews/${photos[0].id}.jpg`;
    const land = holdPreviewWrites(p.fs);

    const writing = storage.putPhoto({
      ...photos[0],
      thumbnailBlob: new Blob(["edited"]),
      previewEdit: "edit-2",
    });
    await vi.advanceTimersByTimeAsync(0);
    const removing = storage.deletePhoto(photos[0].id);
    land();
    await Promise.all([writing, removing]);

    expect(p.fs.has(jpg)).toBe(false);
  });

  it("leaves no preview file for a photo another window removed while this one wrote it", async () => {
    const p = await savedWithEditedPreview();
    const mine = await open(p);
    const other = await open(p);
    const id = mine.photos[0].id;
    const land = holdPreviewWrites(p.fs);

    const writing = mine.storage.putPhoto({
      ...mine.photos[0],
      thumbnailBlob: new Blob(["edited"]),
      previewEdit: "edit-2",
    });
    await vi.advanceTimersByTimeAsync(0);
    await other.storage.deletePhoto(id);
    land();
    await writing;

    expect(p.fs.has(`${p.slPath}/previews/${id}.jpg`)).toBe(false);
  });

  it("removes a photo without waiting for a write of its preview still running", async () => {
    const p = await savedWithEditedPreview();
    const { storage, photos } = await open(p);
    const land = holdPreviewWrites(p.fs);
    const writing = storage.putPhoto({
      ...photos[0],
      thumbnailBlob: new Blob(["edited"]),
      previewEdit: "edit-2",
    });
    await vi.advanceTimersByTimeAsync(0);

    let removed = false;
    const removing = storage.deletePhoto(photos[0].id).then(() => (removed = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(removed).toBe(true);

    land();
    await Promise.all([writing, removing]);
    expect(p.fs.has(`${p.slPath}/previews/${photos[0].id}.jpg`)).toBe(false);
  });

  it("keeps naming the stored preview when it can't be read for now", async () => {
    const p = await savedWithEditedPreview();
    const reopened = await open(p);
    p.fs.failReads(/[\\/]previews[\\/]/, "EBUSY", 1);

    const preview = await reopened.storage.readPreview(reopened.photos[0].id);

    await expect(preview?.text()).resolves.toBe("rebuilt:a.jpg");
    expect((await recordIn(reopened.storage)).previewEdit).toBe("edit-1");
  });

  it("skips a queued preview of a photo removed before its turn came", async () => {
    const p = await savedWithEditedPreview();
    const { storage, photos } = await open(p);
    const jpg = `${p.slPath}/previews/${photos[0].id}.jpg`;
    const writes = holdEachPreviewWrite(p.fs);

    const puts = ["E2", "E3"].map((text, i) =>
      storage.putPhoto({
        ...photos[0],
        thumbnailBlob: new Blob([text]),
        previewEdit: `edit-${i + 2}`,
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    const removing = storage.deletePhoto(photos[0].id);
    writes.landAll();
    await Promise.all([...puts, removing]);

    expect(writes.written).toEqual(["E2"]);
    expect(p.fs.has(jpg)).toBe(false);
  });
});

describe("the rotation a stored preview was made at", () => {
  // A turn is stored before its preview, so the record says which way round the
  // preview on disk is (previewRotation). One made at another rotation than the
  // photo's is never shown: the preview is built from the file instead.
  const cfg = BUILDS[1];

  /** Mount a.jpg, saved with its import preview "thumb:a.jpg" at rotation 0. */
  async function saved(): Promise<{ p: Project; photo: CatalogPhoto; storage: ProjectStorage }> {
    const p = mount(cfg, { "a.jpg": "A" });
    const { storage, photos } = await open(p);
    await storage.flush();
    return { p, photo: photos[0], storage };
  }

  const turned = (photo: CatalogPhoto): CatalogPhoto => ({
    ...photo,
    rotation: 90,
    width: photo.height,
    height: photo.width,
    thumbnailBlob: new Blob(["turned"]),
  });

  async function reopenedPreview(p: Project, storage: ProjectStorage): Promise<string | undefined> {
    storage.close();
    const again = await open(p);
    return (await again.storage.readPreview(again.photos[0].id))?.text();
  }

  it("is the old one until the turned preview lands, then the new one", async () => {
    const { p, photo, storage } = await saved();
    const writes = holdEachPreviewWrite(p.fs);

    const putting = storage.putPhoto(turned(photo));
    await vi.advanceTimersByTimeAsync(0);
    expect((await storage.getAllPhotos())[0]).toMatchObject({ rotation: 90, previewRotation: 0 });
    writes.landAll();
    await putting;

    expect((await storage.getAllPhotos())[0]).toMatchObject({ rotation: 90, previewRotation: 90 });
  });

  it("shows a preview built from the file after a quit cut the turned preview's write short", async () => {
    const { p, photo, storage } = await saved();
    const writes = holdEachPreviewWrite(p.fs);
    const putting = storage.putPhoto(turned(photo));
    await vi.advanceTimersByTimeAsync(0);
    await storage.flush({ unloading: true });
    vi.mocked(p.fs.write).mockRestore();

    expect(await reopenedPreview(p, storage)).toBe("rebuilt:a.jpg");
    writes.landAll(); // the quit window's write, so its copy lets go
    await putting;
  });

  it("shows a preview built from the file after the turned preview failed to write", async () => {
    const { p, photo, storage } = await saved();
    p.fs.failWrites(/[\\/]previews[\\/]/, "ENOSPC", 1);
    await storage.putPhoto(turned(photo)).catch(() => {});
    await storage.flush();

    expect(await reopenedPreview(p, storage)).toBe("rebuilt:a.jpg");
  });

  it("shows a preview built from the file after a turn made while previews weren't stored", async () => {
    const { p, photo, storage } = await saved();
    h.persistPreviews = false;
    await storage.putPhoto(turned(photo));
    await storage.flush();
    h.persistPreviews = true;

    expect(await reopenedPreview(p, storage)).toBe("rebuilt:a.jpg");
  });

  it("shows a preview built from the file for a photo saved with no rotation, turned", async () => {
    const { p, storage } = await saved();
    storage.close();
    // A catalog from an older build: the record has no rotation field.
    const file = JSON.parse(catalogText(p) ?? "{}");
    delete file.photos[0].rotation;
    p.fs.put(`${p.slPath}/catalog.json`, JSON.stringify(file));
    const second = await open(p);
    const legacy = second.photos[0];
    expect(legacy.rotation).toBeUndefined();
    p.fs.failWrites(/[\\/]previews[\\/]/, "ENOSPC", 1);

    await second.storage.putPhoto({
      ...legacy,
      rotation: 90,
      width: legacy.height,
      height: legacy.width,
      thumbnailBlob: new Blob(["turned"]),
    });
    await second.storage.flush();

    expect((await second.storage.getAllPhotos())[0]).toMatchObject({
      rotation: 90,
      previewRotation: 0,
    });
    expect(await reopenedPreview(p, second.storage)).toBe("rebuilt:a.jpg");
  });

  it("shows the stored preview once the turned one landed", async () => {
    const { p, photo, storage } = await saved();
    await storage.putPhoto(turned(photo));
    await storage.flush();

    expect(await reopenedPreview(p, storage)).toBe("turned");
  });

  it("follows the preview into another window", async () => {
    const { p, photo, storage } = await saved();
    const other = await open(p);

    await storage.putPhoto(turned(photo));

    expect((await other.storage.getAllPhotos())[0]).toMatchObject({ previewRotation: 90 });
    await expect((await other.storage.readPreview(photo.id))?.text()).resolves.toBe("turned");
  });
});

describe("how many previews are written at once", () => {
  // Each write holds its whole preview in memory, on both sides of the desktop
  // bridge, so a batch of new previews is written a few at a time.
  const cfg = BUILDS[1];
  const FILES = { "a.jpg": "A", "b.jpg": "B", "c.jpg": "C", "d.jpg": "D", "e.jpg": "E" };

  const preview =(photo: CatalogPhoto, text: string, previewEdit?: string): CatalogPhoto => ({
    ...photo,
    thumbnailBlob: new Blob([text]),
    previewEdit,
  });

  it("is four, whatever the batch", async () => {
    const p = mount(cfg, FILES);
    const { storage, photos } = await open(p);
    const writes = holdEachPreviewWrite(p.fs);

    const batch = photos.map((photo) => preview(photo, `new:${photo.relPath}`));
    const putting = storage.putPhotos(batch);
    await vi.advanceTimersByTimeAsync(0);
    expect(writes.written).toHaveLength(4);
    writes.landAll();
    await putting;

    expect(writes.written).toHaveLength(5);
    for (const photo of photos)
      expect(p.fs.text(`${p.slPath}/previews/${photo.id}.jpg`)).toBe(`new:${photo.relPath}`);
  });

  it("keeps each photo's writes in the order they were asked for, across batches", async () => {
    const p = mount(cfg, FILES);
    const { storage, photos } = await open(p);
    const last = photos[photos.length - 1];
    const writes = holdEachPreviewWrite(p.fs);

    const first = storage.putPhotos(
      photos.map((photo) => preview(photo, `A:${photo.relPath}`, "edit-A")),
    );
    const second = storage.putPhotos([preview(last, "B", "edit-B")]);
    await vi.advanceTimersByTimeAsync(0);
    writes.landAll();
    await Promise.all([first, second]);
    await vi.advanceTimersByTimeAsync(5000);

    expect(p.fs.text(`${p.slPath}/previews/${last.id}.jpg`)).toBe("B");
    expect((await storage.getAllPhotos()).find((photo) => photo.id === last.id)?.previewEdit).toBe(
      "edit-B",
    );
    expect(writes.written).not.toContain(`A:${last.relPath}`);
  });

  it("lets the next one start when a write fails", async () => {
    const p = mount(cfg, FILES);
    const { storage, photos } = await open(p);
    const writes = holdEachPreviewWrite(p.fs);

    const outcome = storage
      .putPhotos(photos.map((photo) => preview(photo, `new:${photo.relPath}`)))
      .then(
        () => "written",
        () => "failed",
      );
    await vi.advanceTimersByTimeAsync(0);
    p.fs.failWrites(/[\\/]previews[\\/]/, "EBUSY", 1);
    writes.landOldest();
    await vi.advanceTimersByTimeAsync(0);

    expect(writes.written).toHaveLength(5);
    writes.landAll();
    // The failed preview fails nothing: the records were stored.
    await expect(outcome).resolves.toBe("written");
  });
});

describe("opaque per-photo blobs", () => {
  const cfg = BUILDS[1];

  it("round-trips a payload without touching catalog.json", async () => {
    const p = mount(cfg, { "a.jpg": "A" });
    const opened = await open(p);
    const id = opened.photos[0].id;

    await opened.storage.putPhotoBlob(id, "warp", new Uint8Array([1, 2, 3, 4]));
    await opened.storage.flush();

    await expect(opened.storage.getPhotoBlob(id, "warp")).resolves.toEqual(
      new Uint8Array([1, 2, 3, 4]),
    );
    expect(p.fs.text(`${p.slPath}/catalog.json`)).not.toContain("warp");
  });

  it("writes exactly the view's bytes, not the whole backing buffer", async () => {
    const p = mount(cfg, { "a.jpg": "A" });
    const opened = await open(p);
    const id = opened.photos[0].id;
    const backing = new Uint8Array([9, 9, 9, 1, 2, 3, 9]);

    await opened.storage.putPhotoBlob(id, "warp", backing.subarray(3, 6));

    await expect(opened.storage.getPhotoBlob(id, "warp")).resolves.toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it("deletes the payload when given null, and reports a missing one as null", async () => {
    const p = mount(cfg, { "a.jpg": "A" });
    const opened = await open(p);
    const id = opened.photos[0].id;
    await opened.storage.putPhotoBlob(id, "warp", new Uint8Array([1]));

    await opened.storage.putPhotoBlob(id, "warp", null);

    await expect(opened.storage.getPhotoBlob(id, "warp")).resolves.toBeNull();
    await expect(opened.storage.getPhotoBlob(id, "never-written")).resolves.toBeNull();
  });
});

describe("open-time callbacks", () => {
  const cfg = BUILDS[1];

  it("paints saved records as handle-less skeletons before the scan runs", async () => {
    const p = mount(cfg, { "a.jpg": "A", "b.jpg": "B" });
    const first = await open(p);
    await first.storage.flush();

    let skeletons: CatalogPhoto[] = [];
    await open(p, { onSkeletons: (_s, _raw, sk) => (skeletons = sk) });

    expect(ids(skeletons)).toEqual(ids(first.photos));
    for (const sk of skeletons) {
      expect(sk.fileHandle).toBeNull();
      expect(sk.thumbnailBlob).toBeNull();
    }
  });

  it("counts progress against newly-discovered files only", async () => {
    const p = mount(cfg, { "a.jpg": "A" });
    const first = await open(p);
    await first.storage.flush();
    p.fs.put(`${p.rootPath}/b.jpg`, "B");
    p.fs.put(`${p.rootPath}/c.jpg`, "C");

    const progress: [number, number][] = [];
    await open(p, { onProgress: (done, total) => progress.push([done, total]) });

    expect(progress).toEqual([
      [0, 2],
      [1, 2],
      [2, 2],
    ]);
  });

  it("announces each imported photo as it lands", async () => {
    const p = mount(cfg, { "a.jpg": "A", "b.jpg": "B" });
    const seen: string[] = [];

    const opened = await open(p, { onPhoto: (photo) => seen.push(photo.relPath) });

    expect(seen.sort()).toEqual(rels(opened.photos));
  });
});

describe("sidecar adoption", () => {
  const cfg = BUILDS[1];

  it("adopts ratings, labels, keywords and develop maps travelling with the file", async () => {
    const p = mount(cfg, { "a.jpg": "A" });
    p.fs.put(
      `${p.rootPath}/a.jpg.safelight.json`,
      JSON.stringify({
        safelightSidecar: 1,
        info: { rating: 4, colorLabel: "red", flag: "pick", keywords: ["dawn"] },
        maps: { stack: [{ timestamp: 1, label: "Exposure", params: {} }], currentIndex: 0 },
      }),
    );

    const opened = await open(p);

    expect(opened.photos[0]).toMatchObject({
      rating: 4,
      colorLabel: "red",
      flag: "pick",
      keywords: ["dawn"],
    });
    const state = await opened.storage.getEditState(opened.photos[0].id);
    expect(state?.stack).toHaveLength(1);
    expect(state?.currentIndex).toBe(0);
  });

  it("ignores a sidecar that isn't ours or isn't parseable", async () => {
    const p = mount(cfg, { "a.jpg": "A", "b.jpg": "B" });
    p.fs.put(`${p.rootPath}/a.jpg.safelight.json`, JSON.stringify({ info: { rating: 4 } }));
    p.fs.put(`${p.rootPath}/b.jpg.safelight.json`, "{ truncated");

    const opened = await open(p);

    expect(opened.photos.map((x) => x.rating)).toEqual([0, 0]);
  });

  it("lets an extension's import metadata win over the sidecar", async () => {
    const p = mount(cfg, { "a.jpg": "A" });
    p.fs.put(
      `${p.rootPath}/a.jpg.safelight.json`,
      JSON.stringify({ safelightSidecar: 1, info: { rating: 4 } }),
    );
    h.importOverride = { rating: 1, keywords: ["from-xmp"] };

    const opened = await open(p);

    expect(opened.photos[0]).toMatchObject({ rating: 1, keywords: ["from-xmp"] });
  });
});

describe("catalog writes", () => {
  // A storage writes catalog.json one save at a time. Saves asked for during a
  // write share one write after it, which reads the catalog when it starts.
  const cfg = BUILDS[1];
  const FILES = { "a.jpg": "A", "b.jpg": "B", "c.jpg": "C" };

  /** A project whose catalog.json exists, so each save is a single write. */
  async function saved() {
    const p = mount(cfg, FILES);
    const { storage, photos } = await open(p);
    await storage.flush();
    return { p, storage, photos, before: catalogWrites(p) };
  }

  it("lands two saves fired together one after the other, and the file holds both", async () => {
    const { p, storage, photos, before } = await saved();
    const writes = p.fs.holdWrites();

    const first = storage.putEditState(edit(photos[0].id, "One"));
    const second = storage.putEditState(edit(photos[1].id, "Two"));
    await vi.waitFor(() => expect(catalogWrites(p)).toBeGreaterThan(before));
    writes.landAll();
    await Promise.all([first, second]);

    expect(p.fs.mostConcurrentWrites(`${p.slPath}/catalog.json`)).toBe(1);
    expect(catalogWrites(p) - before).toBeLessThanOrEqual(2);
    expect(labelsOnDisk(p)).toEqual({ [photos[0].id]: "One", [photos[1].id]: "Two" });
  });

  it("shares one write among the saves asked for while a write runs", async () => {
    const { p, storage, photos, before } = await saved();
    const [a, b, c] = photos.map((photo) => photo.id);
    const writes = p.fs.holdWrites();

    const first = storage.putEditState(edit(a, "One"));
    const second = storage.putEditState(edit(b, "Two"));
    const third = storage.putEditState(edit(c, "Three"));
    await vi.waitFor(() => expect(catalogWrites(p)).toBeGreaterThan(before));
    writes.landAll();

    // Each caller resolves only once a write holding its own change has landed.
    await first;
    expect(labelsOnDisk(p)).toMatchObject({ [a]: "One" });
    await second;
    expect(labelsOnDisk(p)).toMatchObject({ [b]: "Two" });
    await third;
    expect(labelsOnDisk(p)).toEqual({ [a]: "One", [b]: "Two", [c]: "Three" });
    expect(catalogWrites(p) - before).toBe(2);
    expect(p.fs.mostConcurrentWrites(`${p.slPath}/catalog.json`)).toBe(1);
  });

  it("writes at once for a window that is closing, beside a write still running", async () => {
    // A closing page won't run a write queued behind another.
    const { p, storage, photos, before } = await saved();
    const writes = p.fs.holdWrites();
    const saving = storage.putEditState(edit(photos[0].id, "One"));
    await vi.waitFor(() => expect(catalogWrites(p) - before).toBe(1));

    const flushing = storage.flush({ unloading: true });
    await vi.waitFor(() => expect(catalogWrites(p) - before).toBe(2));
    writes.landAll();
    await Promise.all([saving, flushing]);

    expect(labelsOnDisk(p)).toEqual({ [photos[0].id]: "One" });
  });

  it("otherwise flushes once the write still running has landed, which holds it all", async () => {
    const { p, storage, photos, before } = await saved();
    const writes = p.fs.holdWrites();
    const saving = storage.putEditState(edit(photos[0].id, "One"));
    await vi.waitFor(() => expect(catalogWrites(p) - before).toBe(1));

    let flushed = false;
    const flushing = storage.flush().then(() => (flushed = true));
    await vi.advanceTimersByTimeAsync(100);
    expect(flushed).toBe(false);
    writes.landAll();
    await Promise.all([saving, flushing]);

    expect(catalogWrites(p) - before).toBe(1);
  });

  it("and writes after it a change made once that write began", async () => {
    const { p, storage, photos, before } = await saved();
    const writes = p.fs.holdWrites();
    const saving = storage.putEditState(edit(photos[0].id, "One"));
    await vi.waitFor(() => expect(catalogWrites(p) - before).toBe(1));
    void storage.putPhoto({ ...photos[1], rating: 4 });

    const flushing = storage.flush();
    await vi.advanceTimersByTimeAsync(100);
    expect(catalogWrites(p) - before).toBe(1);
    writes.landAll();
    await Promise.all([saving, flushing]);

    expect(catalogWrites(p) - before).toBe(2);
    expect(catalog(p)?.photos[1].rating).toBe(4);
  });
});

describe.each(BUILDS)("a flush with nothing to save ($label)", (cfg) => {
  // Every launch, pop-out and window close flushes the catalog. An unchanged
  // catalog isn't written again: the write would gain nothing, and could land over
  // a newer one another window wrote.
  const FILES = { "a.jpg": "A", "b.jpg": "B", "c.jpg": "C" };
  const CATALOG_FILE = /[\\/]catalog\.json$/;

  /** A project saved once and opened again, unchanged. */
  async function reopened() {
    const p = mount(cfg, FILES);
    const first = await open(p);
    await first.storage.flush();
    first.storage.close();
    const again = await open(p);
    return { p, storage: again.storage, photos: again.photos, before: catalogWrites(p) };
  }

  it("writes nothing for a catalog that opened unchanged", async () => {
    const { p, storage, before } = await reopened();

    await storage.flush();

    expect(catalogWrites(p)).toBe(before);
  });

  it("writes nothing as the window closes when nothing changed", async () => {
    const { p, storage, before } = await reopened();

    await storage.flush({ unloading: true });
    storage.close();
    await vi.advanceTimersByTimeAsync(5000);

    expect(catalogWrites(p)).toBe(before);
  });

  it("writes nothing more once its last change is saved", async () => {
    const { p, storage, photos } = await reopened();
    await storage.putPhoto({ ...photos[0], rating: 3 });
    await storage.flush();
    const saved = catalogWrites(p);

    await storage.flush();
    await storage.flush({ unloading: true });

    expect(catalogWrites(p)).toBe(saved);
    expect(catalog(p)?.photos[0].rating).toBe(3);
  });

  it("writes again after a write that failed, with no change since", async () => {
    const { p, storage, photos } = await reopened();
    p.fs.failWrites(CATALOG_FILE, "EBUSY");
    await storage.putEditState(edit(photos[0].id, "Kept"));
    p.fs.stopFailingWrites();

    await storage.flush();

    expect(labelsOnDisk(p)).toEqual({ [photos[0].id]: "Kept" });
  });

  it("writes a change whose write failed as the window closes", async () => {
    const { p, storage, photos } = await reopened();
    p.fs.failWrites(CATALOG_FILE, "EBUSY");
    await storage.putEditState(edit(photos[0].id, "Kept"));
    p.fs.stopFailingWrites();

    await storage.flush({ unloading: true });

    expect(labelsOnDisk(p)).toEqual({ [photos[0].id]: "Kept" });
  });

  it("writes a change whose write failed when the window leaves the catalog", async () => {
    const { p, storage, photos } = await reopened();
    p.fs.failWrites(CATALOG_FILE, "EBUSY");
    await storage.putEditState(edit(photos[0].id, "Kept"));
    p.fs.stopFailingWrites();

    storage.close();
    await vi.advanceTimersByTimeAsync(0);

    expect(labelsOnDisk(p)).toEqual({ [photos[0].id]: "Kept" });
  });

  it("tries a write that fails as the window leaves once more, then lets go", async () => {
    const { p, storage, photos } = await reopened();
    const listening = FakeChannel.listening();
    p.fs.failWrites(CATALOG_FILE, "EBUSY", 1);

    const saving = storage.putEditState(edit(photos[0].id, "Kept")); // its write is running
    const left = storage.flush(); // as the window leaves the catalog: a flush, then close
    storage.close();
    await Promise.all([saving, left]);

    expect(labelsOnDisk(p)).toEqual({ [photos[0].id]: "Kept" });
    expect(FakeChannel.listening()).toBe(listening - 1);
  });

  it("tries three more times once that retry fails too, then gives up and lets go", async () => {
    const { p, storage, photos } = await reopened();
    const listening = FakeChannel.listening();
    const attempts = catalogWriteAttempts(p.fs);
    p.fs.failWrites(CATALOG_FILE, "EBUSY");

    const saving = storage.putEditState(edit(photos[0].id, "Lost"));
    const left = storage.flush();
    storage.close();
    await Promise.all([saving, left]);
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(attempts()).toBe(5); // its write, the flush's, and three timed retries
    expect(FakeChannel.listening()).toBe(listening - 1);
  });

  it("follows the other windows until it gives up", async () => {
    const { p, storage, photos } = await reopened();
    const listening = FakeChannel.listening();
    p.fs.failWrites(CATALOG_FILE, "EBUSY");
    await storage.putEditState(edit(photos[0].id, "Lost"));

    storage.close();
    await vi.advanceTimersByTimeAsync(30_000);
    const meanwhile = FakeChannel.listening();
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect([meanwhile, FakeChannel.listening()]).toEqual([listening, listening - 1]);
  });

  it("says so when it gives up after its window left", async () => {
    const { p, storage, photos } = await reopened();
    const statuses: SaveStatus[] = [];
    const stop = onSaveStatus((status, from) => {
      if (from === storage) statuses.push(status);
    });
    p.fs.failWrites(CATALOG_FILE, "ENOSPC");
    await storage.putEditState(edit(photos[0].id, "Lost"));

    storage.close();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    stop();

    expect(statuses.at(-1)).toEqual({ ok: false, reason: "the disk is full", gaveUp: true });
    expect(statuses.filter((status) => !status.ok && status.gaveUp)).toHaveLength(1);
  });

  it("does nothing more when it is closed again", async () => {
    const { p, storage, photos } = await reopened();
    const attempts = catalogWriteAttempts(p.fs);
    p.fs.failWrites(CATALOG_FILE, "EBUSY");
    await storage.putEditState(edit(photos[0].id, "Lost"));
    storage.close();
    await vi.advanceTimersByTimeAsync(0); // its write as it leaves fails; a try waits
    const once = attempts();

    storage.close();
    await vi.advanceTimersByTimeAsync(0);

    expect(attempts()).toBe(once);
    p.fs.stopFailingWrites();
    await vi.advanceTimersByTimeAsync(60_000); // its try lands, and it lets go
  });
});

describe("a save that fails", () => {
  // A program holding catalog.json (a sync client, a virus scanner) or a full disk
  // fails a save. The change stays to save: the storage tries again by itself and
  // says how each save ended.
  const cfg = BUILDS[1];
  const FILES = { "a.jpg": "A", "b.jpg": "B", "c.jpg": "C" };
  const CATALOG_FILE = /[\\/]catalog\.json$/;
  const stops: (() => void)[] = [];

  afterEach(() => {
    for (const stop of stops.splice(0)) stop();
  });

  /** A project saved once, how each save of its storage ends from now on, and the
   *  catalog.json writes it asks for. */
  async function saved() {
    const p = mount(cfg, FILES);
    const { storage, photos } = await open(p);
    await storage.flush();
    const statuses: SaveStatus[] = [];
    stops.push(
      onSaveStatus((status, from) => {
        if (from === storage) statuses.push(status);
      }),
    );
    return { p, storage, photos, statuses, attempts: catalogWriteAttempts(p.fs) };
  }

  it("tries again with no change since", async () => {
    const { p, storage, photos } = await saved();
    p.fs.failWrites(CATALOG_FILE, "EPERM");
    await storage.putEditState(edit(photos[0].id, "Kept"));
    p.fs.stopFailingWrites();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(labelsOnDisk(p)).toEqual({ [photos[0].id]: "Kept" });
  });

  it("tries after 2, 5, 15 and 30 seconds, then every minute", async () => {
    const { p, storage, photos, attempts } = await saved();
    p.fs.failWrites(CATALOG_FILE, "EBUSY");
    await storage.putEditState(edit(photos[0].id, "Kept"));

    // Each wait in turn: no try a millisecond before it ends, one try as it ends.
    const tries: number[] = [];
    for (const wait of [2000, 5000, 15_000, 30_000, 60_000, 60_000]) {
      await vi.advanceTimersByTimeAsync(wait - 1);
      tries.push(attempts());
      await vi.advanceTimersByTimeAsync(1);
      tries.push(attempts());
    }
    p.fs.stopFailingWrites();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(tries).toEqual([1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7]);
    expect(labelsOnDisk(p)).toEqual({ [photos[0].id]: "Kept" });
  });

  it("keeps saving, and trying again, when a listener throws", async () => {
    const { p, storage, photos, attempts } = await saved();
    stops.push(
      onSaveStatus(() => {
        throw new Error("a listener's own bug");
      }),
    );
    p.fs.failWrites(CATALOG_FILE, "EBUSY", 1);

    await expect(storage.putEditState(edit(photos[0].id, "Kept"))).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(2000);

    expect(attempts()).toBe(2);
    expect(labelsOnDisk(p)).toEqual({ [photos[0].id]: "Kept" });
  });

  it("says why a save failed, then that the next one landed", async () => {
    const { p, storage, photos, statuses } = await saved();
    p.fs.failWrites(CATALOG_FILE, "EBUSY", 1);

    await storage.putEditState(edit(photos[0].id, "Kept"));
    await vi.advanceTimersByTimeAsync(2000);

    expect(statuses).toEqual([
      { ok: false, reason: "the file is locked or not writable" },
      { ok: true },
    ]);
  });

  it("lets the save of a later change take the place of the next try", async () => {
    const { p, storage, photos, attempts } = await saved();
    p.fs.failWrites(CATALOG_FILE, "EBUSY", 1);
    await storage.putEditState(edit(photos[0].id, "Kept"));

    await vi.advanceTimersByTimeAsync(1000);
    void storage.putPhoto({ ...photos[1], rating: 3 }); // saved before the try is due
    await vi.advanceTimersByTimeAsync(60_000);

    expect(attempts()).toBe(2);
    expect(labelsOnDisk(p)).toEqual({ [photos[0].id]: "Kept" });
    expect(catalog(p)?.photos[1].rating).toBe(3);
  });

  it.each([
    ["EPERM", "the file is locked or not writable"],
    ["EBUSY", "the file is locked or not writable"],
    ["EACCES", "the file is locked or not writable"],
    ["ENOSPC", "the disk is full"],
    ["EROFS", "the folder is read-only"],
  ])("says what %s means", async (code, reason) => {
    const { p, storage, photos, statuses } = await saved();
    p.fs.failWrites(CATALOG_FILE, code, 1);

    await storage.putEditState(edit(photos[0].id, "Kept"));

    expect(statuses).toEqual([{ ok: false, reason }]);
  });

  it.each([
    [
      "Error invoking remote method 'fs:write': Error: EPERM: operation not permitted, open 'D:\\DCIM\\.safelight\\catalog.json'",
      "the file is locked or not writable",
    ],
    [
      "Error invoking remote method 'fs:write': Error: ENOTDIR: not a directory, open 'D:\\DCIM\\.safelight\\catalog.json'",
      "ENOTDIR: not a directory, open 'D:\\DCIM\\.safelight\\catalog.json'",
    ],
  ])("leaves out how the desktop app passes on %s", async (message, reason) => {
    const { p, storage, photos, statuses } = await saved();
    vi.spyOn(p.fs, "write").mockRejectedValueOnce(new Error(message));

    await storage.putEditState(edit(photos[0].id, "Kept"));

    expect(statuses).toEqual([{ ok: false, reason }]);
  });

  it("says a catalog is too large to save, and tries again only when asked", async () => {
    const { p, storage, photos, statuses } = await saved();
    const before = catalogWrites(p);
    const huge = {
      ...edit(photos[0].id, "Huge"),
      toJSON: (): never => {
        throw new RangeError("Invalid string length");
      },
    };

    await expect(storage.putEditState(huge)).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const unasked = statuses.length;
    await storage.flush();

    const tooLarge = { ok: false, reason: "the catalog is too large to save as one file" };
    expect(unasked).toBe(1);
    expect(statuses).toEqual([tooLarge, tooLarge]);
    expect(catalogWrites(p)).toBe(before);
  });
});

describe("catalogs of different projects", () => {
  // A shoot folder copied, catalog and all, to another drive keeps its photo ids.
  // A window on the copy must not take on what a window on the original writes.
  const ORIGINAL = "D:\\Shoot";
  const COPY = "E:\\Backup\\Shoot";

  it("ignores the records a window on another copy of the project writes", async () => {
    const fs = new MemoryFs(ORIGINAL, COPY);
    h.fs = fs;
    const photos = [photoRecord("x"), photoRecord("y")];
    const opened: ProjectStorage[] = [];
    for (const root of [ORIGINAL, COPY]) {
      for (const p of photos) fs.put(`${root}/${p.relPath}`, p.id);
      fs.put(`${root}/.safelight/catalog.json`, JSON.stringify({ version: 1, photos, edits: [] }));
      h.wd = {
        sl: nativeDirectoryHandle(`${root}\\.safelight`),
        location: "in-folder",
        externalPath: null,
        promotedFromExternal: null,
      };
      const { storage } = await ProjectStorage.open(nativeDirectoryHandle(root));
      openCatalogs.push(storage);
      opened.push(storage);
    }
    const [original, copy] = opened;

    await original.putEditState(edit("x", "Exposure"));
    await original.deletePhoto("y");
    const [shown] = await copy.getAllPhotos(); // the copy then saves for a reason of its own
    await copy.putPhoto({ ...shown, rating: 1 });
    await copy.flush();

    const onDisk = JSON.parse(fs.text(`${COPY}/.safelight/catalog.json`) ?? "null") as StoredCatalog;
    expect({ ids: ids(onDisk.photos), edits: onDisk.edits, removed: onDisk.removed }).toEqual({
      ids: ["x", "y"],
      edits: [],
      removed: [],
    });
  });

  it("keeps two unrelated browser projects with the same folder name apart", async () => {
    // Two cards both called DCIM, in two browser windows: the browser build has no
    // paths, and camera file names overlap.
    const fs = new MemoryFs("/cardA/DCIM", "/cardB/DCIM");
    h.fs = null;
    const shot = (id: string, file: string, over: Partial<CatalogPhoto> = {}) => ({
      ...photoRecord(id),
      filename: file,
      relPath: file,
      ...over,
    });
    fs.put("/cardA/DCIM/DSC_0001.jpg", "A1");
    fs.put("/cardA/DCIM/DSC_0002.jpg", "A2");
    fs.put(
      "/cardA/DCIM/.safelight/catalog.json",
      JSON.stringify({
        version: 1,
        photos: [shot("a1", "DSC_0001.jpg", { rating: 5 }), shot("a2", "DSC_0002.jpg")],
        edits: [edit("a1", "A's look")],
      }),
    );
    fs.put("/cardB/DCIM/DSC_0001.jpg", "B1");
    fs.put("/cardB/DCIM/DSC_0003.jpg", "B3");
    const openCard = async (root: string) => {
      h.wd = {
        sl: fsaDirectoryHandle(fs, `${root}/.safelight`),
        location: "in-folder",
        externalPath: null,
        promotedFromExternal: null,
      };
      const opened = await ProjectStorage.open(fsaDirectoryHandle(fs, root));
      openCatalogs.push(opened.storage);
      return opened;
    };

    const a = await openCard("/cardA/DCIM");
    await openCard("/cardB/DCIM"); // imports its own DSC_0001.jpg and DSC_0003.jpg
    await a.storage.putPhoto({ ...a.photos[1], flag: "pick" }); // A then saves
    await a.storage.flush();
    const saved = JSON.parse(fs.text("/cardA/DCIM/.safelight/catalog.json") ?? "null") as StoredCatalog;
    a.storage.close();
    const again = await openCard("/cardA/DCIM");

    expect(ids(saved.photos)).toEqual(["a1", "a2"]);
    expect(ids(again.photos)).toEqual(["a1", "a2"]);
    expect(again.photos[0].rating).toBe(5);
    expect((await again.storage.getEditState("a1"))?.stack[0].label).toBe("A's look");
  });

  it("names its catalog in every save", async () => {
    const p = mount(BUILDS[1], { "a.jpg": "A" });
    const first = await open(p);
    await first.storage.flush();
    const id = catalog(p)?.id;

    const again = await open(p);
    await again.storage.putEditState(edit(again.photos[0].id, "Later"));

    expect(id).toEqual(expect.any(String));
    expect(catalog(p)?.id).toBe(id);
  });

  it("shares a catalog saved before catalogs had an id between the windows that open it", async () => {
    const p = mount(BUILDS[1], { "a.jpg": "A" });
    const old = { ...photoRecord("old"), filename: "a.jpg", relPath: "a.jpg" };
    p.fs.put(`${p.slPath}/catalog.json`, JSON.stringify({ version: 1, photos: [old], edits: [] }));
    const a = await open(p);
    const b = await open(p);

    await a.storage.putEditState(edit("old", "From A"));

    await expect(b.storage.getEditState("old")).resolves.toEqual(edit("old", "From A"));
  });

  it("opens one record per file, the first saved", async () => {
    // A catalog can hold a record a window kept for another window on a file of
    // its own (a copy of the project in the browser build): it must not take the
    // photo's place.
    const p = mount(BUILDS[1], { "a.jpg": "A" });
    const at = (id: string, file: string, over: Partial<CatalogPhoto> = {}) => ({
      ...photoRecord(id),
      filename: file,
      relPath: file,
      ...over,
    });
    p.fs.put(
      `${p.slPath}/catalog.json`,
      JSON.stringify({
        version: 1,
        photos: [at("own", "a.jpg", { rating: 5 }), at("kept", "a.jpg")],
        edits: [edit("own", "Own look")],
      }),
    );

    const opened = await open(p);

    expect(ids(opened.photos)).toEqual(["own"]);
    expect(opened.photos[0].rating).toBe(5);
    expect((await opened.storage.getEditState("own"))?.stack[0].label).toBe("Own look");
    await vi.advanceTimersByTimeAsync(1000); // and the catalog is saved without them
    expect(ids(catalog(p)?.photos ?? [])).toEqual(["own"]);
  });
});

describe("catalogKey", () => {
  // Names the catalog file a storage writes: the windows that share one take on
  // each other's records.
  const native = (path: string) => nativeDirectoryHandle(path);

  beforeEach(() => {
    h.fs = new MemoryFs();
  });

  it("names a desktop catalog by its working folder, in any case or slash on Windows", () => {
    const root = native("D:\\Photos");
    expect(catalogKey(root, native("D:\\Photos\\.safelight"), "one")).toBe(
      catalogKey(root, native("d:/photos/.safelight/"), "another"),
    );
    expect(catalogKey(root, native("D:\\Photos\\.safelight"), "one")).not.toBe(
      catalogKey(root, native("E:\\Photos\\.safelight"), "one"),
    );
  });

  it("keeps the case of other systems' paths", () => {
    const root = native("/home/u/Photos");
    expect(catalogKey(root, native("/home/u/Photos/.safelight"), "one")).not.toBe(
      catalogKey(root, native("/home/u/photos/.safelight"), "one"),
    );
  });

  it("names a browser catalog by its folder and the id its catalog keeps", () => {
    const fs = new MemoryFs();
    const browser = (path: string) => fsaDirectoryHandle(fs, path);
    const shoot = catalogKey(browser("/a/shoot"), browser("/a/shoot/.safelight"), "one");
    expect(catalogKey(browser("/b/shoot"), browser("/b/shoot/.safelight"), "one")).toBe(shoot);
    expect(catalogKey(browser("/b/shoot"), browser("/b/shoot/.safelight"), "two")).not.toBe(shoot);
    expect(catalogKey(browser("/a/other"), browser("/a/other/.safelight"), "one")).not.toBe(shoot);
  });
});

describe("windows sharing a catalog", () => {
  // Every window opens the project with its own storage and saves the whole
  // catalog from its own copy, so each write goes out to the other windows and
  // they take it on. A and B stand for two windows; broadcast's same-window
  // fan-out carries the records between them.
  const cfg = BUILDS[1];
  const FILES = { "a.jpg": "A", "b.jpg": "B", "c.jpg": "C" };
  const stops: (() => void)[] = [];

  afterEach(() => {
    for (const stop of stops.splice(0)) stop();
    setCatalogStorage(null);
  });

  /** A imported the folder and saved it; B then opened A's catalog, so both
   *  windows hold the same photos under the same ids. What a test does next
   *  happens a while after those saves, as it would in use. */
  async function twoWindows() {
    const p = mount(cfg, FILES);
    const a = await open(p);
    await a.storage.flush();
    const b = await open(p);
    await vi.advanceTimersByTimeAsync(5000);
    return { p, a: a.storage, b: b.storage, inA: a.photos, inB: b.photos };
  }

  /** The records `storage` takes on from other windows, in order. */
  function takenOnBy(storage: ProjectStorage): CatalogRecords[] {
    const taken: CatalogRecords[] = [];
    stops.push(
      onRemoteRecords((records, from) => {
        if (from === storage) taken.push(records);
      }),
    );
    return taken;
  }

  /** `storage` saves for a reason of its own: it flags `photo`, a photo the test
   *  otherwise leaves alone, and writes at once. */
  async function savesOwnChange(storage: ProjectStorage, photo: CatalogPhoto) {
    await storage.putPhoto({ ...photo, flag: "pick" });
    await storage.flush();
  }

  it("shows B an edit A writes", async () => {
    const { a, b, inA } = await twoWindows();

    await a.putEditState(edit(inA[0].id, "From A"));

    await expect(b.getEditState(inA[0].id)).resolves.toEqual(edit(inA[0].id, "From A"));
  });

  it("keeps A's edit on disk when B next saves for a reason of its own", async () => {
    const { p, a, b, inA } = await twoWindows();

    await a.putEditState(edit(inA[0].id, "From A"));
    await b.putEditState(edit(inA[1].id, "From B"));

    expect(labelsOnDisk(p)).toEqual({ [inA[0].id]: "From A", [inA[1].id]: "From B" });
  });

  it("gives B a rating A sets, on B's own record, and B's next save keeps it", async () => {
    const { p, a, b, inA, inB } = await twoWindows();
    const preview = new Blob(["B's preview"]);
    await b.putPhoto({ ...inB[1], thumbnailBlob: preview, thumbnailUrl: "blob:window-b/1" });

    await a.putPhoto({ ...inA[1], rating: 4 });

    const mine = (await b.getAllPhotos()).find((photo) => photo.id === inA[1].id);
    expect(mine).toMatchObject({ rating: 4, thumbnailUrl: "blob:window-b/1" });
    expect(mine?.thumbnailBlob).toBe(preview);
    expect(mine?.fileHandle).toBe(inB[1].fileHandle);
    expect(mine?.directoryHandle).toBe(inB[1].directoryHandle);
    await b.putEditState(edit(inA[0].id, "B saves"));
    expect(catalog(p)?.photos.find((photo) => photo.id === inA[1].id)?.rating).toBe(4);
  });

  it("removes from B a photo A deletes, with its edit, and B's save keeps it removed", async () => {
    const { p, a, b, inA, inB } = await twoWindows();
    await a.putEditState(edit(inA[0].id, "Doomed"));

    await a.deletePhoto(inA[0].id);

    expect(ids(await b.getAllPhotos())).toEqual([inA[1].id, inA[2].id]);
    await expect(b.getEditState(inA[0].id)).resolves.toBeUndefined();
    await savesOwnChange(b, inB[2]);
    expect(catalog(p)).toMatchObject({ edits: [], removed: ["a.jpg"] });
    expect(rels(catalog(p)?.photos ?? [])).toEqual(["b.jpg", "c.jpg"]);
  });

  it("ignores its own records: A takes nothing back and no save repeats", async () => {
    const { p, a, b, inA } = await twoWindows();
    const byA = takenOnBy(a);
    const byB = takenOnBy(b);
    const before = catalogWrites(p);

    await a.putEditState(edit(inA[0].id, "Once"));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(byA).toEqual([]);
    expect(byB).toEqual([{ edits: [edit(inA[0].id, "Once")], photos: [], deletedIds: [] }]);
    // A's own save only: A doesn't save its echo, and B has nothing to repair.
    expect(catalogWrites(p) - before).toBe(1);
  });

  it("leaves the file to A when B hasn't saved since A's change", async () => {
    // B saving now would gain nothing and would drop what only A holds.
    const { p, a, b, inA } = await twoWindows();
    await a.putPhoto({ ...inA[0], id: "copy-1", copyOf: inA[0].id, copyName: "copy" });

    await a.putEditState(edit(inA[1].id, "From A"));
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(b.getEditState(inA[1].id)).resolves.toEqual(edit(inA[1].id, "From A"));
    expect(ids(catalog(p)?.photos ?? [])).toContain("copy-1");
    expect(labelsOnDisk(p)).toEqual({ [inA[1].id]: "From A" });
  });

  it("keeps a photo A adds in B's saves, without showing it in B", async () => {
    // B's save would otherwise drop it from the file, as B's window closing does.
    const { p, a, b, inA, inB } = await twoWindows();
    const byB = takenOnBy(b);

    await a.putPhotos([{ ...inA[0], id: "copy-1", copyOf: inA[0].id, copyName: "copy" }]);
    await a.putEditState(edit("copy-1", "Copy look"));
    await savesOwnChange(b, inB[2]);

    expect(byB).toEqual([]);
    expect(ids(await b.getAllPhotos())).toEqual(ids(inA));
    expect(ids(catalog(p)?.photos ?? [])).toContain("copy-1");
    expect(labelsOnDisk(p)).toEqual({ "copy-1": "Copy look" });
  });

  it("shows a photo another window added once the project is opened again", async () => {
    const { p, a, b, inA, inB } = await twoWindows();
    await a.putPhotos([{ ...inA[0], id: "copy-1", copyOf: inA[0].id, copyName: "copy" }]);
    await vi.advanceTimersByTimeAsync(3000); // A's save lands

    await savesOwnChange(b, inB[2]); // then B's window closes
    const reopened = await open(p);

    expect(ids(reopened.photos)).toContain("copy-1");
  });

  it("lets go of a photo it keeps for A once A removes it", async () => {
    const { p, a, b, inA, inB } = await twoWindows();
    await a.putPhotos([{ ...inA[0], id: "copy-1", copyOf: inA[0].id, copyName: "copy" }]);
    await a.putEditState(edit("copy-1", "Copy look"));

    await a.deletePhoto("copy-1");
    await savesOwnChange(b, inB[2]);

    expect(ids(catalog(p)?.photos ?? [])).not.toContain("copy-1");
    expect(labelsOnDisk(p)).toEqual({});
  });

  it("keeps nothing that would stand for a file it shows", async () => {
    // Records under ids B doesn't know: another window's import of a file B shows
    // (each window scans the folder on its own), and a copy of a photo B never had.
    const { p, a, b, inA, inB } = await twoWindows();

    await a.putPhotos([
      { ...inA[0], id: "theirs-a" },
      { ...inA[0], id: "their-copy", copyOf: "their-master" },
    ]);
    await savesOwnChange(b, inB[2]);

    expect(ids(catalog(p)?.photos ?? [])).toEqual(ids(inA));
  });

  it("lets a photo take the name of a file removed in another window", async () => {
    // A deletes a reject from disk, then renames a keeper onto the name it freed.
    const { p, a, b, inA } = await twoWindows();
    const [, reject, keeper] = inA;
    await p.fs.remove(`${p.rootPath}/b.jpg`);
    await a.deletePhoto(reject.id);
    await p.fs.move(`${p.rootPath}/c.jpg`, `${p.rootPath}/b.jpg`);
    await a.putPhotos([{ ...keeper, filename: "b.jpg", relPath: "b.jpg" }]);

    await b.putEditState(edit(keeper.id, "From B")); // B then saves for a reason of its own
    const saved = catalog(p);
    const reopened = await open(p);

    expect(saved?.removed).toEqual([]);
    expect(reopened.photos.map((x) => `${x.id}@${x.relPath}`)).toEqual([
      `${inA[0].id}@a.jpg`,
      `${keeper.id}@b.jpg`,
    ]);
    expect((await reopened.storage.getEditState(keeper.id))?.stack[0].label).toBe("From B");
  });

  it("keeps a photo another window stores under the name of a file removed there", async () => {
    // e.g. an extension writing its output file again after the first was removed
    const { p, a, b, inA } = await twoWindows();
    await a.deletePhoto(inA[1].id); // b.jpg leaves the catalog, the file stays
    await a.putPhotos([{ ...inA[1], id: "again", rating: 4 }]);

    await b.putEditState(edit(inA[0].id, "From B"));
    const saved = catalog(p);
    const reopened = await open(p);

    expect(saved?.removed).toEqual([]);
    expect(ids(saved?.photos ?? [])).toEqual([inA[0].id, inA[2].id, "again"]);
    expect(ids(reopened.photos)).toEqual([inA[0].id, "again", inA[2].id]);
  });

  it("drops the virtual copies of a photo another window removes", async () => {
    // B removes the master without showing A's copy of it: removing a master
    // takes its copies with it, in every window.
    const { p, a, b, inA } = await twoWindows();
    const byA = takenOnBy(a);
    await a.putPhotos([{ ...inA[0], id: "copy-1", copyOf: inA[0].id, copyName: "copy" }]);

    await b.deletePhoto(inA[0].id);
    await b.flush();

    expect(ids(await a.getAllPhotos())).not.toContain("copy-1");
    expect(byA.at(-1)?.deletedIds).toEqual([inA[0].id, "copy-1"]);
    expect(ids(catalog(p)?.photos ?? [])).not.toContain("copy-1");
  });

  it("sends the photos a window finds when it opens the folder again", async () => {
    const { p, b, inB } = await twoWindows();
    p.fs.put(`${p.rootPath}/d.jpg`, "D");

    const again = await open(p); // A's window opens the folder again and imports d.jpg
    await savesOwnChange(b, inB[2]);

    expect(rels(catalog(p)?.photos ?? [])).toContain("d.jpg");
    expect(ids(await b.getAllPhotos())).not.toContain(again.newPhotos[0].id);
  });

  it("refuses a stale write for a photo another window removed", async () => {
    const { p, a, b, inB } = await twoWindows();
    await a.deletePhoto(inB[1].id);

    // e.g. a decode that began before the removal arrived writes its photo back
    await b.putPhoto({ ...inB[1], exif: { colorTemperature: 5000 } });
    await savesOwnChange(b, inB[2]);

    expect(ids(await b.getAllPhotos())).not.toContain(inB[1].id);
    const reopened = await open(p);
    expect(ids(reopened.photos)).not.toContain(inB[1].id);
  });

  it("sends a photo's records in the order it stores them", async () => {
    const { p, a, b, inA } = await twoWindows();
    const turned = new Blob(["turned"]);
    const writes = p.fs.holdWrites();

    const first = a.putPhoto({ ...inA[1], rating: 1, thumbnailBlob: turned }); // a new preview to write
    const second = a.putPhoto({ ...inA[1], rating: 2, thumbnailBlob: turned }); // nothing to write
    await second;
    writes.landAll();
    await first;

    expect((await b.getAllPhotos())[1].rating).toBe(2);
  });

  it("sends an edit before its save lands", async () => {
    const { p, a, b, inA } = await twoWindows();
    const before = catalogWrites(p);
    const writes = p.fs.holdWrites();

    const saved = a.putEditState(edit(inA[0].id, "From A"));
    await vi.waitFor(() => expect(catalogWrites(p) - before).toBe(1));

    await expect(b.getEditState(inA[0].id)).resolves.toEqual(edit(inA[0].id, "From A"));
    writes.landAll();
    await saved;
  });

  it("heals a save B had running when A's records arrived", async () => {
    const { p, a, b, inA, inB } = await twoWindows();
    const before = catalogWrites(p);
    const writes = p.fs.holdWrites();

    void b.putPhoto({ ...inB[2], flag: "pick" });
    const bSaved = b.flush(); // B's copy doesn't have A's edit yet
    await vi.waitFor(() => expect(catalogWrites(p) - before).toBe(1));
    const aSaved = a.putEditState(edit(inA[0].id, "From A"));
    await vi.waitFor(() => expect(catalogWrites(p) - before).toBe(2));
    writes.landLatest(); // A's write lands first ...
    await aSaved;
    writes.landAll(); // ... and B's, without A's edit, after it
    await bSaved;

    expect(labelsOnDisk(p)).toEqual({});
    await vi.advanceTimersByTimeAsync(1000);
    expect(labelsOnDisk(p)).toEqual({ [inA[0].id]: "From A" });
    const healed = catalogWrites(p);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(catalogWrites(p)).toBe(healed); // the repair isn't sent on, so nothing repeats
  });

  it("writes its pending save at once when the window leaves the catalog", async () => {
    // Left to its debounce, B's save would land after A's next change, and B no
    // longer takes A's changes on to repair it.
    const { p, a, b, inA, inB } = await twoWindows();
    const before = catalogWrites(p);
    const writes = p.fs.holdWrites();
    await b.putPhoto({ ...inB[1], rating: 2 });

    setCatalogStorage(b);
    setCatalogStorage(null); // the window opens another project
    const aSaved = a.putEditState(edit(inA[0].id, "From A"));
    await vi.waitFor(() => expect(catalogWrites(p) - before).toBe(2));
    writes.landAll();
    await aSaved;
    await vi.advanceTimersByTimeAsync(10_000);

    expect(labelsOnDisk(p)).toEqual({ [inA[0].id]: "From A" });
    expect(catalog(p)?.photos.find((photo) => photo.id === inA[1].id)?.rating).toBe(2);
  });

  it("leaves the file to A when B's last save ended before A's change", async () => {
    const { p, a, b, inA, inB } = await twoWindows();
    await savesOwnChange(b, inB[2]);
    await vi.advanceTimersByTimeAsync(5000);
    await a.putPhoto({ ...inA[0], id: "copy-1", copyOf: inA[0].id, copyName: "copy" });

    await a.putEditState(edit(inA[1].id, "From A"));
    await vi.advanceTimersByTimeAsync(10_000);

    expect(ids(catalog(p)?.photos ?? [])).toContain("copy-1");
    expect(labelsOnDisk(p)).toEqual({ [inA[1].id]: "From A" });
  });

  it("sends a batch as one message of stored records", async () => {
    const { a, b, inA } = await twoWindows();
    const sent: CatalogRecords[] = [];
    stops.push(
      onBroadcast((message) => {
        if (message.type === "catalog-records") sent.push(message.payload);
      }),
    );
    const byB = takenOnBy(b);

    await a.putEditStates(inA.map((photo) => edit(photo.id, "Batch")));
    await a.putPhotos(inA.map((photo) => ({ ...photo, flag: "pick" as const })));

    expect(sent.map((records) => [records.edits.length, records.photos.length])).toEqual([
      [3, 0],
      [0, 3],
    ]);
    for (const record of sent[1].photos)
      for (const local of ["directoryHandle", "fileHandle", "thumbnailBlob", "thumbnailUrl"])
        expect(record).not.toHaveProperty(local);
    expect(byB).toHaveLength(2);
    expect((await b.getAllPhotos()).map((photo) => photo.flag)).toEqual(["pick", "pick", "pick"]);
  });

  it("takes on what A writes while B is opening, and B's open reports it", async () => {
    const p = mount(cfg, FILES);
    const a = await open(p);
    await a.storage.flush();

    const b = await open(p, {
      // B has read the catalog and is about to scan the folder.
      onSkeletons: () => void a.storage.putPhoto({ ...a.photos[1], rating: 5 }),
    });

    expect(b.photos[1].rating).toBe(5);
    expect((await b.storage.getAllPhotos())[1].rating).toBe(5);
  });

  it("stops taking on records once the window installs another catalog", async () => {
    const { a, b, inA } = await twoWindows();
    setCatalogStorage(b);
    await a.putEditState(edit(inA[0].id, "Before"));
    const listening = FakeChannel.listening();

    setCatalogStorage(null);
    await a.putEditState(edit(inA[0].id, "After"));

    expect((await b.getEditState(inA[0].id))?.stack[0].label).toBe("Before");
    expect(FakeChannel.listening()).toBe(listening - 1);
  });

  it("stops following when its open fails", async () => {
    const p = mount(cfg, FILES, "/data/catalogs/photos/.safelight");
    const a = await open(p);
    await a.storage.flush();
    const listening = FakeChannel.listening();
    await p.fs.remove(p.rootPath); // the folder is gone, so the scan fails

    await expect(open(p, { onSkeletons: () => {} })).rejects.toThrow();

    expect(FakeChannel.listening()).toBe(listening);
  });

  it("takes on what A writes while a save that failed as B left waits to be tried again", async () => {
    // B's next try writes B's copy, which must not undo A's change.
    const { p, a, b, inA, inB } = await twoWindows();
    p.fs.failWrites(/[\\/]catalog\.json$/, "EBUSY", 1);
    await b.putPhoto({ ...inB[1], rating: 2 });
    b.close(); // its write fails, and is tried again in a few seconds
    await vi.advanceTimersByTimeAsync(0);
    await a.putEditState(edit(inA[0].id, "From A"));

    await vi.advanceTimersByTimeAsync(60_000);

    expect(labelsOnDisk(p)).toEqual({ [inA[0].id]: "From A" });
    expect(catalog(p)?.photos.find((photo) => photo.id === inB[1].id)?.rating).toBe(2);
  });

  it("saves a change B holds once A, whose window left, gives up saving it", async () => {
    // B took A's edit on and left the file to A, so nothing else would write it.
    const { p, a, inA } = await twoWindows();
    p.fs.failWrites(/[\\/]catalog\.json$/, "EBUSY");
    await a.putEditState(edit(inA[0].id, "From A"));
    a.close();
    await vi.advanceTimersByTimeAsync(10 * 60_000); // A tries a few more times, then gives up
    p.fs.stopFailingWrites();

    await vi.advanceTimersByTimeAsync(60_000);

    expect(labelsOnDisk(p)).toEqual({ [inA[0].id]: "From A" });
  });

  it("leaves a change A gave up on to the windows that heard it", async () => {
    // C opened after A's edit, from a file without it: a save of C's would drop it.
    const { p, a, inA } = await twoWindows();
    p.fs.failWrites(/[\\/]catalog\.json$/, "EBUSY");
    await a.putEditState(edit(inA[0].id, "From A")); // B takes it on
    await open(p);
    await vi.advanceTimersByTimeAsync(5000);
    stops.push(
      onBroadcast((message) => {
        if (message.type === "catalog-records" && message.payload.unsaved)
          p.fs.stopFailingWrites();
      }),
    );

    a.close();
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    expect(labelsOnDisk(p)).toEqual({ [inA[0].id]: "From A" });
  });
});

describe("a change the other windows can't be told about", () => {
  // A message carries only what structured clone can copy; a function in an
  // extension's parameters, say, makes the send throw. The change is still this
  // window's own: it is stored and saved, and an open that found it goes on.
  const cfg = BUILDS[1];
  const FILES = { "a.jpg": "A", "b.jpg": "B", "c.jpg": "C" };

  const saysSo = () =>
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("other windows"),
      expect.objectContaining({ name: "DataCloneError" }),
    );

  it("still saves an edit that can't be sent, and says so once", async () => {
    const p = mount(cfg, FILES);
    const { storage, photos } = await open(p);
    await storage.flush();
    const plain = edit(photos[0].id, "Odd");
    const odd = { ...plain, stack: [{ ...plain.stack[0], paramBag: { "ext.callback": () => 1 } }] };

    await storage.putEditState(odd);

    expect(labelsOnDisk(p)).toEqual({ [photos[0].id]: "Odd" });
    await expect(storage.getEditState(photos[0].id)).resolves.toBe(odd);
    expect(console.warn).toHaveBeenCalledTimes(1);
    saysSo();
  });

  it.each([
    ["closes", (a: ProjectStorage) => a.flush({ unloading: true })],
    ["leaves the project: a flush, then close", async (a: ProjectStorage) => {
      await a.flush();
      a.close();
    }],
    ["is closed", async (a: ProjectStorage) => a.close()],
  ])("writes it again when its window %s, after another window's save dropped it", async (
    _how,
    leave,
  ) => {
    // The other windows never held it, so any save of theirs leaves it out.
    const p = mount(cfg, FILES);
    const a = await open(p);
    await a.storage.flush();
    const b = await open(p);
    const plain = edit(a.photos[0].id, "Odd");
    const odd = { ...plain, stack: [{ ...plain.stack[0], paramBag: { "ext.callback": () => 1 } }] };
    await a.storage.putEditState(odd);
    await vi.advanceTimersByTimeAsync(1000);
    await b.storage.putPhoto({ ...b.photos[2], flag: "pick" }); // B saves for its own reason
    await b.storage.flush();
    expect(labelsOnDisk(p)).toEqual({});

    await leave(a.storage);
    await vi.advanceTimersByTimeAsync(0);

    expect(labelsOnDisk(p)).toEqual({ [a.photos[0].id]: "Odd" });
  });

  it("still saves a photo that can't be sent, with its preview, and says so once", async () => {
    const p = mount(cfg, FILES);
    const { storage, photos } = await open(p);
    await storage.flush();
    const exif = { cameraMake: "Odd", callback: () => 1 };

    await storage.putPhoto({ ...photos[1], exif, thumbnailBlob: new Blob(["turned"]) });
    await storage.flush();

    expect(p.fs.text(`${p.slPath}/previews/${photos[1].id}.jpg`)).toBe("turned");
    expect(catalog(p)?.photos.find((photo) => photo.id === photos[1].id)?.exif).toEqual({
      cameraMake: "Odd",
    });
    expect(console.warn).toHaveBeenCalledTimes(1);
    saysSo();
  });

  it("opens the project when the photos it found can't be sent, and says so once", async () => {
    const exif = { cameraMake: "Odd", callback: () => 1 };
    h.importOverride = { exif };
    const p = mount(cfg, FILES);

    const opened = await open(p);
    await opened.storage.flush();

    expect(rels(opened.photos)).toEqual(["a.jpg", "b.jpg", "c.jpg"]);
    expect(ids(opened.newPhotos)).toEqual(ids(opened.photos));
    expect(rels(catalog(p)?.photos ?? [])).toEqual(["a.jpg", "b.jpg", "c.jpg"]);
    expect(console.warn).toHaveBeenCalledTimes(1);
    saysSo();
  });
});

describe("a window that closes while its own open is still running", () => {
  // What the other windows write while a window opens the project is held until
  // the open ends. A window that closes first mustn't write its copy without it:
  // if that write lands last, it undoes the other window's change.
  const cfg = BUILDS[1];
  const FILES = { "a.jpg": "A", "b.jpg": "B", "c.jpg": "C" };

  /** A has saved the project and B is opening it. Once B has painted the saved
   *  photos, B flags the last one (a change of its own, to save), A starts saving
   *  a new edit of the first photo, which B can only hold, and `leave` runs with
   *  B's storage. Every catalog write from then on is held. */
  async function leavingMidOpen(
    leave: (b: ProjectStorage, skeletons: CatalogPhoto[]) => Promise<void>,
  ) {
    const p = mount(cfg, FILES);
    const a = await open(p);
    await a.storage.flush();
    const photoId = a.photos[0].id;
    const before = catalogWrites(p);
    const writes = p.fs.holdWrites();
    let saved: Promise<void> = Promise.resolve();
    let left: Promise<void> = Promise.resolve();
    await open(p, {
      onSkeletons: (storage, _rawCacheDir, skeletons) => {
        void storage.putPhoto({ ...skeletons[2], flag: "pick" });
        saved = a.storage.putEditState(edit(photoId, "From A"));
        left = leave(storage, skeletons);
      },
    });
    await vi.waitFor(() => expect(catalogWrites(p) - before).toBe(2));
    return { p, photoId, writes, saved, left };
  }

  it("writes what it was holding when its window quits", async () => {
    const { p, photoId, writes, saved, left } = await leavingMidOpen(
      async (b) => b.flush({ unloading: true }),
    );

    writes.landNext(); // A's write lands first
    await saved;
    writes.landAll(); // then the quitting window's, which stays
    await left;

    expect(labelsOnDisk(p)).toEqual({ [photoId]: "From A" });
  });

  it("writes what it was holding when it leaves the catalog with a save pending", async () => {
    const { p, photoId, writes, saved } = await leavingMidOpen(async (b, skeletons) => {
      void b.putPhoto({ ...skeletons[1], rating: 2 }); // a save of its own is pending
      b.close();
    });

    writes.landNext();
    await saved;
    writes.landAll();
    await vi.advanceTimersByTimeAsync(0);

    expect(labelsOnDisk(p)).toEqual({ [photoId]: "From A" });
  });

  it("writes what it was holding when the project is closed: a flush, then close", async () => {
    const { p, photoId, writes, saved } = await leavingMidOpen(async (b) => {
      void b.flush();
      b.close();
    });

    writes.landNext();
    await saved;
    writes.landNext(); // the flush's write, which doesn't hold A's edit yet
    await vi.advanceTimersByTimeAsync(0); // the write close() queued behind it starts
    writes.landAll();
    await vi.advanceTimersByTimeAsync(0);

    expect(labelsOnDisk(p)).toEqual({ [photoId]: "From A" });
  });

  it("reports what it holds once, as it arrives, and not when the window leaves", async () => {
    // The window leaving runs no app code. A record of a photo the open shows is
    // taken on, and reported, as it arrives, before the open ends.
    const reports: { from: ProjectStorage; records: CatalogRecords }[] = [];
    const leaving: { storage?: ProjectStorage } = {};
    const stop = onRemoteRecords((records, from) => void reports.push({ from, records }));
    try {
      const { photoId, writes, saved, left } = await leavingMidOpen(async (b) => {
        leaving.storage = b;
        return b.flush({ unloading: true });
      });
      writes.landAll();
      await Promise.all([saved, left]);

      expect(reports.filter((r) => r.from === leaving.storage).map((r) => r.records)).toEqual([
        { edits: [edit(photoId, "From A")], photos: [], deletedIds: [] },
      ]);
    } finally {
      stop();
    }
  });

  it.each([
    ["is closed", (b: ProjectStorage) => b.close()],
    ["flushes as it unloads", (b: ProjectStorage) => void b.flush({ unloading: true })],
  ])("still takes it on when its open ends after the window %s", async (_how, leave) => {
    // The open runs on after the window left (or a closing page stays open): it
    // imports the new file and saves, and those saves must carry it too.
    const p = mount(cfg, FILES);
    const a = await open(p);
    await a.storage.flush();
    p.fs.put(`${p.rootPath}/d.jpg`, "D");

    await open(p, {
      onSkeletons: (storage) => {
        void a.storage.putPhoto({ ...a.photos[1], rating: 4 });
        void a.storage.flush();
        a.storage.close(); // A has written all it will
        leave(storage);
      },
    });
    await vi.advanceTimersByTimeAsync(5000);

    const saved = catalog(p)?.photos ?? [];
    expect(rels(saved)).toContain("d.jpg"); // B's save landed, last
    expect(saved.find((photo) => photo.id === a.photos[1].id)?.rating).toBe(4);
  });

  /** A has saved the project and c.jpg has since left the folder, so B's walk
   *  saves at its end. B's window leaves the project once B has painted the saved
   *  photos, and A rates the second photo after that. */
  async function closedMidOpen() {
    const p = mount(cfg, FILES);
    const a = await open(p);
    await a.storage.flush();
    await p.fs.remove(`${p.rootPath}/c.jpg`);
    const rated = a.photos[1];
    const listening = FakeChannel.listening();
    const reports: CatalogRecords[] = [];
    const stop = onRemoteRecords((records, from) => {
      if (from !== a.storage) reports.push(records);
    });
    await open(p, {
      onSkeletons: (b) => {
        b.close();
        void a.storage.putPhoto({ ...rated, rating: 5 });
      },
    });
    return { p, rated, listening, reports, stop };
  }

  it("takes on a change made after it closed into the save its walk ends with", async () => {
    const { p, rated, stop } = await closedMidOpen();
    stop();

    await vi.advanceTimersByTimeAsync(5000); // both saves land, B's last

    const saved = catalog(p)?.photos ?? [];
    expect(rels(saved)).not.toContain("c.jpg"); // B's save landed
    expect(saved.find((photo) => photo.id === rated.id)?.rating).toBe(5);
  });

  it("takes a change made after it closed into a write it makes before its walk ends", async () => {
    // A write through it lands mid-walk (a last edit committed as the window left).
    // If the app quits before the walk ends, nothing repairs that write later.
    const p = mount(cfg, FILES);
    const a = await open(p);
    await a.storage.flush();
    p.fs.put(`${p.rootPath}/d.jpg`, "D"); // B's walk imports it
    const [first, second] = a.photos;
    let left: ProjectStorage | null = null;

    await open(p, {
      onSkeletons: (b) => {
        left = b;
        b.close();
        void a.storage.putEditState(edit(first.id, "From A")); // saved at once
      },
      onPhoto: () => void left?.putEditState(edit(second.id, "Late")),
    });

    expect(labelsOnDisk(p)).toEqual({ [first.id]: "From A", [second.id]: "Late" });
  });

  it("follows the other windows, reporting nothing, until that save has landed", async () => {
    const { listening, reports, stop } = await closedMidOpen();
    try {
      expect(FakeChannel.listening()).toBe(listening + 1);
      await vi.advanceTimersByTimeAsync(5000);

      expect(FakeChannel.listening()).toBe(listening);
      expect(reports).toEqual([]);
    } finally {
      stop();
    }
  });
});

describe.each(BUILDS)("changes made while the folder opens ($label)", (cfg) => {
  // The grid shows the saved photos before the folder is walked, and what the user
  // does to them meanwhile is stored at once. The walk attaches each photo to its
  // file and finds the new ones without undoing any of it.
  const FILES = { "a.jpg": "A", "b.jpg": "B", "c.jpg": "C" };

  /** A project imported and saved once, by a window that has since closed it. */
  async function savedProject(files: Record<string, string> = FILES) {
    const p = mount(cfg, files);
    const first = await open(p);
    await first.storage.flush();
    first.storage.close();
    return { p, first };
  }

  it("keeps what is stored for a photo before the walk reaches its file", async () => {
    const { p } = await savedProject();
    const changed: Partial<CatalogPhoto> = {
      rating: 5,
      colorLabel: "red",
      flag: "pick",
      keywords: ["dawn"],
      rotation: 90,
    };

    const second = await open(p, {
      onSkeletons: (storage, _raw, skeletons) =>
        void storage.putPhoto({ ...skeletons[0], ...changed }),
    });
    await second.storage.flush();

    expect(second.photos[0]).toMatchObject(changed);
    expect(second.photos[0].fileHandle).not.toBeNull();
    expect(catalog(p)?.photos[0]).toMatchObject(changed);
  });

  it("keeps a change stored after the walk passed the photo, as a new file decodes", async () => {
    const { p } = await savedProject({ "a.jpg": "A" });
    p.fs.put(`${p.rootPath}/b.jpg`, "B");
    let painted: { storage: ProjectStorage; skeleton: CatalogPhoto } | null = null;

    const second = await open(p, {
      onSkeletons: (storage, _raw, skeletons) => (painted = { storage, skeleton: skeletons[0] }),
      onPhoto: () => {
        if (painted) void painted.storage.putPhoto({ ...painted.skeleton, rating: 4 });
      },
    });

    const a = second.photos.find((photo) => photo.relPath === "a.jpg");
    expect(a?.rating).toBe(4);
    expect(a?.fileHandle).not.toBeNull();
  });

  it("keeps a photo removed during the open out, now and on the next open", async () => {
    const { p, first } = await savedProject();
    const gone = first.photos[0];

    const second = await open(p, { onSkeletons: (storage) => void storage.deletePhoto(gone.id) });
    await second.storage.flush();
    second.storage.close();
    const third = await open(p);

    expect(ids(second.photos)).not.toContain(gone.id);
    expect(ids(catalog(p)?.photos ?? [])).not.toContain(gone.id);
    expect(rels(third.photos)).not.toContain(gone.relPath);
  });

  it("keeps a photo it has just found out once it is removed during the open", async () => {
    const { p } = await savedProject({ "a.jpg": "A" });
    p.fs.put(`${p.rootPath}/b.jpg`, "B");
    let storage: ProjectStorage | null = null;

    const second = await open(p, {
      onSkeletons: (opening) => (storage = opening),
      onPhoto: (found) => void storage?.deletePhoto(found.id),
    });
    await second.storage.flush();

    expect(rels(second.photos)).toEqual(["a.jpg"]);
    expect(rels(catalog(p)?.photos ?? [])).toEqual(["a.jpg"]);
  });

  it("keeps a virtual copy made during the open, right after its master", async () => {
    const { p, first } = await savedProject();

    const second = await open(p, {
      onSkeletons: (storage, _raw, skeletons) =>
        void storage.putPhotos([
          { ...skeletons[0], id: "copy-1", copyOf: skeletons[0].id, copyName: "copy" },
        ]),
    });
    await second.storage.flush();

    const [master, ...rest] = ids(first.photos);
    expect(ids(second.photos)).toEqual([master, "copy-1", ...rest]);
    expect(second.photos[1].fileHandle).toBe(second.photos[0].fileHandle);
    expect(ids(catalog(p)?.photos ?? [])).toContain("copy-1");
  });

  it("keeps a saved virtual copy removed during the open out", async () => {
    const p = mount(cfg, FILES);
    const first = await open(p);
    const master = first.photos[0];
    await first.storage.putPhoto({ ...master, id: "copy-1", copyOf: master.id, copyName: "copy" });
    await first.storage.flush();
    first.storage.close();

    const second = await open(p, {
      onSkeletons: (storage) => void storage.deletePhoto("copy-1"),
    });
    await second.storage.flush();

    expect(ids(second.photos)).toEqual(ids(first.photos));
    expect(ids(catalog(p)?.photos ?? [])).toEqual(ids(first.photos));
  });

  it("drops a copy made during the open whose master's file is gone", async () => {
    const { p, first } = await savedProject();
    const [master, ...rest] = first.photos;
    await p.fs.remove(`${p.rootPath}/${master.relPath}`);

    const second = await open(p, {
      onSkeletons: (storage, _raw, skeletons) => {
        const skeleton = skeletons.find((photo) => photo.id === master.id);
        if (!skeleton) return;
        void storage.putPhotos([{ ...skeleton, id: "copy-1", copyOf: master.id }]);
        void storage.putEditState(edit("copy-1", "Copy look"));
      },
    });
    await second.storage.flush();

    expect(ids(second.photos)).toEqual(ids(rest));
    expect(ids(catalog(p)?.photos ?? [])).toEqual(ids(rest));
    expect(labelsOnDisk(p)).toEqual({});
  });

  it("keeps a saved photo removed after the walk passed its file out", async () => {
    const { p, first } = await savedProject({ "a.jpg": "A" });
    p.fs.put(`${p.rootPath}/b.jpg`, "B");
    const gone = first.photos[0];
    let storage: ProjectStorage | null = null;

    const second = await open(p, {
      onSkeletons: (opening) => (storage = opening),
      onPhoto: () => void storage?.deletePhoto(gone.id), // b.jpg decodes after a.jpg is walked
    });
    await second.storage.flush();
    second.storage.close();
    const third = await open(p);

    expect(rels(second.photos)).toEqual(["b.jpg"]);
    expect(rels(catalog(p)?.photos ?? [])).toEqual(["b.jpg"]);
    expect(rels(third.photos)).toEqual(["b.jpg"]);
  });

  it("keeps a copy name given during the open", async () => {
    const p = mount(cfg, FILES);
    const first = await open(p);
    const master = first.photos[0];
    await first.storage.putPhoto({ ...master, id: "copy-1", copyOf: master.id, copyName: "copy" });
    await first.storage.flush();
    first.storage.close();

    const second = await open(p, {
      onSkeletons: (storage, _raw, skeletons) => {
        const copy = skeletons.find((photo) => photo.id === "copy-1");
        if (copy) void storage.putPhoto({ ...copy, copyName: "print" });
      },
    });

    expect(second.photos.find((photo) => photo.id === "copy-1")?.copyName).toBe("print");
  });

  it("keeps a photo moved during the open in its new folder", async () => {
    // The move lands after the scan listed the folder, while a new file decodes.
    const { p } = await savedProject({ "a.jpg": "A" });
    p.fs.put(`${p.rootPath}/b.jpg`, "B");
    let painted: { storage: ProjectStorage; skeleton: CatalogPhoto } | null = null;

    const second = await open(p, {
      onSkeletons: (storage, _raw, skeletons) => (painted = { storage, skeleton: skeletons[0] }),
      onPhoto: () => {
        if (!painted) return;
        void p.fs.move(`${p.rootPath}/a.jpg`, `${p.rootPath}/trip/a.jpg`);
        const moved = { ...painted.skeleton, relPath: "trip/a.jpg", folder: "trip" };
        void painted.storage.putPhoto(moved);
      },
    });
    await second.storage.flush();

    expect(rels(second.photos)).toEqual(["trip/a.jpg", "b.jpg"]);
    expect(second.photos[0].folder).toBe("trip");
    expect(rels(catalog(p)?.photos ?? [])).toEqual(["trip/a.jpg", "b.jpg"]);
  });

  it("keeps an edit stored during the open", async () => {
    const { p, first } = await savedProject();
    const id = first.photos[0].id;

    const second = await open(p, {
      onSkeletons: (storage) => void storage.putEditState(edit(id, "Kept")),
    });

    await expect(second.storage.getEditState(id)).resolves.toEqual(edit(id, "Kept"));
  });

  it("hands a first open's storage over before it imports the first photo", async () => {
    const p = mount(cfg, FILES);
    const events: string[] = [];
    let handed: ProjectStorage | null = null;

    const opened = await open(p, {
      onSkeletons: (storage, _raw, skeletons) => {
        handed = storage;
        events.push(`painted ${skeletons.length}`);
      },
      onPhoto: () => void events.push("photo"),
    });

    expect(events).toEqual(["painted 0", "photo", "photo", "photo"]);
    expect(handed).toBe(opened.storage);
  });
});
