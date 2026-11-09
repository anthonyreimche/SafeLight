// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// catalog.json as a file: what it holds, how a saved one is read and opened, and
// the copies kept beside it (backups, and damaged catalogues kept aside). See
// project-storage for how a storage opens and saves it.

import type { EditState, StoredPhoto } from "@/catalog/types";
import { readChangeStamps, type ChangeStamps } from "./change-stamps";
import {
  fileTimestamp,
  isPlainObject,
  listNames,
  readJSONFile,
  removeEntry,
  writeBlob,
  type JSONFileRead,
} from "./fs";
import {
  CATALOG_VERSION,
  CatalogDamagedError,
  CatalogTooNewError,
  CatalogUnreadableError,
} from "./catalog-errors";
import { hasEditStack, openableEdit, UNREADABLE_RETRY_DELAYS } from "./edit-files";
import { nativePathOf } from "./native-fs";
import { namesFoldCase } from "./reattach";

export interface CatalogFile {
  version: 1;
  /** Tells the browser build's windows which catalogue they share (catalogKey).
   *  Catalogues saved before it have none. */
  id?: string;
  photos: StoredPhoto[];
  edits: EditState[];
  /** relPaths the user removed from the catalogue whose files remain on disk, so
   *  the next scan skips them instead of re-importing (see deletePhoto). */
  removed?: string[];
  /** When each record last changed (see change-stamps). Left out when none did;
   *  catalogues saved before it have none, and every record in them counts as the
   *  oldest. */
  changed?: ChangeStamps;
}

export const CATALOG = "catalog.json";
/** catalog.json as the main window opened it, kept once its first save has replaced
 *  it. Every such session rewrites it, so nothing else keeps a copy under this name:
 *  a fold of read-only edits keeps its own (working-dir.ts). */
export const BACKUP = "catalog.bak.json";
/** The backups before it, newest first. A session writes BACKUP over the newest
 *  and each moves down one place, so a few bad sessions in a row leave a good one. */
export const OLDER_BACKUPS = ["catalog.bak-1.json", "catalog.bak-2.json"];
/** How many of each kind of catalog.corrupt-<time>.json is kept; the rest are
 *  removed as a new one is written. Each is a whole catalogue. */
const KEPT_COPIES = 3;

/** How open() recovered a catalogue it couldn't use as saved: restored from its
 *  backup, or rebuilt by importing the folder again. `kept` names the copy of the
 *  damaged catalogue kept beside it (else of a damaged backup), or is null when
 *  there was none to keep (missing or empty). */
export interface CatalogRecovery {
  from: "backup" | "rescan";
  kept: string | null;
}

/** A saved catalogue as this build opens it: the records it can open, the
 *  top-level keys it doesn't know (saved back as they came), and how many
 *  entries it left out. Its change stamps are in `file.changed`. `damaged` when
 *  what it left out is the catalogue itself: a list of photos or edits that isn't
 *  a list, or photos none of which it can open. */
export interface OpenedCatalog {
  file: CatalogFile & { changed: ChangeStamps };
  extra: Record<string, unknown>;
  skipped: number;
  damaged: boolean;
}

/** What an open starts from: the catalogue (null: import the folder as new), how
 *  it was recovered, and catalog.json as read when it opened as saved, which the
 *  session's first save keeps as the backup. */
export interface SavedCatalog {
  catalog: OpenedCatalog | null;
  recovered: CatalogRecovery | null;
  bytes: Uint8Array<ArrayBuffer> | null;
}

function isStoredPhoto(entry: unknown): entry is StoredPhoto {
  if (!isPlainObject(entry)) return false;
  const { id, relPath, copyOf } = entry;
  return (
    typeof id === "string" &&
    id !== "" &&
    typeof relPath === "string" &&
    (copyOf === undefined || typeof copyOf === "string")
  );
}

/** Open a saved catalogue: refuse a newer version, and keep only the records this
 *  build can open. A list that isn't a list opens as an empty one. */
function openCatalog(saved: Record<string, unknown>): OpenedCatalog {
  const { version, id, photos, edits, removed, changed, ...extra } = saved;
  if (typeof version === "number" && version > CATALOG_VERSION)
    throw new CatalogTooNewError(version);
  let skipped = 0;
  const entries = <T>(list: unknown, valid: (entry: unknown) => entry is T): T[] => {
    if (list === undefined) return [];
    if (!Array.isArray(list)) {
      skipped++;
      return [];
    }
    const all: unknown[] = list;
    const kept = all.filter(valid);
    skipped += all.length - kept.length;
    return kept;
  };
  const openedPhotos = entries(photos, isStoredPhoto);
  const notList = (list: unknown) => list !== undefined && !Array.isArray(list);
  return {
    file: {
      version: 1,
      id: typeof id === "string" && id !== "" ? id : undefined,
      photos: openedPhotos,
      edits: entries(edits, hasEditStack).flatMap((edit) => {
        const openable = openableEdit(edit);
        if (openable !== edit) skipped++;
        return openable ? [openable] : [];
      }),
      removed: entries(removed, (entry): entry is string => typeof entry === "string"),
      // A stamp this build can't read only makes its record the oldest, so none is
      // counted as skipped.
      changed: readChangeStamps(changed),
    },
    extra,
    skipped,
    damaged:
      notList(photos) ||
      notList(edits) ||
      (Array.isArray(photos) && photos.length > 0 && openedPhotos.length === 0),
  };
}

/** Read a catalogue file, waiting a few seconds for one another program holds; one
 *  that still can't be read stops the open, with catalog.json as it was. */
