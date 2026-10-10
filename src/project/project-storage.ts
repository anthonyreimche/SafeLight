// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// ProjectStorage: the catalog lives inside the project folder.
//
//   <project>/.safelight/catalog.json   photo records + edit histories
//   <project>/.safelight/previews/      <photoId>.jpg grid thumbnails
//   <project>/.safelight/raw/           decoded-RAW develop cache
//
// …except when the project folder is read-only (e.g. a memory card): resolveWorkingDir
// (see working-dir.ts) then redirects this whole .safelight tree to a writeable
// location under the app data dir. Everything below derives from the one `sl`
// handle, so it's agnostic to where that actually points.
//
// Opening a project reconciles catalog.json against a fresh disk scan: new
// files get decoded + thumbnailed, records whose file vanished are dropped,
// and everything else keeps its ratings/edits. Files the user removed from the
// catalog are tombstoned so they aren't re-imported while their original stays
// on disk, until a photo is stored under that name again. Saves are debounced
// whole-file JSON writes, one at a time (handles and blobs are never serialized).
// A write that fails is tried again after a wait, and how each write ends is
// reported to the app (onSaveStatus).
//
// A catalog.json that can't be read, or was saved by a newer version, stops the
// open with nothing written. A damaged one is kept aside as
// catalog.corrupt-<time>.json. A damaged or missing one is restored from
// catalog.bak.json (the catalog as a session opened it, kept by that session's
// first save); with no usable backup the open starts from the folder alone.
//
// Every window (the main one and each pop-out) opens the project with its own
// storage and saves the whole file from its own copy. So each write is also sent
// to the windows on the same catalog file as "catalog-records". Each takes them
// on where they are the newer change (see change-stamps): the photos it shows
// change in place, and photos it doesn't show (added by the sender since this
// window opened) are kept, unshown, so its own saves don't drop them. It saves
// again when a save of its own may have put the old records back on disk, or when
// the sender gave up writing them. A window that opens says so once it has read
// catalog.json ("catalog-hello"), and every other storage on the catalog answers
// with what it changed or took in since it opened, which that file may not hold.

import {
  mergeStoredPhoto,
  storedPhoto,
  type CatalogPhoto,
  type EditState,
  type StoredPhoto,
} from "@/catalog/types";
import type { CatalogStorage } from "@/catalog/storage";
import { buildPhoto, buildPreviewBlob } from "@/modules/library/import-photos";
import { getSettings } from "@/state/settings-store";
import type { LoadedPreview } from "@/state/thumbnail-loader";
import {
  broadcast,
  onBroadcast,
  WINDOW_ID,
  type CatalogHello,
  type CatalogRecords,
  type SentCatalogRecords,
} from "@/state/broadcast";
import {
  ChangeClock,
  changedGroups,
  latest,
  mergePhoto,
  newer,
  own,
  readChangeStamps,
  stampAll,
  type ChangeStamp,
  type ChangeStamps,
  type PhotoStamps,
} from "./change-stamps";
import {
  isPlainObject,
  mapLimit,
  readBlob,
  readBlobIfThere,
  readJSON,
  fileTimestamp,
  readJSONFile,
  removeEntry,
  writeBlob,
  writeJSON,
  type JSONFileRead,
} from "./fs";
import {
  CATALOG_VERSION,
  CatalogDamagedError,
  CatalogTooNewError,
  CatalogUnreadableError,
  failureReason,
} from "./catalog-errors";
import { nativePathOf } from "./native-fs";
import { scanProject, type FolderNode, type ScannedFile } from "./scan";
import { resolveWorkingDir, type WorkingDirLocation } from "./working-dir";
import { emitPhotoImport } from "@/extensions/registry";

interface CatalogFile {
  version: 1;
  /** Tells the browser build's windows which catalog they share (catalogKey).
   *  Catalogs saved before it have none. */
  id?: string;
  photos: StoredPhoto[];
  edits: EditState[];
  /** relPaths the user removed from the catalog whose files remain on disk, so
   *  the next scan skips them instead of re-importing (see deletePhoto). */
  removed?: string[];
  /** When each record last changed (see change-stamps). Left out when none did;
   *  catalogs saved before it have none, and every record in them counts as the
   *  oldest. */
  changed?: ChangeStamps;
}

const CATALOG = "catalog.json";
/** catalog.json as a session opened it, kept once its first save has replaced it.
 *  Every session rewrites it, so nothing else keeps a copy under this name: a
 *  fold of read-only edits keeps its own (working-dir.ts). */
const BACKUP = "catalog.bak.json";
/** The waits between reads of a catalog another program holds, before the open
 *  gives up (about four seconds in all). */
const UNREADABLE_RETRY_DELAYS = [250, 500, 1000, 2000];

/** How open() recovered a catalog it couldn't use as saved: restored from its
 *  backup, or rebuilt by importing the folder again. `kept` names the copy of the
 *  damaged catalog kept beside it (else of a damaged backup), or is null when
 *  there was none to keep (missing or empty). */
export interface CatalogRecovery {
  from: "backup" | "rescan";
  kept: string | null;
}

/** A saved catalog as this build opens it: the records it can open, the
 *  top-level keys it doesn't know (saved back as they came), and how many
 *  entries it left out. Its change stamps are in `file.changed`. */
interface OpenedCatalog {
  file: CatalogFile & { changed: ChangeStamps };
  extra: Record<string, unknown>;
  skipped: number;
}

/** What an open starts from: the catalog (null: import the folder as new), how
 *  it was recovered, and catalog.json as read when it opened as saved, which the
 *  session's first save keeps as the backup. */
interface SavedCatalog {
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

function isEditState(entry: unknown): entry is EditState {
  return (
    isPlainObject(entry) &&
    typeof entry.photoId === "string" &&
    Array.isArray(entry.stack) &&
    typeof entry.currentIndex === "number"
  );
}

/** Open a saved catalog: refuse a newer version, and keep only the records this
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
  return {
    file: {
      version: 1,
      id: typeof id === "string" && id !== "" ? id : undefined,
      photos: entries(photos, isStoredPhoto),
      edits: entries(edits, isEditState),
      removed: entries(removed, (entry): entry is string => typeof entry === "string"),
      // A stamp this build can't read only makes its record the oldest, so none is
      // counted as skipped.
      changed: readChangeStamps(changed),
    },
    extra,
    skipped,
  };
}

/** Read a catalog file, waiting a few seconds for one another program holds; one
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

/** Keep a copy of a catalog file (`catalog` or `catalog.bak`) the open won't keep
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
  return name;
}

/** Read the catalog an open starts from. A damaged catalog.json is kept aside,
 *  then the backup stands in for it, as it does for a missing one. With no backup
 *  to use, the folder is imported again: as a new project when neither file was
 *  there, else as a rebuild, keeping a damaged backup aside too, since the next
 *  session's backup would write over it. */
async function readSavedCatalog(sl: FileSystemDirectoryHandle): Promise<SavedCatalog> {
  const read = await readCatalogFile(sl, CATALOG);
  if (read.kind === "ok") {
    const catalog = openCatalog(read.value);
    if (catalog.skipped > 0) await keepAside(sl, read.bytes);
    return { catalog, recovered: null, bytes: read.bytes };
  }
  const kept =
    read.kind === "corrupt" && read.bytes.length > 0 ? await keepAside(sl, read.bytes) : null;
  const backup = await readCatalogFile(sl, BACKUP);
  if (backup.kind === "ok") {
    const catalog = openCatalog(backup.value);
    return { catalog, recovered: { from: "backup", kept }, bytes: null };
  }
  if (read.kind === "missing" && backup.kind === "missing")
    return { catalog: null, recovered: null, bytes: null };
  const keptBackup =
    backup.kind === "corrupt" && backup.bytes.length > 0
      ? await keepAside(sl, backup.bytes, "catalog.bak")
      : null;
  return { catalog: null, recovered: { from: "rescan", kept: kept ?? keptBackup }, bytes: null };
}

const SAVE_DELAY = 800;
// Hard cap so a steady stream of writes (e.g. a long import) still flushes
// periodically instead of the debounce sliding forever and persisting nothing.
const MAX_SAVE_DELAY = 2500;
// During the import walk the ceiling relaxes: every flush re-serializes the
// whole catalog, so at 2.5s a long import spends ~O(n²) work re-writing records
// it just wrote. 10s keeps progress durable while cutting that churn 4×.
const BULK_SAVE_DELAY = 10_000;
/** The waits before each try again of a catalog.json write that keeps failing;
 *  the last one repeats. */
const SAVE_RETRY_DELAYS = [2000, 5000, 15_000, 30_000, 60_000];
/** How many times a copy the window has left tries a failed write again before it
 *  gives the change up to the other windows (letGoIfIdle). */
const RETRIES_AFTER_CLOSE = 3;
/** How long a storage keeps answering with a tombstone after a write of its own
 *  that holds it has landed (ms). A storage that opens reads catalog.json within
 *  seconds of starting to listen, and says hello once it has read it. */
const TOMBSTONE_ANSWERED_FOR = 60_000;
/** How many previews one storage writes at once. Each write holds its whole preview
 *  in memory on both sides of the desktop bridge, whose queue is per file. */
const PREVIEW_WRITES_AT_ONCE = 4;

/** Hears the records a storage took on from another window. */
type RemoteRecordsListener = (records: CatalogRecords, storage: ProjectStorage) => void;

const remoteRecordsListeners = new Set<RemoteRecordsListener>();

/** Hear what any ProjectStorage in this window takes on from other windows: only
 *  the records for photos it holds, reported once its copy has them. Returns the
 *  unsubscribe. */
export function onRemoteRecords(listener: RemoteRecordsListener): () => void {
  remoteRecordsListeners.add(listener);
  return () => void remoteRecordsListeners.delete(listener);
}

/** How a catalog.json write ended: it landed, or it failed for `reason`, worded
 *  for the user. `gaveUp` is set once a storage whose window left the catalog
 *  stops trying: its last changes are in no file unless another window saves them. */
export type SaveStatus = { ok: true } | { ok: false; reason: string; gaveUp?: true };

type SaveStatusListener = (status: SaveStatus, storage: ProjectStorage) => void;

const saveStatusListeners = new Set<SaveStatusListener>();

/** Hear how each catalog.json write of any ProjectStorage in this window ended.
 *  Returns the unsubscribe. */
export function onSaveStatus(listener: SaveStatusListener): () => void {
  saveStatusListeners.add(listener);
  return () => void saveStatusListeners.delete(listener);
}

/** Why a catalog.json write failed, worded for the user. The desktop bridge hands
 *  an error on with its own prefix and keeps the errno only in the message. */
function saveFailureReason(error: unknown): string {
  if (error instanceof RangeError) return "the catalog is too large to save as one file";
  const errno = failureReason(error);
  if (errno === "EPERM" || errno === "EBUSY" || errno === "EACCES")
    return "the file is locked or not writable";
  if (errno === "ENOSPC") return "the disk is full";
  if (errno === "EROFS") return "the folder is read-only";
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method 'fs:write': (Error: )?/, "");
}

