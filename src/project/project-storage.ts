// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// ProjectStorage: the catalogue lives inside the project folder.
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
// catalogue are tombstoned so they aren't re-imported while their original stays
// on disk, until a photo is stored under that name again. Saves are debounced
// whole-file JSON writes, one at a time (handles and blobs are never serialized).
// A write that fails is tried again after a wait, and how each write ends is
// reported to the app (onSaveStatus).
//
// A catalog.json that can't be read, or was saved by a newer version, stops the
// open with nothing written. A damaged one is kept aside as
// catalog.corrupt-<time>.json. A damaged or missing one is restored from
// catalog.bak.json (the catalogue as the main window opened it, kept by that
// session's first save, when it held nothing this build couldn't open; the two
// before it stay as catalog.bak-1.json and catalog.bak-2.json); with no usable
// backup the open starts from the folder alone. Of the damaged copies kept aside,
// the newest few of each kind stay.
//
// Every window (the main one and each pop-out) opens the project with its own
// storage and saves the whole file from its own copy. So each write is also sent
// to the windows on the same catalogue file as "catalog-records". Each takes them
// on where they are the newer change (see change-stamps): the photos it shows
// change in place, and photos it doesn't show (added by the sender since this
// window opened) are kept, unshown, so its own saves don't drop them. It saves
// again when a save of its own may have put the old records back on disk, or when
// the sender gave up writing them. A window that opens says so once it has read
// catalog.json ("catalog-hello"), and every other storage on the catalogue answers
// with what it changed or took in since it opened, which that file may not hold.

import {
  mergeStoredPhoto,
  storedPhoto,
  type CatalogPhoto,
  type EditState,
  type StoredPhoto,
} from "@/catalog/types";
import { historyCursor } from "@/catalog/history-cursor";
import type { CatalogStorage } from "@/catalog/storage";
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
  stampAll,
  type ChangeStamp,
  type ChangeStamps,
  type PhotoStamps,
} from "./change-stamps";
import { mapLimit, readBlobIfThere, readJSON, removeEntry, writeBlob } from "./fs";
import {
  BACKUP,
  CATALOG,
  catalogIdOf,
  catalogKey,
  isMainWindow,
  OLDER_BACKUPS,
  readSavedCatalog,
  type CatalogRecovery,
} from "./catalog-file";
import { catalogText, forgetStepTexts, sameRecordText } from "./catalog-json";
import { fsErrorText } from "./fs-errors";
import { openableEdit, SAVE_RETRY_DELAYS } from "./edit-files";
import { nativeFs } from "./native-fs";
import { PhotoBlobs } from "./photo-blobs";
import { findMoved, namesFoldCase, shotDiffers } from "./reattach";
import { scanProject, type FolderNode, type ScannedFile } from "./scan";
import { recordVolume } from "./volume-print";
import { adoptSidecar, SIDECAR_SUFFIX, type PhotoSidecar } from "./sidecar";
import { resolveWorkingDir, type WorkingDirLocation } from "./working-dir";
import { isSourceFile, isSourceRoot, pairSourceRecords } from "./library-sources";

export { catalogKey, type CatalogRecovery } from "./catalog-file";

/** What a storage needs from the layers above it, handed in by whoever opens it
 *  (see storage-deps): the import of the files the open walk finds new, the
 *  "Store previews on disk" setting, and the extensions' import hook. */
export interface ProjectStorageDeps {
  /** Tells an image the import can read by its file name. */
  isSupportedName(name: string): boolean;
  /** The record of a new file, relPath/folder left for the walk; null if it can't be read. */
  importPhoto(
    fileHandle: FileSystemFileHandle,
    directoryHandle: FileSystemDirectoryHandle | null,
  ): Promise<CatalogPhoto | null>;
  /** A grid preview built from the photo's source file; null if it can't decode,
   *  or once `signal` aborts. */
  buildPreviewBlob(photo: CatalogPhoto, signal?: AbortSignal): Promise<LoadedPreview | null>;
  persistPreviews(): boolean;
  /** The fields extensions read for a new file, from its sidecars; null for none. */
  emitPhotoImport(ctx: {
    photo: CatalogPhoto;
    dir: FileSystemDirectoryHandle;
    fileName: string;
  }): Promise<Partial<CatalogPhoto> | null>;
}

const SAVE_DELAY = 800;
// Hard cap so a steady stream of writes (e.g. a long import) still flushes
// periodically instead of the debounce sliding forever and persisting nothing.
const MAX_SAVE_DELAY = 2500;
// During the import walk the ceiling relaxes: every flush re-serializes the
// whole catalogue, so at 2.5s a long import spends ~O(n²) work re-writing records
// it just wrote. 10s keeps progress durable while cutting that churn 4×.
const BULK_SAVE_DELAY = 10_000;
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
 *  for the user. `gaveUp` is set once a storage whose window left the catalogue
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

