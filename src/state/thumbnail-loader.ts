// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// On-open grid-preview loader. The grid renders skeletons instantly and pulls
// previews on demand: visible cells request first (in order), and a low-priority
// idle pass fills the rest. A small window of reads runs concurrently — async
// fs IPC handlers overlap in the main process (libuv pool), so a few in-flight
// reads hide per-read round-trip latency without flooding it. Loaded blobs are
// flushed to the catalog store in one batched update per frame to avoid a
// render storm.

import { useCatalogStore } from "./catalog-store";

type Loader = (id: string) => Promise<Blob | null>;

const CONCURRENCY = 3;

let loader: Loader | null = null;
let gen = 0;
const queue: string[] = [];
const queued = new Set<string>();
const inFlight = new Set<string>();
let active = 0;
let pending: { id: string; blob: Blob }[] = [];
let flushScheduled = false;

/** Install the preview reader for the just-opened project, clearing any queue
 *  left from a previous folder. Returns a generation token callers can check to
 *  abort a stale background pass after a newer open. */
export function setThumbnailLoader(l: Loader | null): number {
  loader = l;
  queue.length = 0;
  queued.clear();
  // Stale in-flight reads keep their slots until they settle (their results are
  // discarded by the generation guard); clearing the set here lets the new
  // project re-request the same id without being deduped against a stale read.
  inFlight.clear();
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
  if (!loader || queued.has(id) || inFlight.has(id)) return;
  queued.add(id);
  queue.push(id);
  pump();
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

function pump(): void {
  while (loader && active < CONCURRENCY && queue.length) {
    const id = queue.shift()!;
    queued.delete(id);
    inFlight.add(id);
    active++;
    const myGen = gen; // stamp so a newer open can disown this read's result
    const read = loader;
    void (async () => {
      let blob: Blob | null = null;
      try {
        blob = await read(id);
      } catch {
        blob = null;
      }
      // A newer open may have swapped the project during the read; its blob must
      // not merge into the new catalog under this id.
      if (blob && gen === myGen) {
        pending.push({ id, blob });
        scheduleFlush();
      }
    })().finally(() => {
      inFlight.delete(id);
      active--;
      pump();
    });
  }
}
