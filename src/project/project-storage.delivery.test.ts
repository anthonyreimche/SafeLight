// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Two windows whose messages take time to arrive and whose catalog writes take
// time to land, as between real windows. One window's messages arrive in the
// order it sent them (the BroadcastChannel guarantee) but late, and two windows'
// writes to catalog.json can land in either order. Both windows open one
// in-memory project from a saved catalog, so they share its photo ids.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPhoto, EditState } from "@/catalog/types";
import type { BroadcastMessage } from "@/state/broadcast";

const h = vi.hoisted(() => ({
  listeners: new Set<(message: BroadcastMessage) => void>(),
  listenerIds: new WeakMap<object, number>(),
  lastListenerId: 0,
  /** When the last message from each sender reaches each listener. */
  arrivals: new Map<string, number>(),
  /** How long the next message takes to arrive, in ms. */
  latency: (): number => 0,
}));

// The plain-browser build: no native file bridge.
vi.mock("@/native/privileged", () => ({ privilegedFs: () => null }));

vi.mock("@/state/broadcast", () => ({
  WINDOW_ID: "test-window",
  broadcast: (message: BroadcastMessage) => {
    const sender = message.type === "catalog-records" ? message.payload.origin : "";
    for (const listener of [...h.listeners]) {
      let id = h.listenerIds.get(listener);
      if (!id) h.listenerIds.set(listener, (id = ++h.lastListenerId));
      const route = `${sender}→${id}`;
      const at = Math.max(Date.now() + h.latency(), h.arrivals.get(route) ?? 0);
      h.arrivals.set(route, at);
      const copy = structuredClone(message);
      setTimeout(() => {
        if (h.listeners.has(listener)) listener(copy);
      }, at - Date.now());
    }
  },
  onBroadcast: (listener: (message: BroadcastMessage) => void) => {
    h.listeners.add(listener);
    return () => void h.listeners.delete(listener);
  },
}));

import { photo } from "@/catalog/stored-edit.fixtures";
import { MemoryFs, fsaDirectoryHandle } from "./memory-fs.test-support";
import { ProjectStorage } from "./project-storage";

/** A file system whose catalog.json writes land after a delay: the next delays
 *  in `queued`, then whatever `delay` returns. */
class SlowFs extends MemoryFs {
  queued: number[] = [];
  delay: () => number = () => 0;

  override async write(path: string, data: Uint8Array): Promise<void> {
    const copy = new Uint8Array(data);
    const wait = path.endsWith("catalog.json") ? (this.queued.shift() ?? this.delay()) : 0;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    return super.write(path, copy);
  }
}

const ROOT = "/home/u/photos";
const PHOTO_IDS = ["a", "b", "c", "d", "e", "f"];

interface Disk {
  photos: CatalogPhoto[];
  edits: EditState[];
  removed?: string[];
}

const edit = (photoId: string, label: string): EditState => ({
  photoId,
  stack: [{ timestamp: 1, label, params: {} as EditState["stack"][0]["params"] }],
  currentIndex: 0,
});

