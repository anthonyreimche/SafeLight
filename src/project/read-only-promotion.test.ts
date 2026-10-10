// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Edits made while a folder was read-only are folded back into its own catalog
// the next time it opens writeable, and the catalog they replace is kept. The
// real working-dir and ProjectStorage run here over one in-memory desktop file
// system, so what one open keeps is what the next open finds.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPhoto, EditState } from "@/catalog/types";
import type { NativeFsBridge } from "@/extensions/types";
import { MemoryFs } from "./memory-fs.test-support";

const h = vi.hoisted(() => ({
  fs: null as NativeFsBridge | null,
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
vi.mock("@/extensions/registry", () => ({ emitPhotoImport: async () => null }));
vi.mock("@/modules/library/import-photos", () => ({
  isSupportedName: (name: string) => /\.jpe?g$/i.test(name),
  buildPhoto: async (
    file: File,
    directoryHandle: FileSystemDirectoryHandle | null,
    fileHandle: FileSystemFileHandle | null,
  ): Promise<CatalogPhoto> => ({
    id: `p${++h.built}:${file.name}`,
    filename: file.name,
    relPath: "",
    folder: "",
    directoryHandle,
    fileHandle,
    thumbnailBlob: null,
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
  buildPreviewBlob: async () => null,
}));

import { ProjectStorage, type OpenedProject } from "./project-storage";
import { nativeDirectoryHandle } from "./native-fs";

const CARD = "E:\\DCIM";
const SPILLOVER = "C:/Users/u/AppData/Safelight/catalogs/dcim/.safelight";

/** A desktop file system whose separate catalogs live under SPILLOVER. */
class DesktopFs extends MemoryFs {
  async externalCatalogDir(_root: string, _base?: string | null, create = true) {
    if (create) {
      await this.mkdir(SPILLOVER);
      return SPILLOVER;
    }
    return (await this.exists(`${SPILLOVER}/catalog.json`)) ? SPILLOVER : null;
  }
}

class FakeChannel {
  postMessage(message: unknown): void {
    structuredClone(message);
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

const opened: OpenedProject[] = [];
async function open(): Promise<OpenedProject> {
  const project = await ProjectStorage.open(nativeDirectoryHandle(CARD));
  opened.push(project);
  return project;
}

const edit = (photoId: string, label: string): EditState => ({
  photoId,
  stack: [{ timestamp: 1, label, params: {} as EditState["stack"][0]["params"] }],
  currentIndex: 0,
});

beforeEach(() => {
  h.built = 0;
  vi.stubGlobal("BroadcastChannel", FakeChannel);
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  for (const project of opened.splice(0)) project.storage.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("folding a read-only session's edits back in", () => {
  it("keeps the catalog it replaced through the opens that follow", async () => {
    const fs = new DesktopFs(CARD);
    h.fs = fs;
    fs.put(`${CARD}/a.jpg`, "A");
    const first = await open();
    await first.storage.putEditState(edit(first.photos[0].id, "Before the card went read-only"));
    first.storage.close();
    const beforeMerge = fs.text(`${CARD}/.safelight/catalog.json`);
    // The read-only session's catalog: the folder's own, plus an edit, written later.
    const spilled = JSON.parse(beforeMerge ?? "null") as { edits: EditState[] };
    spilled.edits = [edit(first.photos[0].id, "Made while read-only")];
    fs.put(`${SPILLOVER}/catalog.json`, JSON.stringify(spilled));
    fs.put(`${SPILLOVER}/.seeded`, CARD);

    // Each session that follows saves a change of its own.
    const promoted = await open();
    await promoted.storage.putPhoto({ ...promoted.photos[0], rating: 1 });
    await promoted.storage.flush();
    promoted.storage.close();
    const reopened = await open(); // a pop-out, or the next launch
    await reopened.storage.putPhoto({ ...reopened.photos[0], rating: 2 });
    await reopened.storage.flush();

    expect(promoted.promotedFromExternal).toBe(SPILLOVER);
    expect((await reopened.storage.getEditState(first.photos[0].id))?.stack[0].label).toBe(
      "Made while read-only",
    );
    const kept = fs
      .tree(`${CARD}/.safelight`)
      .filter((path) => /\/catalog\.before-merge-[^/]*\.json$/.test(path));
    expect(kept.map((path) => fs.text(path))).toEqual([beforeMerge]);
  });
});