/** Why a catalog.json write failed, worded for the user. */
function saveFailureReason(error: unknown): string {
  if (error instanceof RangeError) return "the catalogue is too large to save as one file";
  return fsErrorText(error);
}

/** The records catalog.json can hold (`saved` is a record as it is written), and an
 *  error naming the others, each logged. A value JSON can't write (a BigInt, a
 *  cycle, a getter that throws), which an extension can set, would fail every
 *  later save of the whole file, so a record holding one never enters a copy. */
function savable<T>(
  records: readonly T[],
  what: string,
  idOf: (record: T) => string,
  saved: (record: T) => unknown = (record) => record,
): { records: T[]; refused: Error | null } {
  const kept: T[] = [];
  const refused: string[] = [];
  for (const record of records) {
    try {
      JSON.stringify(saved(record));
      kept.push(record);
    } catch (error) {
      const id = idOf(record);
      refused.push(id);
      console.error(`[project] the ${what} of ${id} can't be saved, so it isn't stored:`, error);
    }
  }
  return {
    records: kept,
    refused:
      refused.length > 0 ? new Error(`the ${what} of ${refused.join(", ")} can't be saved`) : null,
  };
}

/** The storages whose window has left their catalogue while they may still write it
 *  (close), until they let go (letGoIfIdle). */
const leftCopies = new Set<ProjectStorage>();

/** Write now what each catalogue this window has left still holds: the window is
 *  closing, and their next try would come after it. Called before the open
 *  catalogue's own flush, so that write is asked for last (see flush). */
export function flushLeftCopies(): void {
  for (const storage of leftCopies) void storage.flush({ unloading: true });
}

/** Counts the storages this window has opened, to name each one's records. */
let openedStorages = 0;

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

export interface OpenedProject {
  storage: ProjectStorage;
  tree: FolderNode;
  /** Folders the scan couldn't list, as paths from the project root. */
  unreadable: string[];
  /** Files the scan left out as unsupported, counted by lower-cased extension. */
  skipped: Record<string, number>;
  photos: CatalogPhoto[];
  /** Photos discovered on this open (candidates for background pre-decode), as
   *  held once it ends: one removed meanwhile is left out. */
  newPhotos: CatalogPhoto[];
  rawCacheDir: FileSystemDirectoryHandle;
  /** Where the .safelight working dir ended up: in the project folder, or
   *  redirected to a writeable app-data location because the folder is read-only. */
  storageLocation: WorkingDirLocation;
  /** Absolute path of the external working dir when redirected, else null. */
  externalPath: string | null;
  /** Set when read-only-session edits were just folded back into this in-folder
   *  catalogue — the separate catalogue they came from. Else null. */
  promotedFromExternal: string | null;
  /** How a catalogue that couldn't be used as saved was recovered, else null. */
  recovered: CatalogRecovery | null;
}

export class ProjectStorage implements CatalogStorage {
  private photos = new Map<string, CatalogPhoto>();
  private edits = new Map<string, EditState>();
  /** Tombstoned relPaths — files removed from the catalogue but still on disk. */
  private removed = new Set<string>();
  private lastThumb = new Map<string, Blob | null>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private firstDirtyAt = 0;
  /** Whether this copy holds a change catalog.json may lack: set by a change to
   *  save, cleared as a write takes its copy of the catalogue, set again if that
   *  write fails. A flush with nothing to save writes nothing. */
  private dirty = false;
  /** Set for good once a change couldn't be sent to the other windows (send): they
   *  never held it, so any later save of theirs leaves it out of the file, unseen
   *  here. A copy that holds one writes whenever it is flushed or closed. */
  private unsent = false;
  /** True while the open() walk imports new files — relaxes the save ceiling. */
  private scanning = false;
  /** Whether the open() walk took a photo at its file's new size (resize). */
  private resized = false;
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
   *  opened: what it answers a storage that opens on the catalogue later with
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
  /** The id this catalogue keeps (catalogIdOf), and the catalogue file this storage
   *  writes (catalogKey); both are known once open() has read catalog.json. */
  private catalogId = "";
  private catalog = "";
  private stopListening: (() => void) | null = null;
  /** True until open() has built this copy, or failed: its walk may still save. */
  private walking = true;
  /** Set once the window has left this catalogue (close). */
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
  /** The catalogue's top-level keys this build doesn't know, saved back as read. */
  private extra: Record<string, unknown> = {};
  /** catalog.json as this session opened it, which its first save keeps as
   *  catalog.bak.json; null once kept, or when there is none to keep (a restore or
   *  rebuild found the file damaged or missing, or it held entries this build
   *  couldn't open, or this is a pop-out window). */
  private backup: Blob | null = null;
  /** The history snapshots putEditStates has found catalog.json can hold. A history
   *  keeps its earlier snapshots as they are, so each is checked once, not with
   *  every step added after it. */
  private writable = new WeakSet<EditState["stack"][number]>();

