// On-open grid-preview loader. The Electron fs bridge serializes reads over one
// IPC channel, so reading every cached preview up front costs the same few
// seconds no matter how it's batched. Instead the grid renders skeletons
// instantly and pulls previews on demand: visible cells request first (in
// order), and a low-priority idle pass fills the rest. Loaded blobs are flushed
// to the catalog store in one batched update per frame to avoid a render storm.

import { useCatalogStore } from "./catalog-store";

type Loader = (id: string) => Promise<Blob | null>;

let loader: Loader | null = null;
let gen = 0;
const queue: string[] = [];
const queued = new Set<string>();
let running = false;
let pending: { id: string; blob: Blob }[] = [];
let flushScheduled = false;

/** Install the preview reader for the just-opened project, clearing any queue
 *  left from a previous folder. Returns a generation token callers can check to
 *  abort a stale background pass after a newer open. */
export function setThumbnailLoader(l: Loader | null): number {
  loader = l;
  queue.length = 0;
  queued.clear();
  pending = [];
  running = false;
  return ++gen;
}

/** The current loader generation (bumped on every setThumbnailLoader). */
export function thumbnailGen(): number {
  return gen;
}

/** Request a photo's grid preview. Deduped; FIFO so previews arrive in request
 *  order (visible cells, mounting top-to-bottom, naturally request in order). */
export function requestThumbnail(id: string): void {
  if (!loader || queued.has(id)) return;
  queued.add(id);
  queue.push(id);
  void pump();
}

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  requestAnimationFrame(() => {
    flushScheduled = false;
    const batch = pending;
    pending = [];
    if (batch.length) useCatalogStore.getState().mergeThumbnails(batch);
  });
}

async function pump(): Promise<void> {
  if (running || !loader) return;
  running = true;
  const myGen = gen; // stop if a newer setThumbnailLoader swaps the project out
  try {
    while (gen === myGen && queue.length) {
      const id = queue.shift()!;
      queued.delete(id);
      let blob: Blob | null = null;
      try {
        blob = await loader(id);
      } catch {
        blob = null;
      }
      if (blob) {
        pending.push({ id, blob });
        scheduleFlush();
      }
    }
  } finally {
    running = false;
  }
}