/** The storages whose window has left their catalog while they may still write it
 *  (close), until they let go (letGoIfIdle). */
const leftCopies = new Set<ProjectStorage>();

/** Write now what each catalog this window has left still holds: the window is
 *  closing, and their next try would come after it. Called before the open
 *  catalog's own flush, so that write is asked for last (see flush). */
export function flushLeftCopies(): void {
  for (const storage of leftCopies) void storage.flush({ unloading: true });
}

/** Counts the storages this window has opened, to name each one's records. */
let openedStorages = 0;

/** Names the catalog file a storage writes, so windows take on only the records
 *  of the catalog they share; a copy of the project elsewhere keeps the same photo
 *  ids. In the desktop build that is the working folder's path, compared without
 *  case on Windows. The browser build has no paths: there the project folder's
 *  name and `catalogId`, which the catalog keeps (catalogIdOf), stand in. */
export function catalogKey(
  root: FileSystemDirectoryHandle,
  sl: FileSystemDirectoryHandle,
  catalogId: string,
): string {
  const path = nativePathOf(sl);
  if (path === null) return `folder:${root.name}:${catalogId}`;
  const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(path);
  const slashed = path.replace(/[\\/]+/g, "/").replace(/\/$/, "");
  return windows ? slashed.toLowerCase() : slashed;
}

/** The id a catalog is known by: the one it keeps; for a catalog saved before
 *  catalogs had one, an id every window derives alike from its photo ids, so the
 *  windows open on it agree; for a new catalog, a fresh one. Saves keep it. */
function catalogIdOf(saved: CatalogFile | null): string {
  if (saved?.id) return saved.id;
  const photoIds = (saved?.photos ?? []).map((p) => p.id).sort();
  if (photoIds.length === 0) return crypto.randomUUID();
  // FNV-1a over the ids: stable and cheap; it only has to tell catalogs apart.
  let hash = 0x811c9dc5;
  for (const char of photoIds.join("\n")) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `photos-${hash.toString(16)}-${photoIds.length}`;
}

/** A record's rotation; one saved without it (an older build's) is unturned. */
function turnOf(record: Pick<StoredPhoto, "rotation">): number {
  return record.rotation ?? 0;
}

/** The rotation the preview a record describes was made at (previewRotation). */
function madeAt(record: Pick<StoredPhoto, "rotation" | "previewRotation">): number {
  return record.previewRotation ?? turnOf(record);
}

function folderOf(relPath: string): string {
  const i = relPath.lastIndexOf("/");
  return i === -1 ? "" : relPath.slice(0, i);
}

// Sidecar written by folder-ops.exportPhotoData; kept in sync there. Inlined
// (not imported) to avoid a project-storage ↔ folder-ops ↔ project-store cycle.
const SIDECAR_SUFFIX = ".safelight.json";

interface PhotoSidecar {
  safelightSidecar?: number;
  info?: {
    rating?: number;
    colorLabel?: CatalogPhoto["colorLabel"];
    flag?: CatalogPhoto["flag"];
    keywords?: string[];
  };
  maps?: { stack: EditState["stack"]; currentIndex: number } | null;
}

export interface OpenedProject {
  storage: ProjectStorage;
  tree: FolderNode;
  photos: CatalogPhoto[];
  /** Photos discovered on this open (candidates for background pre-decode). */
  newPhotos: CatalogPhoto[];
  rawCacheDir: FileSystemDirectoryHandle;
  /** Where the .safelight working dir ended up: in the project folder, or
   *  redirected to a writeable app-data location because the folder is read-only. */
  storageLocation: WorkingDirLocation;
  /** Absolute path of the external working dir when redirected, else null. */
  externalPath: string | null;
  /** Set when read-only-session edits were just folded back into this in-folder
   *  catalog — the separate catalog they came from. Else null. */
  promotedFromExternal: string | null;
  /** How a catalog that couldn't be used as saved was recovered, else null. */
  recovered: CatalogRecovery | null;
}

