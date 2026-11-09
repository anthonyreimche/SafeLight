// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Folder management for the Folders panel: create / rename folders, and move
// folders or photos between folders by dragging. Every op mutates the real
// directory tree on disk, then updates the affected catalogue records (relPath /
// folder / live handles) and refreshes the folder tree — no re-decode, so
// ratings, edits and cached thumbnails (keyed by photo id) are preserved.

import { useProjectStore } from "./project-store";
import { useCatalogStore } from "@/state/catalog-store";
import { useUIStore } from "@/state/ui-store";
import { catalogStorage } from "@/catalog/storage";
import { nativeFs, nativePathOf, revealNativePath } from "./native-fs";
import { writeJSON } from "./fs";
import type { CatalogPhoto } from "@/catalog/types";
import { SIDECAR_SUFFIX, type PhotoSidecar } from "./sidecar";

export { SIDECAR_SUFFIX };

// ── relative-path helpers (posix separators, "" = project root) ──────────────
function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}
function dirnameRel(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}
function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

function root(): FileSystemDirectoryHandle | null {
  return useProjectStore.getState().root;
}

/** Split a filename into [base, ext] where ext keeps its leading dot (or ""). A
 *  leading-dot name (".hidden") is treated as all base, no extension. */
function splitExt(name: string): [string, string] {
  const i = name.lastIndexOf(".");
  return i > 0 ? [name.slice(0, i), name.slice(i)] : [name, ""];
}

/** Reduce a user-typed name to one filesystem entry name: a single path segment
 *  (separators would silently create or move into nested folders) with no
 *  trailing dots or spaces, which Windows can't keep. "" if nothing is left. */
function cleanEntryName(raw: string): string {
  return raw.trim().replace(/[/\\]/g, "").replace(/[. ]+$/, "");
}

/** Whether two paths differ only in case. On NTFS and APFS by default that is one
 *  entry respelled; where names keep their case (Linux, or a case-sensitive volume
 *  of Windows or macOS) the new spelling may be another entry. The platform can't
 *  say which, since a card or share keeps its own rules, so the folder's listing
 *  does (nameTaken). */
function caseOnlyChange(fromRel: string, toRel: string): boolean {
  return fromRel !== toRel && fromRel.toLowerCase() === toRel.toLowerCase();
}

/** Whether `toRel` is taken by an entry other than `fromRel`. A case-only change
 *  reads the parent's listing for the exact new spelling: a lookup would answer
 *  yes on a disk that ignores case, where the entry found is the one being
 *  respelled, and a native rename onto a real second entry replaces it. */
async function nameTaken(
  rootHandle: FileSystemDirectoryHandle,
  fromRel: string,
  toRel: string,
  kind: "file" | "directory",
): Promise<boolean> {
  if (!caseOnlyChange(fromRel, toRel)) {
    return kind === "file" ? existsRel(rootHandle, toRel) : dirExistsRel(rootHandle, toRel);
  }
  const parent = await resolveDir(rootHandle, dirnameRel(toRel));
  const target = basename(toRel);
  for await (const name of parent.keys()) {
    if (name === target) return true;
  }
  return false;
}

/** Does a project-relative path exist on disk? Works in both the native and FSA
 *  builds (the latter probes the parent directory handle). */
async function existsRel(
  rootHandle: FileSystemDirectoryHandle,
  rel: string,
): Promise<boolean> {
  const fs = nativeFs();
  const rootPath = nativePathOf(rootHandle);
  if (fs && rootPath) {
    return fs.exists(`${rootPath.replace(/[/\\]+$/, "")}/${rel}`);
  }
  try {
    const parent = await resolveDir(rootHandle, dirnameRel(rel));
    await parent.getFileHandle(basename(rel));
    return true;
  } catch {
    return false;
  }
}

/** Does a project-relative *directory* exist on disk? (existsRel probes for a
 *  file, so it can't see a folder in the FSA build.) */
async function dirExistsRel(
  rootHandle: FileSystemDirectoryHandle,
  rel: string,
): Promise<boolean> {
  const fs = nativeFs();
  const rootPath = nativePathOf(rootHandle);
  if (fs && rootPath) {
    return fs.exists(`${rootPath.replace(/[/\\]+$/, "")}/${rel}`);
  }
  try {
    const parent = await resolveDir(rootHandle, dirnameRel(rel));
    await parent.getDirectoryHandle(basename(rel));
    return true;
  } catch {
    return false;
  }
}

