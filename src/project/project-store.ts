// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Project state: which folder is open, its folder tree, and the open/reopen
// flows. "Open Folder" is the only way photos enter Safelight — the folder IS
// the catalog, with .safelight/ as its working directory.

import { create } from "zustand";
import type { CatalogPhoto } from "@/catalog/types";
import { catalogStorage, setCatalogStorage } from "@/catalog/storage";
import { verifyPermission } from "@/catalog/permissions";
import { useCatalogStore } from "@/state/catalog-store";
import { useUIStore } from "@/state/ui-store";
import { preDecodeRawsForCache, repairMissingPreviews } from "@/modules/library/import-photos";
import { setRawCacheDir } from "@/raw/raw-cache";
import { warmDecodePool } from "@/raw/decode-pool";
import { detachedModule } from "@/state/detach";
import {
  ProjectStorage,
  flushLeftCopies,
  onSaveStatus,
  type CatalogRecovery,
} from "./project-storage";
import { CatalogDamagedError, CatalogTooNewError, CatalogUnreadableError } from "./catalog-errors";
import { shouldWarmDecodePool } from "./warm-decode";
import { ReadOnlyProjectError } from "./working-dir";
import { getSettings } from "@/state/settings-store";
import {
  addRecentProject,
  getLastProject,
  recentHandle,
  type RecentProject,
} from "./recent";
import { isNativeFS, nativeDirectoryHandle, nativePathOf, pickNativeDirectory } from "./native-fs";
import { scanProject, type FolderNode } from "./scan";
import { visiblePhotos } from "@/modules/library/visible-photos";
import {
  requestThumbnail,
  setThumbnailLoader,
  thumbnailGen,
} from "@/state/thumbnail-loader";

// Best-effort flush of the debounced catalog on quit, so the last edits/imports
// in the final save window aren't lost (incremental saves cover the rest). The
// catalogs this window left go first, so the open one's write is asked for last.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    flushLeftCopies();
    void catalogStorage().flush?.({ unloading: true });
  });
}

// Schedule low-priority work for when the main thread is idle (falls back to a
// short timeout where requestIdleCallback isn't available).
function onIdle(fn: () => void): void {
  const ric = (window as unknown as {
    requestIdleCallback?: (cb: () => void) => void;
  }).requestIdleCallback;
  if (ric) ric(fn);
  else setTimeout(fn, 200);
}

// Spin up the libraw decoder pool at idle, only in a window that decodes RAWs.
// Resolves once it is ready (immediately where it is not wanted), because the
// "Cache all" pre-decode sizes its concurrency from the warmed pool. A failed
// warm-up resolves too: decoding then runs on the pool's fallback size.
function warmDecoding(): Promise<void> {
  if (!shouldWarmDecodePool(detachedModule())) return Promise.resolve();
  return new Promise((resolve) => {
    onIdle(() => void warmDecodePool().then(resolve, resolve));
  });
}

// Module-level abort controller for the current import, so stopImport() can
// cancel the expensive decode loop without touching Zustand (AbortController is
// mutable and shouldn't trigger re-renders).
let importAbort: AbortController | null = null;

// The open project's background passes (preview repair, Cache all pre-decode):
// stopped as the next project starts opening or this one closes, so they read,
// decode and write nothing more for a project the user has left.
let passesAbort: AbortController | null = null;

/** The open project's passes signal, for background work the user starts on it
 *  (Cache all now, Rebuild previews, Reimport): it aborts as the next project
 *  starts opening or this one closes. Undefined with no project open. */
export function projectPassSignal(): AbortSignal | undefined {
  return passesAbort?.signal;
}

// Generation counter — bumped on each openProject / closeProject so that an
// in-flight open whose generation no longer matches skips its finalization.
let openGen = 0;

// The save of the catalog the window last left. The next open waits for it to
// settle before reading catalog.json, as reopening that folder must find the save
// there; a failed save holds up no open.
let leftCatalogSaved: Promise<void> = Promise.resolve();

/** The name of the project each catalog the window left belonged to. */
const leftProjects = new WeakMap<object, string>();

/** Leave the installed catalog: save what it holds, and close it (setCatalogStorage)
 *  so it takes no more changes. */
function leaveCatalog(): void {
  const storage = catalogStorage();
  leftProjects.set(storage, useProjectStore.getState().name);
  const saving = storage.flush?.();
  if (saving) leftCatalogSaved = saving.catch(() => {});
  setCatalogStorage(null);
}

let hearingSaves = false;