export class ProjectStorage implements CatalogStorage {
  private photos = new Map<string, CatalogPhoto>();
  private edits = new Map<string, EditState>();
  /** Tombstoned relPaths — files removed from the catalog but still on disk. */
  private removed = new Set<string>();
  private lastThumb = new Map<string, Blob | null>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private firstDirtyAt = 0;
  /** Whether this copy holds a change catalog.json may lack: set by a change to
   *  save, cleared as a write takes its copy of the catalog, set again if that
   *  write fails. A flush with nothing to save writes nothing. */
  private dirty = false;
  /** Set for good once a change couldn't be sent to the other windows (send): they
   *  never held it, so any later save of theirs leaves it out of the file, unseen
   *  here. A copy that holds one writes whenever it is flushed or closed. */
  private unsent = false;
  /** True while the open() walk imports new files — relaxes the save ceiling. */
  private scanning = false;
  /** The catalog.json write in progress, and the write queued behind it. */
  private writing: Promise<void> | null = null;
  private nextWrite: Promise<void> | null = null;
  /** When the last catalog.json write ended (Date.now()). */
  private lastWriteEnded = 0;
  /** Names this storage on the records it sends, so it can tell its own echo. */
  private readonly origin = `${WINDOW_ID}:${++openedStorages}`;
  /** Stamps the changes made in this copy (see change-stamps). */
  private readonly clock = new ChangeClock(this.origin);
  /** The change stamps of the records this copy holds, kept beside them: each photo
   *  record's by group of fields, and each edit history's. */
  private photoStamps = new Map<string, PhotoStamps>();
  private editStamps = new Map<string, ChangeStamp>();
  /** The photo records and edit histories this copy changed or took in since it
   *  opened: what it answers a storage that opens on the catalog later with
   *  (answer), with its removals. */
  private changedPhotos = new Set<string>();
  private changedEdits = new Set<string>();
  /** The files this copy tombstoned in this session, each with the change count it
   *  was tombstoned at (changes) and, once a write of this copy holding it landed,
   *  when that was. An answer sends those not landed before the storage it answers
   *  began listening: that storage may have read a file without the tombstone, and
   *  hold no record whose removal would bring it. One that landed earlier was in the
   *  file it read, and isn't sent: tombstones carry no stamps, and a later open may
   *  have dropped it since, its file having left the folder, while a file put back
   *  under that name must import. Landed ones are kept for a while only
   *  (TOMBSTONE_ANSWERED_FOR). */
  private removedFiles = new Map<string, { at: number; landed: number | null }>();
  /** Counts the changes made to this copy, so a write knows which it holds. */
  private changes = 0;
  /** The storages whose answer this copy took in. It holds every change of theirs
   *  made before it listened, so it saves for them when one gives up (apply). */
  private heardFrom = new Set<string>();
  /** The id this catalog keeps (catalogIdOf), and the catalog file this storage
   *  writes (catalogKey); both are known once open() has read catalog.json. */
  private catalogId = "";
  private catalog = "";
  private stopListening: (() => void) | null = null;
  /** True until open() has built this copy, or failed: its walk may still save. */
  private walking = true;
  /** Set once the window has left this catalog (close). */
  private closed = false;
  /** Each photo's newest preview write that hasn't ended, and when it ends
   *  (writePreview). A record changes once its preview lands (previewStored), so
   *  while any is here this copy may still write. */
  private previewWrites = new Map<string, { ended: Promise<void> }>();
  /** Preview writes running now (at most PREVIEW_WRITES_AT_ONCE), and the writes
   *  waiting for one of them to end, oldest first (takePreviewSlot). */
  private previewSlotsTaken = 0;
  private previewSlotQueue: (() => void)[] = [];
  /** How many catalog.json writes in a row have failed, which sets the wait before
   *  the next try (retryLater), and why the last one did. */
  private failures = 0;
  private lastFailure = "it couldn't be written";
  /** How many tries again of a failed write have started since the window left. */
  private retriesAfterClose = 0;
  /** When this copy began taking on the other windows' records (listen). */
  private listeningSince = 0;
  /** When the oldest change this copy sent, or saves again for another window,
   *  entered it, of those no landed write holds; null when there is none. A copy
   *  that gives up writing them passes it on (letGoIfIdle). */
  private unsavedSince: number | null = null;
  /** Other windows' records that arrived while open() was still building this copy
   *  and wait for it (see hold); null once records apply as they arrive. */
  private waiting: SentCatalogRecords[] | null = null;
  /** Records of photos other windows added that this window doesn't show. Kept
   *  so this copy's saves write them back; the next open shows them. */
  private unshown = new Map<string, StoredPhoto>();
  /** The virtual copies of each master, shown or kept, so a removal finds them
   *  without looking through every record. show, keep and drop keep it current. */
  private copies = new Map<string, Set<string>>();
  /** Every photo removed from this copy since it opened, here or in another
   *  window. A record that comes back for one of them is stale: a late message, or
   *  a writer that held the photo from before its removal. */
  private removedIds = new Set<string>();
  /** The catalog's top-level keys this build doesn't know, saved back as read. */
  private extra: Record<string, unknown> = {};
  /** catalog.json as this session opened it, which its first save keeps as
   *  catalog.bak.json; null once kept, or when there is none to keep (a restore or
   *  rebuild found the file damaged or missing). */
  private backup: Blob | null = null;

  private sl: FileSystemDirectoryHandle;
  private previews: FileSystemDirectoryHandle;
  /** Lazily-created .safelight/blobs/ dir for opaque per-photo binary payloads
   *  (e.g. an extension's warp displacement field), kept out of catalog.json. */
  private blobsDir: FileSystemDirectoryHandle | null = null;

  private constructor(
    sl: FileSystemDirectoryHandle,
    previews: FileSystemDirectoryHandle,
  ) {
    this.sl = sl;
    this.previews = previews;
  }

