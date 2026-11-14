// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The automatic pass that pre-decodes RAWs into the develop-preview cache.

import type { CatalogPhoto } from "@/catalog/types";
import { fillCacheEntry } from "@/catalog/cache-fill";
import { isRawFile } from "@/raw/raw-preview";
import { decodePoolSize, warmDecodePool } from "@/raw/decode-pool";
import { cacheListing, rawCacheGeneration } from "@/raw/raw-cache";
import { photoCacheKey } from "@/raw/photo-cache-key";
import { getSettings } from "@/state/settings-store";
import { useCatalogStore } from "@/state/catalog-store";

/**
 * The most photos the automatic cache pass takes on. Filling the cache costs
 * about 2.3 s of decode and 43 MB of storage per photo (36 MB of preview,
 * measured 2026-10-18 on 24 MP NEFs, and 6 to 8 MB of centre sample since
 * 3.1.0), so 1,000 photos is some 40 minutes and 43 GB. A project that needs
 * more than that is left to the caching Develop does as photos are opened;
 * "Cache all now" still caches every photo.
 */
export const EAGER_CACHE_LIMIT = 1000;

/** Refused writes in a row after which a pass gives up on the cache: a full
 *  disk or storage quota would otherwise cost a decode per photo for nothing. */
const REFUSED_WRITES_BEFORE_GIVING_UP = 3;

/**
 * Pre-decode RAW files and write them to the develop-preview cache
 * (.safelight/raw/ in the open project) so the first Develop open is instant
 * instead of waiting for libraw.
 *
 * Decode-once, cheaply: the cache directory is listed ONCE up front, and any
 * photo whose cache key is already present is skipped without touching its file
 * (so is one with a marker that the decoder can't use it; see raw-cache.ts). An
 * entry from before 3.1.0 is rewritten after the photos with no entry, when the
 * whole list fits EAGER_CACHE_LIMIT. The key is derived from the catalogue record (relPath + fileSize), so deciding
 * what to skip needs no getFile — which matters because in Electron getFile()
 * reads the whole RAW off disk. So reopening a fully-cached project (this session
 * or a future one) reads one directory listing and decodes nothing. Only files
 * missing from the cache are opened and decoded, and each write lands in the same
 * directory, so an interrupted run just resumes with the remainder next time.
 *
 * Runs as a small bounded pool (a few files at once) so the cache fills several
 * times faster than the old one-at-a-time loop — which is what makes the FIRST
 * Develop open hit a warm cache instead of racing a slow sequential walk. Each
 * libraw decode runs in its own Web Worker, so concurrency genuinely uses extra
 * cores; the pool is capped to keep memory/CPU sane while the user browses.
 * The automatic pass skips a project that needs more than EAGER_CACHE_LIMIT
 * photos cached, and any pass stops once the cache refuses writes in a row.
 * Fire and forget.
 */
export async function preDecodeRawsForCache(
  photos: CatalogPhoto[],
  opts?: {
    force?: boolean;
    onProgress?: (done: number, total: number) => void;
    /** The project's: once the user leaves it, the pass reads and writes no more. */
    signal?: AbortSignal;
  },
): Promise<void> {
  const s = getSettings();
  // Master switch off → never write the cache, even for a forced "Cache all now".
  if (!s.rawCacheEnabled) return;
  // "As needed" mode skips the background pass (only opened photos get cached),
  // unless the user explicitly asked to cache everything now.
  if (!opts?.force && !s.rawCachePrefetch) return;
  const signal = opts?.signal;
  if (signal?.aborted) return;

  // Writes land only in the cache folder of the project the pass began in.
  const generation = rawCacheGeneration();
  const { done: settled, stale } = await cacheListing(); // one directory listing
  // A cached decode is served without libraw, so Develop takes the as-shot white
  // balance from the photo's record alone: a RAW whose import left it pending, as
  // the catalogue holds the photo now, waits for a later pass.
  const pending = new Set(
    useCatalogStore
      .getState()
      .photos.flatMap((p) => (p.metadataPending ? [p.id] : [])),
  );
  const keyOf = (p: CatalogPhoto) => photoCacheKey(p);
  const candidates = photos.filter(
    (p) => p.fileHandle && !pending.has(p.id) && isRawFile({ name: p.filename } as File),
  );
  const missing = candidates.filter((p) => !settled.has(keyOf(p)) && !stale.has(keyOf(p)));
  if (!opts?.force && missing.length > EAGER_CACHE_LIMIT) {
    console.info(
      `[cache] ${missing.length} photos need caching, more than the ${EAGER_CACHE_LIMIT} ` +
        `the automatic pass takes on: they cache as they are opened`,
    );
    return;
  }
  // Entries from before 3.1.0 still serve, so they wait behind the photos with
  // no entry and are taken only when the whole list fits the limit; the rest
  // complete as their photos are opened, or all at once with "Cache all now".
  const old = candidates.filter((p) => stale.has(keyOf(p)));
  const takeOld = opts?.force || missing.length + old.length <= EAGER_CACHE_LIMIT;
  if (!takeOld && old.length > 0) {
    console.info(
      `[cache] ${old.length} entries from an earlier version are left to complete as ` +
        `their photos are opened`,
    );
  }
  const todo = takeOld ? [...missing, ...old] : missing;
  opts?.onProgress?.(0, todo.length);
  if (todo.length === 0) return;
  let done = 0;
  let refusedInARow = 0;
  let giveUp = false;
  // Sized by the pool below, which "Cache all now" can reach before it warms up.
  await warmDecodePool();

  const decodeOne = async (photo: CatalogPhoto): Promise<void> => {
    try {
      const result = await fillCacheEntry(photo, generation, signal);
      if (result === "taken") {
        refusedInARow = 0;
      } else if (result === "refused" && ++refusedInARow >= REFUSED_WRITES_BEFORE_GIVING_UP && !giveUp) {
        giveUp = true;
        console.warn(
          `[cache] ${refusedInARow} writes in a row were refused (the disk or the ` +
            `storage quota may be full); the rest are left to cache as they are opened`,
        );
      }
    } catch {
      // A single decode failure shouldn't stop the rest.
    } finally {
      opts?.onProgress?.(++done, todo.length);
    }
  };

  // Bounded concurrency: one fewer than the persistent decode pool (default 3),
  // whose last instance background work never gets (see decode-pool.ts); one
  // more decode would only hold its file's bytes while it waited. Each full-res
  // float decode holds ~380 MB, but the pool caps total instances so memory
  // stays bounded. Workers yield between files for the UI thread.
  const limit = Math.min(Math.max(1, decodePoolSize() - 1), todo.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < todo.length && !signal?.aborted && !giveUp) {
      const photo = todo[next++];
      await decodeOne(photo);
      await new Promise<void>((res) => setTimeout(res, 0)); // yield to UI
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, todo.length) }, () => worker()),
  );
}
