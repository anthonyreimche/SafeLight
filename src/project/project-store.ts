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
import { ProjectStorage } from "./project-storage";
import {
  addRecentProject,
  getLastProject,
  recentHandle,
  type RecentProject,
} from "./recent";
import { isNativeFS, nativeDirectoryHandle, pickNativeDirectory } from "./native-fs";
import { scanProject, type FolderNode } from "./scan";
import { visiblePhotos } from "@/modules/library/visible-photos";
import {
  requestThumbnail,
  setThumbnailLoader,
  thumbnailGen,
} from "@/state/thumbnail-loader";

// Best-effort flush of the debounced catalog on quit, so the last edits/imports
// in the final save window aren't lost (incremental saves cover the rest).
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    void catalogStorage().flush?.();
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

// Module-level abort controller for the current import, so stopImport() can
// cancel the expensive decode loop without touching Zustand (AbortController is
// mutable and shouldn't trigger re-renders).
let importAbort: AbortController | null = null;

// Generation counter — bumped on each openProject / closeProject so that an
// in-flight open whose generation no longer matches skips its finalization.
let openGen = 0;

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

interface ProjectState {
  root: FileSystemDirectoryHandle | null;
  name: string;
  tree: FolderNode | null;
  opening: boolean;
  /** New-file import progress for the loading bar. total=0 when not importing. */
  importDone: number;
  importTotal: number;

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
    if (get().opening) return;
    const gen = ++openGen;
    importAbort = new AbortController();
    const signal = importAbort.signal;
    set({ opening: true, importDone: 0, importTotal: 0 });
    // Clear the old catalog immediately so the grid shows photos as they arrive
    // rather than showing the previous folder until the new one is fully loaded.
    useCatalogStore.getState().replaceCatalog([]);
    // Restore the folder this project was last viewing (or null = All Photos for
    // a first/different project). Seed lastPersistedFolder first so the change
    // subscription below doesn't redundantly re-write what we just restored.
    activeProjectKey = handle.name;
    const restoredFolder = restoreActiveFolder(handle.name);
    lastPersistedFolder = restoredFolder;
    useUIStore.getState().setActiveFolder(restoredFolder);
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

      // Phase 1 — paint the grid from the saved catalog the instant it's read,
      // before the disk scan, so skeletons appear with the UI rather than after.
      let painted = false;
      const onSkeletons = (
        storage: ProjectStorage,
        rawCacheDir: FileSystemDirectoryHandle,
        skeletons: CatalogPhoto[],
      ) => {
        if (gen !== openGen) return;
        painted = true;
        setRawCacheDir(rawCacheDir);
        setCatalogStorage(storage);
        set({ root: handle, name: handle.name });
        const thumbGen = setThumbnailLoader((id) => storage.readPreview(id));
        useCatalogStore.getState().finalizeCatalog(skeletons);
        kickThumbnails(skeletons, thumbGen);
      };

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
      buf = []; // discard any stragglers if cancelled
      if (gen !== openGen) return;
      flush(); // drain any photos buffered since the last frame
      setRawCacheDir(opened.rawCacheDir);
      setCatalogStorage(opened.storage);
      set({ root: handle, name: handle.name, tree: opened.tree });
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
      // Background: fill in previews for any records imported without one (decode
      // failed at scan time), updating them in place so they're never re-imported.
      void repairMissingPreviews(opened.photos, (p) =>
        useCatalogStore.getState().updatePhoto(p),
      );
      // Background: pre-decode RAWs so first Develop open is instant. Pass the
      // full set (not just newPhotos) so any RAW left uncached by an interrupted
      // earlier run is filled in now; the per-file check skips ones already done.
      void preDecodeRawsForCache(opened.photos);
    } catch (e) {
      console.error("[project] open failed:", e);
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
    if (get().root) {
      try { void catalogStorage().flush?.(); } catch { /* best effort */ }
    }
    set({ root: null, name: "", tree: null, opening: false, importDone: 0, importTotal: 0 });
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