/** Walk from the project root to a relative folder, optionally creating it. */
async function resolveDir(
  rootHandle: FileSystemDirectoryHandle,
  rel: string,
  create = false,
): Promise<FileSystemDirectoryHandle> {
  let dir = rootHandle;
  if (!rel) return dir;
  for (const seg of rel.split("/")) {
    dir = await dir.getDirectoryHandle(seg, { create });
  }
  return dir;
}

// ── on-disk move (file or directory) ─────────────────────────────────────────
// Electron: a single native rename moves a whole subtree atomically. Browser
// (FSA) has no move API, so fall back to recursive copy + delete.

async function moveOnDisk(
  rootHandle: FileSystemDirectoryHandle,
  srcRel: string,
  destRel: string,
  kind: "file" | "directory",
): Promise<void> {
  const fs = nativeFs();
  const rootPath = nativePathOf(rootHandle);
  if (fs && rootPath) {
    const abs = (rel: string) => `${rootPath.replace(/[/\\]+$/, "")}/${rel}`;
    await fs.move(abs(srcRel), abs(destRel));
    return;
  }
  // FSA fallback. A copy onto the same name in another case would land on the
  // source itself where the disk ignores case, and the delete would then take
  // both, so that goes through a temporary name.
  if (caseOnlyChange(srcRel, destRel)) {
    const temp = `${destRel}.${Date.now().toString(36)}.renaming`;
    await moveOnDisk(rootHandle, srcRel, temp, kind);
    await moveOnDisk(rootHandle, temp, destRel, kind);
    return;
  }
  const srcParent = await resolveDir(rootHandle, dirnameRel(srcRel));
  const destParent = await resolveDir(rootHandle, dirnameRel(destRel), true);
  if (kind === "file") {
    await copyFile(srcParent, basename(srcRel), destParent, basename(destRel));
  } else {
    const srcDir = await srcParent.getDirectoryHandle(basename(srcRel));
    await copyDir(srcDir, destParent, basename(destRel));
  }
  await srcParent.removeEntry(basename(srcRel), { recursive: kind === "directory" });
}

async function copyFile(
  srcDir: FileSystemDirectoryHandle,
  name: string,
  destDir: FileSystemDirectoryHandle,
  destName: string,
): Promise<void> {
  const fh = await srcDir.getFileHandle(name);
  const file = await fh.getFile();
  const out = await destDir.getFileHandle(destName, { create: true });
  const w = await out.createWritable();
  await w.write(file);
  await w.close();
}

async function copyDir(
  srcDir: FileSystemDirectoryHandle,
  destParent: FileSystemDirectoryHandle,
  newName: string,
): Promise<void> {
  const destDir = await destParent.getDirectoryHandle(newName, { create: true });
  // Copy hidden entries too: they're user data that must travel with the folder.
  // (The project's .safelight working dir lives at the root, never inside a
  // moved subfolder, so it can't be dragged through here.)
  for await (const entry of srcDir.values()) {
    if (entry.kind === "directory") {
      await copyDir(entry as FileSystemDirectoryHandle, destDir, entry.name);
    } else {
      await copyFile(srcDir, entry.name, destDir, entry.name);
    }
  }
}

// ── catalogue updates ──────────────────────────────────────────────────────────

/** Where a photo lives now, as far as a move or rename changed it. */
type Relocation = Partial<
  Pick<CatalogPhoto, "filename" | "folder" | "relPath" | "directoryHandle" | "fileHandle">
>;

/** Persist where photos now live, keyed by id; a virtual copy shares its master's
 *  file, so it follows its master. Applied to the photos as the store holds them
 *  once the disk work is done, which another window's records may have changed. */
async function relocate(moved: Map<string, Relocation>): Promise<void> {
  const updated = useCatalogStore.getState().photos.flatMap((p) => {
    const to = moved.get(p.id) ?? (p.copyOf ? moved.get(p.copyOf) : undefined);
    return to ? [{ ...p, ...to }] : [];
  });
  await useCatalogStore.getState().relocatePhotos(updated);
}

/** Rebuild handle + path fields for every photo under `oldPrefix`, rewriting
 *  the prefix to `newPrefix`, then persist them. */
