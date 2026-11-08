// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The background passes over photos already in the catalogue: repair of missing
// previews, pending libraw metadata, preview rebuild and re-import from disk.

import type { CatalogPhoto } from "@/catalog/types";
import { parseExif, parseExifDate, parseXmp } from "@/catalog/exif";
import {
  bakeFor,
  bakeRotation,
  manualRotation,
  normalizeRotation,
  orientationToRotation,
} from "@/catalog/orient";
import { isRawFile } from "@/raw/raw-preview";
import type { DecodeRequest } from "@/raw/decode-pool";
import { deleteCachedPreview, hasDecodeMarker, rawCacheKey } from "@/raw/raw-cache";
import { getSettings } from "@/state/settings-store";
import { photoById, useCatalogStore, type RebuiltChange } from "@/state/catalog-store";
import { catalogStorage, type PutOptions } from "@/catalog/storage";
import { createThumbnail } from "./import-thumb-task";
import {
  catalogSize,
  decodeImportBitmap,
  rawBytesOf,
  readRawMetadata,
  storable,
  turned,
} from "./import-decode";
import { decodeFailureReason, mimeTypeFromName } from "./import-record";

/** Store what a repair, rebuild or re-import worked out for `photo`, on the photo
 *  as the catalogue holds it once the decode is done. The decode takes a while, and
 *  the photo may have been rated or changed meanwhile, here or in another window;
 *  those changes stay. Nothing is stored for a photo that left the catalogue, nor a
 *  preview built for a turn the photo no longer has. Resolves with what was
 *  stored and the fields that changed, or null. Only those fields are for the
 *  catalogue to take on (mergeRebuiltPhoto): the photo may change again while the
 *  preview is written. A preview built here comes from the file, so it shows no
 *  edit: an edited one it replaces no longer counts as the photo's look. */
/** For passes that run unasked over the whole catalogue: a lost save leaves the
 *  pending mark or the missing size, so a later open runs the pass again. What the
 *  user asks for (rebuild, reimport) saves on the normal cadence. */
const DERIVED_AGAIN: PutOptions = { lazy: true };

async function storeOnCurrent(
  photo: CatalogPhoto,
  change: Omit<RebuiltChange, "thumbnailUrl" | "previewEdit">,
  save: PutOptions = {},
): Promise<{ photo: CatalogPhoto; change: RebuiltChange } | null> {
  const current = photoById(useCatalogStore.getState().photos, photo.id);
  if (!current) return null;
  if (change.thumbnailBlob && current.rotation !== photo.rotation) return null;
  const changed: RebuiltChange = changedFields(change, current);
  if (change.thumbnailBlob) {
    changed.thumbnailUrl = URL.createObjectURL(change.thumbnailBlob);
    if (current.previewEdit !== undefined) changed.previewEdit = undefined;
  }
  const updated: CatalogPhoto = { ...current, ...changed };
  await catalogStorage().putPhoto(updated, save); // writes the preview + persists
  if (!photoById(useCatalogStore.getState().photos, photo.id)) {
    if (changed.thumbnailUrl) URL.revokeObjectURL(changed.thumbnailUrl);
    return null;
  }
  return { photo: updated, change: changed };
}

/** The fields of `change` whose values differ from `photo`'s. */
function changedFields<T extends object>(change: T, photo: T): Partial<T> {
  const changed: Partial<T> = {};
  for (const key in change) if (change[key] !== photo[key]) changed[key] = change[key];
  return changed;
}

/**
 * Retry building previews for records imported without one (width 0). Updates
 * each in place — same id, so ratings/edits are untouched — writes its grid
 * preview, persists, and hands `onRepaired` the fields it changed so the live
 * grid refreshes. Records that still can't decode are left as-is and retried on
 * a later open. A RAW the decoder has failed on for good (see raw-cache.ts)
 * would only fail again, so it is left alone until a Reimport.
 * Sequential + fire-and-forget, like the RAW pre-decode. `signal` belongs to
 * the project: once the user leaves it, the pass reads and stores no more.
 */
