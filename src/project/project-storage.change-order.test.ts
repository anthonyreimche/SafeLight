// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Windows that share a catalog must end with the newer of two changes to a
// record, whatever order the records reach them in: a window opening before
// another's change has landed in catalog.json, and records arriving while a
// window's open still walks the folder.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CatalogPhoto, EditState } from "@/catalog/types";
import type { NativeFsBridge } from "@/extensions/types";
import type { WorkingDir } from "./working-dir";
import { MemoryFs, FsError, fsaDirectoryHandle } from "./memory-fs.test-support";

const h = vi.hoisted(() => ({
  fs: null as NativeFsBridge | null,
  wd: null as WorkingDir | null,
  persistPreviews: true,
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
vi.mock("@/extensions/registry", () => ({ emitPhotoImport: async () => null }));
vi.mock("@/modules/library/import-photos", () => ({
  isSupportedName: (name: string) => /\.(jpe?g)$/i.test(name),
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
import type { CatalogStorage } from "@/catalog/storage";
import { onBroadcast, type SentCatalogRecords } from "@/state/broadcast";

/** A MemoryFs whose next writes to chosen files fail with an errno, as they do
 *  while a sync or antivirus program holds the file. */
class FlakyFs extends MemoryFs {
  failingWrites: { path: RegExp; code: string; left: number } | null = null;
  /** Runs once, as the next read of catalog.json starts. */
  onCatalogRead: (() => void) | null = null;
  /** While set, the next read of catalog.json takes its bytes at once, then waits
   *  for it. */
  readGate: Promise<void> | null = null;
  override async read(path: string): Promise<{ data: Uint8Array; mtimeMs: number; size: number }> {
    const catalogRead = /catalog\.json$/.test(path);
    const run = catalogRead ? this.onCatalogRead : null;
    if (run) {
      this.onCatalogRead = null;
      run();
    }
    const gate = catalogRead ? this.readGate : null;
    const read = await super.read(path);
    if (gate) {
      this.readGate = null;
      await gate;
    }
    return read;
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

/** Stands in for the BroadcastChannel: the storages a test opens share one window,
 *  so broadcast's same-window fan-out carries messages between them. */
class FakeChannel {
  readonly listeners = new Set<unknown>();
  postMessage(message: unknown): void {
    structuredClone(message);
  }
  addEventListener(_type: string, listener: unknown): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: string, listener: unknown): void {
    this.listeners.delete(listener);
  }
}

const BUILDS = [
  { label: "electron", rootPath: "D:\\DCIM", native: true },
  { label: "browser", rootPath: "/home/u/photos", native: false },
] as const;

function mount(cfg: { rootPath: string; native: boolean }, files: Record<string, string>) {
  const fs = new FlakyFs(cfg.rootPath);
  for (const [rel, body] of Object.entries(files)) fs.put(`${cfg.rootPath}/${rel}`, body);
  h.fs = cfg.native ? fs : null;
  const dir = (p: string) => (cfg.native ? nativeDirectoryHandle(p) : fsaDirectoryHandle(fs, p));
  const sl = `${cfg.rootPath}/.safelight`;
  h.wd = { sl: dir(sl), location: "in-folder", externalPath: null, promotedFromExternal: null };
  return { fs, rootPath: cfg.rootPath, slPath: sl, root: dir(cfg.rootPath) };
}
type Project = ReturnType<typeof mount>;

interface Saved {
  photos: CatalogPhoto[];
  edits: EditState[];
  removed?: string[];
  changed?: { photos: Record<string, Record<string, unknown>>; edits: Record<string, unknown> };
}

function catalog(p: Project): Saved | null {
  const raw = p.fs.text(`${p.slPath}/catalog.json`);
  return raw === null ? null : JSON.parse(raw);
}

/** The catalog-records messages sent from now on, as the other windows get them. */
function sentRecords(): SentCatalogRecords[] {
  const sent: SentCatalogRecords[] = [];
  const stop = onBroadcast((message) => {
    if (message.type === "catalog-records") sent.push(message.payload);
  });
  stoppers.push(stop);
  return sent;
}
const stoppers: (() => void)[] = [];

const edit = (photoId: string, label: string): EditState => ({
  photoId,
  stack: [{ timestamp: 1, label, params: {} as EditState["stack"][0]["params"] }],
  currentIndex: 0,
});

const opened: CatalogStorage[] = [];
async function open(
  p: Project,
  opts: {
    onSkeletons?: (s: ProjectStorage, raw: FileSystemDirectoryHandle, sks: CatalogPhoto[]) => void;
    onPhoto?: (photo: CatalogPhoto) => void;
  } = {},
): Promise<OpenedProject> {
  const o = await ProjectStorage.open(p.root, opts.onPhoto, opts.onSkeletons);
  opened.push(o.storage);
  return o;
}

beforeEach(() => {
  h.fs = null;
  h.wd = null;
  h.persistPreviews = true;
  h.built = 0;
  vi.stubGlobal("BroadcastChannel", FakeChannel);
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const stop of stoppers.splice(0)) stop();
  for (const storage of opened.splice(0)) storage.close?.();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.each(BUILDS)("a window that opens before another's change lands ($label)", (cfg) => {
  it("keeps the main window's rating on disk after the pop-out saves and the main window quits", async () => {
    const p = mount(cfg, { "a.jpg": "A", "b.jpg": "B" });
    const a = await open(p); // the main window
    await a.storage.flush();
    const photo = a.photos[0];

    void a.storage.putPhoto({ ...photo, rating: 5 }); // saved after the 800 ms debounce
    const b = await open(p); // a pop-out opens now, reading catalog.json first
    await vi.advanceTimersByTimeAsync(2000); // A's save lands
    expect(catalog(p)?.photos.find((x) => x.id === photo.id)?.rating).toBe(5);
    await vi.advanceTimersByTimeAsync(5000);
    await b.storage.putEditState(edit(b.photos[1].id, "Pop-out edit")); // saved at once
    await vi.advanceTimersByTimeAsync(5000);
    await a.storage.flush({ unloading: true }); // the app quits

    const inB = b.photos.find((x) => x.id === photo.id)?.rating;
    const onDisk = catalog(p)?.photos.find((x) => x.id === photo.id)?.rating;
    expect({ inB, onDisk }).toEqual({ inB: 5, onDisk: 5 });
  });

  it("keeps a change whose save was failing when the pop-out opened", async () => {
    const p = mount(cfg, { "a.jpg": "A", "b.jpg": "B" });
    const a = await open(p);
    await a.storage.flush();
    const photo = a.photos[0];
    p.fs.failingWrites = { path: /catalog\.json$/, code: "EBUSY", left: 2 };

    await a.storage.putEditState(edit(photo.id, "Main edit")); // fails, retried in 2 s
    const b = await open(p); // a pop-out opens while the save keeps failing
    await vi.advanceTimersByTimeAsync(60_000); // A's retries land
    const landed = catalog(p)?.edits.find((e) => e.photoId === photo.id)?.stack[0].label;
    expect(landed).toBe("Main edit");
    await b.storage.putPhoto({ ...b.photos[1], rating: 3 });
    await vi.advanceTimersByTimeAsync(5000);
    await a.storage.flush({ unloading: true });

    const onDisk = catalog(p)?.edits.find((e) => e.photoId === photo.id)?.stack[0].label;
    expect(onDisk).toBe("Main edit");
  });
});

describe.each(BUILDS)("records that arrive while a window's open walks the folder ($label)", (cfg) => {
  it("don't undo an edit the opening window made after them", async () => {
    const p = mount(cfg, { "a.jpg": "A", "b.jpg": "B" });
    const a = await open(p);
    await a.storage.flush();
    const id = a.photos[0].id;
    p.fs.put(`${p.rootPath}/c.jpg`, "C"); // B's walk has a file to import

    let b: ProjectStorage | null = null;
    const second = await open(p, {
      onSkeletons: (storage) => {
        b = storage;
        void a.storage.putEditState(edit(id, "From A")); // first, in A
      },
      onPhoto: () => void b?.putEditState(edit(id, "From B")), // later, in B
    });
    await vi.advanceTimersByTimeAsync(5000);

    const inA = (await a.storage.getEditState(id))?.stack[0].label;
    const inB = (await second.storage.getEditState(id))?.stack[0].label;
    const onDisk = catalog(p)?.edits.find((e) => e.photoId === id)?.stack[0].label;
    expect({ inA, inB, onDisk }).toEqual({ inA: "From B", inB: "From B", onDisk: "From B" });
  });

  it("aren't written over the opening window's newer edit by its next save", async () => {
    const p = mount(cfg, { "a.jpg": "A", "b.jpg": "B" });
    const a = await open(p);
    await a.storage.flush();
    const id = a.photos[0].id;
    p.fs.put(`${p.rootPath}/c.jpg`, "C");

    let b: ProjectStorage | null = null;
    const second = await open(p, {
      onSkeletons: (storage) => {
        b = storage;
        void a.storage.putEditState(edit(id, "From A"));
      },
      onPhoto: () => void b?.putEditState(edit(id, "From B")),
    });
    await vi.advanceTimersByTimeAsync(5000);
    a.storage.close(); // A's window closes; it had nothing more to write
    await vi.advanceTimersByTimeAsync(5000);
    await second.storage.putPhoto({ ...second.photos[1], rating: 1 });
    await second.storage.flush();

    const onDisk = catalog(p)?.edits.find((e) => e.photoId === id)?.stack[0].label;
    expect(onDisk).toBe("From B");
  });

  it("don't undo a rating the opening window gave after them", async () => {
    const p = mount(cfg, { "a.jpg": "A", "b.jpg": "B" });
    const a = await open(p);
    await a.storage.flush();
    const photo = a.photos[0];
    p.fs.put(`${p.rootPath}/c.jpg`, "C");

    let painted: { storage: ProjectStorage; sk: CatalogPhoto } | null = null;
    const second = await open(p, {
      onSkeletons: (storage, _raw, sks) => {
        const sk = sks.find((s) => s.id === photo.id);
        if (sk) painted = { storage, sk };
        void a.storage.putPhoto({ ...photo, rating: 2 });
      },
      onPhoto: () => {
        if (painted) void painted.storage.putPhoto({ ...painted.sk, rating: 5 });
      },
    });
    await vi.advanceTimersByTimeAsync(5000);

    const inA = (await a.storage.getAllPhotos()).find((x) => x.id === photo.id)?.rating;
    const inB = second.photos.find((x) => x.id === photo.id)?.rating;
    const onDisk = catalog(p)?.photos.find((x) => x.id === photo.id)?.rating;
    expect({ inA, inB, onDisk }).toEqual({ inA: 5, inB: 5, onDisk: 5 });
  });
});

describe.each(BUILDS)("a window's open, before its walk ($label)", (cfg) => {
  it("paints a change another window sent while it read the catalog", async () => {
    const p = mount(cfg, { "a.jpg": "A", "b.jpg": "B" });
    const a = await open(p);
    await a.storage.flush();
    const photo = a.photos[0];
    p.fs.onCatalogRead = () => void a.storage.putPhoto({ ...photo, rating: 3 });

    let painted: number | undefined;
    await open(p, {
      onSkeletons: (_storage, _raw, sks) => {
        painted = sks.find((sk) => sk.id === photo.id)?.rating;
      },
    });

    expect(painted).toBe(3);
  });
});

describe.each(BUILDS)("the windows that answer a window opening ($label)", (cfg) => {
  it("include one that left the catalog and still tries a save that fails", async () => {
    const p = mount(cfg, { "a.jpg": "A", "b.jpg": "B" });
    const a = await open(p);
    await a.storage.flush();
    const photo = a.photos[0];
    p.fs.failingWrites = { path: /catalog\.json$/, code: "EBUSY", left: 2 };
    await a.storage.putEditState(edit(photo.id, "Main edit")); // fails
    a.storage.close(); // its write as it leaves fails too; it tries again later

    const b = await open(p);
    await vi.advanceTimersByTimeAsync(60_000); // A's try lands, and A lets go
    await b.storage.putPhoto({ ...b.photos[1], rating: 3 });
    await b.storage.flush();

    const onDisk = catalog(p)?.edits.find((e) => e.photoId === photo.id)?.stack[0].label;
    expect(onDisk).toBe("Main edit");
  });

  it("include one that left the catalog while its open still walked the folder", async () => {
    const p = mount(cfg, { "a.jpg": "A", "b.jpg": "B" });
    const first = await open(p);
    await first.storage.flush();
    first.storage.close();
    p.fs.put(`${p.rootPath}/c.jpg`, "C"); // A's walk has a file to import
    p.fs.failingWrites = { path: /catalog\.json$/, code: "EBUSY", left: 1 };

    const mid: { a?: ProjectStorage; rated?: CatalogPhoto; b?: Promise<OpenedProject> } = {};
    await open(p, {
      onSkeletons: (storage, _raw, sks) => {
        mid.a = storage;
        mid.rated = sks[0];
      },
      onPhoto: () => {
        if (!mid.a || !mid.rated) return;
        void mid.a.putPhoto({ ...mid.rated, rating: 4 });
        mid.a.close(); // the window leaves mid-walk; its save fails and is tried later
        mid.b = open(p); // ... and opens the folder again
      },
    });
    if (!mid.b || !mid.rated) throw new Error("the walk imported nothing");
    const second = await mid.b;
    await vi.advanceTimersByTimeAsync(60_000);
    await second.storage.putEditState(edit(second.photos[1].id, "Later"));

    expect(catalog(p)?.photos.find((x) => x.id === mid.rated?.id)?.rating).toBe(4);
  });

  it("leave out a photo another window removed before its save landed", async () => {
    const p = mount(cfg, { "a.jpg": "A", "b.jpg": "B" });
    const a = await open(p);
    await a.storage.flush();
    const gone = a.photos[0];
    await a.storage.deletePhoto(gone.id); // saved after the debounce

    const b = await open(p);
    await vi.advanceTimersByTimeAsync(2000);
    const kept = b.photos.find((x) => x.id !== gone.id);
    if (kept) await b.storage.putPhoto({ ...kept, rating: 2 });
    await b.storage.flush();

    expect(b.photos.map((x) => x.id)).not.toContain(gone.id);
    expect(catalog(p)?.photos.map((x) => x.id)).not.toContain(gone.id);
  });

  it("keep a virtual copy another window made before its save landed", async () => {
    const p = mount(cfg, { "a.jpg": "A", "b.jpg": "B" });
    const a = await open(p);
    await a.storage.flush();
    const master = a.photos[0];
    void a.storage.putPhotos([{ ...master, id: "copy-1", copyOf: master.id, copyName: "copy" }]);

    const b = await open(p);
    await vi.advanceTimersByTimeAsync(2000);
    await b.storage.putPhoto({ ...b.photos[1], rating: 2 });
    await b.storage.flush();

    expect(catalog(p)?.photos.map((x) => x.id)).toContain("copy-1");
  });

  it("don't bring back a photo another window imported and removed before its save landed", async () => {
    const p = mount(cfg, { "a.jpg": "A", "b.jpg": "B" });
    const first = await open(p);
    await first.storage.flush();
    first.storage.close();
    p.fs.put(`${p.rootPath}/c.jpg`, "C");
    const a = await open(p); // imports c.jpg; its save waits for the debounce
    await a.storage.deletePhoto(a.newPhotos[0].id);

    const b = await open(p);
    await vi.advanceTimersByTimeAsync(15_000);
    await b.storage.putPhoto({ ...b.photos[0], rating: 2 });
    await b.storage.flush();

    expect(b.photos.map((x) => x.relPath)).not.toContain("c.jpg");
    expect(catalog(p)?.photos.map((x) => x.relPath)).not.toContain("c.jpg");
  });

  it("say nothing when they hold no change since they opened", async () => {
    const p = mount(cfg, { "a.jpg": "A", "b.jpg": "B" });
    const first = await open(p);
    await first.storage.flush();
    first.storage.close();
    await open(p); // opens unchanged
    const sent = sentRecords();

    await open(p);

    expect(sent.filter((r) => r.answer)).toEqual([]);
  });

  it("make no other window save when one that answered leaves with nothing to save", async () => {
    const p = mount(cfg, { "a.jpg": "A", "b.jpg": "B" });
    const a = await open(p);
    await a.storage.flush();
    await a.storage.putPhoto({ ...a.photos[0], rating: 2 });
    await a.storage.flush(); // landed, yet A answers with it all the same
    await open(p);
    const before = p.fs.writeCount(`${p.slPath}/catalog.json`);

    a.storage.close();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(p.fs.writeCount(`${p.slPath}/catalog.json`)).toBe(before);
  });

  it("don't bring back a removed photo whose save landed after the opening window read", async () => {
    const p = mount(cfg, { "a.jpg": "A" });
    const first = await open(p);
    await first.storage.flush();
    first.storage.close();
    p.fs.put(`${p.rootPath}/n.jpg`, "N");
    const a = await open(p); // A imports n.jpg; its save is pending
    await a.storage.deletePhoto(a.newPhotos[0].id); // removed before the save lands

    let release = (): void => {};
    p.fs.readGate = new Promise<void>((resolve) => (release = resolve));
    const opening = open(p); // B takes the old bytes now: no n.jpg, no tombstone
    await vi.advanceTimersByTimeAsync(0);
    await a.storage.flush(); // A's save lands meanwhile, holding the tombstone
    expect(catalog(p)?.removed).toContain("n.jpg");
    release(); // B goes on, says hello, and walks the folder
    const b = await opening;
    await vi.advanceTimersByTimeAsync(5000);

    expect(b.photos.map((x) => x.relPath)).not.toContain("n.jpg");
  });

  it("say again what each took in from another window, not only their own changes", async () => {
    const p = mount(cfg, { "a.jpg": "A", "b.jpg": "B" });
    const a = await open(p);
    await a.storage.flush();
    const c = await open(p);
    const id = c.photos[0].id;
    await c.storage.putEditState(edit(id, "From C")); // A takes it in
    const sent = sentRecords();

    await open(p);

    const answers = sent.filter((r) => r.answer && r.edits.some((e) => e.photoId === id));
    expect(new Set(answers.map((r) => r.origin)).size).toBe(2);
  });
});

describe.each(BUILDS)("a change another window gave up saving ($label)", (cfg) => {
  it("is saved by a window that opened after it, once that window had its answer", async () => {
    const p = mount(cfg, { "a.jpg": "A", "b.jpg": "B" });
    const a = await open(p);
    await a.storage.flush();
    const photo = a.photos[0];
    // A's write of the edit, its write as it leaves, and its three tries after that.
    p.fs.failingWrites = { path: /catalog\.json$/, code: "EBUSY", left: 5 };
    await a.storage.putEditState(edit(photo.id, "Given up"));
    await vi.advanceTimersByTimeAsync(1); // B starts listening after the edit was sent

    await open(p);
    a.storage.close();
    await vi.advanceTimersByTimeAsync(10 * 60_000);

    const onDisk = catalog(p)?.edits.find((e) => e.photoId === photo.id)?.stack[0].label;
    expect(onDisk).toBe("Given up");
  });
});

describe.each(BUILDS)("the order of changes to one record ($label)", (cfg) => {
  const ratingIn = async (storage: CatalogStorage, id: string) =>
    (await storage.getAllPhotos()).find((x) => x.id === id)?.rating;

  it("puts a change made after taking in another window's after it, in the same millisecond too", async () => {
    const p = mount(cfg, { "a.jpg": "A", "b.jpg": "B" });
    const a = await open(p);
    await a.storage.flush();
    const b = await open(p);
    const id = a.photos[0].id;
    for (const rating of [1, 2, 3]) {
      const held = (await b.storage.getAllPhotos()).find((x) => x.id === id);
      if (held) await b.storage.putPhoto({ ...held, rating });
    }

    const inA = (await a.storage.getAllPhotos()).find((x) => x.id === id);
    if (inA) await a.storage.putPhoto({ ...inA, rating: 5 });
    await a.storage.flush();
    await b.storage.flush();

    const onDisk = catalog(p)?.photos.find((x) => x.id === id)?.rating;
    const ratings = { a: await ratingIn(a.storage, id), b: await ratingIn(b.storage, id), onDisk };
    expect(ratings).toEqual({ a: 5, b: 5, onDisk: 5 });
  });

  it("puts a change made after reading a catalog stamped ahead of the clock after that stamp", async () => {
    const p = mount(cfg, { "a.jpg": "A", "b.jpg": "B" });
    const first = await open(p);
    await first.storage.flush();
    first.storage.close();
    const id = first.photos[0].id;
    const ahead = [Date.now() + 3_600_000, "a later session"];
    const saved = { ...catalog(p), changed: { photos: { [id]: { rating: ahead } }, edits: {} } };
    p.fs.put(`${p.slPath}/catalog.json`, JSON.stringify(saved));
    const a = await open(p);
    const b = await open(p);

    const inB = (await b.storage.getAllPhotos()).find((x) => x.id === id);
    if (inB) await b.storage.putPhoto({ ...inB, rating: 4 });

    expect(await ratingIn(a.storage, id)).toBe(4);
  });
});

describe.each(BUILDS)("the change stamps a catalog keeps ($label)", (cfg) => {
  const stamp = [expect.any(Number), expect.any(String)];

  it("are saved with a change, and a catalog nobody changed has none", async () => {
    const p = mount(cfg, { "a.jpg": "A", "b.jpg": "B" });
    const a = await open(p);
    await a.storage.flush();
    expect(catalog(p)?.changed).toBeUndefined();
    const photo = a.photos[0];

    await a.storage.putPhoto({ ...photo, flag: "pick" });
    await a.storage.putEditState(edit(photo.id, "Look"));
    await a.storage.flush();

    expect(catalog(p)?.changed?.photos[photo.id]).toEqual({ flag: stamp });
    expect(catalog(p)?.changed?.edits[photo.id]).toEqual(stamp);
  });

  it("leave with a record the folder no longer has", async () => {
    const p = mount(cfg, { "a.jpg": "A" });
    const first = await open(p);
    await first.storage.flush();
    first.storage.close();
    const id = first.photos[0].id;
    const changed = {
      photos: { [id]: { rating: [1, "w"] }, gone: { rating: [1, "w"] } },
      edits: { gone: [1, "w"] },
    };
    p.fs.put(`${p.slPath}/catalog.json`, JSON.stringify({ ...catalog(p), changed }));

    const a = await open(p);
    await a.storage.putPhoto({ ...a.photos[0], rating: 1 });
    await a.storage.flush();

    expect(Object.keys(catalog(p)?.changed?.photos ?? {})).toEqual([id]);
    expect(catalog(p)?.changed?.edits).toEqual({});
  });

  it("that this build can't read only count as the oldest", async () => {
    const p = mount(cfg, { "a.jpg": "A" });
    const first = await open(p);
    await first.storage.flush();
    first.storage.close();
    p.fs.put(`${p.slPath}/catalog.json`, JSON.stringify({ ...catalog(p), changed: "junk" }));

    const a = await open(p);
    await a.storage.putPhoto({ ...a.photos[0], rating: 1 });
    await a.storage.flush();

    expect(a.photos).toHaveLength(1);
    expect(p.fs.tree(p.slPath).filter((path) => /corrupt/.test(path))).toEqual([]);
    expect(catalog(p)?.changed?.photos[a.photos[0].id]).toEqual({ rating: stamp });
  });
});
