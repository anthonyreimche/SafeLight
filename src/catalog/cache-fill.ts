// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// One photo's unit of work for the RAW cache: decode it as background work,
// judge the decode as Develop's open does, and write the entry (raw-cache.ts).
// The cache pass (import-photos.ts) runs it over a project; Develop runs it
// behind an open served from an entry written before 3.1.0, which lacks the
// decoded size and the centre sample the entry now keeps (cache-encode.ts).
// Each entry written is announced (cache-events.ts), so a view holding the
// photo from the entry as it was takes the decoded size and the sample at once.

import type { CatalogPhoto } from "./types";
import { normalizeRotation, orientationToRotation, rotateFloatRGBA } from "./orient";
import { decodeRawToFloat } from "@/raw/decode";
import { acceptDecode } from "@/raw/accept-decode";
import { extractRawPreview } from "@/modules/library/raw-preview";
import { markDecode, rawCacheGeneration, rawCacheKey, writeCachedPreview } from "@/raw/raw-cache";
import { cutSourceSample } from "@/rendering/source-sample";
import { rememberLearned, hasCameraMatch, learnedMatch } from "./decode-learned";
import { emitCacheEntryFilled } from "./cache-events";

/** "refused": a write the cache could not take (the disk or the quota is full),
 *  which a pass counts to know when to stop. "nothing": a failed or rejected
 *  decode (marked as the pass marks them), an abandoned one, or a photo without
 *  a file. */
export type CacheFillResult = "taken" | "refused" | "nothing";

/** Decode the photo and write its cache entry, or mark what the decode showed.
 *  `generation` is the cache's when the work began (rawCacheGeneration), so the
 *  write and any marker land only in the project the work began in. `signal`
 *  abandons a decode still waiting for the pool, and once aborted nothing is
 *  written or marked. */
export async function fillCacheEntry(
  photo: CatalogPhoto,
  generation: number,
  signal?: AbortSignal,
): Promise<CacheFillResult> {
  if (!photo.fileHandle) return "nothing";
  const key = rawCacheKey(photo.relPath, photo.fileSize, photo.rotation ?? 0);
  const file = await photo.fileHandle.getFile();
  if (signal?.aborted) return "nothing";
  // Background: a photo opened in Develop meanwhile goes ahead of the queue.
  const f = await decodeRawToFloat(file, { background: true, signal });
  if (signal?.aborted) return "nothing";
  if ("failure" in f) {
    // Only a failure that would recur is remembered; any other is retried on
    // a later pass.
    if (f.failure === "unsupported") await markDecode(key, "unsupported", generation);
    return "nothing";
  }

  let rotateDeg = photo.rotation ?? 0;
  if (f.oriented) {
    rotateDeg = normalizeRotation(rotateDeg - orientationToRotation(photo.exif?.orientation));
  }
  const r = rotateFloatRGBA(f.data, f.width, f.height, rotateDeg);

  // Same ruling as Develop's open. A cached decode is served without a second
  // look, so a marginal or wrong-colour one would show on every open. The
  // preview is read only now, once there is a decode to judge.
  const { use, cache, match } = await acceptDecode(f, r, await extractRawPreview(file));
  if (signal?.aborted) return "nothing";
  // The camera match, as Develop's open learns it: most RAWs are decoded here
  // before they are first opened.
  if (use && !hasCameraMatch(photo)) rememberLearned(photo, learnedMatch(match));
  if (!cache) {
    // Either verdict would come out the same on every pass. A marginal decode
    // is still shown in Develop; a rejected one never is.
    await markDecode(key, use ? "suspicious" : "unsupported", generation);
    return "nothing";
  }
  if (!(await writeCachedPreview(key, r.data, r.width, r.height, generation))) return "refused";
  // A write dropped because the project changed meanwhile also answers true;
  // its photo is no longer any view's to update.
  if (rawCacheGeneration() === generation) {
    emitCacheEntryFilled({
      photo,
      fullWidth: r.width,
      fullHeight: r.height,
      cutSample: () => cutSourceSample(r.data, r.width, r.height),
    });
  }
  return "taken";
}

// The entry being rewritten, by cache key and the project it began in.
let running: { key: string; generation: number } | null = null;
let waiting: { photo: CatalogPhoto; generation: number } | null = null;

/** Rewrite one entry from before 3.1.0 with the decoded size and the sample,
 *  behind the open it was served to; returns at once. One runs at a time (a
 *  decode holds hundreds of megabytes); the newest request made meanwhile
 *  waits and runs next, so the photo the user went to last is completed next,
 *  and any request waiting before it is dropped. A request for the entry
 *  already being rewritten is ignored: a photo shown again during its own
 *  rewrite asks again, and a second decode would write the same entry and
 *  push the photo waiting out of its place. The write lands only in the
 *  project the request began in (the generation guard in raw-cache.ts). */
export function completeCachedEntry(photo: CatalogPhoto, generation: number): void {
  const key = rawCacheKey(photo.relPath, photo.fileSize, photo.rotation ?? 0);
  if (running) {
    if (running.key === key && running.generation === generation) return;
    waiting = { photo, generation };
    return;
  }
  running = { key, generation };
  void fillCacheEntry(photo, generation)
    // The entry still serves as it is, so a failure is logged and let go.
    .catch((err: unknown) => console.warn("[cache] completion failed:", err))
    .finally(() => {
      running = null;
      const next = waiting;
      waiting = null;
      if (next) completeCachedEntry(next.photo, next.generation);
    });
}