export async function repairMissingPreviews(
  photos: CatalogPhoto[],
  onRepaired?: (photo: CatalogPhoto, change: RebuiltChange) => void,
  signal?: AbortSignal,
): Promise<void> {
  const request: DecodeRequest = { background: true, signal };
  const todo = photos.filter((p) => p.fileHandle && p.width === 0);
  for (const photo of todo) {
    if (signal?.aborted) return;
    try {
      const key = rawCacheKey(photo.relPath, photo.fileSize, photo.rotation ?? 0);
      const raw = isRawFile({ name: photo.filename } as File);
      if (raw && (await hasDecodeMarker(key, "unsupported"))) continue;
      const file = await photo.fileHandle!.getFile();
      if (signal?.aborted) return;
      const bytes = await rawBytesOf(file);
      const decoded = storable(
        await decodeImportBitmap(file, photo.exif.orientation, request, undefined, photo.relPath, bytes),
      );
      if (!decoded) continue; // still can't — try again next open
      if (signal?.aborted) {
        decoded.bitmap.close();
        return;
      }
      const rawMeta = await readRawMetadata(file, request, bytes);

      const { bitmap, oriented } = decoded;
      // Keep the photo's canonical rotation (EXIF + manual). The thumbnail only
      // needs to bake whatever this decode hasn't already applied: when the
      // decoder pre-oriented the pixels, subtract the EXIF portion so only the
      // manual rotation is baked.
      const { rotation, manual, bake } = bakeFor(photo, oriented);
      const thumb = await createThumbnail(bitmap, bake, getSettings().thumbMaxEdge);
      const { width, height } = catalogSize(rawMeta?.frame, manual, decoded, bake);
      bitmap.close();
      if (signal?.aborted) return;

      const updated = await storeOnCurrent(photo, {
        thumbnailBlob: thumb,
        width,
        height,
        rotation,
        decodeError: undefined, // a preview built this time — clear the marker
      }, DERIVED_AGAIN);
      if (updated) onRepaired?.(updated.photo, updated.change);

      await new Promise<void>((res) => setTimeout(res, 0));
    } catch {
      // One failure shouldn't stop the rest.
    }
  }
}

/**
 * Read what libraw knows of each RAW whose import left it pending (see
 * importPhoto) from the whole file: its frame size, as-shot white balance and
 * exposure bias. Each is stored on the photo as the catalogue holds it once libraw
 * is done, the frame turned by the photo's manual rotation then, and `onRead` is
 * handed the fields that changed. A white balance the file's EXIF declared stays.
 * A RAW libraw can't read keeps its preview's size and isn't tried again; one
 * whose file can't be read now keeps its mark for a later open. A photo whose
 * mark was cleared meanwhile, or that left the catalogue, isn't read at all.
 * Sequential background work, like repairMissingPreviews. `signal` belongs to the
 * project: once the user leaves it, the pass reads and stores no more.
 */
export async function readPendingMetadata(
  photos: CatalogPhoto[],
  onRead?: (photo: CatalogPhoto, change: RebuiltChange) => void,
  signal?: AbortSignal,
): Promise<void> {
  return readMetadataOf(photos, { background: true, signal }, onRead);
}

/** Read now, ahead of the background pass, the metadata still pending for the
 *  photos among `ids`, and show it on them in the catalogue: for an action about to
 *  start an edit from a photo's as-shot white balance. Libraw takes it as work
 *  the user waits on. */
export async function settlePendingMetadata(ids: readonly string[]): Promise<void> {
  const wanted = new Set(ids);
  const pending = useCatalogStore
    .getState()
    .photos.filter((p) => p.metadataPending && wanted.has(p.id));
  if (pending.length === 0) return;
  await readMetadataOf(pending, { background: false }, (p, change) =>
    useCatalogStore.getState().mergeRebuiltPhoto(p.id, change),
  );
}

/** The photo selected last whose pending metadata is still to be read, and the
 *  run of reads under way. */
let selectedNext: string | null = null;
let selectedReads: Promise<void> | null = null;

/** Read the pending metadata of the photo the Library shows (null: one with
 *  nothing pending), as settlePendingMetadata does, one photo at a time. A read
 *  under way finishes, then only the photo selected last is read, so arrowing
 *  through the grid reads the photo it stops on, not every photo it passes.
 *  Resolves once the run of reads ends. */
export function settleSelectedPhoto(id: string | null): Promise<void> {
  selectedNext = id;
  selectedReads ??= (async () => {
    try {
      while (selectedNext !== null) {
        const next = selectedNext;
        selectedNext = null;
        await settlePendingMetadata([next]);
      }
    } finally {
      selectedReads = null;
    }
  })();
  return selectedReads;
}