/** Show why the open project's catalog saves fail (saveError). A catalog the window
 *  has left keeps saving for a while, unshown, and only tells this window if it
 *  gives up (storageNotice). Started by the first open, not as this module loads:
 *  project-storage reaches this module through its own imports, so it may not
 *  have loaded yet. */
function hearSaves(): void {
  if (hearingSaves) return;
  hearingSaves = true;
  onSaveStatus((status, storage) => {
    if (storage !== catalogStorage()) {
      const name = leftProjects.get(storage);
      if (!status.ok && status.gaveUp && name)
        useProjectStore.setState({
          storageNotice:
            `Safelight couldn't save your last changes to “${name}” after you left it ` +
            `(${status.reason}). If “${name}” is open in another Safelight window, that ` +
            `window saves them.`,
        });
      return;
    }
    useProjectStore.setState({
      saveError: status.ok ? null : `Couldn't save the catalog: ${status.reason}`,
    });
  });
}

// Per-project persistence of the selected library folder, so a folder filter
// (and its non-recursive scope) survives an app restart — openProject runs on
// every launch via openLast and would otherwise reset the view to All Photos.
// Keyed by project so a different project never inherits a stale folder path.
const FOLDER_KEY = "sl_active_folder_v1";
let activeProjectKey = "";
let lastPersistedFolder: string | null | undefined;

function persistActiveFolder(folder: string | null): void {
  if (!activeProjectKey) return;
  try {
    localStorage.setItem(
      FOLDER_KEY,
      JSON.stringify({ project: activeProjectKey, folder }),
    );
  } catch {}
}

function restoreActiveFolder(project: string): string | null {
  try {
    const raw = localStorage.getItem(FOLDER_KEY);
    if (raw) {
      const v = JSON.parse(raw) as { project?: string; folder?: string | null };
      if (v && v.project === project) return v.folder ?? null;
    }
  } catch {}
  return null;
}

/** Turn an open failure into a verbose, actionable message for the error banner.
 *  The motivating case is a read-only source folder (a memory card) where the
 *  old code only console.error'd and left an unexplained empty library. */
function describeOpenError(e: unknown, folderName: string): string {
  if (e instanceof ReadOnlyProjectError) {
    if (e.redirectFailed) {
      const reason = e.cause instanceof Error ? ` (${e.cause.message})` : "";
      return (
        `Couldn't open “${folderName}”: Safelight couldn't write to the catalog ` +
        `storage location${reason}. Choose a writeable folder under Preferences ▸ ` +
        `Previews ▸ “Separate catalog location”, then try again.`
      );
    }
    return (
      `Couldn't open “${folderName}”. This folder is read-only, so Safelight ` +
      `can't create its .safelight working folder here. Use the desktop app ` +
      `(which stores the catalog in a writeable location automatically), or ` +
      `open a writeable copy of the folder.`
    );
  }
  if (e instanceof CatalogUnreadableError)
    return (
      `Couldn't open “${folderName}”: its catalog can't be read right now (${e.reason}). ` +
      `A sync or antivirus program may be using it. Nothing was changed. Try again in a moment.`
    );
  if (e instanceof CatalogDamagedError)
    return (
      `Couldn't open “${folderName}”: its catalog is damaged and Safelight couldn't keep ` +
      `a copy of it (${e.reason}). Nothing was changed.`
    );
  if (e instanceof CatalogTooNewError)
    return (
      `“${folderName}” was saved by a newer version of Safelight. Update Safelight to ` +
      `open it. Nothing was changed.`
    );
  const msg = e instanceof Error ? e.message : String(e);
  return `Couldn't open “${folderName}”: ${msg}`;
}

/** Tell the user how a catalog that couldn't be used as saved was recovered. */
function describeRecovery(recovered: CatalogRecovery, folderName: string): string {
  const how =
    recovered.from === "backup"
      ? `The catalog of “${folderName}” couldn't be used, so Safelight restored it from ` +
        `its backup. Changes made since that backup may be missing.`
      : `The catalog of “${folderName}” couldn't be used and had no usable backup, so ` +
        `Safelight imported the folder again. Earlier ratings and edits could not be ` +
        `recovered.`;
  if (!recovered.kept) return how;
  return `${how} The damaged file was kept next to the catalog as ${recovered.kept}.`;
}

interface ProjectState {
  root: FileSystemDirectoryHandle | null;
  name: string;
  tree: FolderNode | null;
  opening: boolean;
  /** New-file import progress for the loading bar. total=0 when not importing. */
  importDone: number;
  importTotal: number;

