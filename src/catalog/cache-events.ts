// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A RAW cache entry rewritten with its decoded size and centre sample
// (cache-fill.ts), announced for a view that still holds the photo from the
// entry as it was before. Its own module, importing types only, so the cache
// work and the Develop view can share it without a cycle.

import type { CatalogPhoto } from "./types";
import type { StoredSample } from "@/rendering/source-sample";

export interface FilledEntry {
  photo: CatalogPhoto;
  /** The decoded frame's size, upright, as the entry records it. */
  fullWidth: number;
  fullHeight: number;
  /** The frame's native centre (source-sample.ts), cut on demand. Call it
   *  during the listener: the decode is let go once the listeners return. */
  cutSample(): StoredSample;
}

type Listener = (entry: FilledEntry) => void;

const listeners = new Set<Listener>();

/** Listen for filled entries; the returned function stops listening. */
export function onCacheEntryFilled(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitCacheEntryFilled(entry: FilledEntry): void {
  for (const listener of [...listeners]) {
    try {
      listener(entry);
    } catch (err) {
      // A view's failure must not fail the cache work that announced the entry.
      console.warn("[cache] filled-entry listener failed:", err);
    }
  }
}
