// Remembers the last opened project folder.
//
//   • Browser: FileSystemDirectoryHandles are structured-cloneable, so they
//     persist in IndexedDB; only their permission resets, which the reconnect
//     flow re-requests on a click.
//   • Electron: we persist the absolute path in localStorage and rebuild a
//     native handle from it on launch — no permission, no gesture, reconnects
//     automatically.

import {
  isNativeFS,
  nativeDirectoryHandle,
  nativePathOf,
} from "./native-fs";

const DB_NAME = "safelight-projects";
const STORE = "recent";
const LS_PATH = "safelight:lastProjectPath";

interface RecentProject {
  key: "last";
  name: string;
  handle: FileSystemDirectoryHandle;
  openedAt: number;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE))
        req.result.createObjectStore(STORE, { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveLastProject(
  handle: FileSystemDirectoryHandle,
): Promise<void> {
  // Electron: a native handle carries its absolute path — persist that instead.
  const path = nativePathOf(handle);
  if (path) {
    try {
      localStorage.setItem(LS_PATH, path);
    } catch {}
    return;
  }
  try {
    const db = await openDB();
    const entry: RecentProject = {
      key: "last",
      name: handle.name,
      handle,
      openedAt: Date.now(),
    };
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch {}
}

export async function getLastProject(): Promise<FileSystemDirectoryHandle | null> {
  // Electron: rebuild a native handle from the saved path (no permission needed).
  if (isNativeFS()) {
    const path = localStorage.getItem(LS_PATH);
    return path ? nativeDirectoryHandle(path) : null;
  }
  try {
    const db = await openDB();
    const entry = await new Promise<RecentProject | undefined>(
      (resolve, reject) => {
        const req = db.transaction(STORE, "readonly").objectStore(STORE).get("last");
        req.onsuccess = () => resolve(req.result as RecentProject | undefined);
        req.onerror = () => reject(req.error);
      },
    );
    return entry?.handle ?? null;
  } catch {
    return null;
  }
}