  private sl: FileSystemDirectoryHandle;
  private previews: FileSystemDirectoryHandle;
  private readonly blobs: PhotoBlobs;

  private readonly deps: ProjectStorageDeps;

  private constructor(
    sl: FileSystemDirectoryHandle,
    previews: FileSystemDirectoryHandle,
    deps: ProjectStorageDeps,
  ) {
    this.sl = sl;
    this.previews = previews;
    this.blobs = new PhotoBlobs(sl);
    this.deps = deps;
  }

  static async open(
    root: FileSystemDirectoryHandle,
    deps: ProjectStorageDeps,
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
    const storage = new ProjectStorage(sl, previews, deps);
    // Follow the other windows from before catalog.json is read: which catalogue what
    // they write belongs to is only known once it is read, so it waits until then
    // (see hold).
    storage.listen();
    try {
      // Read the saved catalogue first (one quick read) and paint the grid from it
      // immediately as skeleton records — no live handles, no previews — so the UI
      // appears at once. The directory scan below then runs without blocking the
      // first paint, attaching handles and finding new/removed files. A catalogue that
      // can't be read, or is too new, stops the open here: nothing is written,
      // sent or installed.
      const { catalog: opened, recovered, bytes } = await readSavedCatalog(sl);
      const saved = opened?.file ?? null;
      storage.extra = opened?.extra ?? {};
      if (bytes && opened?.skipped === 0 && isMainWindow()) storage.backup = new Blob([bytes]);
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
      // Records of one name but another size are other photos (another card at the
      // same mount point, a file replaced): each is kept, and the file goes to the
      // one of its size.
      const savedRecords = saved?.photos ?? [];
      const byRel = new Map<string, StoredPhoto>();
      const named = new Map<string, StoredPhoto[]>();
      for (const p of savedRecords) {
        if (p.copyOf) continue;
        const sharing = named.get(p.relPath) ?? [];
        if (sharing.some((r) => r.fileSize === p.fileSize)) continue;
        named.set(p.relPath, [...sharing, p]);
        if (!byRel.has(p.relPath)) byRel.set(p.relPath, p);
      }
      const masterRecords = new Set([...named.values()].flat());
      const savedPhotos = savedRecords.filter((p) => p.copyOf || masterRecords.has(p));

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
      // What the other windows sent while the catalogue was read is painted with it.
      storage.holdEarly();
      onSkeletons?.(
        storage,
        rawCacheDir,
        skeletons.flatMap((sk) => storage.photos.get(sk.id) ?? []),
      );
      // Ask the others for what they changed that the file may not hold yet.
      storage.greet();

      const scan = await scanProject(root, deps.isSupportedName);
      const scanPaths = new Set(scan.files.map((f) => f.path));
      const underUnreadable = (rel: string) =>
        scan.unreadable.some((folder) => rel === folder || rel.startsWith(`${folder}/`));

      const importStarted = Date.now();
      // A library source names each photo by a key of its own, which follows the photo
      // through renamed albums and renamed photos: its records pair with the files by
      // that key alone, so no file takes the record of another photo that had its path.
      const sourcePairs = isSourceRoot(root)
        ? pairSourceRecords(
            [...masterRecords].filter((r) => !storage.removedIds.has(r.id)),
            scan.files,
          )
        : null;

      // A saved photo whose file the scan found under another spelling of its path,
      // or moved or renamed while the app was closed, keeps its record (and with it
      // its edits) on the file's new path instead of being imported again as new.
      const searchMoved = () =>
        findMoved(
          [...byRel.values()].filter(
            (r) =>
              !scanPaths.has(r.relPath) &&
              !underUnreadable(r.relPath) &&
              !storage.removedIds.has(r.id),
          ),
          scan.files.filter((f) => !byRel.has(f.path) && !storage.removed.has(f.path)),
          namesFoldCase(),
          { signal, onProgress },
        ).catch((error: unknown) => {
          // A search that fails costs its photos one import again, never the open.
          console.warn("[project] the search for moved photos failed:", error);
          return new Map<ScannedFile, StoredPhoto>();
        });
      const moved = sourcePairs
        ? new Map([...sourcePairs].filter(([file, record]) => file.path !== record.relPath))
        : await searchMoved();
      for (const [file, record] of moved) {
        const relocated = storage.relocate(record, file);
        if (sourcePairs) {
          sourcePairs.set(file, relocated);
        } else {
          byRel.delete(record.relPath);
          byRel.set(file.path, relocated);
        }
      }

      // The saved record each file is: the one under its path, unless the listing
      // gave the file another size. Then it is the one of that size under the path,
      // or that record still unless the file's capture time shows it is another
      // photo; then the file is new. The browser build's listing gives no sizes, so
      // there the path decides alone. Telling another card at one mount point from
      // this one is the separate catalogue's print's work (volume-print.ts). A
      // library source's are its pairs.
      const known = sourcePairs ?? new Map<ScannedFile, StoredPhoto>();
      if (!sourcePairs)
        await mapLimit(scan.files, 8, async (f: ScannedFile) => {
          const prev = byRel.get(f.path);
          if (!prev) return;
          const sized =
            f.size === undefined || prev.fileSize === f.size
              ? prev
              : named.get(f.path)?.find((r) => r.fileSize === f.size);
          if (sized) known.set(f, sized);
          else if (!(await shotDiffers(prev, f))) known.set(f, prev);
        });

      // New files (not in the saved catalogue, not tombstoned) are the ones that get
      // decoded — the slow part of opening. Report progress against that count.
      const counted = new Set(
        scan.files.flatMap((f) => (known.has(f) || storage.removed.has(f.path) ? [] : [f])),
      );
      const newTotal = counted.size;
      let newDone = 0;
      onProgress?.(0, newTotal);

      // Ids, not records: an import's record holds its preview until the grid lets
      // go of it (forgetPreviews), which a list of the records would keep.
      const newIds: string[] = [];
      storage.scanning = true;
      /** The file the scan found each saved photo on. */
      const fileOf = new Map<string, ScannedFile>();
      const results = await mapLimit(scan.files, 8, async (f: ScannedFile): Promise<string | null> => {
        const prev = known.get(f);
        if (prev) {
          // Known photo: reattach live handles only. The cached preview is loaded
          // later, on demand (visible cells first), so the open never blocks on
          // hundreds of serial preview reads.
          if (storage.removedIds.has(prev.id)) return null;
          fileOf.set(prev.id, f);
          const photo = storage.resize(storage.onFile(prev, f), f);
          storage.show(photo);
          return photo.id;
        }
        // Tombstoned: the user removed this photo from the catalogue while its file
        // stayed on disk. Honour that removal instead of re-importing it as new,
        // one another window's answer told of after the count too.
        if (storage.removed.has(f.path)) {
          if (counted.has(f)) onProgress?.(++newDone, newTotal);
          return null;
        }
        // New file: decode, thumbnail, cache the preview on disk. The import reads
        // only as much of the file as its preview needs.
        if (signal?.aborted) {
          onProgress?.(++newDone, newTotal);
          return null;
        }
        try {
          const built = await deps.importPhoto(f.handle, f.parent);
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
                Object.assign(photo, adoptSidecar(info));
                if (sc.maps && Array.isArray(sc.maps.stack) && sc.maps.stack.length > 0) {
                  const adopted = openableEdit({
                    photoId: photo.id,
                    stack: sc.maps.stack,
                    currentIndex: historyCursor(sc.maps.currentIndex, sc.maps.stack.length),
                  });
                  if (adopted) {
                    storage.changedEdits.add(photo.id);
                    storage.edits.set(photo.id, adopted);
                  }
                }
              }
            } catch {
              /* invalid sidecar — ignore */
            }
          }

          // Let extensions contribute metadata read from sidecars. Their values
          // take precedence over the SafeLight sidecar.
          try {
            const ov = await deps.emitPhotoImport({
              photo,
              dir: f.parent,
              fileName: f.handle.name,
            });
            if (ov) {
              const merged = { ...photo, ...ov };
              const { refused } = savable([merged], "import metadata", () => f.path, storedPhoto);
              if (!refused) photo = merged;
            }
          } catch {
            /* extension import failed — ignore */
          }
          // A preview that can't be written keeps the photo: it is left unheld, so
          // the next put that carries it writes it.
          let previewHeld = true;
          if (photo.thumbnailBlob && deps.persistPreviews()) {
            try {
              await writeBlob(previews, `${photo.id}.jpg`, photo.thumbnailBlob);
            } catch (err) {
              previewHeld = false;
              console.warn(`[import] the preview of ${f.path} couldn't be stored:`, err);
            }
          }
          if (previewHeld) storage.lastThumb.set(photo.id, photo.thumbnailBlob);
          storage.show(photo);
          storage.changedPhotos.add(photo.id);
          newIds.push(photo.id);
          onPhoto?.(photo);
          // Persist progress as we go: an interrupted import resumes from the last
          // saved photo instead of re-decoding the whole folder next launch.
          storage.scheduleSave();
          onProgress?.(++newDone, newTotal);
          return photo.id;
        } catch (err) {
          console.warn(`[import] skipped ${f.path}:`, err);
          onProgress?.(++newDone, newTotal);
          return null;
        }
      });

      storage.scanning = false;
      // A cancelled search for moved photos pairs none of the files it had yet to
      // read, so only an open that ran to the end may take a missing file for gone.
      const finished = !signal?.aborted;
      // Each photo the walk reached, as this copy holds it now: a change stored
      // after the walk passed it stays, and a photo removed meanwhile stays out.
      const masters = results.flatMap((id) => {
        const held = id === null || storage.removedIds.has(id) ? undefined : storage.photos.get(id);
        if (!held) return [];
        const file = fileOf.get(held.id);
        return [file ? storage.onFile(held, file) : held];
      });

      // A folder the scan couldn't list hides its photos, and a cancelled open
      // leaves the files it didn't pair unknown: those photos are not gone, so
      // their records stay as saved (without live handles) rather than being
      // dropped with their edits.
      if (!finished || scan.unreadable.length > 0)
        for (const saved of byRel.values()) {
          const held = storage.photos.get(saved.id);
          if (
            held &&
            !fileOf.has(saved.id) &&
            (!finished || underUnreadable(saved.relPath)) &&
            !storage.removedIds.has(saved.id)
          )
            masters.push(held);
        }

      // A record under a file's name that the file turned out not to be is another
      // photo, whose own file isn't here: it stays as saved, with its edits. A library
      // source's photo is known by its key, so one not paired is gone from the source.
      const walkedIds = new Set(masters.map((m) => m.id));
      if (!sourcePairs)
        for (const saved of masterRecords) {
          const held = storage.photos.get(saved.id);
          if (
            held &&
            scanPaths.has(saved.relPath) &&
            !fileOf.has(saved.id) &&
            !walkedIds.has(saved.id) &&
            !storage.removedIds.has(saved.id)
          )
            masters.push(held);
        }

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
      const heldPaths = new Set(masters.map((m) => m.relPath));
      let prunedTombstone = false;
      for (const r of [...storage.removed])
        if ((!scanPaths.has(r) && !underUnreadable(r)) || heldPaths.has(r)) {
          storage.removed.delete(r);
          prunedTombstone = true;
        }

      const heldIds = new Set(masters.map((m) => m.id));
      const removedCount = [...byRel.values()].filter((r) => !heldIds.has(r.id)).length;
      if (
        newIds.length > 0 ||
        moved.size > 0 ||
        storage.resized ||
        removedCount > 0 ||
        prunedTombstone ||
        droppedCopy || // a virtual copy was dropped — re-persist
        savedPhotos.length !== savedRecords.length || // a second record for one file
        recovered !== null || // the restored or rebuilt catalogue replaces the damaged one
        (opened?.skipped ?? 0) > 0 // records this build couldn't open, kept aside
      )
        storage.scheduleSave();

      // A separate catalogue keeps a print of the card it was found on, so another
      // card mounted at the same path later opens one of its own (working-dir).
      const fs = nativeFs();
      if (fs && externalPath && finished)
        await recordVolume(
          fs,
          externalPath,
          masters.filter((m) => m.fileHandle),
        ).catch((error: unknown) => console.warn("[project] the card's print wasn't kept:", error));

      storage.applyWaiting();
      storage.walking = false;
      storage.letGoIfIdle();
      // Other windows open on this catalogue keep the photos found here, so their
      // saves don't drop them, and take on the new place of the ones found moved.
      const asHeld = (id: string) => storage.photos.get(id) ?? [];
      const found = newIds.flatMap(asHeld);
      const relocated = [...moved.values()].flatMap(({ id }) => asHeld(id));
      if (found.length + relocated.length > 0)
        storage.send(
          {
            photos: [...found, ...relocated].map(storedPhoto),
            edits: found.flatMap((photo) => storage.edits.get(photo.id) ?? []),
          },
          importStarted,
        );
      return {
        storage,
        tree: scan.tree,
        unreadable: scan.unreadable,
        skipped: scan.skipped,
        // Each record as it stands once the waiting records are applied.
        photos: photos.flatMap((photo) => storage.photos.get(photo.id) ?? []),
        newPhotos: found,
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
   *  photo's record named; otherwise the record keeps naming the copy on disk.
   *  A library source's photo's preview comes from the source, so it is kept on
   *  disk once built: the source is read once per photo.
   *  `hold: false` leaves the blob out of the ones kept to spot a changed preview;
   *  `build: false` reads the disk copy only; `signal` stops a build (the grid
   *  no longer wants the preview). */
  async readPreview(
    id: string,
    options?: { hold?: boolean; build?: boolean; signal?: AbortSignal },
  ): Promise<LoadedPreview | null> {
    const hold = options?.hold !== false;
    // Taken before the read: a record names a preview only once it is on disk
    // (previewStored), so the preview read is never older than this edit.
    const record = this.photos.get(id);
    const previewEdit = record?.previewEdit;
    const turnedSince = record !== undefined && madeAt(record) !== turnOf(record);
    let missing = false;
    if (this.deps.persistPreviews() && !turnedSince) {
      try {
        const blob = await readBlobIfThere(this.previews, `${id}.jpg`);
        if (blob) {
          if (hold) this.lastThumb.set(id, blob);
          return Object.assign(blob, { previewEdit });
        }
        missing = true;
      } catch {
        // Can't be read for now (another program holds it): the record keeps naming it.
      }
    }
    const photo = options?.build === false ? undefined : this.photos.get(id);
    if (photo) {
      const blob = await this.deps.buildPreviewBlob(photo, options?.signal);
      if (blob) {
        if (hold) this.lastThumb.set(id, blob);
        // A source's preview came over the network: kept, so it is read once.
        if (isSourceFile(photo.fileHandle) && this.deps.persistPreviews())
          void this.writePreview(id, blob, undefined, turnOf(photo)).catch((err: unknown) => {
            console.warn(`[project] the preview of ${id} couldn't be stored:`, err);
            if (this.lastThumb.get(id) === blob) this.lastThumb.delete(id);
          });
        // Not sent (each window's previews are its own) nor saved (every load derives it again).
        // A preview stored while this one was built keeps the edit it shows.
        const held = this.photos.get(id);
        const named = held?.previewEdit !== undefined && held.previewEdit === photo.previewEdit;
        if (missing && named) this.show({ ...held, previewEdit: undefined });
        // A source's photo listed without a size takes its preview's, stored like any
        // change to its record, until its original's replaces it (decode-learned.ts).
        const sized = this.photos.get(id);
        if (blob.frame && sized && !(sized.width > 0 && sized.height > 0) && turnOf(sized) === turnOf(photo))
          await this.storePhotos(
            [{ ...sized, thumbnailBlob: null, width: blob.frame.width, height: blob.frame.height }],
            { lazy: true },
          );
        return blob;
      }
    }
    return null;
  }

  /** Stop holding the previews of photos the grid let go of (see readPreview), so
   *  the blobs they were read as can be freed. A preview that comes back is read
   *  again and held again; one put without having been read is written. A record
   *  holding the preview stored for it (an import's) lets go of it and its URL,
   *  which the grid revoked: the record's stored fields stay as they are, so this
   *  is no change to save or send. */
  forgetPreviews(ids: readonly string[]): void {
    for (const id of ids) {
      if (this.mayForgetPreview(id)) {
        const held = this.photos.get(id);
        if (held) {
          const record = { ...held, thumbnailBlob: null, thumbnailUrl: null };
          sameRecordText(held, record);
          this.show(record);
        }
      }
      this.lastThumb.delete(id);
    }
  }

  /** Whether the preview the photo's record holds is one readPreview brings back
   *  once let go of: the one stored for it, or one built again with previews not
   *  kept on disk. One whose write failed is the only copy, and the next put that
   *  carries it writes it. */
  mayForgetPreview(id: string): boolean {
    const blob = this.photos.get(id)?.thumbnailBlob;
    return !!blob && this.lastThumb.get(id) === blob;
  }

  async putPhoto(photo: CatalogPhoto, options?: { lazy?: boolean }): Promise<void> {
    await this.putPhotos([photo], options);
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
   *  doesn't fail the records. With `lazy` the catalogue save waits for the bulk
   *  delay (see scheduleSave); the message to the other windows doesn't. A record
   *  catalog.json can't hold (savable) is not stored, the one held before it stays,
   *  and once the rest are stored this rejects naming its photo. */
  async putPhotos(photos: CatalogPhoto[], options?: { lazy?: boolean }): Promise<void> {
    const { records, refused } = savable(photos, "photo record", (photo) => photo.id, storedPhoto);
    await this.storePhotos(records, options);
    if (refused) throw refused;
  }

  /** putPhotos for the records catalog.json can hold. */
  private async storePhotos(photos: CatalogPhoto[], options?: { lazy?: boolean }): Promise<void> {
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
    this.scheduleSave(options?.lazy);
    // Sent before the previews are written, so the other windows get this copy's
    // changes in the order it made them. The edit a preview shows follows it once
    // it is on disk.
    this.send({ photos: records }, since);
    if (!this.deps.persistPreviews() || previews.length === 0) return;
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

  heldPhoto(id: string): CatalogPhoto | undefined {
    return this.photos.get(id);
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

  /** Remove the previews kept for these photos, so each is built again when the
   *  grid next reads it. A write asked for before a removal lands first, and one
   *  asked for after it lands instead. */
  async dropStoredPreviews(ids: string[]): Promise<void> {
    await Promise.all(ids.map((id) => this.removePreview(id)));
  }

  private removePreview(id: string): Promise<void> {
    const before = this.previewWrites.get(id)?.ended;
    const turn = { ended: Promise.resolve() };
    this.previewWrites.set(id, turn);
    this.lastThumb.delete(id);
    const newest = () => this.previewWrites.get(id) === turn;
    const removed = (async () => {
      if (before) await before;
      if (newest()) await removeEntry(this.previews, `${id}.jpg`);
    })();
    turn.ended = removed.then(
      () => undefined,
      () => undefined,
    );
    return removed.finally(() => {
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
    // The preview is on disk; a record that still names the old one is rebuilt
    // on the next open, so the save can wait. A copy the window has left has
    // nothing to batch with, and is let go once it has written.
    this.scheduleSave(!this.closed);
    this.send({ photos: [storedPhoto(record)] }, since);
  }

  async deletePhoto(id: string): Promise<void> {
    await this.deletePhotos([id]);
  }

  /** Remove the photos in one save and one message, however many there are. The
   *  records are gone once this is called; what it returns settles when their
   *  previews and blobs are removed too. */
  deletePhotos(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return Promise.resolve();
    const since = Date.now();
    const dropped = ids.flatMap((id) => this.forget(id).dropped);
    this.scheduleSave();
    this.send({ deletedIds: [...ids] }, since);
    // A write of its preview still running removes the file again once it lands
    // (writePreview).
    return Promise.all([
      mapLimit(dropped, 8, (id) => removeEntry(this.previews, `${id}.jpg`)),
      this.blobs.deletePhotoBlobs(dropped),
    ]).then(() => {});
  }

  /** Drop a photo's record, shown or not, its edit history and its virtual copies
   *  (removing a master takes them with it, even those this window doesn't show),
   *  and refuse them from now on (removedIds). The file is tombstoned so the next
   *  folder scan doesn't re-import it as "new": removal is from the catalogue only,
   *  the original stays on disk. A VIRTUAL COPY owns no file of its own (it shares
   *  its master's), so tombstoning its relPath would wrongly suppress the master's
   *  file; a copy's record is just dropped. Returns every id dropped, and those of
   *  them this window showed. */
  private forget(id: string): { dropped: string[]; shown: string[] } {
    const dropped = [id, ...(this.copies.get(id) ?? [])];
    const shown: string[] = [];
    for (const gone of dropped) {
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
    return { dropped, shown };
  }

  /** A photo stored under a file's name puts that file back in the catalogue, so the
   *  file's tombstone goes: a photo renamed onto the name of one removed earlier,
   *  or a new one an extension stores under it. A virtual copy owns no file. */
  private revive(photo: StoredPhoto): void {
    if (photo.copyOf) return;
    this.removed.delete(photo.relPath);
    this.removedFiles.delete(photo.relPath);
  }

  /** Whether records are this copy's to take: sent to every storage on the catalogue,
   *  or an answer to this one's hello. */
  private isFor(records: SentCatalogRecords): boolean {
    return records.to === undefined || records.to === this.origin;
  }

  /** The files the photos this copy holds, shown or kept, have as their own. */
  private heldFiles(): Set<string> {
    const files = new Set<string>();
    for (const records of [this.photos.values(), this.unshown.values()])
      for (const photo of records) if (!photo.copyOf) files.add(photo.relPath);
    return files;
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

  /** `photo` at the size the listing gave its file `file`, when that changed: the
   *  file was rewritten in place. Stamped as changed, so the record and what is
   *  keyed by its size (the RAW cache) follow the file. */
  private resize(photo: CatalogPhoto, file: ScannedFile): CatalogPhoto {
    if (file.size === undefined || photo.fileSize === file.size) return photo;
    const stamps = { ...this.photoStamps.get(photo.id), file: this.clock.next() };
    this.photoStamps.set(photo.id, stamps);
    this.changedPhotos.add(photo.id);
    this.resized = true;
    return { ...photo, fileSize: file.size };
  }

  /** `saved` on the path open()'s scan found its file under, as the photo held for
   *  it is from now on, the location stamped as changed now. */
  private relocate(saved: StoredPhoto, file: ScannedFile): StoredPhoto {
    const location = {
      relPath: file.path,
      filename: file.handle.name,
      folder: folderOf(file.path),
    };
    const held = this.photos.get(saved.id);
    if (held) this.show({ ...held, ...location });
    const stamps = { ...this.photoStamps.get(saved.id), location: this.clock.next() };
    this.photoStamps.set(saved.id, stamps);
    this.changedPhotos.add(saved.id);
    return { ...saved, ...location };
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

  getPhotoBlob(photoId: string, key: string): Promise<Uint8Array | null> {
    return this.blobs.get(photoId, key);
  }

  putPhotoBlob(photoId: string, key: string, data: Uint8Array | null): Promise<void> {
    return this.blobs.put(photoId, key, data);
  }

  async putEditState(editState: EditState): Promise<void> {
    await this.putEditStates([editState]);
  }

  /** putEditState for a batch: every state is stored before the one save, so a bulk
   *  action costs one whole-file write instead of one per photo. A state catalog.json
   *  can't hold (savable) is not stored, the one held before it stays, and once the
   *  rest are saved this rejects naming its photo. */
  async putEditStates(editStates: EditState[]): Promise<void> {
    const { records, refused } = savable(
      editStates,
      "edit",
      (editState) => editState.photoId,
      (editState) => ({
        ...editState,
        stack: editState.stack.filter((snapshot) => !this.writable.has(snapshot)),
      }),
    );
    for (const { stack } of records) for (const snapshot of stack) this.writable.add(snapshot);
    for (const { stack } of editStates) forgetStepTexts(stack);
    await this.storeEditStates(records);
    if (refused) throw refused;
  }

  /** putEditStates for the states catalog.json can hold. */
  private async storeEditStates(editStates: EditState[]): Promise<void> {
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

  /** Tell the other windows on this catalogue what this storage wrote, with the
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
      console.warn("[project] a catalogue change could not be sent to the other windows:", error);
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

  /** Start taking on the records other windows write to this catalogue, and answering
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

  /** Take on what arrives while open() builds this copy. Until the catalogue is read,
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

  /** The catalogue has been read: take on what arrived before, in order, as hold does. */
  private holdEarly(): void {
    const early = this.waiting ?? [];
    this.waiting = [];
    for (const records of early) this.hold(records);
  }

  /** Ask the other storages on this catalogue for the changes they hold that the
   *  catalog.json this copy read may lack (answer). */
  private greet(): void {
    broadcast({
      type: "catalog-hello",
      payload: { catalog: this.catalog, origin: this.origin, since: this.listeningSince },
    });
  }

  /** Answer a storage that has just read this catalogue, and it alone (`to`), with
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

  /** The window has left this catalogue: what this copy takes on is no longer
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

  /** Stop taking on other windows' records once the window has left this catalogue
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

  /** Take on records another window wrote to this catalogue, each where it is the
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
   *  is off or the window has left this catalogue. Never sends: every window already
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
    let heldFiles: Set<string> | null = null;
    for (const file of records.removed ?? []) {
      if (this.removed.has(file) || (heldFiles ??= this.heldFiles()).has(file)) continue;
      this.removed.add(file);
      this.removedFiles.set(file, { at: ++this.changes, landed: null });
      changed = true;
    }
    const held = this.photos.size + this.unshown.size + this.edits.size;
    for (const id of records.deletedIds) shown.deletedIds.push(...this.forget(id).shown);
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
   *  build, a photo of a duplicated project whose catalogue key meets this one's.
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

  /** With `lazy` (data a pass can derive again) the save waits BULK_SAVE_DELAY
   *  from the first lazy change, and never pushes back a save already armed. A
   *  normal change replaces a lazy timer and its write carries the lazy changes. */
  private scheduleSave(lazy = false): void {
    this.dirty = true;
    if (lazy) {
      if (!this.saveTimer) {
        this.saveTimer = setTimeout(() => void this.save(), BULK_SAVE_DELAY);
      }
      return;
    }
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
   *  and that write reads the catalogue when it starts. So each caller resolves
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

  /** Never rejects: the save it follows stands either way. The older backups move
   *  down first, the oldest being replaced, so a write that fails part way loses
   *  no backup that was there. */
  private async writeBackup(backup: Blob): Promise<void> {
    try {
      const generations = [BACKUP, ...OLDER_BACKUPS];
      // The same catalogue again would only push an older one out.
      const newest = await readBlobIfThere(this.sl, BACKUP);
      if (newest && newest.size === backup.size && (await newest.text()) === (await backup.text()))
        return;
      for (let i = generations.length - 1; i > 0; i--) {
        const newer = await readBlobIfThere(this.sl, generations[i - 1]);
        if (newer) await writeBlob(this.sl, generations[i], newer);
      }
      await writeBlob(this.sl, BACKUP, backup);
    } catch (error) {
      console.warn("[project] the catalogue couldn't be backed up:", error);
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
      const photos = [...this.photos.values(), ...this.unshown.values()];
      const edits = [...this.edits.values()];
      const changed = this.stampsOf(photos, edits);
      const stamped = Object.keys(changed.photos).length + Object.keys(changed.edits).length > 0;
      const text = catalogText({
        ...this.extra,
        version: 1,
        id: this.catalogId,
        photos,
        edits,
        removed: [...this.removed],
        ...(stamped ? { changed } : {}),
      });
      const file = await this.sl.getFileHandle(CATALOG, { create: true });
      const writable = await file.createWritable();
      await writable.write(text);
      await writable.close();
    } catch (error) {
      this.dirty = true;
      if (unsavedSince !== null) this.noteUnsaved(unsavedSince);
      this.failures++;
      this.lastFailure = saveFailureReason(error);
      console.error("[project] catalogue save failed:", error);
      this.report({ ok: false, reason: this.lastFailure });
      // A catalogue too large to write would fail the same way on every try: the
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