  /** Blocking message shown when opening a folder failed (e.g. it's read-only
   *  and no writeable catalog location could be established). null = no error. */
  openError: string | null;
  /** Whether openError is about a folder Safelight can't write to, which a
   *  separate catalog location in Preferences can fix. */
  openErrorReadOnly: boolean;
  /** Non-blocking notice shown when a read-only folder's catalog was redirected
   *  to a writeable location, so the user knows where their data lives. */
  storageNotice: string | null;
  /** Why the open project's last catalog save failed, while its saves keep
   *  failing (the storage tries again by itself). null = the last save landed. */
  saveError: string | null;
  /** Dismiss the current open error / storage notice banners. */
  dismissOpenError: () => void;
  dismissStorageNotice: () => void;

  /** Folder picker → open as project. Must run within a user gesture. */
  openProjectPicker: () => Promise<void>;
  openProject: (handle: FileSystemDirectoryHandle) => Promise<void>;
  /** Open a folder chosen from the welcome grid. Re-grants permission inside
   *  the click gesture (browser), then opens via the normal openProject path. */
  openRecent: (entry: RecentProject) => Promise<void>;
  /** Reopen the last project if its permission survived; otherwise flag the
   *  reconnect flow (re-granting needs a user gesture). */
  openLast: () => Promise<void>;
  /** Called from the reconnect button: re-request permission, then open. */
  reconnectLast: () => Promise<boolean>;
  /** Cancel an in-progress import. Already-imported photos are kept; the rest
   *  will be picked up on the next folder open. */
  stopImport: () => void;
  /** Close the current project and return to the welcome screen. */
  closeProject: () => void;
  /** Re-walk the open folder and refresh the tree (after a folder op on disk).
   *  Cheap: lists directories only, never re-decodes photos. */
  refreshTree: () => Promise<void>;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  root: null,
  name: "",
  tree: null,
  opening: false,
  importDone: 0,
  importTotal: 0,
  openError: null,
  openErrorReadOnly: false,
  storageNotice: null,
  saveError: null,
  dismissOpenError: () => set({ openError: null }),
  dismissStorageNotice: () => set({ storageNotice: null }),

  async openProjectPicker() {
    // Electron: native folder picker → absolute path → path-backed handle, so
    // the folder reconnects on next launch without a permission gesture.
    if (isNativeFS()) {
      const path = await pickNativeDirectory();
      if (!path) return; // user cancelled
      await get().openProject(nativeDirectoryHandle(path));
      return;
    }
    let handle: FileSystemDirectoryHandle;
    try {
      handle = await window.showDirectoryPicker({
        mode: "readwrite",
        id: "safelight-project",
      });
    } catch {
      return; // user cancelled
    }
    await get().openProject(handle);
  },