const storages: ProjectStorage[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  h.listeners.clear();
  h.arrivals.clear();
  h.latency = () => 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  for (const storage of storages.splice(0)) storage.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Both windows open the project from one saved catalog, a while before the
 *  test acts. */
async function twoWindows() {
  const fs = new SlowFs(ROOT);
  const photos = PHOTO_IDS.map((id) => photo(id));
  for (const p of photos) fs.put(`${ROOT}/${p.relPath}`, p.id);
  fs.put(`${ROOT}/.safelight/catalog.json`, JSON.stringify({ version: 1, photos, edits: [] }));
  const root = fsaDirectoryHandle(fs, ROOT);
  const a = await ProjectStorage.open(root);
  const b = await ProjectStorage.open(root);
  storages.push(a.storage, b.storage);
  await vi.advanceTimersByTimeAsync(5000);
  const disk = () => JSON.parse(fs.text(`${ROOT}/.safelight/catalog.json`) ?? "null") as Disk;
  return { fs, a: a.storage, b: b.storage, disk };
}

const labels = (disk: Disk) =>
  Object.fromEntries(disk.edits.map((e) => [e.photoId, e.stack[0].label]));

describe("records that take a while to arrive", () => {
  it("repair a save that landed after the sender's while they were on their way", async () => {
    const { fs, a, b, disk } = await twoWindows();
    h.latency = () => 50;
    const [, , , ofB] = await b.getAllPhotos();
    void b.putPhoto({ ...ofB, flag: "pick" }); // a change of B's own, to save
    await vi.advanceTimersByTimeAsync(60); // A hears of it; B's save is still debounced
    fs.queued = [5, 20]; // A's write lands quickly, B's more slowly

    const aSaved = a.putEditState(edit("a", "From A"));
    await vi.advanceTimersByTimeAsync(1);
    const bSaved = b.flush(); // B hasn't heard of A's edit yet
    await vi.advanceTimersByTimeAsync(30);
    await Promise.all([aSaved, bSaved]);

    expect(labels(disk())).toEqual({}); // B's copy, without A's edit, landed last
    const landed = fs.writeCount(`${ROOT}/.safelight/catalog.json`);
    await vi.advanceTimersByTimeAsync(2000);
    expect(labels(disk())).toEqual({ a: "From A" });
    expect(fs.writeCount(`${ROOT}/.safelight/catalog.json`) - landed).toBe(1); // B's repair
  });

  it("don't bring back a photo this window removed before they arrived", async () => {
    const { a, b, disk } = await twoWindows();
    h.latency = () => 50;
    const [, mine] = await a.getAllPhotos();

    void b.deletePhoto(mine.id); // B removes the photo ...
    void a.putPhoto({ ...mine, rating: 4 }); // ... while A, not yet told, rates it
    await vi.advanceTimersByTimeAsync(5000);
    await b.flush();

    expect((await a.getAllPhotos()).map((p) => p.id)).not.toContain(mine.id);
    expect(disk().photos.map((p) => p.id)).not.toContain(mine.id);
    expect(disk().removed).toEqual([mine.relPath]);
  });
});

/** Seeded random numbers, so a failing seed can be replayed. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One random run: each window changes only the photos it owns (the same photo
 *  changed in two windows at once is a known limit), at random times, with random
 *  delays on messages and writes. Returns what didn't converge. */
async function runSeed(seed: number, removals: boolean): Promise<string[]> {
  const rand = mulberry32(seed);
  const { fs, a, b, disk } = await twoWindows();
  fs.delay = () => Math.floor(rand() * 400);
  h.latency = () => Math.floor(rand() * 300);

  const windows = { A: a, B: b };
  const owner = new Map<string, "A" | "B">(PHOTO_IDS.map((id, i) => [id, i < 3 ? "A" : "B"]));
  /** Each virtual copy's master, as the app records it: the root master. */
  const copies = new Map<string, string>();
  const removed = new Set<string>();
  const wantEdit = new Map<string, string>();
  const wantRating = new Map<string, number>();
  let step = 0;

  for (let i = 0; i < 30; i++) {
    const at = Math.floor(rand() * 4000);
    const who = rand() < 0.5 ? "A" : "B";
    const roll = rand();
    setTimeout(() => {
      const w = windows[who];
      const mine = [...owner].filter(([id, o]) => o === who && !removed.has(id)).map(([id]) => id);
      if (mine.length === 0) return;
      const pick = mine[Math.floor(rand() * mine.length)];
      const label = `L${++step}`;
      if (roll < 0.25) {
        wantEdit.set(pick, label);
        void w.putEditState(edit(pick, label));
      } else if (roll < 0.4) {
        const two = mine.slice(0, 2);
        for (const id of two) wantEdit.set(id, label);
        void w.putEditStates(two.map((id) => edit(id, label)));
      } else if (roll < 0.7) {
        const rating = step % 6;
        wantRating.set(pick, rating);
        void w.getAllPhotos().then((all) => {
          const record = all.find((p) => p.id === pick);
          if (record) void w.putPhoto({ ...record, rating });
        });
      } else if (roll < 0.82) {
        const copyId = `copy-${step}`;
        const master = copies.get(pick) ?? pick;
        owner.set(copyId, who);
        copies.set(copyId, master);
        void w.getAllPhotos().then((all) => {
          const record = all.find((p) => p.id === pick);
          if (record) void w.putPhotos([{ ...record, id: copyId, copyOf: master, rating: 0 }]);
        });
      } else if (roll < 0.95 || !removals) {
        void w.flush();
      } else {
        // Removing a master takes its copies with it.
        removed.add(pick);
        for (const [copy, master] of copies) if (master === pick) removed.add(copy);
        void w.deletePhoto(pick);
      }
    }, at);
  }
  await vi.advanceTimersByTimeAsync(60_000);

  const problems: string[] = [];
  const shown = async (who: "A" | "B") => new Map((await windows[who].getAllPhotos()).map((p) => [p.id, p]));
  for (const who of ["A", "B"] as const) {
    const records = await shown(who);
    for (const [id, o] of owner) {
      const record = records.get(id);
      // The other window keeps a copy it didn't make, unshown, until it reopens.
      const showsIt = !removed.has(id) && (!copies.has(id) || o === who);
      if (!showsIt) {
        if (record) problems.push(`${who} shows ${id}`);
        continue;
      }
      if (!record) {
        problems.push(`${who} lost ${id}`);
        continue;
      }
      if (record.rating !== (wantRating.get(id) ?? 0)) problems.push(`${who} ${id} rating`);
      const label = (await windows[who].getEditState(id))?.stack[0].label;
      if (label !== wantEdit.get(id)) problems.push(`${who} ${id} edit ${label}`);
    }
  }
  const onDisk = disk();
  for (const id of owner.keys()) {
    const record = onDisk.photos.find((p) => p.id === id);
    if (removed.has(id)) {
      if (record) problems.push(`disk keeps removed ${id}`);
      continue;
    }
    if (!record) {
      problems.push(`disk lost ${id}`);
      continue;
    }
    if (record.rating !== (wantRating.get(id) ?? 0)) problems.push(`disk ${id} rating`);
    const label = onDisk.edits.find((e) => e.photoId === id)?.stack[0].label;
    if (label !== wantEdit.get(id)) problems.push(`disk ${id} edit ${label}`);
  }
  for (const storage of storages.splice(0)) storage.close();
  return problems;
}

describe("two windows changing their own photos at random", () => {
  it("end with the same records in both windows and on disk", async () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= 300; seed++) {
      const problems = await runSeed(seed, false);
      if (problems.length > 0) failures.push(`seed ${seed}: ${problems.join(", ")}`);
    }
    expect(failures).toEqual([]);
  });

  it("do so with removals too", async () => {
    const failures: string[] = [];
    for (let seed = 1001; seed <= 1300; seed++) {
      const problems = await runSeed(seed, true);
      if (problems.length > 0) failures.push(`seed ${seed}: ${problems.join(", ")}`);
    }
    expect(failures).toEqual([]);
  });
});
