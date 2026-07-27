// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CatalogPhoto, EditState } from "@/catalog/types";
import type { NativeFsBridge } from "@/extensions/types";
import { MemoryFs, fsaDirectoryHandle } from "./memory-fs.test-support";

const h = vi.hoisted(() => ({
  fs: null as NativeFsBridge | null,
  root: null as FileSystemDirectoryHandle | null,
  photos: [] as CatalogPhoto[],
  activeFolder: null as string | null,
  edits: new Map<string, EditState>(),
}));

vi.mock("@/native/privileged", () => ({ privilegedFs: () => h.fs }));

vi.mock("./project-store", () => ({
  useProjectStore: {
    getState: () => ({ root: h.root, refreshTree: async () => {} }),
  },
}));

vi.mock("@/state/catalog-store", () => ({
  useCatalogStore: {
    getState: () => ({
      photos: h.photos,
      relocatePhotos: async (updated: CatalogPhoto[]) => {
        const byId = new Map(updated.map((p) => [p.id, p] as const));
        h.photos = h.photos.map((p) => byId.get(p.id) ?? p);
      },
      removePhotos: async (ids: string[]) => {
        const gone = new Set(ids);
        h.photos = h.photos.filter((p) => !gone.has(p.id));
      },
    }),
  },
}));

vi.mock("@/state/ui-store", () => ({
  useUIStore: {
    getState: () => ({
      activeFolder: h.activeFolder,
      setActiveFolder: (path: string | null) => {
        h.activeFolder = path;
      },
    }),
  },
}));

vi.mock("@/catalog/storage", () => ({
  catalogStorage: () => ({ getEditState: async (id: string) => h.edits.get(id) }),
}));

import {
  SIDECAR_SUFFIX,
  createFolder,
  deleteFolder,
  exportPhotoData,
  moveFolder,
  movePhotos,
  renameFolder,
  renamePhoto,
  revealPhoto,
  uniqueFolderName,
} from "./folder-ops";
import { nativeDirectoryHandle } from "./native-fs";

// The three shapes the folder ops actually run in: Electron on a Windows drive,
// Electron on a POSIX mount, and the plain-browser FSA build (no path bridge, so
// every move is a recursive copy + delete instead of one rename).
const BUILDS = [
  { label: "electron · windows", rootPath: "D:\\Photos", native: true },
  { label: "electron · posix", rootPath: "/home/u/photos", native: true },
  { label: "browser · FSA", rootPath: "/home/u/photos", native: false },
] as const;

interface Env {
  fs: MemoryFs;
  rootPath: string;
  root: FileSystemDirectoryHandle;
}

function open(rootPath: string, native: boolean): Env {
  const fs = new MemoryFs(rootPath);
  h.fs = native ? fs : null;
  const root = native ? nativeDirectoryHandle(rootPath) : fsaDirectoryHandle(fs, rootPath);
  h.root = root;
  return { fs, rootPath, root };
}

/** MemoryFs keys entries with forward slashes whatever shape went in. */
const at = (env: Env, rel: string) => `${env.rootPath}/${rel}`.replace(/\\/g, "/");

async function dirHandle(env: Env, rel: string): Promise<FileSystemDirectoryHandle> {
  let dir = env.root;
  if (!rel) return dir;
  for (const seg of rel.split("/")) dir = await dir.getDirectoryHandle(seg);
  return dir;
}