async function readCatalogFile(
  sl: FileSystemDirectoryHandle,
  name: string,
): Promise<Exclude<JSONFileRead, { kind: "unreadable" }>> {
  let read = await readJSONFile(sl, name);
  for (const delay of UNREADABLE_RETRY_DELAYS) {
    if (read.kind !== "unreadable") return read;
    await new Promise((resolve) => setTimeout(resolve, delay));
    read = await readJSONFile(sl, name);
  }
  if (read.kind === "unreadable") throw new CatalogUnreadableError(read.error);
  return read;
}

/** Keep a copy of a catalogue file (`catalog` or `catalog.bak`) the open won't keep
 *  as it was, beside it, and return the copy's name. A copy that can't be written
 *  stops the open: the save that follows would replace the only one. */
async function keepAside(
  sl: FileSystemDirectoryHandle,
  bytes: Uint8Array<ArrayBuffer>,
  of: "catalog" | "catalog.bak" = "catalog",
) {
  const name = `${of}.corrupt-${fileTimestamp()}.json`;
  try {
    await writeBlob(sl, name, new Blob([bytes]));
  } catch (error) {
    throw new CatalogDamagedError(error);
  }
  await pruneKeptCopies(sl, `${of}.corrupt-`);
  return name;
}

/** Remove all but the newest KEPT_COPIES files named `prefix` + a time + .json. A
 *  copy that can't be removed stays; it is no reason to stop the open. */
async function pruneKeptCopies(sl: FileSystemDirectoryHandle, prefix: string): Promise<void> {
  try {
    const copies: string[] = [];
    for await (const name of listNames(sl))
      if (name.startsWith(prefix) && name.endsWith(".json")) copies.push(name);
    for (const name of copies.sort().slice(0, -KEPT_COPIES)) await removeEntry(sl, name);
  } catch (error) {
    console.warn("[project] old copies of the catalogue couldn't be removed:", error);
  }
}

/** Whether this is the main window: a pop-out opens the project too, and the
 *  catalogue it opens may be the one a bad session just left. */
export function isMainWindow(): boolean {
  return !new URLSearchParams(globalThis.location?.search).has("detached");
}

/** Read the catalogue an open starts from. A damaged catalog.json (unreadable as
 *  JSON, or `damaged` as opened) is kept aside, then the backup stands in for it,
 *  as it does for a missing one. A catalog.json that opens damaged still opens
 *  when its backup is no better. With no backup to use, the folder is imported
 *  again: as a new project when neither file was there, else as a rebuild,
 *  keeping a damaged backup aside too, since the next session's backup would
 *  write over it. */
export async function readSavedCatalog(sl: FileSystemDirectoryHandle): Promise<SavedCatalog> {
  const read = await readCatalogFile(sl, CATALOG);
  let asSaved: SavedCatalog | null = null;
  let kept: string | null = null;
  if (read.kind === "ok") {
    const catalog = openCatalog(read.value);
    if (catalog.skipped > 0) kept = await keepAside(sl, read.bytes);
    asSaved = { catalog, recovered: null, bytes: read.bytes };
    if (!catalog.damaged) return asSaved;
  } else if (read.kind === "corrupt" && read.bytes.length > 0) {
    kept = await keepAside(sl, read.bytes);
  }
  const backup = await readCatalogFile(sl, BACKUP);
  if (backup.kind === "ok") {
    const catalog = openCatalog(backup.value);
    if (!asSaved || !catalog.damaged)
      return { catalog, recovered: { from: "backup", kept }, bytes: null };
  }
  if (asSaved) return asSaved;
  if (read.kind === "missing" && backup.kind === "missing")
    return { catalog: null, recovered: null, bytes: null };
  const keptBackup =
    backup.kind === "corrupt" && backup.bytes.length > 0
      ? await keepAside(sl, backup.bytes, "catalog.bak")
      : null;
  return { catalog: null, recovered: { from: "rescan", kept: kept ?? keptBackup }, bytes: null };
}

/** Names the catalogue file a storage writes, so windows take on only the records
 *  of the catalogue they share; a copy of the project elsewhere keeps the same photo
 *  ids. In the desktop build that is the working folder's path, compared without
 *  case where the file system ignores it (namesFoldCase). The browser build has no
 *  paths: there the project folder's name and `catalogId`, which the catalogue keeps
 *  (catalogIdOf), stand in. */
export function catalogKey(
  root: FileSystemDirectoryHandle,
  sl: FileSystemDirectoryHandle,
  catalogId: string,
): string {
  const path = nativePathOf(sl);
  if (path === null) return `folder:${root.name}:${catalogId}`;
  const slashed = path.replace(/[\\/]+/g, "/").replace(/\/$/, "");
  return namesFoldCase() ? slashed.toLowerCase() : slashed;
}

/** The id a catalogue is known by: the one it keeps; for a catalogue saved before
 *  catalogues had one, an id every window derives alike from its photo ids, so the
 *  windows open on it agree; for a new catalogue, a fresh one. Saves keep it. */
export function catalogIdOf(saved: CatalogFile | null): string {
  if (saved?.id) return saved.id;
  const photoIds = (saved?.photos ?? []).map((p) => p.id).sort();
  if (photoIds.length === 0) return crypto.randomUUID();
  // FNV-1a over the ids: stable and cheap; it only has to tell catalogues apart.
  let hash = 0x811c9dc5;
  for (const char of photoIds.join("\n")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `photos-${hash.toString(16)}-${photoIds.length}`;
}