  async openProject(handle) {
    hearSaves();
    if (get().opening) return;
    // The project being left is saved and takes no more changes. Until the new
    // one's catalog is read, a change has no catalog to go into.
    leaveCatalog();
    const gen = ++openGen;
    importAbort = new AbortController();
    const signal = importAbort.signal;
    passesAbort?.abort();
    passesAbort = new AbortController();
    const passes = passesAbort.signal;
    // The tree goes with the project: folder actions resolve its paths against
    // the root, which the new project takes once its catalog is read.
    set({
      opening: true,
      importDone: 0,
      importTotal: 0,
      openError: null,
      openErrorReadOnly: false,
      storageNotice: null,
      saveError: null,
      tree: null,
    });
    // Clear the old catalog immediately so the grid shows photos as they arrive
    // rather than showing the previous folder until the new one is fully loaded.
    useCatalogStore.getState().replaceCatalog([]);
    // Restore the folder this project was last viewing (or null = All Photos for
    // a first/different project). Seed lastPersistedFolder first so the change
    // subscription below doesn't redundantly re-write what we just restored.
    activeProjectKey = nativePathOf(handle) ?? handle.name;
    const restoredFolder = restoreActiveFolder(activeProjectKey);
    lastPersistedFolder = restoredFolder;
    useUIStore.getState().setActiveFolder(restoredFolder);
    // Started when this project's storage is installed, once its catalog is read
    // (onSkeletons).
    let decoderWarm: Promise<void> | null = null;
    const warmOnce = () => (decoderWarm ??= warmDecoding());
    try {
      // Buffer streamed (newly-decoded) photos and flush once per frame, so a
      // large import appends in a few batches instead of one re-render per photo.
      let buf: CatalogPhoto[] = [];
      let scheduled = false;
      const flush = () => {
        scheduled = false;
        if (buf.length === 0) return;
        useCatalogStore.getState().appendPhotos(buf);
        buf = [];
      };

      // Queue cached previews for loading: visible cells request first (via the
      // Thumbnail IntersectionObserver); when idle, enqueue the rest in view order.
      const kickThumbnails = (photos: CatalogPhoto[], thumbGen: number) => {
        const ui = useUIStore.getState();
        const toLoad = photos.filter((p) => !p.thumbnailUrl);
        const inView = visiblePhotos(
          toLoad,
          ui.filter,
          ui.sortField,
          ui.sortDirection,
          ui.activeFolder,
        );
        const seen = new Set(inView.map((p) => p.id));
        const ordered = [...inView, ...toLoad.filter((p) => !seen.has(p.id))];
        onIdle(() => {
          if (thumbnailGen() !== thumbGen) return; // a newer folder was opened
          for (const p of ordered) requestThumbnail(p.id);
        });
      };

      // Phase 1 — the instant the catalog is read, before the disk scan: install
      // this project's storage, a first import's too, so every change from now on
      // is stored in it, and paint the grid from the saved photos, so skeletons
      // appear with the UI rather than after.
      let painted = false;
      const onSkeletons = (
        storage: ProjectStorage,
        rawCacheDir: FileSystemDirectoryHandle,
        skeletons: CatalogPhoto[],
      ) => {
        if (gen !== openGen) return;
        painted = skeletons.length > 0;
        setRawCacheDir(rawCacheDir);
        setCatalogStorage(storage);
        set({ root: handle, name: handle.name });
        const thumbGen = setThumbnailLoader((id) => storage.readPreview(id));
        if (painted) {
          useCatalogStore.getState().finalizeCatalog(skeletons);
          kickThumbnails(skeletons, thumbGen);
        }
        warmOnce();
      };

      await leftCatalogSaved;
      const opened = await ProjectStorage.open(
        handle,
        (photo) => {
          if (gen !== openGen) return;
          buf.push(photo);
          if (!scheduled) {
            scheduled = true;
            requestAnimationFrame(flush);
          }
        },
        onSkeletons,
        (done, total) => {
          if (gen === openGen) set({ importDone: done, importTotal: total });
        },
        signal,
      );
      if (gen !== openGen) {
        buf = []; // discard any stragglers if cancelled
        opened.storage.close(); // no window shows it, so it stops following the others
        return;
      }
      flush(); // drain any photos buffered since the last frame
      // The storage, raw cache and name went in once the catalog was read
      // (onSkeletons); the folder tree is known only now.
      set({ tree: opened.tree });
      const notices: string[] = [];
      if (opened.recovered) notices.push(describeRecovery(opened.recovered, handle.name));
      // The catalog/previews/cache landed in a separate location (a read-only
      // source can't host its own .safelight). Tell the user where their data
      // lives. In explicit "external" mode this is expected, so stay quiet there.
      if (
        opened.storageLocation === "external" &&
        getSettings().catalogLocation !== "external"
      ) {
        notices.push(
          `“${handle.name}” can't store its Safelight catalog in the folder ` +
            `itself, so its catalog, previews and cache are kept at ` +
            `${opened.externalPath}. Edits and ratings are saved there.`,
        );
      } else if (opened.promotedFromExternal) {
        // The folder is writeable again; edits made while it was read-only have
        // been folded back into its in-folder catalog and the separate copy
        // retired. The pre-merge catalog is kept under its own name, which no
        // session's backup writes over (working-dir.ts).
        notices.push(
          `Edits you made to “${handle.name}” while it was read-only have been ` +
            `merged back into its catalog. The catalog from before the merge was kept ` +
            `in .safelight as catalog.before-merge- followed by the date and time, in ` +
            `case you need it.`,
        );
      }
      if (notices.length > 0) set({ storageNotice: notices.join(" ") });
      // Phase 2 — the scan finished: attach handles, add new, drop removed. If we
      // painted skeletons, reconcile (keeps already-loaded previews); otherwise
      // (first import / no cache) finalize and kick off loading normally.
      if (painted) {
        useCatalogStore.getState().reconcileCatalog(opened.photos);
      } else {
        const thumbGen = setThumbnailLoader((id) => opened.storage.readPreview(id));
        useCatalogStore.getState().finalizeCatalog(opened.photos);
        kickThumbnails(opened.photos, thumbGen);
      }
      // Remember this folder for the welcome grid, with the first photo's grid
      // preview as the card cover. Reattached photos load previews lazily, so
      // fall back to reading the cover off disk when no blob is in memory yet.
      const first = opened.photos[0];
      const cover = first
        ? first.thumbnailBlob ?? (await opened.storage.readPreview(first.id))
        : null;
      if (gen !== openGen) return;
      await addRecentProject(handle, cover);
      // Persist the final import state now (don't rely on the debounced save or
      // the best-effort beforeunload flush, which can be cut short on app quit),
      // so newly-imported records survive even an immediate close.
      // AWAIT it: the background pre-decode below now runs several files in
      // parallel and saturates disk/CPU; a fire-and-forget catalog write could
      // lose that race and never land, re-importing everything on the next open.
      // Flushing first guarantees catalog.json is durable before any heavy work.
      await catalogStorage().flush?.();
      // A popped-out window shows the main window's project; that one runs them.
      if (detachedModule() === null) {
        // Background: fill in previews for any records imported without one (decode
        // failed at scan time), updating them in place so they're never re-imported.
        void repairMissingPreviews(
          opened.photos,
          (p, change) => useCatalogStore.getState().mergeRebuiltPhoto(p.id, change),
          passes,
        );
        // Background: pre-decode RAWs so first Develop open is instant. Pass the
        // full set (not just newPhotos) so any RAW left uncached by an interrupted
        // earlier run is filled in now; the per-file check skips ones already done.
        // The warm-up can outlast this project: one left meanwhile starts no pass.
        void warmOnce().then(() => {
          if (!passes.aborted) return preDecodeRawsForCache(opened.photos, { signal: passes });
        });
      }
    } catch (e) {
      console.error("[project] open failed:", e);
      // The grid was cleared when the open began; no project stays named over it,
      // nor takes the changes made from here, nor runs passes for it.
      if (gen === openGen) {
        setCatalogStorage(null);
        passesAbort?.abort();
        passesAbort = null;
        set({
          openError: describeOpenError(e, handle.name),
          openErrorReadOnly: e instanceof ReadOnlyProjectError,
          saveError: null,
          root: null,
          tree: null,
        });
      }
    } finally {
      if (gen === openGen) {
        importAbort = null;
        set({ opening: false, importDone: 0, importTotal: 0 });
      }
    }
  },