  static async open(
    root: FileSystemDirectoryHandle,
    onPhoto?: (photo: CatalogPhoto) => void,
    onSkeletons?: (
      storage: ProjectStorage,
      rawCacheDir: FileSystemDirectoryHandle,
      skeletons: CatalogPhoto[],
    ) => void,
    // Progress of decoding newly-discovered files (the slow part of opening).
    // Fires once with done=0 when the new-file count is known, then per file.
    onProgress?: (done: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<OpenedProject> {
    // Resolve a writeable .safelight working dir. Normally <project>/.safelight,
    // but redirected to the app data dir when the folder is read-only (e.g. a
    // memory card). Throws ReadOnlyProjectError if no writeable dir is possible —
    // caught by openProject, which shows a verbose message instead of failing mute.
    const {
      sl,
      location: storageLocation,
      externalPath,
      promotedFromExternal = null,
    } = await resolveWorkingDir(root);
    const previews = await sl.getDirectoryHandle("previews", { create: true });
    const rawCacheDir = await sl.getDirectoryHandle("raw", { create: true });
    const storage = new ProjectStorage(sl, previews);
    // Follow the other windows from before catalog.json is read: which catalog what
    // they write belongs to is only known once it is read, so it waits until then
    // (see hold).
    storage.listen();
    try {
      // Read the saved catalog first (one quick read) and paint the grid from it
      // immediately as skeleton records — no live handles, no previews — so the UI
      // appears at once. The directory scan below then runs without blocking the
      // first paint, attaching handles and finding new/removed files. A catalog that
      // can't be read, or is too new, stops the open here: nothing is written,
      // sent or installed.
      const { catalog: opened, recovered, bytes } = await readSavedCatalog(sl);
      const saved = opened?.file ?? null;
      storage.extra = opened?.extra ?? {};
      if (bytes) storage.backup = new Blob([bytes]);
      storage.catalogId = catalogIdOf(saved);
      storage.catalog = catalogKey(root, sl, storage.catalogId);
      for (const [id, stamps] of Object.entries(saved?.changed.photos ?? {})) {
        storage.photoStamps.set(id, stamps);
        storage.clock.observe(latest(stamps));
      }
      for (const [id, stamp] of Object.entries(saved?.changed.edits ?? {})) {
        storage.editStamps.set(id, stamp);
        storage.clock.observe(stamp);
      }

      // Seed saved edit histories up front so incremental saves during a long
      // (resumable) import keep develop edits; orphans are pruned after the walk.
      for (const e of saved?.edits ?? []) storage.edits.set(e.photoId, e);

      // Load tombstones before the scan so removed-but-still-on-disk files are
      // skipped rather than re-imported as new. Pruned after the walk once their
      // file is truly gone.
      for (const r of saved?.removed ?? []) storage.removed.add(r);

      // Match disk files to MASTER records only. Virtual copies share a master's
      // relPath but own no disk file, so they must not shadow the master in this
      // map — they're re-attached separately after the walk. One record per file,
      // the first saved (a window writes the photos it shows before those it keeps
      // for other windows), so a kept record never takes a shown photo's place. A
      // record wins over a tombstone for its file: the photo took the name later.
      const savedRecords = saved?.photos ?? [];
      const byRel = new Map<string, StoredPhoto>();
      for (const p of savedRecords) if (!p.copyOf && !byRel.has(p.relPath)) byRel.set(p.relPath, p);
      const savedPhotos = savedRecords.filter((p) => p.copyOf || byRel.get(p.relPath) === p);

      // The storage is handed over here, a first open's too (with no skeletons):
      // what the app stores from now on lands in this copy, and the walk keeps it.
      const skeletons = savedPhotos.map(
        (s): CatalogPhoto => ({
          ...s,
          directoryHandle: null,
          fileHandle: null,
          thumbnailBlob: null,
          thumbnailUrl: null,
        }),
      );
      for (const sk of skeletons) storage.show(sk);
      // What the other windows sent while the catalog was read is painted with it.
      storage.holdEarly();
      onSkeletons?.(
        storage,
        rawCacheDir,
        skeletons.flatMap((sk) => storage.photos.get(sk.id) ?? []),
      );
      // Ask the others for what they changed that the file may not hold yet.
      storage.greet();

      const scan = await scanProject(root);

      // New files (not in the saved catalog, not tombstoned) are the ones that get
      // decoded — the slow part of opening. Report progress against that count.
      const counted = new Set(
        scan.files.flatMap((f) => (byRel.has(f.path) || storage.removed.has(f.path) ? [] : [f])),
      );
      const newTotal = counted.size;
      let newDone = 0;
      onProgress?.(0, newTotal);

      const newPhotos: CatalogPhoto[] = [];
      const importStarted = Date.now();
      storage.scanning = true;
      /** The file the scan found each saved photo on. */
      const fileOf = new Map<string, ScannedFile>();
      const results = await mapLimit(scan.files, 8, async (f: ScannedFile) => {
        const prev = byRel.get(f.path);
        if (prev) {
          // Known photo: reattach live handles only. The cached preview is loaded
          // later, on demand (visible cells first), so the open never blocks on
          // hundreds of serial preview reads.
          if (storage.removedIds.has(prev.id)) return null;
          fileOf.set(prev.id, f);
          const photo = storage.onFile(prev, f);
          storage.show(photo);
          return photo;
        }
        // Tombstoned: the user removed this photo from the catalog while its file
        // stayed on disk. Honor that removal instead of re-importing it as new,
        // one another window's answer told of after the count too.
        if (storage.removed.has(f.path)) {
          if (counted.has(f)) onProgress?.(++newDone, newTotal);
          return null;
        }
        // New file: decode, thumbnail, cache the preview on disk.
        if (signal?.aborted) {
          onProgress?.(++newDone, newTotal);
          return null;
        }
        try {
          const file = await f.handle.getFile();
          const built = await buildPhoto(file, f.parent, f.handle);
          if (!built) {
            onProgress?.(++newDone, newTotal);
            return null;
          }
          let photo: CatalogPhoto = {
            ...built,
            relPath: f.path,
            folder: folderOf(f.path),
          };
          // Adopt a sidecar (ratings/labels + develop maps) that travelled with
          // the file from another project, so the data follows the photo. The
          // scan already listed every sidecar, so only probe ones that exist —
          // an unconditional read here failed once per imported file.
          if (scan.sidecars.has(`${f.path}${SIDECAR_SUFFIX}`)) {
            try {
              const sc = await readJSON<PhotoSidecar>(
                f.parent,
                `${f.handle.name}${SIDECAR_SUFFIX}`,
              );
              if (sc && sc.safelightSidecar === 1) {
                const info = sc.info ?? {};
                if (typeof info.rating === "number") photo.rating = info.rating;
                if (info.colorLabel) photo.colorLabel = info.colorLabel;
                if (info.flag) photo.flag = info.flag;
                if (Array.isArray(info.keywords)) photo.keywords = info.keywords;
                if (sc.maps && Array.isArray(sc.maps.stack)) {
                  storage.changedEdits.add(photo.id);
                  storage.edits.set(photo.id, {
                    photoId: photo.id,
                    stack: sc.maps.stack,
                    currentIndex:
                      typeof sc.maps.currentIndex === "number"
                        ? sc.maps.currentIndex
                        : sc.maps.stack.length - 1,
                  });
                }
              }
            } catch {
              /* invalid sidecar — ignore */
            }
          }

          // Let extensions contribute metadata read from sidecars. Their values
          // take precedence over the SafeLight sidecar.
          try {
            const ov = await emitPhotoImport({
              photo,
              dir: f.parent,
              fileName: f.handle.name,
            });
            if (ov) photo = { ...photo, ...ov };
          } catch {
            /* extension import failed — ignore */
          }
          if (photo.thumbnailBlob && getSettings().persistPreviews)
            await writeBlob(previews, `${photo.id}.jpg`, photo.thumbnailBlob);
          storage.lastThumb.set(photo.id, photo.thumbnailBlob);
          storage.show(photo);
          storage.changedPhotos.add(photo.id);
          newPhotos.push(photo);
          onPhoto?.(photo);
          // Persist progress as we go: an interrupted import resumes from the last
          // saved photo instead of re-decoding the whole folder next launch.
          storage.scheduleSave();
          onProgress?.(++newDone, newTotal);
          return photo;
        } catch (err) {
          console.warn(`[import] skipped ${f.path}:`, err);
          onProgress?.(++newDone, newTotal);
          return null;
        }
      });

      storage.scanning = false;
      // Each photo the walk reached, as this copy holds it now: a change stored
      // after the walk passed it stays, and a photo removed meanwhile stays out.
      const masters = results.flatMap((walked) => {
        if (!walked || storage.removedIds.has(walked.id)) return [];
        const file = fileOf.get(walked.id);
        return [file ? storage.onFile(walked, file) : (storage.photos.get(walked.id) ?? walked)];
      });

      // Re-attach virtual copies, saved or made during the open, as this copy holds
      // them: records that share a master's source file but own no disk file of
      // their own. Each inherits its master's live handles + relPath, and is placed
      // right after the master so it stays adjacent under import-order / date
      // sorts. A copy whose master vanished from disk is dropped (its edit history
      // is pruned just below). copyOf points at the root master, so copies-of-copies
      // resolve here too.
      const mastersById = new Map(masters.map((m) => [m.id, m] as const));
      const copiesByMaster = new Map<string, CatalogPhoto[]>();
      let droppedCopy = false;
      for (const held of storage.photos.values()) {
        if (!held.copyOf) continue;
        const master = mastersById.get(held.copyOf);
        if (!master) {
          droppedCopy = true;
          continue;
        }
        const copy: CatalogPhoto = {
          ...held,
          // Mirror the master's real file identity (it may have been renamed); the
          // copy's own distinction lives in copyName, not filename.
          filename: master.filename,
          relPath: master.relPath,
          folder: master.folder,
          directoryHandle: master.directoryHandle,
          fileHandle: master.fileHandle,
          thumbnailBlob: null,
          thumbnailUrl: null,
        };
        const arr = copiesByMaster.get(master.id);
        if (arr) arr.push(copy);
        else copiesByMaster.set(master.id, [copy]);
      }

      // Final list: each disk master (in scan order) followed by its virtual copies.
      const photos: CatalogPhoto[] = [];
      for (const m of masters) {
        photos.push(m);
        const cs = copiesByMaster.get(m.id);
        if (cs) photos.push(...cs);
      }

      // Rebuild the photo map from the scan result so any skeletons seeded above
      // for files that have since vanished from disk are dropped.
      for (const id of [...storage.photos.keys()]) storage.drop(id);
      for (const p of photos) storage.show(p);

      // Drop edit histories whose photo no longer exists (file gone, or a virtual
      // copy whose master is gone). Surviving copies are in storage.photos, so kept.
      for (const id of [...storage.edits.keys()])
        if (!storage.photos.has(id)) storage.edits.delete(id);

      // Prune tombstones whose file has left the folder: once the original is gone
      // the tombstone has nothing to suppress, and dropping it lets a later copy
      // back into the folder import freshly. A tombstone for a file a photo holds
      // is out of date too: that photo took the name since (see revive).
      const scanPaths = new Set(scan.files.map((f) => f.path));
      const heldPaths = new Set(masters.map((m) => m.relPath));
      let prunedTombstone = false;
      for (const r of [...storage.removed])
        if (!scanPaths.has(r) || heldPaths.has(r)) {
          storage.removed.delete(r);
          prunedTombstone = true;
        }

      const removedCount = byRel.size - (masters.length - newPhotos.length);
      if (
        newPhotos.length > 0 ||
        removedCount > 0 ||
        prunedTombstone ||
        droppedCopy || // a virtual copy was dropped — re-persist
        savedPhotos.length !== savedRecords.length || // a second record for one file
        recovered !== null || // the restored or rebuilt catalog replaces the damaged one
        (opened?.skipped ?? 0) > 0 // records this build couldn't open, kept aside
      )
        storage.scheduleSave();

      storage.applyWaiting();
      storage.walking = false;
      storage.letGoIfIdle();
      // Other windows open on this catalog keep the photos found here, so their
      // saves don't drop them.
      const found = newPhotos.flatMap((photo) => storage.photos.get(photo.id) ?? []);
      if (found.length > 0)
        storage.send(
          {
            photos: found.map(storedPhoto),
            edits: found.flatMap((photo) => storage.edits.get(photo.id) ?? []),
          },
          importStarted,
        );
      return {
        storage,
        tree: scan.tree,
        // Each record as it stands once the waiting records are applied.
        photos: photos.flatMap((photo) => storage.photos.get(photo.id) ?? []),
        newPhotos,
        rawCacheDir,
        storageLocation,
        externalPath,
        promotedFromExternal,
        recovered,
      };
    } catch (error) {
      storage.walking = false;
      storage.close();
      // A copy the window had already left lets go here, now its walk is over.
      storage.letGoIfIdle();
      throw error;
    }
  }

  // ── CatalogStorage ─────────────────────────────────────────────────────────

  async getAllPhotos(): Promise<CatalogPhoto[]> {
    return [...this.photos.values()];
  }

  /** Read a photo's grid preview for the block thumbnail loader. Normally reads
   *  the cached <id>.jpg from disk (and caches the blob so a later putPhoto won't
   *  needlessly rewrite it), with the edit its record names (previewEdit). When
   *  "Store previews on disk" is off — or the disk copy is missing — it rebuilds
   *  the preview from the source file on demand, which shows no edit. So does a
   *  disk copy made at another rotation than the photo's (previewRotation), or one
   *  that can't be read for now. A missing disk copy also drops the edit the
   *  photo's record named; otherwise the record keeps naming the copy on disk. */
  async readPreview(id: string): Promise<LoadedPreview | null> {
    // Taken before the read: a record names a preview only once it is on disk
    // (previewStored), so the preview read is never older than this edit.
    const record = this.photos.get(id);
    const previewEdit = record?.previewEdit;
    const turnedSince = record !== undefined && madeAt(record) !== turnOf(record);
    let missing = false;
    if (getSettings().persistPreviews && !turnedSince) {
      try {
        const blob = await readBlobIfThere(this.previews, `${id}.jpg`);
        if (blob) {
          this.lastThumb.set(id, blob);
          return Object.assign(blob, { previewEdit });
        }
        missing = true;
      } catch {
        // Can't be read for now (another program holds it): the record keeps naming it.
      }
    }
    const photo = this.photos.get(id);
    if (photo) {
      const blob = await buildPreviewBlob(photo);
      if (blob) {
        this.lastThumb.set(id, blob);
        // Not sent (each window's previews are its own) nor saved (every load derives it again).
        // A preview stored while this one was built keeps the edit it shows.
        const held = this.photos.get(id);
        const named = held?.previewEdit !== undefined && held.previewEdit === photo.previewEdit;
        if (missing && named) this.show({ ...held, previewEdit: undefined });
        return blob;
      }
    }
    return null;
  }

  async putPhoto(photo: CatalogPhoto): Promise<void> {
    await this.putPhotos([photo]);
  }

  /** Store the records (a photo removed from this copy stays removed, see
   *  removedIds; a file a photo is stored under is no longer removed, see revive),
   *  then write the previews that changed. A record describes the preview on disk:
   *  the edit it shows (previewEdit) and the rotation it was made at
   *  (previewRotation). It keeps the description it holds until a preview it is
   *  stored with is written (previewStored); a turn stored before then names the
   *  rotation the preview on disk still has. Each group of fields that differs from
   *  the record held is stamped as changed now (see change-stamps). Resolves once
   *  the previews are written or have failed: a preview that can't be written
   *  doesn't fail the records. */
  async putPhotos(photos: CatalogPhoto[]): Promise<void> {
    const since = Date.now();
    const stored = photos.filter((photo) => !this.removedIds.has(photo.id));
    if (stored.length === 0) return;
    const previews: { id: string; blob: Blob; previewEdit?: string; rotation: number }[] = [];
    let stamp: ChangeStamp | undefined;
    const records = stored.map((photo) => {
      const held = this.heldRecord(photo.id);
      const record: CatalogPhoto = {
        ...photo,
        previewEdit: held?.previewEdit,
        previewRotation:
          held && turnOf(held) !== turnOf(photo) ? madeAt(held) : held?.previewRotation,
      };
      const groups = held ? changedGroups(held, storedPhoto(record)) : null;
      if (!groups || groups.length > 0) {
        stamp ??= this.clock.next();
        const stamps = groups ? { ...this.photoStamps.get(photo.id) } : stampAll(stamp);
        for (const group of groups ?? []) stamps[group] = stamp;
        this.photoStamps.set(photo.id, stamps);
      }
      this.show(record);
      this.revive(record);
      this.changedPhotos.add(photo.id);
      // Persist the thumbnail only when it actually changed (e.g. rotation), and
      // only when previews are kept on disk.
      if (photo.thumbnailBlob && this.lastThumb.get(photo.id) !== photo.thumbnailBlob) {
        this.lastThumb.set(photo.id, photo.thumbnailBlob);
        const { id, thumbnailBlob: blob, previewEdit } = photo;
        previews.push({ id, blob, previewEdit, rotation: turnOf(photo) });
      }
      return storedPhoto(record);
    });
    this.scheduleSave();
    // Sent before the previews are written, so the other windows get this copy's
    // changes in the order it made them. The edit a preview shows follows it once
    // it is on disk.
    this.send({ photos: records }, since);
    if (!getSettings().persistPreviews || previews.length === 0) return;
    const written = await Promise.allSettled(
      previews.map(({ id, blob, previewEdit, rotation }) =>
        this.writePreview(id, blob, previewEdit, rotation),
      ),
    );
    // A preview that can't be written fails nothing: its record is stored, and
    // still describes the preview on disk. The next put that carries it writes it.
    written.forEach((result, i) => {
      if (result.status === "fulfilled") return;
      const { id, blob } = previews[i];
      console.warn(`[project] the preview of ${id} couldn't be stored:`, result.reason);
      if (this.lastThumb.get(id) === blob) this.lastThumb.delete(id);
    });
  }

  /** The record this copy holds for `id`, shown or kept, as catalog.json stores it. */
  private heldRecord(id: string): StoredPhoto | undefined {
    const shown = this.photos.get(id);
    return shown ? storedPhoto(shown) : this.unshown.get(id);
  }

  /** Write `blob` as `id`'s preview once the writes asked for before it have ended,
   *  so writes to one file land in the order they were asked for, whatever the file
   *  system does. Each write that lands is then the preview on disk and the record
   *  describes it (previewStored), even if a newer one is still to come: that one
   *  may fail. A write that a newer one replaces while it waits is skipped, as is
   *  one of a photo removed meanwhile. A few previews are written at once
   *  (takePreviewSlot); the turn above is taken first, so the order holds. */
  private writePreview(
    id: string,
    blob: Blob,
    previewEdit: string | undefined,
    rotation: number,
  ): Promise<void> {
    const before = this.previewWrites.get(id)?.ended;
    const turn = { ended: Promise.resolve() };
    this.previewWrites.set(id, turn);
    const newest = () => this.previewWrites.get(id) === turn;
    const due = () => newest() && !this.removedIds.has(id);
    const written = (async () => {
      if (before) await before;
      if (!due()) return;
      const slot = this.takePreviewSlot();
      if (slot) await slot;
      try {
        if (!due()) return;
        await writeBlob(this.previews, `${id}.jpg`, blob);
      } finally {
        this.releasePreviewSlot();
      }
      // The photo was removed while its preview was written, here or in another
      // window, whose removal of the file may have come first: it goes now.
      if (this.removedIds.has(id)) await removeEntry(this.previews, `${id}.jpg`);
      else this.previewStored(id, previewEdit, rotation);
    })();
    turn.ended = written.then(
      () => undefined,
      () => undefined,
    );
    return written.finally(() => {
      if (newest()) this.previewWrites.delete(id);
      this.letGoIfIdle();
    });
  }

  /** Count one more preview write as running: at once (null) while fewer than
   *  PREVIEW_WRITES_AT_ONCE are, else when the promise resolves, as one ends. Writes
   *  that wait start in the order they began waiting. */
  private takePreviewSlot(): Promise<void> | null {
    if (this.previewSlotsTaken < PREVIEW_WRITES_AT_ONCE) {
      this.previewSlotsTaken++;
      return null;
    }
    return new Promise<void>((resolve) => this.previewSlotQueue.push(resolve));
  }

  /** A preview write ended, landed or not: its place goes to the oldest waiting. */
  private releasePreviewSlot(): void {
    const next = this.previewSlotQueue.shift();
    if (next) next();
    else this.previewSlotsTaken--;
  }

  /** A preview putPhotos asked for `id` is on disk: the photo's record now names the
   *  edit it shows and the rotation it was made at, unless the photo left this copy.
   *  Saved and sent as any change to a record is, with no new stamp: the record's
   *  fields are as they were. */
  private previewStored(id: string, previewEdit: string | undefined, rotation: number): void {
    const held = this.photos.get(id);
    if (!held || (held.previewEdit === previewEdit && madeAt(held) === rotation)) return;
    const since = Date.now();
    const record = { ...held, previewEdit, previewRotation: rotation };
    this.show(record);
    this.changedPhotos.add(id);
    this.scheduleSave();
    this.send({ photos: [storedPhoto(record)] }, since);
  }

  async deletePhoto(id: string): Promise<void> {
    const since = Date.now();
    this.forget(id);
    this.scheduleSave();
    this.send({ deletedIds: [id] }, since);
    // A write of its preview still running removes the file again once it lands
    // (writePreview).
    await removeEntry(this.previews, `${id}.jpg`);
    // Drop any opaque per-photo blobs (warp fields, etc.) for this photo. Open
    // the dir WITHOUT creating it so blobs written in an earlier session are
    // reached too, but projects that never used blobs don't get an empty dir.
    let dir = this.blobsDir;
    if (!dir) {
      try {
        dir = await this.sl.getDirectoryHandle("blobs");
        this.blobsDir = dir;
      } catch {
        dir = null;
      }
    }
    if (dir) {
      const safeId = id.replace(/[^a-zA-Z0-9._-]/g, "_");
      // keys() is a standard FileSystemDirectoryHandle async iterator; not in
      // every TS lib target, so reach it through a narrow cast.
      const keys = (dir as unknown as { keys?: () => AsyncIterable<string> }).keys;
      if (keys) {
        try {
          for await (const name of keys.call(dir)) {
            if (typeof name === "string" && name.startsWith(`${safeId}.`))
              await removeEntry(dir, name);
          }
        } catch {
          /* best-effort cleanup */
        }
      }
    }
  }

  /** Drop a photo's record, shown or not, its edit history and its virtual copies
   *  (removing a master takes them with it, even those this window doesn't show),
   *  and refuse them from now on (removedIds). The file is tombstoned so the next
   *  folder scan doesn't re-import it as "new": removal is from the catalog only,
   *  the original stays on disk. A VIRTUAL COPY owns no file of its own (it shares
   *  its master's), so tombstoning its relPath would wrongly suppress the master's
   *  file; a copy's record is just dropped. Returns the ids this window showed. */
  private forget(id: string): string[] {
    const shown: string[] = [];
    for (const gone of [id, ...(this.copies.get(id) ?? [])]) {
      const photo = this.photos.get(gone) ?? this.unshown.get(gone);
      if (photo && !photo.copyOf && photo.relPath) {
        this.removed.add(photo.relPath);
        this.removedFiles.set(photo.relPath, { at: ++this.changes, landed: null });
      }
      if (this.photos.has(gone)) shown.push(gone);
      this.drop(gone);
      this.edits.delete(gone);
      this.photoStamps.delete(gone);
      this.editStamps.delete(gone);
      this.lastThumb.delete(gone);
      this.removedIds.add(gone);
    }
    return shown;
  }

  /** A photo stored under a file's name puts that file back in the catalog, so the
   *  file's tombstone goes: a photo renamed onto the name of one removed earlier,
   *  or a new one an extension stores under it. A virtual copy owns no file. */
  private revive(photo: StoredPhoto): void {
    if (photo.copyOf) return;
    this.removed.delete(photo.relPath);
    this.removedFiles.delete(photo.relPath);
  }

  /** Whether records are this copy's to take: sent to every storage on the catalog,
   *  or an answer to this one's hello. */
  private isFor(records: SentCatalogRecords): boolean {
    return records.to === undefined || records.to === this.origin;
  }

  /** Whether a photo this copy holds, shown or kept, has `file` as its own. */
  private holdsFile(file: string): boolean {
    for (const photo of [...this.photos.values(), ...this.unshown.values()])
      if (!photo.copyOf && photo.relPath === file) return true;
    return false;
  }

  /** A saved photo as this copy holds it, on the file open()'s scan found it on:
   *  what was stored for it since the open began stays. A photo moved meanwhile
   *  keeps its new place and the handles its move gave it. */
  private onFile(saved: StoredPhoto, file: ScannedFile): CatalogPhoto {
    const held = this.photos.get(saved.id);
    if (held && held.relPath !== file.path) return held;
    return {
      ...(held ?? saved),
      folder: folderOf(file.path),
      directoryHandle: file.parent,
      fileHandle: file.handle,
      thumbnailBlob: null,
      thumbnailUrl: null,
    };
  }

  /** Hold `photo` as one this window shows. Records enter, change and leave this
   *  copy only through show, keep and drop, which keep `copies` current. */
  private show(photo: CatalogPhoto): void {
    this.fileCopy(photo.id, photo.copyOf);
    this.unshown.delete(photo.id);
    this.photos.set(photo.id, photo);
  }

  /** Hold a record of a photo this window doesn't show (see unshown). */
  private keep(stored: StoredPhoto): void {
    this.fileCopy(stored.id, stored.copyOf);
    this.unshown.set(stored.id, stored);
  }

  /** Let go of a photo's record, shown or kept. */
  private drop(id: string): void {
    this.fileCopy(id, undefined);
    this.photos.delete(id);
    this.unshown.delete(id);
  }

  /** File `id` in `copies` under the master its record now copies, if any, in
   *  place of the one its record held until now. */
  private fileCopy(id: string, master: string | undefined): void {
    const was = (this.photos.get(id) ?? this.unshown.get(id))?.copyOf;
    if (was === master) return;
    if (was) {
      const filed = this.copies.get(was);
      filed?.delete(id);
      if (filed?.size === 0) this.copies.delete(was);
    }
    if (master) this.copies.set(master, (this.copies.get(master) ?? new Set<string>()).add(id));
  }

  async getEditState(photoId: string): Promise<EditState | undefined> {
    return this.edits.get(photoId);
  }

  async getAllEditStates(): Promise<EditState[]> {
    return [...this.edits.values()];
  }

  // ── opaque per-photo blobs ───────────────────────────────────────────────────
  // Stored as individual files under .safelight/blobs/ so a multi-hundred-KB
  // payload (e.g. a warp field) never enters the whole-file catalog.json rewrite.

  private async blobs(): Promise<FileSystemDirectoryHandle> {
    if (!this.blobsDir)
      this.blobsDir = await this.sl.getDirectoryHandle("blobs", { create: true });
    return this.blobsDir;
  }

  private blobName(photoId: string, key: string): string {
    const safe = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, "_");
    return `${safe(photoId)}.${safe(key)}.bin`;
  }

  async getPhotoBlob(photoId: string, key: string): Promise<Uint8Array | null> {
    try {
      const blob = await readBlob(await this.blobs(), this.blobName(photoId, key));
      if (!blob) return null;
      return new Uint8Array(await blob.arrayBuffer());
    } catch {
      return null;
    }
  }

  async putPhotoBlob(
    photoId: string,
    key: string,
    data: Uint8Array | null,
  ): Promise<void> {
    const dir = await this.blobs();
    const name = this.blobName(photoId, key);
    if (data == null) {
      await removeEntry(dir, name);
      return;
    }
    // Copy into a fresh ArrayBuffer-backed Blob so a view over a larger buffer
    // (or a SharedArrayBuffer) is written as exactly its `data` bytes.
    await writeBlob(dir, name, new Blob([data.slice()]));
  }

  async putEditState(editState: EditState): Promise<void> {
    await this.putEditStates([editState]);
  }

  /** putEditState for a batch: every state is stored before the one save, so a bulk
   *  action costs one whole-file write instead of one per photo. */
  async putEditStates(editStates: EditState[]): Promise<void> {
    const since = Date.now();
    const stored = editStates.filter((editState) => !this.removedIds.has(editState.photoId));
    if (stored.length === 0) return;
    const stamp = this.clock.next();
    for (const editState of stored) {
      this.edits.set(editState.photoId, editState);
      this.editStamps.set(editState.photoId, stamp);
      this.changedEdits.add(editState.photoId);
    }
    this.dirty = true;
    // Sent before the save lands, so the other windows hear of it at once.
    this.send({ edits: stored }, since);
    // Persist edits immediately rather than on the debounce: develop commits are
    // discrete, user-paced actions, and the beforeunload flush can be cut short
    // on app quit — so a debounced edit made just before closing was being lost.
    await this.save();
  }

  // ── other windows ──────────────────────────────────────────────────────────

  /** Tell the other windows on this catalog what this storage wrote, with the
   *  records' stamps; `since` is when the records entered this copy (see apply).
   *  An answer adds no change of this copy's, so it isn't counted as unsaved.
   *  Records a message can't carry (structured clone throws) reach no other window,
   *  and say so: the caller's own write and the open it belongs to go on regardless. */
  private send(
    records: Partial<CatalogRecords> & Pick<SentCatalogRecords, "unsaved" | "answer" | "removed" | "to">,
    since: number,
  ): void {
    if (!records.unsaved && !records.answer) this.noteUnsaved(since);
    try {
      broadcast({
        type: "catalog-records",
        payload: {
          catalog: this.catalog,
          origin: this.origin,
          since,
          edits: [],
          photos: [],
          deletedIds: [],
          ...records,
          changed: this.stampsOf(records.photos ?? [], records.edits ?? []),
        },
      });
    } catch (error) {
      this.unsent = true;
      console.warn("[project] a catalog change could not be sent to the other windows:", error);
    }
  }

  /** The stamps this copy holds for these records. */
  private stampsOf(photos: readonly StoredPhoto[], edits: readonly EditState[]): ChangeStamps {
    return {
      photos: Object.fromEntries(
        photos.flatMap(({ id }) => {
          const stamps = this.photoStamps.get(id);
          return stamps ? [[id, stamps] as const] : [];
        }),
      ),
      edits: Object.fromEntries(
        edits.flatMap(({ photoId }) => {
          const stamp = this.editStamps.get(photoId);
          return stamp ? [[photoId, stamp] as const] : [];
        }),
      ),
    };
  }

  /** Start taking on the records other windows write to this catalog, and answering
   *  the storages that open on it. Until applyWaiting, records arriving go through
   *  hold. */
  private listen(): void {
    this.listeningSince = Date.now();
    this.waiting = [];
    this.stopListening = onBroadcast((message) => {
      if (message.type === "catalog-hello") return this.answer(message.payload);
      if (message.type !== "catalog-records") return;
      if (!this.waiting) return this.apply(message.payload);
      this.hold(message.payload);
    });
  }

  /** Take on what arrives while open() builds this copy. Until the catalog is read,
   *  everything waits (see holdEarly). Then the records of photos this copy shows,
   *  and removals, apply at once, so a change made here after them is the newer;
   *  only the records of photos it doesn't show wait for the walk to end
   *  (applyWaiting), when mayKeep sees every file the walk shows. Once the window has
   *  left, those are also folded in as they arrive (see foldWaiting), as any write
   *  may be this copy's last. */
  private hold(records: SentCatalogRecords): void {
    if (records.origin === this.origin || !this.isFor(records)) return;
    let later: SentCatalogRecords | null = records;
    if (this.catalog !== "") {
      if (records.catalog !== this.catalog) return;
      if (!records.unsaved) later = this.applyShown(records);
    }
    if (!later) return;
    this.waiting?.push(later);
    if (this.closed) this.apply(later, { report: false });
  }

  /** Apply the part of `records` for photos this copy shows, and every removal;
   *  return the rest, or null when there is none. */
  private applyShown(records: SentCatalogRecords): SentCatalogRecords | null {
    const shown = new Set(this.photos.keys());
    const photos = records.photos.filter((photo) => !shown.has(photo.id));
    const edits = records.edits.filter((editState) => !shown.has(editState.photoId));
    this.apply({
      ...records,
      photos: records.photos.filter((photo) => shown.has(photo.id)),
      edits: records.edits.filter((editState) => shown.has(editState.photoId)),
    });
    if (photos.length + edits.length === 0) return null;
    return { ...records, photos, edits, deletedIds: [], removed: undefined };
  }

  /** The catalog has been read: take on what arrived before, in order, as hold does. */
  private holdEarly(): void {
    const early = this.waiting ?? [];
    this.waiting = [];
    for (const records of early) this.hold(records);
  }

  /** Ask the other storages on this catalog for the changes they hold that the
   *  catalog.json this copy read may lack (answer). */
  private greet(): void {
    broadcast({
      type: "catalog-hello",
      payload: { catalog: this.catalog, origin: this.origin, since: this.listeningSince },
    });
  }

  /** Answer a storage that has just read this catalog, and it alone (`to`), with
   *  every record this copy changed or took in since it opened, its removals, and
   *  the files it removed whose tombstone may be missing from the file that storage
   *  read (removedFiles): its saves would drop them all. The stamps decide what it
   *  takes. */
  private answer(hello: CatalogHello): void {
    if (hello.catalog !== this.catalog || hello.origin === this.origin) return;
    const photos = [...this.changedPhotos].flatMap((id) => this.heldRecord(id) ?? []);
    const edits = [...this.changedEdits].flatMap((id) => this.edits.get(id) ?? []);
    const deletedIds = [...this.removedIds];
    const removed = [...this.removedFiles].flatMap(([file, { landed }]) =>
      this.removed.has(file) && (landed === null || landed >= hello.since) ? [file] : [],
    );
    if (photos.length + edits.length + deletedIds.length + removed.length === 0) return;
    // Every change this copy holds entered it once it was listening.
    const to = hello.origin;
    this.send({ photos, edits, deletedIds, removed, answer: true, to }, this.listeningSince);
  }

  /** Apply the records that arrived while open() built this copy; later ones apply
   *  as they arrive. */
  private applyWaiting(): void {
    const waiting = this.waiting ?? [];
    this.waiting = null;
    for (const records of waiting) this.apply(records);
  }

  /** Take what arrived while open() builds this copy into it now, ahead of a write
   *  that may be its last, so that write doesn't undo another window's change. The
   *  window is leaving, so nothing is reported to the app. The records stay held: an
   *  open still running rebuilds the photo records when its walk ends, and takes
   *  them on then, reporting them unless the window has left (close). */
  private foldWaiting(): void {
    for (const records of this.waiting ?? []) this.apply(records, { report: false });
  }

  /** The window has left this catalog: what this copy takes on is no longer
   *  reported. Writes through it still persist, carrying what an open still running
   *  was holding. While it may still write (mayWrite) it keeps taking on the other
   *  windows' records, so its last write doesn't undo theirs; then it stops. Once
   *  closed, closing again does nothing (a failed open's storage is closed by the
   *  open and again as the app uninstalls it). */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.foldWaiting();
    // Left to its debounce, a pending save would land after the other windows
    // have moved on. A clean copy's running write already holds what it wasn't
    // able to send.
    if (this.dirty || (this.unsent && !this.writing)) void this.save();
    if (this.mayWrite()) leftCopies.add(this);
    this.letGoIfIdle();
  }