async function readMetadataOf(
  photos: CatalogPhoto[],
  request: DecodeRequest,
  onRead?: (photo: CatalogPhoto, change: RebuiltChange) => void,
): Promise<void> {
  const signal = request.signal;
  const held = (id: string) => photoById(useCatalogStore.getState().photos, id);
  for (const photo of photos) {
    if (signal?.aborted) return;
    if (!photo.metadataPending || !photo.fileHandle || !held(photo.id)?.metadataPending) continue;
    try {
      const file = await photo.fileHandle.getFile();
      if (signal?.aborted) return;
      const meta = await readRawMetadata(file, request);
      if (signal?.aborted) return;

      const current = held(photo.id);
      if (!current?.metadataPending) continue;
      const exif = { ...current.exif };
      if (meta?.colorTemperature && !exif.colorTemperature) {
        exif.colorTemperature = meta.colorTemperature;
      }
      if (meta?.rawExposureBias !== undefined) exif.rawExposureBias = meta.rawExposureBias;
      const manual = manualRotation(current.rotation, current.exif.orientation);
      const { width, height } = meta?.frame ? turned(meta.frame, manual) : current;
      const updated = await storeOnCurrent(current, {
        width,
        height,
        exif,
        metadataPending: undefined,
      }, DERIVED_AGAIN);
      if (updated) onRead?.(updated.photo, updated.change);

      await new Promise<void>((res) => setTimeout(res, 0));
    } catch {
      // The file can't be read now; the mark stays for a later open.
    }
  }
}

/**
 * Re-decode every catalogue photo and regenerate its grid preview at the current
 * "Thumbnail quality" (thumbMaxEdge). Unlike repairMissingPreviews this rebuilds
 * ALL previews, not just missing ones — it's the way a changed thumbMaxEdge takes
 * effect on an existing library, since known photos are otherwise never re-decoded
 * on open. Updates each photo in place (same id), rewrites its disk preview and
 * hands `onRebuilt` the fields it changed. Reports progress so a Preferences
 * button can show "12 / 340". Sequential to keep memory sane; one failure doesn't
 * stop the rest. `signal` belongs to the project: once the user leaves it, the
 * rebuild reads and stores no more.
 */
export async function rebuildThumbnails(
  photos: CatalogPhoto[],
  onProgress?: (done: number, total: number) => void,
  onRebuilt?: (photo: CatalogPhoto, change: RebuiltChange) => void,
  signal?: AbortSignal,
): Promise<void> {
  const todo = photos.filter((p) => p.fileHandle);
  let done = 0;
  onProgress?.(0, todo.length);
  // Long enough that the user goes on editing: a photo opened meanwhile goes first.
  const request: DecodeRequest = { background: true, signal };
  for (const photo of todo) {
    if (signal?.aborted) return;
    try {
      const file = await photo.fileHandle!.getFile();
      if (signal?.aborted) return;
      const bytes = await rawBytesOf(file);
      const decoded = storable(
        await decodeImportBitmap(file, photo.exif.orientation, request, undefined, photo.relPath, bytes),
      );
      if (decoded) {
        if (signal?.aborted) {
          decoded.bitmap.close();
          return;
        }
        const rawMeta = await readRawMetadata(file, request, bytes);
        const { bitmap, oriented } = decoded;
        // Preserve the photo's canonical rotation (EXIF + any manual rotation);
        // a rebuild changes pixels, not orientation. Bake only what this decode
        // hasn't already applied — subtract the EXIF portion when pre-oriented.
        const { rotation, manual, bake } = bakeFor(photo, oriented);
        const thumb = await createThumbnail(bitmap, bake, getSettings().thumbMaxEdge);
        const { width, height } = catalogSize(rawMeta?.frame, manual, decoded, bake);
        bitmap.close();
        if (signal?.aborted) return;

        const updated = await storeOnCurrent(photo, {
          thumbnailBlob: thumb,
          width,
          height,
          rotation,
          decodeError: undefined, // a preview built this time — clear the marker
        });
        if (updated) onRebuilt?.(updated.photo, updated.change);
      }
    } catch {
      // One failure shouldn't stop the rest.
    }
    onProgress?.(++done, todo.length);
    await new Promise<void>((res) => setTimeout(res, 0));
  }
}

/**
 * Re-import photos from disk: re-read each source file, refresh its EXIF and
 * file metadata, regenerate the grid preview at the current Thumbnail quality,
 * and invalidate the develop-preview cache so the next Develop open re-decodes
 * the (possibly changed) pixels. User curation — rating, label, flag, keywords,
 * manual rotation — and develop edits are preserved (they key off the stable
 * photo id, not the file). Updates each record in place, persists, hands
 * `onReimported` the fields it changed, and reports progress. Sequential; one
 * failure doesn't stop the rest.
 * Returns how many succeeded / failed. A photo removed while it was read, or
 * turned while its new preview was built, counts as neither: nothing was stored.
 * `signal` belongs to the project: once the user leaves it, the re-import
 * reads, drops and stores no more, and the photos it didn't finish count as
 * neither.
 */