async function relocateSubtree(
  rootHandle: FileSystemDirectoryHandle,
  oldPrefix: string,
  newPrefix: string,
): Promise<void> {
  const photos = useCatalogStore.getState().photos;
  const dirCache = new Map<string, FileSystemDirectoryHandle>();
  const dirFor = async (rel: string) => {
    let d = dirCache.get(rel);
    if (!d) {
      d = await resolveDir(rootHandle, rel);
      dirCache.set(rel, d);
    }
    return d;
  };

  const moved = new Map<string, Relocation>();
  for (const p of photos) {
    const under = p.folder === oldPrefix || p.folder.startsWith(`${oldPrefix}/`);
    if (!under) continue;
    const newFolder = newPrefix + p.folder.slice(oldPrefix.length);
    const dir = await dirFor(newFolder);
    const fileHandle = await dir.getFileHandle(p.filename);
    moved.set(p.id, {
      folder: newFolder,
      relPath: joinRel(newFolder, p.filename),
      directoryHandle: dir,
      fileHandle,
    });
  }
  await relocate(moved);
}

/** The handle of a file an op just put at `name` in `folder`, or null when the
 *  lookup fails: the record still follows the file, and the next scan re-attaches
 *  a handle rather than the record keeping one to the old path. */
async function movedFileHandle(
  rootHandle: FileSystemDirectoryHandle,
  folder: string,
  name: string,
): Promise<FileSystemFileHandle | null> {
  try {
    return await (await resolveDir(rootHandle, folder)).getFileHandle(name);
  } catch (e) {
    console.warn(`[folder-ops] ${joinRel(folder, name)} moved but couldn't be found again:`, e);
    return null;
  }
}

/** Best-effort: keep a photo's sidecar paired with its image. A sidecar already
 *  at `toRel` isn't this photo's, and a native rename would replace it, so then
 *  this one stays where it is. */
async function carrySidecar(
  rootHandle: FileSystemDirectoryHandle,
  fromRel: string,
  toRel: string,
): Promise<void> {
  try {
    if (!(await existsRel(rootHandle, fromRel))) return;
    if (await nameTaken(rootHandle, fromRel, toRel, "file")) {
      console.warn(`[folder-ops] sidecar move ${fromRel} → ${toRel} skipped: name in use`);
      return;
    }
    await moveOnDisk(rootHandle, fromRel, toRel, "file");
  } catch (e) {
    console.warn(`[folder-ops] sidecar move ${fromRel} skipped:`, e);
  }
}

// ── public operations ────────────────────────────────────────────────────────

/** Create a subfolder under `parentRel`. Returns its relative path, or null. */
export async function createFolder(
  parentRel: string,
  name: string,
): Promise<string | null> {
  const rootHandle = root();
  const clean = cleanEntryName(name);
  if (!rootHandle || !clean) return null;
  const parent = await resolveDir(rootHandle, parentRel, true);
  await parent.getDirectoryHandle(clean, { create: true });
  await useProjectStore.getState().refreshTree();
  return joinRel(parentRel, clean);
}