  /** Whether this copy may still write catalog.json: its open is still walking the
   *  folder, a save is pending or running, a try again of a failed write among
   *  them (retryLater keeps it in saveTimer), or a preview is still being written
   *  (previewWrites). */
  private mayWrite(): boolean {
    return (
      this.walking ||
      this.saveTimer !== null ||
      this.writing !== null ||
      this.nextWrite !== null ||
      this.previewWrites.size > 0
    );
  }

  /** Stop taking on other windows' records once the window has left this catalog
   *  and this copy won't write again. Changes it sent that no write of it landed
   *  are then given up: the windows that heard them all are told to save them, and
   *  this window that this copy gave up (onSaveStatus, `gaveUp`). */
  private letGoIfIdle(): void {
    if (!this.closed || this.mayWrite()) return;
    leftCopies.delete(this);
    const stop = this.stopListening;
    if (!stop) return;
    this.stopListening = null;
    stop();
    if (this.unsavedSince === null) return;
    this.send({ unsaved: true }, this.unsavedSince);
    this.report({ ok: false, reason: this.lastFailure, gaveUp: true });
  }

  /** Count a change that entered this copy at `since` among those no landed write
   *  holds (unsavedSince). */
  private noteUnsaved(since: number): void {
    this.unsavedSince = Math.min(this.unsavedSince ?? since, since);
  }

