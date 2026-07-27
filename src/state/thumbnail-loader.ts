// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

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
let runningGen = -1;
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

/** Re-read one photo's preview from disk (via the installed loader, which reads
 *  <id>.jpg) and replace its in-store thumbnail. Unlike requestThumbnail, this
 *  refreshes a photo that already has a preview — used when another window edited
 *  it. No-op if no project/loader is active. */
export async function reloadThumbnail(id: string): Promise<void> {
  if (!loader) return;
  const myGen = gen;
  let blob: Blob | null = null;
  try {
    blob = await loader(id);
  } catch {
    blob = null;
  }
  // Bail if the project was swapped out while reading, or the read found nothing.
  if (!blob || gen !== myGen) return;
  useCatalogStore.getState().replaceThumbnail(id, blob);
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
  runningGen = myGen;
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
      // A newer open may have swapped the project during the read; its blob must
      // not merge into the new catalog under this id.
      if (blob && gen === myGen) {
        pending.push({ id, blob });
        scheduleFlush();
      }
    }
  } finally {
    // Only release if a newer pump hasn't already taken over. A newer open may
    // have queued its own requests behind this stale pump; drain them.
    if (runningGen === myGen) {
      running = false;
      if (queue.length) void pump();
    }
  }
}
