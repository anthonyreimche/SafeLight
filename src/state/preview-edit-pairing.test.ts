// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A photo's grid preview and the edit it shows (previewEdit) stay paired: Develop
// draws the preview first only while that edit is the one it opens with. This
// window runs its storage, preview reader, catalog store and the following of other
// windows' records, wired as opening a project wires them. Another window is
// driven through its storage, as its catalog store and edited-thumbnail drive it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPhoto } from "@/catalog/types";

// The plain-browser build: no native file bridge.
vi.mock("@/native/privileged", () => ({ privilegedFs: () => null }));

vi.mock("@/project/project-store", () => ({
  useProjectStore: { getState: () => ({}) },
}));

vi.mock("@/modules/library/import-photos", () => ({
  isSupportedName: (name: string) => /\.nef$/i.test(name),
  buildPhoto: async () => null,
  buildPreviewBlob: async (photo: CatalogPhoto) =>
    photo.fileHandle ? new Blob([`built:${photo.id}`]) : null,
}));

import { editFingerprint } from "@/catalog/edit-fingerprint";
import { setCatalogStorage } from "@/catalog/storage";
import { photo } from "@/catalog/stored-edit.fixtures";
import { freshParams } from "@/catalog/types";
// Whether Develop draws a photo's stored preview first when it opens on an edit.
import { previewShowsEdit as developDrawsStoredPreview } from "@/hooks/preview-shows-edit";
import { MemoryFs, fsaDirectoryHandle } from "@/project/memory-fs.test-support";
import { ProjectStorage } from "@/project/project-storage";
import { useCatalogStore } from "./catalog-store";
import { followCatalogRecords } from "./catalog-sync";
import { useSettings } from "./settings-store";
import { reloadThumbnail, requestThumbnail, setThumbnailLoader } from "./thumbnail-loader";

class FakeChannel {
  postMessage(message: unknown): void {
    structuredClone(message);
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

const ROOT = "/home/u/photos";
const ID = "x";

let frames: FrameRequestCallback[] = [];
const storages: ProjectStorage[] = [];
let stopFollowing = (): void => {};

beforeEach(() => {
  frames = [];
  vi.stubGlobal("BroadcastChannel", FakeChannel);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  useSettings.setState({ persistPreviews: true });
  useCatalogStore.setState({ photos: [] });
});

afterEach(() => {
  stopFollowing();
  setThumbnailLoader(null);
  setCatalogStorage(null);
  for (const storage of storages.splice(0)) storage.close();
  vi.unstubAllGlobals();
});

/** A project holding x.NEF, saved with a preview on disk that shows `previewEdit`. */
function project(previewEdit?: string): FileSystemDirectoryHandle {
  const fs = new MemoryFs(ROOT);
  const x = { ...photo(ID), previewEdit };
  fs.put(`${ROOT}/${x.relPath}`, "raw");
  fs.put(`${ROOT}/.safelight/previews/${ID}.jpg`, "on disk");
  fs.put(`${ROOT}/.safelight/catalog.json`, JSON.stringify({ version: 1, photos: [x], edits: [] }));
  return fsaDirectoryHandle(fs, ROOT);
}

/** Open the project in this window: its storage, preview reader and photos, and
 *  the following of other windows' records. */
async function thisWindow(root: FileSystemDirectoryHandle): Promise<ProjectStorage> {
  const { storage, photos } = await ProjectStorage.open(root);
  storages.push(storage);
  setCatalogStorage(storage);
  setThumbnailLoader((id) => storage.readPreview(id));
  useCatalogStore.setState({ photos });
  stopFollowing();
  stopFollowing = followCatalogRecords();
  return storage;
}

async function otherWindow(root: FileSystemDirectoryHandle): Promise<ProjectStorage> {
  const { storage } = await ProjectStorage.open(root);
  storages.push(storage);
  return storage;
}

/** The grid asks for the preview: let the read land, then the frame that hands it
 *  to the store. */
async function previewLoads(): Promise<void> {
  requestThumbnail(ID, { visible: true });
  await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0));
  const due = frames;
  frames = [];
  for (const cb of due) cb(0);
}