  /** Take on records another window wrote to this catalog, each where it is the
   *  newer change (see change-stamps): an edit history whole, and each group of a
   *  photo record's fields on its own. For a photo this window shows, its handles,
   *  preview blob and URL stay. The description of the preview on disk the windows
   *  share (previewEdit, previewRotation) is the sender's, whatever the stamps, as
   *  it follows the preview's writes. A photo it doesn't show, and its edit, are
   *  kept unshown for this copy's saves (mayKeep). A photo record taken on removes
   *  its file's tombstone, as in the sender (revive). A removed photo goes as
   *  deletePhoto removes it (its files are already gone), with its virtual copies;
   *  the files an answer says were removed are tombstoned unless a photo here holds
   *  them. Records of a photo removed from this copy are refused. Then the records
   *  of shown photos this copy took are reported (onRemoteRecords), unless `report`
   *  is off or the window has left this catalog. Never sends: every window already
   *  received them. */
  private apply(records: SentCatalogRecords, { report = true } = {}): void {
    if (records.catalog !== this.catalog || records.origin === this.origin) return;
    if (!this.isFor(records)) return;
    if (records.answer) this.heardFrom.add(records.origin);
    // The sender gave up writing the changes it sent from `since` on. This copy
    // holds them all if it was listening before the first one was sent, or took the
    // sender's answer; a copy that opened later without one read a file without
    // them, and its save would drop them.
    if (records.unsaved) {
      if (this.listeningSince < records.since || this.heardFrom.has(records.origin))
        this.scheduleSave();
      return;
    }
    const shown: CatalogRecords = { edits: [], photos: [], deletedIds: [] };
    let changed = false;
    for (const editState of records.edits) {
      const id = editState.photoId;
      if (this.removedIds.has(id)) continue;
      const stamp = own(records.changed?.edits, id);
      this.clock.observe(stamp);
      if (this.edits.has(id) && !newer(stamp, this.editStamps.get(id))) continue;
      this.edits.set(id, editState);
      if (stamp) this.editStamps.set(id, stamp);
      else this.editStamps.delete(id);
      this.changedEdits.add(id);
      if (this.photos.has(id)) shown.edits.push(editState);
      changed = true;
    }
    let shownFiles: Set<string> | null = null;
    for (const stored of records.photos) {
      const id = stored.id;
      if (this.removedIds.has(id)) continue;
      const stamps = own(records.changed?.photos, id);
      this.clock.observe(latest(stamps));
      const mine = this.photos.get(id);
      const current = mine ? storedPhoto(mine) : this.unshown.get(id);
      if (current) {
        const merged = mergePhoto(current, this.photoStamps.get(id), stored, stamps);
        const described =
          current.previewEdit === stored.previewEdit && madeAt(current) === madeAt(stored);
        if (!merged.taken && described) continue;
        const record: StoredPhoto = {
          ...merged.record,
          previewEdit: stored.previewEdit,
          previewRotation: madeAt(stored),
        };
        this.photoStamps.set(id, merged.stamps);
        if (mine) this.show(mergeStoredPhoto(mine, record));
        else this.keep(record);
        if (merged.taken) {
          if (mine) shown.photos.push(record);
          this.revive(record);
        }
      } else if (this.mayKeep(stored, (shownFiles ??= this.shownFiles()))) {
        this.keep(stored);
        if (stamps) this.photoStamps.set(id, stamps);
        else this.photoStamps.delete(id);
        this.revive(stored);
      } else continue;
      this.changedPhotos.add(id);
      changed = true;
    }
    for (const file of records.removed ?? []) {
      if (this.removed.has(file) || this.holdsFile(file)) continue;
      this.removed.add(file);
      this.removedFiles.set(file, { at: ++this.changes, landed: null });
      changed = true;
    }
    const held = this.photos.size + this.unshown.size + this.edits.size;
    for (const id of records.deletedIds) shown.deletedIds.push(...this.forget(id));
    if (this.photos.size + this.unshown.size + this.edits.size < held) changed = true;
    if (!changed) return;
    // The sender's save of these records began after `since`. A save of this copy
    // still running, or one that ended since then, may have landed after it and
    // put the old records back, so save again. Otherwise the file already has
    // them, and the next save of this copy writes them too.
    if (this.writing || this.lastWriteEnded >= records.since) {
      this.noteUnsaved(records.since);
      this.scheduleSave();
    }
    if (!report || this.closed) return;
    if (shown.edits.length + shown.photos.length + shown.deletedIds.length === 0) return;
    for (const listener of [...remoteRecordsListeners]) listener(shown, this);
  }

