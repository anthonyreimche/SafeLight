// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CatalogPhoto, EditState } from "@/catalog/types";
import type { NativeFsBridge } from "@/extensions/types";
import type { WorkingDir } from "./working-dir";
import { MemoryFs, fsaDirectoryHandle } from "./memory-fs.test-support";

const h = vi.hoisted(() => ({
  fs: null as NativeFsBridge | null,
  wd: null as WorkingDir | null,
  persistPreviews: true,
  /** Overrides an extension contributes on import, or null for none. */
  importOverride: null as Partial<CatalogPhoto> | null,
  /** Bumped per buildPhoto call so a re-imported file gets a NEW id — which is
   *  how the tests tell "reused the saved record" from "decoded it again". */
  built: 0,
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
  buildPreviewBlob: async (photo: CatalogPhoto) =>
    photo.fileHandle ? new Blob([`rebuilt:${photo.filename}`]) : null,
}));

import { ProjectStorage, type OpenedProject } from "./project-storage";
import { nativeDirectoryHandle } from "./native-fs";

// The catalog is adapter-agnostic — it derives everything from the one working-
// dir handle — so both builds must produce byte-identical catalogs.
const BUILDS = [
  { label: "electron · windows", rootPath: "D:\\DCIM", native: true },
  { label: "browser · FSA", rootPath: "/home/u/photos", native: false },
] as const;

interface Project {
  fs: MemoryFs;
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
  const fs = new MemoryFs(cfg.rootPath);
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
  photos: CatalogPhoto[];
  edits: EditState[];
  removed?: string[];
}

function catalog(p: Project): StoredCatalog | null {
  const raw = p.fs.text(`${p.slPath}/catalog.json`);
  return raw === null ? null : (JSON.parse(raw) as StoredCatalog);
}

const ids = (photos: CatalogPhoto[]) => photos.map((x) => x.id);
const rels = (photos: CatalogPhoto[]) => photos.map((x) => x.relPath);

const edit = (photoId: string, label: string): EditState => ({
  photoId,
  stack: [{ timestamp: 1, label, params: {} as EditState["stack"][0]["params"] }],
  currentIndex: 0,
});

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
  return ProjectStorage.open(
    p.root,
    opts.onPhoto,
    opts.onSkeletons,
    opts.onProgress,
    opts.signal,
  );
}

beforeEach(() => {
  h.fs = null;
  h.wd = null;
  h.persistPreviews = true;
  h.importOverride = null;
  h.built = 0;
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
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
