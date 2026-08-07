// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Delete photos from disk — files go to the OS trash (recoverable), never a
// hard delete. Catalog removal only follows a successful trash, so a locked or
// write-protected file (memory card) stays in the catalog with its error
// reported. Virtual copies share their master's file, so they are never
// trashed from here; removing the master carries its copies away instead.

import { useCatalogStore } from "@/state/catalog-store";
import { nativeFs, nativePathOf } from "@/project/native-fs";
import { deleteCachedPreview, rawCacheKey } from "@/raw/raw-cache";
import { SIDECAR_SUFFIX } from "@/project/folder-ops";

export interface DeleteFromDiskResult {
  /** Photos whose file went to the OS trash (and left the catalog). */
  deleted: number;
  /** Virtual copies in the selection — no file of their own, left untouched. */
  skippedCopies: number;
  failed: { filename: string; message: string }[];
}

/** True when the privileged bridge can trash files (Electron build; the
 *  method is feature-detected so an older preload degrades to unavailable). */
export function diskTrashAvailable(): boolean {
  return typeof nativeFs()?.trash === "function";
}

/** OS-correct name for where trashed files go. */
export function trashLabel(): string {
  const platform = typeof navigator === "undefined" ? "" : navigator.platform;
  return /^win/i.test(platform) ? "Recycle Bin" : "Trash";
}

export async function deletePhotosFromDisk(
  ids: string[],
): Promise<DeleteFromDiskResult> {
  const fs = nativeFs();
  const idSet = new Set(ids);
  const targets = useCatalogStore
    .getState()
    .photos.filter((p) => idSet.has(p.id));

  const result: DeleteFromDiskResult = { deleted: 0, skippedCopies: 0, failed: [] };
  const trashedIds: string[] = [];

  for (const photo of targets) {
    if (photo.copyOf) {
      result.skippedCopies++;
      continue;
    }
    if (typeof fs?.trash !== "function") {
      result.failed.push({
        filename: photo.filename,
        message: "Deleting from disk isn't available in this build.",
      });
      continue;
    }
    const path = nativePathOf(photo.fileHandle);
    if (!path) {
      result.failed.push({
        filename: photo.filename,
        message: "The file's location on disk is unknown.",
      });
      continue;
    }
    try {
      await fs.trash(path);
    } catch (e) {
      result.failed.push({
        filename: photo.filename,
        message: e instanceof Error ? e.message : String(e),
      });
      continue;
    }
    // Best-effort cleanup of what belongs to the file: its exported sidecar
    // and its cached RAW decode. Neither failure should keep the removal back.
    try {
      const sidecar = `${path}${SIDECAR_SUFFIX}`;
      if (await fs.exists(sidecar)) await fs.trash(sidecar);
    } catch {
      /* sidecar is gone or locked — the photo itself is already trashed */
    }
    await deleteCachedPreview(
      rawCacheKey(photo.relPath, photo.fileSize, photo.rotation ?? 0),
    );
    trashedIds.push(photo.id);
    result.deleted++;
  }

  // Removing a master also removes its virtual copies (withVirtualCopies).
  if (trashedIds.length > 0)
    useCatalogStore.getState().removePhotos(trashedIds);
  return result;
}

/** Confirm, trash, then report anything that didn't go cleanly. Shared by the
 *  grid context menu and the keyboard action so the wording never drifts. */
export async function confirmAndDeleteFromDisk(ids: string[]): Promise<void> {
  if (ids.length === 0 || !diskTrashAvailable()) return;
  const n = ids.length;
  const bin = trashLabel();
  const ok = window.confirm(
    `Move ${n} photo${n === 1 ? "" : "s"} to the ${bin}? They'll also be removed from the catalog; the file${n === 1 ? "" : "s"} can be restored from the ${bin}.`,
  );
  if (!ok) return;
  const r = await deletePhotosFromDisk(ids);
  const notes: string[] = [];
  if (r.skippedCopies > 0)
    notes.push(
      `Skipped ${r.skippedCopies} virtual ${r.skippedCopies === 1 ? "copy" : "copies"} — a copy shares its master's file. Use Remove to take copies out of the catalog.`,
    );
  if (r.failed.length > 0)
    notes.push(
      `Couldn't delete ${r.failed.length} file${r.failed.length === 1 ? "" : "s"}:\n` +
        r.failed.map((f) => `• ${f.filename} — ${f.message}`).join("\n"),
    );
  if (notes.length > 0) window.alert(notes.join("\n\n"));
}