  /** Whether a record of a photo this window doesn't show may be kept for its
   *  saves. Never one that would stand for a file this window shows: another
   *  window's import of that same file under its own id, or, in the browser
   *  build, a photo of a duplicated project whose catalog key meets this one's.
   *  Nor a virtual copy of a photo this window knows nothing of. */
  private mayKeep(stored: StoredPhoto, shownFiles: Set<string>): boolean {
    if (stored.copyOf) return this.photos.has(stored.copyOf) || this.unshown.has(stored.copyOf);
    return !shownFiles.has(stored.relPath);
  }

  /** The files of the photos this window shows (masters; copies share theirs). */
  private shownFiles(): Set<string> {
    const files = new Set<string>();
    for (const photo of this.photos.values()) if (!photo.copyOf) files.add(photo.relPath);
    return files;
  }

  // ── persistence ────────────────────────────────────────────────────────────

  private scheduleSave(): void {
    this.dirty = true;
    const now = Date.now();
    if (!this.firstDirtyAt) this.firstDirtyAt = now;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    // Normal 800ms debounce, but never wait longer than the ceiling since the
    // first un-saved change — so a continuous import durably persists progress.
    const cap = this.scanning ? BULK_SAVE_DELAY : MAX_SAVE_DELAY;
    const delay = Math.min(SAVE_DELAY, Math.max(0, cap - (now - this.firstDirtyAt)));
    this.saveTimer = setTimeout(() => void this.save(), delay);
  }

