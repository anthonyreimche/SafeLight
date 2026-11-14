// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Delete photos from disk — files go to the OS trash (recoverable), never a
// hard delete. Catalogue removal only follows a successful trash, so a locked or
// write-protected file (memory card) stays in the catalogue with its error
// reported. Virtual copies share their master's file, so they are never
// trashed from here; removing the master carries its copies away instead.

import { useCatalogStore } from "@/state/catalog-store";
import { nativeFs, nativePathOf } from "@/project/native-fs";
import { deleteCachedPreview } from "@/raw/raw-cache";
import { photoCacheKey } from "@/raw/photo-cache-key";
import { SIDECAR_SUFFIX } from "@/project/folder-ops";
import { alertDialog, confirmDialog } from "@/ui/components/ConfirmDialog";
import { fsErrorText } from "@/project/fs-errors";
import { projectPassSignal } from "@/project/project-store";

/** Trashed photos taken out of the catalogue at a time. */
const REMOVE_BATCH = 10;

export interface DeleteFromDiskResult {
  /** Photos whose file went to the OS trash (and left the catalogue). */
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
  const signal = projectPassSignal();
  const idSet = new Set(ids);
  const targets = useCatalogStore
    .getState()
    .photos.filter((p) => idSet.has(p.id));

  const result: DeleteFromDiskResult = { deleted: 0, skippedCopies: 0, failed: [] };
  const pending: string[] = [];
  // In batches as it goes: once the project is left, the catalogue in the store
  // is another project's, and the trashed photos stay in theirs as missing.
  const flush = async () => {
    if (pending.length === 0 || signal?.aborted) return;
    // Removing a master also removes its virtual copies (withVirtualCopies).
    await useCatalogStore.getState().removePhotos(pending.splice(0));
  };

  try {
    for (const photo of targets) {
      if (photo.copyOf) {
        result.skippedCopies++;
        continue;
      }
      if (signal?.aborted) {
        result.failed.push({
          filename: photo.filename,
          message: "The project was closed before this photo was deleted.",
        });
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
        console.error("[library] couldn't move to trash:", photo.filename, e);
        result.failed.push({
          filename: photo.filename,
          message: fsErrorText(e, { target: "file" }),
        });
        continue;
      }
      pending.push(photo.id);
      result.deleted++;
      // Best-effort cleanup of what belongs to the file: its exported sidecar
      // and its cached RAW decode. Neither failure should keep the removal back.
      try {
        const sidecar = `${path}${SIDECAR_SUFFIX}`;
        if (await fs.exists(sidecar)) await fs.trash(sidecar);
      } catch {
        /* sidecar is gone or locked — the photo itself is already trashed */
      }
      try {
        await deleteCachedPreview(photoCacheKey(photo));
      } catch (e) {
        console.warn("[library] couldn't drop the cached decode:", photo.filename, e);
      }
      if (pending.length >= REMOVE_BATCH) await flush();
    }
  } finally {
    await flush();
  }
  return result;
}

let confirmOpen = false;

/** Confirm, trash, then report anything that didn't go cleanly. Shared by the
 *  grid context menu and the keyboard action so the wording never drifts. A
 *  request made while the confirmation is already open is dropped, not queued
 *  behind it. */
export async function confirmAndDeleteFromDisk(ids: string[]): Promise<void> {
  if (ids.length === 0 || !diskTrashAvailable() || confirmOpen) return;
  const n = ids.length;
  const bin = trashLabel();
  confirmOpen = true;
  const ok = await confirmDialog({
    title: "Delete from disk",
    message: `Move ${n} photo${n === 1 ? "" : "s"} to the ${bin}? They'll also be removed from the catalogue; the file${n === 1 ? "" : "s"} can be restored from the ${bin}.`,
    confirmLabel: `Move to ${bin}`,
    variant: "danger",
  }).finally(() => {
    confirmOpen = false;
  });
  if (!ok) return;
  const r = await deletePhotosFromDisk(ids);
  const notes: string[] = [];
  if (r.skippedCopies > 0)
    notes.push(
      `Skipped ${r.skippedCopies} virtual ${r.skippedCopies === 1 ? "copy" : "copies"}. A copy shares its master's file. Use Remove to take copies out of the catalogue.`,
    );
  if (r.failed.length > 0)
    notes.push(
      `Couldn't delete ${r.failed.length} file${r.failed.length === 1 ? "" : "s"}:\n` +
        r.failed.map((f) => `• ${f.filename}: ${f.message}`).join("\n") +
        `\n${r.failed.length === 1 ? "This photo stays" : "These photos stay"} in the catalogue.`,
    );
  if (notes.length > 0)
    await alertDialog({ title: "Delete from disk", message: notes.join("\n\n") });
}
