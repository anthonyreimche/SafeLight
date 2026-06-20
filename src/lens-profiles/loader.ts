import type { LensfunLens } from "./types";

let cachedDb: LensfunLens[] | null = null;
let loadPromise: Promise<LensfunLens[]> | null = null;

/**
 * Load the Lensfun lens database. Fetches the JSON on first call and caches
 * in memory for subsequent calls. Safe to call multiple times concurrently.
 */
export function loadLensDb(): Promise<LensfunLens[]> {
  if (cachedDb) return Promise.resolve(cachedDb);
  if (loadPromise) return loadPromise;

  loadPromise = fetch(new URL("/data/lens-profiles.json", import.meta.url))
    .then((res) => {
      if (!res.ok) throw new Error(`Failed to load lens database: ${res.status}`);
      return res.json() as Promise<LensfunLens[]>;
    })
    .then((db) => {
      cachedDb = db;
      loadPromise = null;
      return db;
    })
    .catch((err) => {
      loadPromise = null;
      console.warn("Lens profile database unavailable:", err);
      return [] as LensfunLens[];
    });

  return loadPromise;
}

/** Synchronous access to the cached database (null if not yet loaded). */
export function getCachedLensDb(): LensfunLens[] | null {
  return cachedDb;
}
