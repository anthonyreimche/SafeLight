// Remembers the last opened project folder (FileSystemDirectoryHandles are
// structured-cloneable, so they persist in IndexedDB across sessions; only
// their permission resets, which the reconnect flow re-requests).

const DB_NAME = "safelight-projects";
const STORE = "recent";

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
