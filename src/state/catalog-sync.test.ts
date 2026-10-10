// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What another window writes to the catalog, reaching this window's stores: the
// catalog store takes on photo fields and removals, and Develop reloads the photo
// it has open when that photo's edit changes in another window. B is this window
// and A another one, each with its own storage on one in-memory project folder.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The plain-browser build: no native file bridge.
vi.mock("@/native/privileged", () => ({ privilegedFs: () => null }));

import { setCatalogStorage } from "@/catalog/storage";
import { photo, snapshot } from "@/catalog/stored-edit.fixtures";
import type { EditSnapshot, EditState } from "@/catalog/types";
import { MemoryFs, fsaDirectoryHandle } from "@/project/memory-fs.test-support";
import { ProjectStorage } from "@/project/project-storage";
import { useCatalogStore } from "./catalog-store";
import { followCatalogRecords } from "./catalog-sync";
import { useDevelopStore } from "./develop-store";

/** Stands in for the BroadcastChannel between windows. Both storages share this
 *  window, where broadcast's same-window fan-out carries their messages. */
class FakeChannel {
  postMessage(message: unknown): void {
    structuredClone(message);
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

const ROOT = "/home/u/photos";
/** The photo Develop has open in this window, and one it doesn't. */
const OPEN = "x";
const OTHER = "y";

const edit = (photoId: string, stack: EditSnapshot[]): EditState => ({
  photoId,
  stack,
  currentIndex: stack.length - 1,
});
const brighter = (photoId: string) =>
  edit(photoId, [snapshot("Original", {}), snapshot("Exposure", { exposure: 1 })]);

const develop = () => useDevelopStore.getState();
const labels = () => develop().history.map((step) => step.label);
const inStore = (id: string) => useCatalogStore.getState().photos.find((p) => p.id === id);

// zustand keeps the actions in state, so the pristine object doubles as the
// reset baseline (nothing mutates it in place).
const INITIAL = useDevelopStore.getState();
const storages: ProjectStorage[] = [];
let stopFollowing = () => {};

beforeEach(() => {
  vi.stubGlobal("BroadcastChannel", FakeChannel);
  vi.useFakeTimers();
  useDevelopStore.setState(INITIAL, true);
});

afterEach(() => {
  stopFollowing();
  setCatalogStorage(null);
  for (const storage of storages.splice(0)) storage.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Both windows opened the project from one saved catalog. This window is B: its
 *  stores show B's catalog, and Develop has OPEN open at a 5200 K as-shot. */
async function twoWindows(): Promise<{ a: ProjectStorage; b: ProjectStorage }> {
  const fs = new MemoryFs(ROOT);
  const photos = [photo(OPEN), photo(OTHER)];
  for (const p of photos) fs.put(`${ROOT}/${p.relPath}`, p.id);
  fs.put(`${ROOT}/.safelight/catalog.json`, JSON.stringify({ version: 1, photos, edits: [] }));
  const a = await ProjectStorage.open(fsaDirectoryHandle(fs, ROOT));
  const b = await ProjectStorage.open(fsaDirectoryHandle(fs, ROOT));
  storages.push(a.storage, b.storage);

  setCatalogStorage(b.storage);
  useCatalogStore.setState({ photos: b.photos, selectedIds: new Set(), activePhotoId: OPEN });
  stopFollowing = followCatalogRecords();
  await develop().loadEdit(OPEN, 5200);
  return { a: a.storage, b: b.storage };
}

describe("Develop", () => {
  it("reloads the open photo when another window changes its edit", async () => {
    const { a } = await twoWindows();

    await a.putEditState(brighter(OPEN));

    await vi.waitFor(() => expect(labels()).toEqual(["Original", "Exposure"]));
    expect(develop().params.exposure).toBe(1);
    expect(develop().asShotTemperature).toBe(5200);
  });

  it("doesn't reload for an edit this window wrote", async () => {
    const { b } = await twoWindows();
    const reload = vi.spyOn(develop(), "loadEdit");

    await b.putEditState(brighter(OPEN));
    await vi.advanceTimersByTimeAsync(1000);

    expect(reload).not.toHaveBeenCalled();
    expect(labels()).toEqual(["Original"]);
  });

  it("doesn't reload when another photo's edit changes", async () => {
    const { a } = await twoWindows();
    const reload = vi.spyOn(develop(), "loadEdit");

    await a.putEditState(brighter(OTHER));
    await vi.advanceTimersByTimeAsync(1000);

    expect(reload).not.toHaveBeenCalled();
  });
});

describe("the catalog store", () => {
  it("takes on the fields another window wrote, on this window's record", async () => {
    const { a } = await twoWindows();
    const mine = inStore(OTHER);
    const [, theirs] = await a.getAllPhotos();

    await a.putPhoto({ ...theirs, rating: 3, keywords: ["dusk"] });

    expect(inStore(OTHER)).toMatchObject({ rating: 3, keywords: ["dusk"] });
    expect(inStore(OTHER)?.fileHandle).toBe(mine?.fileHandle);
  });

  it("drops a photo another window removed", async () => {
    const { a } = await twoWindows();

    await a.deletePhoto(OTHER);

    expect(useCatalogStore.getState().photos.map((p) => p.id)).toEqual([OPEN]);
  });

  it("ignores another window's catalog taking on what this window wrote", async () => {
    // B's own write reaches A, which reports taking it on. That report is about
    // A's copy, so this window's store must not act on it.
    const { b } = await twoWindows();
    const [, mine] = await b.getAllPhotos();

    await b.putPhoto({ ...mine, rating: 2 });

    expect(inStore(OTHER)?.rating).toBe(0);
  });
});
