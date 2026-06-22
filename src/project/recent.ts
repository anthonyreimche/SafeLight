// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Remembers recently opened project folders for the startup welcome grid.
//
//   • Browser: FileSystemDirectoryHandles are structured-cloneable, so the
//     handle persists in IndexedDB; only its permission resets, which the
//     welcome-card click re-requests.
//   • Electron: we persist the absolute path and rebuild a native handle from
//     it on demand — no permission, no gesture.
//
// Each entry also keeps a small cover preview (the first photo's grid
// thumbnail) so the welcome grid can show folders visually.

import {
  isNativeFS,
  nativeDirectoryHandle,
  nativePathOf,
} from "./native-fs";

const DB_NAME = "safelight-projects";
const STORE = "projects";
const DB_VERSION = 2;
const MAX_RECENT = 24;

// Legacy single-"last" storage (v1), migrated into the list on first read.
const LEGACY_STORE = "recent";
const LEGACY_LS_PATH = "safelight:lastProjectPath";

export interface RecentProject {
  /** Stable key: absolute path (Electron) or folder name (browser). */
  id: string;
  name: string;
  /** Electron absolute path, or null in the browser build. */
  path: string | null;
  /** Browser directory handle, or null in the Electron build. */
  handle: FileSystemDirectoryHandle | null;
  openedAt: number;
  /** First-photo grid preview, used as the welcome card's cover. */
  cover: Blob | null;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE))
        db.createObjectStore(STORE, { keyPath: "id" });
      // Keep the legacy store around for the one-time migration below.
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function getAll(db: IDBDatabase): Promise<RecentProject[]> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result as RecentProject[]);
    req.onerror = () => reject(req.error);
  });
}

function put(db: IDBDatabase, entry: RecentProject): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function addRecentProject(
  handle: FileSystemDirectoryHandle,
  cover: Blob | null,
): Promise<void> {
  const path = nativePathOf(handle);
  const entry: RecentProject = {
    id: path ?? handle.name,
    name: handle.name,
    path,
    // A native (path-backed) handle isn't structured-cloneable and is rebuilt
    // from the path on demand, so don't persist it; browser handles are kept.
    handle: path ? null : handle,
    openedAt: Date.now(),
    cover,
  };
  try {
    const db = await openDB();
    await put(db, entry);
    // Trim the oldest beyond the cap.
    const all = (await getAll(db)).sort((a, b) => b.openedAt - a.openedAt);
    for (const e of all.slice(MAX_RECENT)) await removeRecentProject(e.id);
  } catch {}
}

export async function listRecentProjects(): Promise<RecentProject[]> {
  try {
    const db = await openDB();
    let all = await getAll(db);
    if (all.length === 0) {
      await migrateLegacy(db);
      all = await getAll(db);
    }
    return all.sort((a, b) => b.openedAt - a.openedAt);
  } catch {
    return [];
  }
}

export async function removeRecentProject(id: string): Promise<void> {
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {}
}

/** Rebuild a usable directory handle for a recent entry, or null if neither a
 *  path nor a stored handle is available. */
export function recentHandle(
  entry: RecentProject,
): FileSystemDirectoryHandle | null {
  if (entry.path && isNativeFS()) return nativeDirectoryHandle(entry.path);
  return entry.handle;
}

/** Most-recently-opened project handle. Used by the browser reconnect flow. */
export async function getLastProject(): Promise<FileSystemDirectoryHandle | null> {
  const all = await listRecentProjects();
  return all[0] ? recentHandle(all[0]) : null;
}

// One-time seed of the welcome grid from the old single-"last" storage, so the
// previously-open folder still appears on first launch after the upgrade.
async function migrateLegacy(db: IDBDatabase): Promise<void> {
  try {
    // Electron: an absolute path in localStorage.
    const path = localStorage.getItem(LEGACY_LS_PATH);
    if (path) {
      await put(db, {
        id: path,
        name: path.replace(/[/\\]+$/, "").split(/[/\\]/).pop() || path,
        path,
        handle: null,
        openedAt: Date.now(),
        cover: null,
      });
      return;
    }
    // Browser: a stored handle in the legacy object store.
    if (!db.objectStoreNames.contains(LEGACY_STORE)) return;
    const legacy = await new Promise<{
      name: string;
      handle: FileSystemDirectoryHandle;
      openedAt: number;
    } | undefined>((resolve) => {
      const req = db
        .transaction(LEGACY_STORE, "readonly")
        .objectStore(LEGACY_STORE)
        .get("last");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(undefined);
    });
    if (legacy?.handle) {
      await put(db, {
        id: legacy.name,
        name: legacy.name,
        path: null,
        handle: legacy.handle,
        openedAt: legacy.openedAt ?? Date.now(),
        cover: null,
      });
    }
  } catch {}
}