  private cancelScheduledSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.firstDirtyAt = 0;
  }

  /** Write any pending changes now (see CatalogStorage.flush). With none, resolve
   *  once the write still running, if any, has landed, and write again if it
   *  failed. A copy holding a change it couldn't send (unsent) always writes. */
  async flush(options?: { unloading?: boolean }): Promise<void> {
    if (!options?.unloading) {
      if (this.dirty) return this.save();
      const running = this.nextWrite ?? this.writing;
      if (!running) return this.unsent ? this.save() : undefined;
      await running;
      if (this.dirty) return this.save();
      // A save started meanwhile holds this copy too.
      return this.writing ?? undefined;
    }
    // A closing page won't run a write queued behind another, so this one starts
    // beside it. The desktop main process queues writes to one file and lands the
    // newest last. In the browser build the two race: each lands whole, and the
    // one that finishes last wins, which may be the older.
    this.foldWaiting();
    if (!this.dirty && !this.unsent && !this.writing) return;
    this.cancelScheduledSave();
    await this.writeCatalog();
    // A page that stays open after all (its unload was cancelled) is still a copy
    // the window left: once idle it stops following, and answering, the others.
    this.letGoIfIdle();
  }

  /** Save now. One catalog.json write runs at a time: a save asked for during a
   *  write waits for it, sharing one write with every save asked for meanwhile,
   *  and that write reads the catalog when it starts. So each caller resolves
   *  after a write that holds its change. */
  private save(): Promise<void> {
    this.cancelScheduledSave();
    if (this.nextWrite) return this.nextWrite;
    if (!this.writing) return this.startWrite();
    const next = () => {
      this.nextWrite = null;
      return this.startWrite();
    };
    this.nextWrite = this.writing.then(next, next);
    return this.nextWrite;
  }

  private startWrite(): Promise<void> {
    this.writing = this.writeCatalog().finally(() => {
      this.writing = null;
      this.lastWriteEnded = Date.now();
      this.letGoIfIdle();
    });
    const backup = this.backup;
    if (!backup) return this.writing;
    this.backup = null;
    // Written once this save has landed, not before it: a save held back could land
    // after a write another window started meanwhile, and undo it. Later saves
    // don't wait for the backup; whoever asked for this one does.
    return this.writing.then(() => this.writeBackup(backup));
  }

  /** Never rejects: the save it follows stands either way. */
  private async writeBackup(backup: Blob): Promise<void> {
    try {
      await writeBlob(this.sl, BACKUP, backup);
    } catch (error) {
      console.warn("[project] the catalog couldn't be backed up:", error);
    }
  }

  /** Never rejects: how the write ended is reported (onSaveStatus), and a failed
   *  one is logged, kept to save and tried again (retryLater). */
  private async writeCatalog(): Promise<void> {
    this.dirty = false;
    const unsavedSince = this.unsavedSince;
    this.unsavedSince = null;
    const holds = this.changes;
    try {
      const photos = [...[...this.photos.values()].map(storedPhoto), ...this.unshown.values()];
      const edits = [...this.edits.values()];
      const changed = this.stampsOf(photos, edits);
      const stamped = Object.keys(changed.photos).length + Object.keys(changed.edits).length > 0;
      const data: CatalogFile = {
        ...this.extra,
        version: 1,
        id: this.catalogId,
        photos,
        edits,
        removed: [...this.removed],
        ...(stamped ? { changed } : {}),
      };
      await writeJSON(this.sl, CATALOG, data);
    } catch (error) {
      this.dirty = true;
      if (unsavedSince !== null) this.noteUnsaved(unsavedSince);
      this.failures++;
      this.lastFailure = saveFailureReason(error);
      console.error("[project] catalog save failed:", error);
      this.report({ ok: false, reason: this.lastFailure });
      // A catalog too large to write would fail the same way on every try: the
      // next change or flush tries it again.
      if (!(error instanceof RangeError)) this.retryLater();
      return;
    }
    const landed = Date.now();
    for (const [file, tombstone] of this.removedFiles) {
      if (tombstone.landed === null && tombstone.at <= holds) tombstone.landed = landed;
      else if (tombstone.landed !== null && landed - tombstone.landed > TOMBSTONE_ANSWERED_FOR)
        this.removedFiles.delete(file);
    }
    this.failures = 0;
    this.report({ ok: true });
  }

  /** Never throws: a listener's failure mustn't fail the save or skip its retry. */
  private report(status: SaveStatus): void {
    for (const listener of [...saveStatusListeners]) {
      try {
        listener(status, this);
      } catch (error) {
        console.error("[project] a save status listener failed:", error);
      }
    }
  }

  /** Try a failed write again after a wait (SAVE_RETRY_DELAYS), unless a save of a
   *  later change is already on its way. A copy the window has left tries only a
   *  few times (RETRIES_AFTER_CLOSE). */
  private retryLater(): void {
    if (this.saveTimer || this.nextWrite) return;
    if (this.closed && this.retriesAfterClose >= RETRIES_AFTER_CLOSE) return;
    const delay = SAVE_RETRY_DELAYS[Math.min(this.failures, SAVE_RETRY_DELAYS.length) - 1];
    this.saveTimer = setTimeout(() => {
      if (this.closed) this.retriesAfterClose++;
      void this.save();
    }, delay);
  }
}