  async openRecent(entry) {
    const handle = recentHandle(entry);
    if (!handle) return;
    // Native handles have no permission API (verifyPermission treats them as
    // readable); browser handles re-prompt here, which is allowed because this
    // runs inside the card's click gesture.
    if (await verifyPermission(handle, true, "readwrite")) {
      await get().openProject(handle);
    } else {
      useCatalogStore.setState({ needsReconnect: true });
      set({ name: handle.name });
    }
  },

  async openLast() {
    const handle = await getLastProject();
    if (!handle) return;
    // Re-verify silently; readwrite is needed for the .safelight/ cache.
    if (await verifyPermission(handle, false, "readwrite")) {
      await get().openProject(handle);
    } else {
      useCatalogStore.setState({ needsReconnect: true });
      set({ name: handle.name });
    }
  },

  async reconnectLast() {
    const handle = await getLastProject();
    if (!handle) return false;
    if (!(await verifyPermission(handle, true, "readwrite"))) return false;
    await get().openProject(handle);
    return true;
  },

  stopImport() {
    importAbort?.abort();
  },

  closeProject() {
    ++openGen;
    importAbort?.abort();
    importAbort = null;
    passesAbort?.abort();
    passesAbort = null;
    leaveCatalog();
    set({
      root: null,
      name: "",
      tree: null,
      opening: false,
      importDone: 0,
      importTotal: 0,
      saveError: null,
    });
    useCatalogStore.getState().replaceCatalog([]);
    activeProjectKey = ""; // stop persisting folder changes under the closed project
  },

  async refreshTree() {
    const root = get().root;
    if (!root) return;
    const { tree } = await scanProject(root);
    set({ tree });
  },
}));

// Mirror folder-selection changes to localStorage (debounced by value) so the
// choice persists across restarts. Registered once, after the store exists; the
// value guard keeps unrelated UI-store updates (sort, filter, grid size) cheap.
useUIStore.subscribe((s) => {
  if (s.activeFolder !== lastPersistedFolder) {
    lastPersistedFolder = s.activeFolder;
    persistActiveFolder(s.activeFolder);
  }
});