/** Generate a folder name not already used among `siblingNames`. */
export function uniqueFolderName(siblingNames: string[], base = "Untitled Folder"): string {
  const taken = new Set(siblingNames);
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`)) return `${base} ${i}`;
}

/** Rename a folder in place (same parent). No-op for the root or empty names. */
export async function renameFolder(rel: string, newName: string): Promise<void> {
  const rootHandle = root();
  const clean = cleanEntryName(newName);
  if (!rootHandle || !rel || !clean || clean === basename(rel)) return;
  const newRel = joinRel(dirnameRel(rel), clean);
  // Bail on collision rather than merge into / overwrite an existing folder.
  if (await nameTaken(rootHandle, rel, newRel, "directory")) {
    console.warn(`[folder-ops] rename ${rel} → ${newRel} skipped: name in use`);
    return;
  }
  await moveOnDisk(rootHandle, rel, newRel, "directory");
  await relocateSubtree(rootHandle, rel, newRel);
  await useProjectStore.getState().refreshTree();
}

/** Move a folder into `destParentRel` (""=root). Guards against moving a folder
 *  into itself, into its own descendant, or back into its current parent. */
export async function moveFolder(srcRel: string, destParentRel: string): Promise<void> {
  const rootHandle = root();
  if (!rootHandle || !srcRel) return;
  if (destParentRel === srcRel || destParentRel.startsWith(`${srcRel}/`)) return;
  if (dirnameRel(srcRel) === destParentRel) return;
  const newRel = joinRel(destParentRel, basename(srcRel));
  // Bail on collision rather than merge into / overwrite an existing folder.
  if (await dirExistsRel(rootHandle, newRel)) {
    console.warn(`[folder-ops] move ${srcRel} → ${newRel} skipped: name in use`);
    return;
  }
  await resolveDir(rootHandle, destParentRel, true);
  await moveOnDisk(rootHandle, srcRel, newRel, "directory");
  await relocateSubtree(rootHandle, srcRel, newRel);
  await useProjectStore.getState().refreshTree();
}

/** Move photos (by id) into folder `destRel`. Virtual copies own no file, so a
 *  copy is moved only when its master moves — carried along like renamePhoto — and
 *  a copy dragged without its master is skipped (its file stays with the master). */
export async function movePhotos(ids: string[], destRel: string): Promise<void> {
  const rootHandle = root();
  if (!rootHandle || ids.length === 0) return;
  const idSet = new Set(ids);
  const photos = useCatalogStore.getState().photos.filter((p) => idSet.has(p.id) && !p.copyOf);
  const destDir = await resolveDir(rootHandle, destRel, true);

  const moved = new Map<string, Relocation>();
  for (const p of photos) {
    if (p.folder === destRel) continue; // already here
    const newRel = joinRel(destRel, p.filename);
    // Bail on collision rather than overwrite: the move is a native rename,
    // which silently replaces an existing destination file — that would destroy
    // a different photo and leave two catalogue records on one file.
    if (await existsRel(rootHandle, newRel)) {
      console.warn(`[folder-ops] move ${p.relPath} → ${newRel} skipped: name in use`);
      continue;
    }
    try {
      await moveOnDisk(rootHandle, p.relPath, newRel, "file");
    } catch (e) {
      console.error(`[folder-ops] move ${p.relPath} → ${newRel} failed:`, e);
      continue;
    }

    await carrySidecar(
      rootHandle,
      joinRel(p.folder, `${p.filename}${SIDECAR_SUFFIX}`),
      joinRel(destRel, `${p.filename}${SIDECAR_SUFFIX}`),
    );

    const fileHandle = await movedFileHandle(rootHandle, destRel, p.filename);
    // Its virtual copies come along (see relocate), so they don't go stale before
    // the next scan re-attaches them.
    moved.set(p.id, { folder: destRel, relPath: newRel, directoryHandle: destDir, fileHandle });
  }
  await relocate(moved);
  await useProjectStore.getState().refreshTree();
}

/** Reveal a photo's file in the OS file manager (selects it inside its folder).
 *  Returns false in the plain-browser build or if the path can't be resolved. */
export async function revealPhoto(
  id: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const rootHandle = root();
  const photo = useCatalogStore.getState().photos.find((p) => p.id === id);
  if (!rootHandle || !photo) return { ok: false, reason: "The photo isn't in the open folder." };
  // Prefer the file handle's own absolute path; fall back to root + relPath.
  let filePath = nativePathOf(photo.fileHandle);
  if (!filePath) {
    const rootPath = nativePathOf(rootHandle);
    filePath = rootPath ? `${rootPath.replace(/[/\\]+$/, "")}/${photo.relPath}` : null;
  }
  if (!filePath) return { ok: false, reason: "Showing a file in its folder needs the desktop app." };
  return (await revealNativePath(filePath))
    ? { ok: true }
    : { ok: false, reason: "The file may have moved or been deleted." };
}

export type RenamePhotoResult =
  | { ok: true; filename: string }
  | { ok: false; reason: string };

/** Rename one photo's file on disk, in place (same folder), preserving its
 *  extension. Carries the SafeLight sidecar (<file>.safelight.json) along if one
 *  exists. Cached previews and develop edits are keyed by photo id, so they're
 *  preserved untouched — only the catalogue's filename/relPath/handle update. */
export async function renamePhoto(
  id: string,
  newBaseName: string,
): Promise<RenamePhotoResult> {
  const rootHandle = root();
  if (!rootHandle) return { ok: false, reason: "No project is open." };
  const photo = useCatalogStore.getState().photos.find((p) => p.id === id);
  if (!photo) return { ok: false, reason: "Photo not found." };
  // A virtual copy owns no file — renaming would hit the master's actual file.
  // Its display name is changed via setCopyName instead (handled by the caller).
  if (photo.copyOf) {
    return {
      ok: false,
      reason: "A virtual copy shares its original's file; rename the original instead.",
    };
  }

  const [, ext] = splitExt(photo.filename);
  // The original extension is always re-appended, so only the base is cleaned.
  const cleanBase = cleanEntryName(newBaseName);
  if (!cleanBase) return { ok: false, reason: "Name can't be empty." };
  const newFilename = cleanBase + ext;
  if (newFilename === photo.filename) return { ok: true, filename: photo.filename };

  const newRel = joinRel(photo.folder, newFilename);
  if (await nameTaken(rootHandle, photo.relPath, newRel, "file")) {
    return { ok: false, reason: `“${newFilename}” already exists in this folder.` };
  }

  try {
    await moveOnDisk(rootHandle, photo.relPath, newRel, "file");
  } catch (e) {
    console.error(`[folder-ops] rename ${photo.relPath} → ${newRel} failed:`, e);
    return { ok: false, reason: "Couldn't rename the file on disk." };
  }

  await carrySidecar(
    rootHandle,
    joinRel(photo.folder, `${photo.filename}${SIDECAR_SUFFIX}`),
    joinRel(photo.folder, `${newFilename}${SIDECAR_SUFFIX}`),
  );

  const fileHandle = await movedFileHandle(rootHandle, photo.folder, newFilename);
  // Its virtual copies come along (see relocate), so they don't go stale before
  // the next project scan re-attaches them.
  const { folder, directoryHandle } = photo;
  const renamed = { filename: newFilename, relPath: newRel, folder, directoryHandle, fileHandle };
  await relocate(new Map([[id, renamed]]));
  return { ok: true, filename: newFilename };
}

/** Delete a folder: remove the directory from disk, then drop its photos (and
 *  their previews/edits) from the catalogue and refresh the tree. No-op for the
 *  root. Rejects when the disk delete fails, leaving the catalogue as it was: the
 *  files are still there, and dropping their records would lose their edits and
 *  keep them from being imported again. */
export async function deleteFolder(rel: string): Promise<void> {
  const rootHandle = root();
  if (!rootHandle || !rel) return;
  try {
    const parent = await resolveDir(rootHandle, dirnameRel(rel));
    await parent.removeEntry(basename(rel), { recursive: true });
  } catch (e) {
    console.error(`[folder-ops] delete ${rel} failed:`, e);
    await useProjectStore.getState().refreshTree();
    throw new Error(`Couldn't delete the folder “${rel}”.`, { cause: e });
  }

  const ids = useCatalogStore
    .getState()
    .photos.filter((p) => p.folder === rel || p.folder.startsWith(`${rel}/`))
    .map((p) => p.id);
  await useCatalogStore.getState().removePhotos(ids);

  const active = useUIStore.getState().activeFolder;
  if (active !== null && (active === rel || active.startsWith(`${rel}/`))) {
    useUIStore.getState().setActiveFolder(null);
  }
  await useProjectStore.getState().refreshTree();
}