export async function reimportPhotos(
  photos: CatalogPhoto[],
  onProgress?: (done: number, total: number) => void,
  onReimported?: (photo: CatalogPhoto, change: RebuiltChange) => void,
  signal?: AbortSignal,
): Promise<{ ok: number; failed: number }> {
  const todo = photos.filter((p) => p.fileHandle);
  let done = 0;
  let ok = 0;
  let failed = 0;
  onProgress?.(0, todo.length);
  const request: DecodeRequest = { signal };
  for (const photo of todo) {
    if (signal?.aborted) break;
    try {
      const file = await photo.fileHandle!.getFile();
      // Checked in the step that sends the delete: the next project's cache,
      // which may hold the same key, is set only after its open stops this.
      if (signal?.aborted) break;

      // Drop the stale develop-preview cache entry, and any marker that the
      // decoder can't use the file, so the next Develop open re-decodes from
      // the current file. The key folds in fileSize, so a changed file already
      // misses — this also covers a same-size edit.
      await deleteCachedPreview(
        rawCacheKey(photo.relPath, photo.fileSize, photo.rotation ?? 0),
      );

      // Refresh file-derived metadata. Re-parse EXIF (date / orientation /
      // camera) and, for RAW, the frame size and as-shot WB (metadata-only).
      // Deliberately does NOT re-seed rating / label / keywords from XMP — those
      // are the user's curation now, not the file's.
      const exif = await parseExif(file);
      if (!exif.imageDescription) {
        const xmp = await parseXmp(file);
        if (xmp.title) exif.imageDescription = xmp.title;
      }
      const bytes = await rawBytesOf(file);
      const rawMeta = await readRawMetadata(file, request, bytes);
      if (rawMeta?.colorTemperature && !exif.colorTemperature) {
        exif.colorTemperature = rawMeta.colorTemperature;
      }
      if (rawMeta?.rawExposureBias !== undefined) exif.rawExposureBias = rawMeta.rawExposureBias;

      const meta = {
        fileSize: file.size,
        mimeType: file.type || mimeTypeFromName(file.name) || photo.mimeType,
        exif,
        dateCreated: parseExifDate(exif.dateTimeOriginal) ?? file.lastModified,
      };

      const decoded = await decodeImportBitmap(
        file,
        exif.orientation,
        request,
        undefined,
        photo.relPath,
        bytes,
      ).catch(() => null);
      if (signal?.aborted) {
        if (decoded && !("failure" in decoded)) decoded.bitmap.close();
        break;
      }
      if (!decoded || "failure" in decoded) {
        // The file is readable but undecodable right now — keep the existing
        // preview, just surface the reason. (A missing/locked file throws above
        // and counts as a failure with nothing changed.)
        console.warn(
          `[import] re-import kept the old preview: ${file.name}`,
          decoded?.reason ?? "no decoder could read it",
        );
        const updated = await storeOnCurrent(photo, {
          ...meta,
          decodeError: decodeFailureReason(file, decoded),
        });
        if (updated) {
          onReimported?.(updated.photo, updated.change);
          failed++;
        }
        onProgress?.(++done, todo.length);
        continue;
      }

      const { bitmap, oriented, colorTemperature } = decoded;
      if (colorTemperature && !exif.colorTemperature) {
        exif.colorTemperature = colorTemperature;
      }
      // Recompute the canonical rotation (EXIF + manual) against the FRESHLY
      // parsed EXIF — the orientation tag may have changed on disk since import
      // (the reason to re-import). Peel the manual turns off the OLD EXIF, then
      // re-add the new EXIF portion. Bake only what this decode hasn't already
      // applied — subtract the EXIF portion when pre-oriented.
      const manual = manualRotation(
        photo.rotation ?? orientationToRotation(photo.exif.orientation),
        photo.exif.orientation,
      );
      const rotation = normalizeRotation(manual + orientationToRotation(exif.orientation));
      const bake = bakeRotation(rotation, exif.orientation, oriented);
      const thumb = await createThumbnail(bitmap, bake, getSettings().thumbMaxEdge);
      const { width, height } = catalogSize(rawMeta?.frame, manual, decoded, bake);
      bitmap.close();
      if (signal?.aborted) break;

      const updated = await storeOnCurrent(photo, {
        ...meta,
        thumbnailBlob: thumb,
        width,
        height,
        rotation,
        decodeError: undefined,
        metadataPending: undefined, // libraw read the file above
      });
      if (updated) {
        onReimported?.(updated.photo, updated.change);
        ok++;
      }
    } catch (e) {
      console.warn(`[import] re-import failed: ${photo.filename}`, e);
      failed++;
    }
    onProgress?.(++done, todo.length);
    await new Promise<void>((res) => setTimeout(res, 0));
  }
  return { ok, failed };
}
