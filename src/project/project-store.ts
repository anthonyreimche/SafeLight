// Project state: which folder is open, its folder tree, and the open/reopen
// flows. "Open Folder" is the only way photos enter Safelight — the folder IS
// the catalog, with .safelight/ as its working directory.

import { create } from "zustand";
import { setCatalogStorage } from "@/catalog/storage";
import { verifyPermission } from "@/catalog/permissions";
import { useCatalogStore } from "@/state/catalog-store";
import { useUIStore } from "@/state/ui-store";
import { preDecodeRawsForCache } from "@/modules/library/import-photos";
import { setRawCacheDir } from "@/raw/raw-cache";
import { ProjectStorage } from "./project-storage";
import { getLastProject, saveLastProject } from "./recent";
import type { FolderNode } from "./scan";

interface ProjectState {
  root: FileSystemDirectoryHandle | null;
  name: string;
  tree: FolderNode | null;
  opening: boolean;

  /** Folder picker → open as project. Must run within a user gesture. */
  openProjectPicker: () => Promise<void>;
  openProject: (handle: FileSystemDirectoryHandle) => Promise<void>;
  /** Reopen the last project if its permission survived; otherwise flag the
   *  reconnect flow (re-granting needs a user gesture). */
  openLast: () => Promise<void>;
  /** Called from the reconnect button: re-request permission, then open. */
  reconnectLast: () => Promise<boolean>;
}

export const useProjectStore = create<ProjectState>((set, get) => ({
  root: null,
  name: "",
  tree: null,
  opening: false,

  async openProjectPicker() {
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
    set({ opening: true });
    try {
      const opened = await ProjectStorage.open(handle);
      setRawCacheDir(opened.rawCacheDir);
      setCatalogStorage(opened.storage);
      set({ root: handle, name: handle.name, tree: opened.tree });
      useUIStore.getState().setActiveFolder(null);
      useCatalogStore.getState().replaceCatalog(opened.photos);
      await saveLastProject(handle);
      // Background: pre-decode new RAWs so first Develop open is instant.
      void preDecodeRawsForCache(opened.newPhotos);
    } catch (e) {
      console.error("[project] open failed:", e);
    } finally {
      set({ opening: false });
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
}));
