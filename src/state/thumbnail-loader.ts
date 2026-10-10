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

/** A grid preview as a loader returns it, with the edit it shows. `previewEdit` is
 *  the edit its record named when it was read from the stored copy; one without it,
 *  such as a preview built from the photo's source file, shows none. It rides on
 *  the Blob because the project's reader also hands its result on as a plain Blob. */
export type LoadedPreview = Blob & { readonly previewEdit?: string };

type Loader = (id: string) => Promise<LoadedPreview | null>;

const CONCURRENCY = 3;

let loader: Loader | null = null;
let gen = 0;
// The idle prefill can hold a whole project (tens of thousands of ids), so it is
// consumed through a head index: no shift/splice/indexOf on this array. An id
// the front queue served stays in the array but leaves `queued`, which marks it
// stale for the head to skip.
const queue: string[] = [];
let head = 0;
const queued = new Set<string>();
// Cells on screen (insertion-ordered), served before the prefill.
const front = new Set<string>();
// Previews other windows rewrote (insertion-ordered): served after the cells on
// screen, which a burst of them would otherwise hold up, and before the prefill.
const reloading = new Set<string>();
const inFlight = new Set<string>();
let active = 0;
let pending: { id: string; blob: LoadedPreview }[] = [];
let flushScheduled = false;
// Photos whose next read replaces the preview they show (reloadThumbnail), each
// with the reloads that wait for that read.
const replacing = new Map<string, (() => void)[]>();
// Photos reloaded while a read of theirs ran, which may have read the old preview:
// they are read again once it ends.
const readAgain = new Set<string>();

/** Install the preview reader for the just-opened project, clearing any queue
 *  left from a previous folder. Returns a generation token callers can check to
 *  abort a stale background pass after a newer open. */
export function setThumbnailLoader(l: Loader | null): number {
  loader = l;
  queue.length = 0;
  head = 0;
  queued.clear();
  front.clear();
  reloading.clear();
  // Stale in-flight reads keep their slots until they settle (their results are
  // discarded by the generation guard); clearing the set here lets the new
  // project re-request the same id without being deduped against a stale read.
  inFlight.clear();
  pending = [];
  for (const settled of replacing.values()) for (const settle of settled) settle();
  replacing.clear();
  readAgain.clear();
  return ++gen;
}

/** The current loader generation (bumped on every setThumbnailLoader). */
export function thumbnailGen(): number {
  return gen;
}

/** Request a photo's grid preview. Deduped; FIFO so previews arrive in request
 *  order (visible cells, mounting top-to-bottom, naturally request in order).
 *  `visible` jumps the idle prefill: the id is read as soon as a slot frees, even
 *  if the prefill already holds it. */
export function requestThumbnail(id: string, opts?: { visible?: boolean }): void {
  if (!loader || front.has(id) || inFlight.has(id)) return;
  if (opts?.visible) {
    queued.delete(id);
    reloading.delete(id);
    front.add(id);
  } else {
    if (queued.has(id) || reloading.has(id)) return;
    queued.add(id);
    queue.push(id);
  }
  pump();
}

function nextId(): string | undefined {
  for (const waiting of [front, reloading]) {
    const first = waiting.values().next();
    if (!first.done) {
      waiting.delete(first.value);
      return first.value;
    }
  }
  while (head < queue.length) {
    const id = queue[head++];
    if (queued.delete(id)) return id;
  }
  queue.length = 0;
  head = 0;
  return undefined;
}

/** Re-read one photo's preview from disk (via the installed loader, which reads
 *  <id>.jpg) and replace its in-store thumbnail. Unlike requestThumbnail, this
 *  refreshes a photo that already has a preview — used when another window edited
 *  or turned it. The read takes its turn in the same window of reads, after the
 *  cells on screen and ahead of the idle prefill, so turning hundreds of photos
 *  elsewhere neither reads them all at once nor holds up the grid; reloads of a
 *  photo asked before its read starts share it. Resolves once
 *  the preview is replaced, or the read found nothing or the project changed; at
 *  once with no project. */
export function reloadThumbnail(id: string): Promise<void> {
  if (!loader) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const waiting = replacing.get(id);
    if (waiting) waiting.push(resolve);
    else replacing.set(id, [resolve]);
    if (inFlight.has(id)) {
      readAgain.add(id);
      return;
    }
    queued.delete(id);
    if (!front.has(id)) reloading.add(id);
    pump();
  });
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
  while (loader && active < CONCURRENCY) {
    const id = nextId();
    if (id === undefined) break;
    inFlight.add(id);
    active++;
    const myGen = gen; // stamp so a newer open can disown this read's result
    const read = loader;
    const reloads = replacing.get(id);
    replacing.delete(id);
    void (async () => {
      let blob: LoadedPreview | null = null;
      try {
        blob = await read(id);
      } catch {
        blob = null;
      }
      // A newer open may have swapped the project during the read; its blob must
      // not merge into the new catalog under this id.
      if (!blob || gen !== myGen) return;
      if (reloads) {
        useCatalogStore.getState().replaceThumbnail(id, blob);
        return;
      }
      pending.push({ id, blob });
      scheduleFlush();
    })().finally(() => {
      inFlight.delete(id);
      active--;
      for (const settle of reloads ?? []) settle();
      if (readAgain.delete(id) && gen === myGen) reloading.add(id);
      pump();
    });
  }
}