/** Write a `<image>.safelight.json` sidecar next to each selected photo so its
 *  ratings/labels and develop edits travel if the file is moved to another
 *  project. Returns the number of sidecars written. */
export async function exportPhotoData(ids: string[]): Promise<number> {
  return (await exportPhotoDataReport(ids)).written;
}

/** exportPhotoData with the sidecars that couldn't be written counted too.
 *  Photos it skips (virtual copies, records with no live folder) count in neither. */
export async function exportPhotoDataReport(
  ids: string[],
): Promise<{ written: number; failed: number }> {
  const idSet = new Set(ids);
  const photos = useCatalogStore.getState().photos.filter((p) => idSet.has(p.id));
  const storage = catalogStorage();
  let written = 0;
  let failed = 0;
  for (const p of photos) {
    if (!p.directoryHandle) continue;
    // A virtual copy shares its master's file — its sidecar path collides with
    // the master's, so exporting it would clobber the master's. Only the master
    // owns the on-disk sidecar.
    if (p.copyOf) continue;
    try {
      const edit = await storage.getEditState(p.id);
      const sidecar: PhotoSidecar = {
        safelightSidecar: 1,
        filename: p.filename,
        info: {
          rating: p.rating,
          colorLabel: p.colorLabel,
          flag: p.flag,
          keywords: p.keywords,
        },
        maps: edit ? { stack: edit.stack, currentIndex: edit.currentIndex } : null,
      };
      await writeJSON(p.directoryHandle, `${p.filename}${SIDECAR_SUFFIX}`, sidecar);
      written++;
    } catch (e) {
      failed++;
      console.error(`[folder-ops] sidecar export ${p.relPath} failed:`, e);
    }
  }
  return { written, failed };
}
