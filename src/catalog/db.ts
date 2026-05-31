import type { CatalogPhoto, Collection, EditState } from "./types";

const DB_NAME = "safelight-catalog";
const DB_VERSION = 1;

const STORE_PHOTOS = "photos";
const STORE_COLLECTIONS = "collections";
const STORE_EDITS = "edits";

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains(STORE_PHOTOS)) {
        const photos = db.createObjectStore(STORE_PHOTOS, { keyPath: "id" });
        photos.createIndex("dateImported", "dateImported");
        photos.createIndex("dateCreated", "dateCreated");
        photos.createIndex("rating", "rating");
        photos.createIndex("filename", "filename");
        photos.createIndex("colorLabel", "colorLabel");
        photos.createIndex("flag", "flag");
      }

      if (!db.objectStoreNames.contains(STORE_COLLECTIONS)) {
        db.createObjectStore(STORE_COLLECTIONS, { keyPath: "id" });
      }

      if (!db.objectStoreNames.contains(STORE_EDITS)) {
        db.createObjectStore(STORE_EDITS, { keyPath: "photoId" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

let dbInstance: IDBDatabase | null = null;

async function getDB(): Promise<IDBDatabase> {
  if (!dbInstance) {
    dbInstance = await openDB();
  }
  return dbInstance;
}

function txStore(
  db: IDBDatabase,
  store: string,
  mode: IDBTransactionMode,
): IDBObjectStore {
  return db.transaction(store, mode).objectStore(store);
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// thumbnailUrl is a runtime-only object URL (blob:), valid only for the
// document that created it. Never persist it — it would be dangling on reload.
// It is regenerated from thumbnailBlob when the catalog loads.
function forStorage(photo: CatalogPhoto): CatalogPhoto {
  return { ...photo, thumbnailUrl: null };
}

export const catalogDB = {
  async getAllPhotos(): Promise<CatalogPhoto[]> {
    const db = await getDB();
    return requestToPromise(txStore(db, STORE_PHOTOS, "readonly").getAll());
  },

  async getPhoto(id: string): Promise<CatalogPhoto | undefined> {
    const db = await getDB();
    return requestToPromise(txStore(db, STORE_PHOTOS, "readonly").get(id));
  },

  async putPhoto(photo: CatalogPhoto): Promise<void> {
    const db = await getDB();
    await requestToPromise(
      txStore(db, STORE_PHOTOS, "readwrite").put(forStorage(photo)),
    );
  },

  async putPhotos(photos: CatalogPhoto[]): Promise<void> {
    const db = await getDB();
    const tx = db.transaction(STORE_PHOTOS, "readwrite");
    const store = tx.objectStore(STORE_PHOTOS);
    for (const photo of photos) {
      store.put(forStorage(photo));
    }
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  async deletePhoto(id: string): Promise<void> {
    const db = await getDB();
    await requestToPromise(txStore(db, STORE_PHOTOS, "readwrite").delete(id));
  },

  async getAllCollections(): Promise<Collection[]> {
    const db = await getDB();
    return requestToPromise(
      txStore(db, STORE_COLLECTIONS, "readonly").getAll(),
    );
  },

  async putCollection(collection: Collection): Promise<void> {
    const db = await getDB();
    await requestToPromise(
      txStore(db, STORE_COLLECTIONS, "readwrite").put(collection),
    );
  },

  async deleteCollection(id: string): Promise<void> {
    const db = await getDB();
    await requestToPromise(
      txStore(db, STORE_COLLECTIONS, "readwrite").delete(id),
    );
  },

  async getEditState(photoId: string): Promise<EditState | undefined> {
    const db = await getDB();
    return requestToPromise(txStore(db, STORE_EDITS, "readonly").get(photoId));
  },

  async putEditState(editState: EditState): Promise<void> {
    const db = await getDB();
    await requestToPromise(
      txStore(db, STORE_EDITS, "readwrite").put(editState),
    );
  },
};