/** The other window renders an edited preview for its photo and stores it (as
 *  edited-thumbnail does), and this window reloads that preview (as use-window-sync
 *  does on its announcement). Returns the photo as the other window's store holds it. */
async function editedIn(other: ProjectStorage, previewEdit: string): Promise<CatalogPhoto> {
  const [held] = await other.getAllPhotos();
  const edited = { ...held, thumbnailBlob: new Blob([`edited:${previewEdit}`]), previewEdit };
  await other.putPhoto(edited);
  return edited;
}

const inStore = () => useCatalogStore.getState().photos[0];

describe("a preview this window holds", () => {
  it("isn't given another window's edit by a rating that window wrote", async () => {
    useSettings.setState({ persistPreviews: false });
    const root = project();
    const a = await otherWindow(root);
    const b = await thisWindow(root);
    await previewLoads();

    const edited = await editedIn(a, "edit-E");
    await reloadThumbnail(ID);
    expect(inStore().previewEdit).toBeUndefined();
    await a.putPhoto({ ...edited, rating: 4 });

    expect(inStore().rating).toBe(4);
    await expect(inStore().thumbnailBlob?.text()).resolves.toBe(`built:${ID}`);
    expect(inStore().previewEdit).toBeUndefined();
    // No preview of edit-E was stored, so no record names it: the other window's
    // record leaves it out, and this window's store would keep its own anyway.
    expect((await b.getAllPhotos())[0].previewEdit).toBeUndefined();
  });

  it("takes another window's edit only with its preview, reloaded from disk", async () => {
    const root = project();
    const a = await otherWindow(root);
    await thisWindow(root);
    await previewLoads();

    await editedIn(a, "edit-E");
    // The record has arrived, and names the preview on disk; this window still
    // shows the one it read before.
    await expect(inStore().thumbnailBlob?.text()).resolves.toBe("on disk");
    expect(inStore().previewEdit).toBeUndefined();

    await reloadThumbnail(ID);

    await expect(inStore().thumbnailBlob?.text()).resolves.toBe("edited:edit-E");
    expect(inStore().previewEdit).toBe("edit-E");
  });

  it("shows no edit once another window's change rebuilds it from the file", async () => {
    const root = project("edit-1");
    const a = await otherWindow(root);
    await thisWindow(root);
    await previewLoads();
    expect(inStore().previewEdit).toBe("edit-1");
    useSettings.setState({ persistPreviews: false });

    await editedIn(a, "edit-2");
    await reloadThumbnail(ID);

    await expect(inStore().thumbnailBlob?.text()).resolves.toBe(`built:${ID}`);
    expect(inStore().previewEdit).toBeUndefined();
  });
});

describe("a stored preview, after previews were turned off and on", () => {
  it("isn't paired with an edit made while they were off", async () => {
    const root = project();
    const session = await thisWindow(root);
    await editedIn(session, "edit-1");
    useSettings.setState({ persistPreviews: false });
    await editedIn(session, "edit-2");
    await session.flush();
    useSettings.setState({ persistPreviews: true });

    await thisWindow(root);
    await previewLoads();

    // Develop opens with edit-2, so it doesn't draw this preview first.
    await expect(inStore().thumbnailBlob?.text()).resolves.toBe("edited:edit-1");
    expect(inStore().previewEdit).toBe("edit-1");
  });

  it("isn't drawn as the unedited look once the edit was undone while they were off", async () => {
    const original = { params: freshParams(), paramBag: {}, historyIndex: 0 };
    const root = project();
    const session = await thisWindow(root);
    await editedIn(session, "edit-1");
    useSettings.setState({ persistPreviews: false });
    // The grid loads the photo, built from its file.
    await previewLoads();
    expect(inStore().previewEdit).toBeUndefined();
    // Undo back to Original: its preview is rendered, but not stored.
    await editedIn(session, editFingerprint(original.params, original.paramBag));
    await session.flush();
    useSettings.setState({ persistPreviews: true });

    await thisWindow(root);
    await previewLoads();

    await expect(inStore().thumbnailBlob?.text()).resolves.toBe("edited:edit-1");
    expect(developDrawsStoredPreview(inStore(), original)).toBe(false);
  });
});