const TEMPLATE: Omit<CatalogPhoto, "id" | "filename" | "relPath" | "folder"> = {
  directoryHandle: null,
  fileHandle: null,
  thumbnailBlob: null,
  thumbnailUrl: null,
  width: 4000,
  height: 3000,
  fileSize: 12,
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

/** Put a file on disk and register the matching catalog record with live handles. */
async function addPhoto(
  env: Env,
  relPath: string,
  extra: Partial<CatalogPhoto> = {},
): Promise<CatalogPhoto> {
  const cut = relPath.lastIndexOf("/");
  const folder = cut === -1 ? "" : relPath.slice(0, cut);
  const filename = relPath.slice(cut + 1);
  env.fs.put(at(env, relPath), `pixels:${relPath}`);
  const directoryHandle = await dirHandle(env, folder);
  const photo: CatalogPhoto = {
    ...TEMPLATE,
    id: `id:${relPath}`,
    filename,
    relPath,
    folder,
    directoryHandle,
    fileHandle: await directoryHandle.getFileHandle(filename),
    ...extra,
  };
  h.photos = [...h.photos, photo];
  return photo;
}

/** A virtual copy: no file of its own, mirrors the master's path fields. */
function addCopy(master: CatalogPhoto, copyName: string): CatalogPhoto {
  const copy: CatalogPhoto = {
    ...master,
    id: `${master.id}#${copyName}`,
    copyOf: master.id,
    copyName,
  };
  h.photos = [...h.photos, copy];
  return copy;
}

const find = (id: string): CatalogPhoto => {
  const p = h.photos.find((x) => x.id === id);
  if (!p) throw new Error(`no catalog record ${id}`);
  return p;
};

beforeEach(() => {
  h.fs = null;
  h.root = null;
  h.photos = [];
  h.activeFolder = null;
  h.edits = new Map();
  // The ops log skipped/failed work; keep the reporter clean.
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("uniqueFolderName", () => {
  it("keeps the base name when it's free", () => {
    expect(uniqueFolderName(["Trip", "Misc"])).toBe("Untitled Folder");
    expect(uniqueFolderName([], "Trip")).toBe("Trip");
  });

  it("suffixes with the first free index", () => {
    expect(uniqueFolderName(["Trip"], "Trip")).toBe("Trip 2");
    expect(uniqueFolderName(["Trip", "Trip 2", "Trip 3"], "Trip")).toBe("Trip 4");
    // Gaps are filled rather than skipped past.
    expect(uniqueFolderName(["Trip", "Trip 3"], "Trip")).toBe("Trip 2");
  });
});

describe.each(BUILDS)("folder ops ($label)", ({ rootPath, native }) => {
  const start = () => open(rootPath, native);

  // ── createFolder ──────────────────────────────────────────────────────────

  it("creates a folder under a parent, building the parent chain", async () => {
    const env = start();

    await expect(createFolder("", "2024")).resolves.toBe("2024");
    await expect(createFolder("2024", "Trip")).resolves.toBe("2024/Trip");

    expect(env.fs.has(at(env, "2024/Trip"))).toBe(true);
  });

  it("refuses a blank folder name and does nothing without a project", async () => {
    const env = start();
    await expect(createFolder("", "   ")).resolves.toBeNull();
    h.root = null;
    await expect(createFolder("", "Trip")).resolves.toBeNull();
    expect(env.fs.tree()).toEqual([]);
  });

  it("collapses a typed name to a single folder, never a nested path", async () => {
    // Separators in a name would silently create intermediate folders (or throw
    // from the handle layer); a folder name is one segment, like a file rename.
    const env = start();

    await expect(createFolder("", "2024/Trip")).resolves.toBe("2024Trip");

    expect(env.fs.has(at(env, "2024Trip"))).toBe(true);
    expect(env.fs.has(at(env, "2024"))).toBe(false);
  });

  // ── renameFolder ──────────────────────────────────────────────────────────

  it("renames a folder and rewrites every path under it", async () => {
    const env = start();
    await addPhoto(env, "trip/a.jpg");
    await addPhoto(env, "trip/day2/b.jpg");
    const outside = await addPhoto(env, "other/c.jpg");

    await renameFolder("trip", "Iceland");

    expect(env.fs.has(at(env, "trip"))).toBe(false);
    expect(env.fs.text(at(env, "Iceland/day2/b.jpg"))).toBe("pixels:trip/day2/b.jpg");
    expect(find("id:trip/a.jpg")).toMatchObject({ folder: "Iceland", relPath: "Iceland/a.jpg" });
    expect(find("id:trip/day2/b.jpg")).toMatchObject({
      folder: "Iceland/day2",
      relPath: "Iceland/day2/b.jpg",
    });
    expect(find(outside.id)).toMatchObject({ folder: "other", relPath: "other/c.jpg" });
  });

  it("re-points the moved photos' live handles at their new location", async () => {
    const env = start();
    await addPhoto(env, "trip/a.jpg");

    await renameFolder("trip", "Iceland");

    const moved = find("id:trip/a.jpg");
    expect(await (await moved.fileHandle!.getFile()).text()).toBe("pixels:trip/a.jpg");
    expect(moved.directoryHandle!.name).toBe("Iceland");
  });

  it("is a no-op for the root, a blank name, or the name it already has", async () => {
    const env = start();
    await addPhoto(env, "trip/a.jpg");

    await renameFolder("", "Iceland");
    await renameFolder("trip", "  ");
    await renameFolder("trip", "trip");

    expect(env.fs.has(at(env, "trip/a.jpg"))).toBe(true);
    expect(find("id:trip/a.jpg").relPath).toBe("trip/a.jpg");
  });

  it("refuses to rename onto an existing folder rather than merging into it", async () => {
    const env = start();
    await addPhoto(env, "trip/a.jpg");
    await addPhoto(env, "Iceland/b.jpg");

    await renameFolder("trip", "Iceland");

    expect(env.fs.text(at(env, "trip/a.jpg"))).toBe("pixels:trip/a.jpg");
    expect(env.fs.text(at(env, "Iceland/b.jpg"))).toBe("pixels:Iceland/b.jpg");
    expect(find("id:trip/a.jpg").relPath).toBe("trip/a.jpg");
  });

  it("keeps a rename in place when the typed name contains separators", async () => {
    const env = start();
    await addPhoto(env, "a/trip/x.jpg");

    await renameFolder("a/trip", "b/Iceland");

    expect(env.fs.text(at(env, "a/bIceland/x.jpg"))).toBe("pixels:a/trip/x.jpg");
    expect(env.fs.has(at(env, "b"))).toBe(false);
    expect(find("id:a/trip/x.jpg").relPath).toBe("a/bIceland/x.jpg");
  });

  // ── moveFolder ────────────────────────────────────────────────────────────

  it("moves a folder into another and rewrites its subtree", async () => {
    const env = start();
    await addPhoto(env, "trip/day2/b.jpg");
    await createFolder("", "2024");

    await moveFolder("trip", "2024");

    expect(env.fs.has(at(env, "trip"))).toBe(false);
    expect(env.fs.text(at(env, "2024/trip/day2/b.jpg"))).toBe("pixels:trip/day2/b.jpg");
    expect(find("id:trip/day2/b.jpg")).toMatchObject({
      folder: "2024/trip/day2",
      relPath: "2024/trip/day2/b.jpg",
    });
  });

  it("moves a nested folder back out to the project root", async () => {
    const env = start();
    await addPhoto(env, "2024/trip/a.jpg");

    await moveFolder("2024/trip", "");

    expect(env.fs.text(at(env, "trip/a.jpg"))).toBe("pixels:2024/trip/a.jpg");
    expect(find("id:2024/trip/a.jpg")).toMatchObject({ folder: "trip", relPath: "trip/a.jpg" });
  });

  it("refuses to move a folder into itself, its own descendant, or its current parent", async () => {
    const env = start();
    await addPhoto(env, "2024/trip/day2/a.jpg");

    await moveFolder("2024/trip", "2024/trip");
    await moveFolder("2024/trip", "2024/trip/day2");
    await moveFolder("2024/trip", "2024");

    expect(env.fs.text(at(env, "2024/trip/day2/a.jpg"))).toBe("pixels:2024/trip/day2/a.jpg");
    expect(find("id:2024/trip/day2/a.jpg").relPath).toBe("2024/trip/day2/a.jpg");
  });

  it("allows a move into a sibling whose name merely shares a prefix", async () => {
    // "trip" must not be treated as an ancestor of "tripods" — the descendant
    // guard has to compare whole path segments.
    const env = start();
    await addPhoto(env, "trip/a.jpg");
    await createFolder("", "tripods");

    await moveFolder("trip", "tripods");

    expect(env.fs.text(at(env, "tripods/trip/a.jpg"))).toBe("pixels:trip/a.jpg");
  });

  it("refuses a move that would collide with a folder already in the destination", async () => {
    const env = start();
    await addPhoto(env, "trip/a.jpg");
    await addPhoto(env, "2024/trip/b.jpg");

    await moveFolder("trip", "2024");

    expect(env.fs.text(at(env, "trip/a.jpg"))).toBe("pixels:trip/a.jpg");
    expect(env.fs.text(at(env, "2024/trip/b.jpg"))).toBe("pixels:2024/trip/b.jpg");
  });

  // ── movePhotos ────────────────────────────────────────────────────────────

  it("moves photos into a folder, carrying their sidecars", async () => {
    const env = start();
    await addPhoto(env, "a.jpg");
    env.fs.put(at(env, `a.jpg${SIDECAR_SUFFIX}`), '{"safelightSidecar":1}');

    await movePhotos(["id:a.jpg"], "2024");

    expect(env.fs.has(at(env, "a.jpg"))).toBe(false);
    expect(env.fs.text(at(env, "2024/a.jpg"))).toBe("pixels:a.jpg");
    expect(env.fs.text(at(env, `2024/a.jpg${SIDECAR_SUFFIX}`))).toBe('{"safelightSidecar":1}');
    expect(find("id:a.jpg")).toMatchObject({ folder: "2024", relPath: "2024/a.jpg" });
  });

  it("skips a photo that already lives in the destination", async () => {
    const env = start();
    await addPhoto(env, "2024/a.jpg");

    await movePhotos(["id:2024/a.jpg"], "2024");

    expect(env.fs.text(at(env, "2024/a.jpg"))).toBe("pixels:2024/a.jpg");
  });

  it("never overwrites a different photo that already owns the name in the destination", async () => {
    // fs.rename replaces the destination silently, so an unguarded move destroys
    // the file that was already there and leaves two records on one file.
    const env = start();
    await addPhoto(env, "a/IMG_1.jpg");
    await addPhoto(env, "b/IMG_1.jpg");
    await addPhoto(env, "a/IMG_2.jpg");

    await movePhotos(["id:a/IMG_1.jpg", "id:a/IMG_2.jpg"], "b");

    expect(env.fs.text(at(env, "b/IMG_1.jpg"))).toBe("pixels:b/IMG_1.jpg");
    expect(env.fs.text(at(env, "a/IMG_1.jpg"))).toBe("pixels:a/IMG_1.jpg");
    expect(find("id:a/IMG_1.jpg").relPath).toBe("a/IMG_1.jpg");
    // The rest of the batch still moves.
    expect(env.fs.text(at(env, "b/IMG_2.jpg"))).toBe("pixels:a/IMG_2.jpg");
    expect(find("id:a/IMG_2.jpg").relPath).toBe("b/IMG_2.jpg");
  });

  it("carries a master's virtual copies to the new folder", async () => {
    const env = start();
    const master = await addPhoto(env, "a.jpg");
    const copy = addCopy(master, "copy");

    await movePhotos([master.id], "2024");

    expect(find(copy.id)).toMatchObject({
      folder: "2024",
      relPath: "2024/a.jpg",
      copyOf: master.id,
    });
    expect(find(copy.id).fileHandle).toBe(find(master.id).fileHandle);
  });

  it("ignores a virtual copy dragged without its master", async () => {
    const env = start();
    const master = await addPhoto(env, "a.jpg");
    const copy = addCopy(master, "copy");

    await movePhotos([copy.id], "2024");

    expect(env.fs.text(at(env, "a.jpg"))).toBe("pixels:a.jpg");
    expect(find(copy.id).relPath).toBe("a.jpg");
  });

  // ── renamePhoto ───────────────────────────────────────────────────────────

  it("renames a photo in place, keeping its extension and its sidecar", async () => {
    const env = start();
    await addPhoto(env, "trip/IMG_0001.NEF");
    env.fs.put(at(env, `trip/IMG_0001.NEF${SIDECAR_SUFFIX}`), '{"safelightSidecar":1}');
    h.edits.set("id:trip/IMG_0001.NEF", {
      photoId: "id:trip/IMG_0001.NEF",
      stack: [],
      currentIndex: -1,
    });

    await expect(renamePhoto("id:trip/IMG_0001.NEF", "Sunrise")).resolves.toEqual({
      ok: true,
      filename: "Sunrise.NEF",
    });

    expect(env.fs.has(at(env, "trip/IMG_0001.NEF"))).toBe(false);
    expect(env.fs.text(at(env, "trip/Sunrise.NEF"))).toBe("pixels:trip/IMG_0001.NEF");
    expect(env.fs.text(at(env, `trip/Sunrise.NEF${SIDECAR_SUFFIX}`))).toBe(
      '{"safelightSidecar":1}',
    );
    expect(find("id:trip/IMG_0001.NEF")).toMatchObject({
      filename: "Sunrise.NEF",
      relPath: "trip/Sunrise.NEF",
      folder: "trip",
    });
  });

  it("collapses separators and trailing dots that a filesystem can't keep", async () => {
    const env = start();
    await addPhoto(env, "a.jpg");

    await expect(renamePhoto("id:a.jpg", " ../sun set. ")).resolves.toEqual({
      ok: true,
      filename: "..sun set.jpg",
    });
    expect(env.fs.text(at(env, "..sun set.jpg"))).toBe("pixels:a.jpg");
  });

  it("rejects a name that cleans down to nothing", async () => {
    const env = start();
    await addPhoto(env, "a.jpg");

    await expect(renamePhoto("id:a.jpg", "  ")).resolves.toMatchObject({ ok: false });
    await expect(renamePhoto("id:a.jpg", "///")).resolves.toMatchObject({ ok: false });
    expect(env.fs.text(at(env, "a.jpg"))).toBe("pixels:a.jpg");
  });

  it("refuses to rename onto a file that already exists", async () => {
    const env = start();
    await addPhoto(env, "a.jpg");
    await addPhoto(env, "b.jpg");

    const res = await renamePhoto("id:a.jpg", "b");

    expect(res.ok).toBe(false);
    expect(env.fs.text(at(env, "a.jpg"))).toBe("pixels:a.jpg");
    expect(env.fs.text(at(env, "b.jpg"))).toBe("pixels:b.jpg");
  });

  it("treats renaming to the current name as a no-op success", async () => {
    const env = start();
    await addPhoto(env, "a.jpg");

    await expect(renamePhoto("id:a.jpg", "a")).resolves.toEqual({ ok: true, filename: "a.jpg" });
    expect(env.fs.text(at(env, "a.jpg"))).toBe("pixels:a.jpg");
  });

  it("refuses to rename a virtual copy — it shares the master's file", async () => {
    const env = start();
    const master = await addPhoto(env, "a.jpg");
    const copy = addCopy(master, "copy");

    const res = await renamePhoto(copy.id, "b");

    expect(res).toMatchObject({ ok: false });
    expect(env.fs.text(at(env, "a.jpg"))).toBe("pixels:a.jpg");
  });

  it("carries a rename to the master's virtual copies", async () => {
    const env = start();
    const master = await addPhoto(env, "a.jpg");
    const copy = addCopy(master, "copy");

    await renamePhoto(master.id, "b");

    expect(find(copy.id)).toMatchObject({ filename: "b.jpg", relPath: "b.jpg", copyName: "copy" });
  });

  it("reports a missing photo or a closed project instead of throwing", async () => {
    start();
    await expect(renamePhoto("nope", "x")).resolves.toMatchObject({ ok: false });
    h.root = null;
    await expect(renamePhoto("nope", "x")).resolves.toMatchObject({ ok: false });
  });

  // ── deleteFolder ──────────────────────────────────────────────────────────

  it("deletes a folder with its subtree and drops its photos from the catalog", async () => {
    const env = start();
    await addPhoto(env, "trip/a.jpg");
    await addPhoto(env, "trip/day2/b.jpg");
    await addPhoto(env, "keep/c.jpg");

    await deleteFolder("trip");

    expect(env.fs.tree()).toEqual([at(env, "keep/c.jpg")]);
    expect(h.photos.map((p) => p.id)).toEqual(["id:keep/c.jpg"]);
  });

  it("clears the active folder only when it was inside the deleted tree", async () => {
    const env = start();
    await addPhoto(env, "trip/day2/a.jpg");
    h.activeFolder = "trip/day2";

    await deleteFolder("trip");
    expect(h.activeFolder).toBeNull();

    await addPhoto(env, "keep/c.jpg");
    h.activeFolder = "keep";
    await createFolder("", "gone");
    await deleteFolder("gone");
    expect(h.activeFolder).toBe("keep");
  });

  it("never deletes the project root", async () => {
    const env = start();
    await addPhoto(env, "a.jpg");

    await deleteFolder("");

    expect(env.fs.text(at(env, "a.jpg"))).toBe("pixels:a.jpg");
    expect(h.photos).toHaveLength(1);
  });

  // ── exportPhotoData ───────────────────────────────────────────────────────

  it("writes a sidecar of curation and develop edits next to each photo", async () => {
    const env = start();
    await addPhoto(env, "trip/a.jpg", {
      rating: 4,
      colorLabel: "red",
      flag: "pick",
      keywords: ["iceland", "dawn"],
    });
    const edit: EditState = {
      photoId: "id:trip/a.jpg",
      stack: [{ timestamp: 7, label: "Exposure", params: {} as EditState["stack"][0]["params"] }],
      currentIndex: 0,
    };
    h.edits.set(edit.photoId, edit);

    await expect(exportPhotoData(["id:trip/a.jpg"])).resolves.toBe(1);

    const raw = env.fs.text(at(env, `trip/a.jpg${SIDECAR_SUFFIX}`));
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw!)).toEqual({
      safelightSidecar: 1,
      filename: "a.jpg",
      info: { rating: 4, colorLabel: "red", flag: "pick", keywords: ["iceland", "dawn"] },
      maps: { stack: edit.stack, currentIndex: 0 },
    });
  });

  it("records a null edit history for a photo that was never developed", async () => {
    const env = start();
    await addPhoto(env, "a.jpg");

    await exportPhotoData(["id:a.jpg"]);

    expect(JSON.parse(env.fs.text(at(env, `a.jpg${SIDECAR_SUFFIX}`))!).maps).toBeNull();
  });

  it("skips virtual copies so they can't clobber the master's sidecar", async () => {
    const env = start();
    const master = await addPhoto(env, "a.jpg", { rating: 5 });
    addCopy(master, "copy");

    await expect(exportPhotoData(h.photos.map((p) => p.id))).resolves.toBe(1);

    expect(JSON.parse(env.fs.text(at(env, `a.jpg${SIDECAR_SUFFIX}`))!).info.rating).toBe(5);
    expect(env.fs.tree().filter((p) => p.endsWith(SIDECAR_SUFFIX))).toHaveLength(1);
  });

  it("skips a record with no live directory handle", async () => {
    const env = start();
    await addPhoto(env, "a.jpg", { directoryHandle: null });

    await expect(exportPhotoData(["id:a.jpg"])).resolves.toBe(0);
    expect(env.fs.tree()).toEqual([at(env, "a.jpg")]);
  });
});

describe("revealPhoto", () => {
  it("reveals the photo's own absolute path in the native build", async () => {
    const env = open("D:\\Photos", true);
    await addPhoto(env, "trip/a.jpg");

    await expect(revealPhoto("id:trip/a.jpg")).resolves.toBe(true);
    expect(env.fs.revealed).toEqual(["D:\\Photos/trip/a.jpg"]);
  });

  it("falls back to the project root plus relPath when the record has no handle", async () => {
    const env = open("/home/u/photos", true);
    await addPhoto(env, "trip/a.jpg", { fileHandle: null });

    await expect(revealPhoto("id:trip/a.jpg")).resolves.toBe(true);
    expect(env.fs.revealed).toEqual(["/home/u/photos/trip/a.jpg"]);
  });

  it("returns false in the browser build and for an unknown photo", async () => {
    const env = open("/home/u/photos", false);
    await addPhoto(env, "a.jpg");

    await expect(revealPhoto("id:a.jpg")).resolves.toBe(false);
    await expect(revealPhoto("nope")).resolves.toBe(false);
  });
});
