// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Develop-preview cache: store decoded RAW files in the open project's
// .safelight/raw folder (in IndexedDB, scoped to the project, where the cache
// worker can't reach the folder) so subsequent Develop opens load fast instead
// of re-running libraw (~50ms vs 3-8s).
//
// Cache key = relPath + fileSize + baked rotation. Derived entirely from the
// catalog record so the prefetch skip-check needs no getFile (which reads the
// whole RAW off disk in Electron). A size-changing edit misses automatically; an
// in-place edit that preserves byte size (e.g. EXIF/metadata rewrite) keeps the
// stale entry until Reimport drops it (see reimportPhotos in import-photos.ts).
//
// Format: scene-linear RGBA as IEEE 754 half floats, gzip-compressed. The first
// cache stored an 8-bit JPEG, which only has ~256 levels/channel — a +5 exposure
// push (×32) then stretched the bright sky into visible posterising bands (and
// JPEG's lossy chroma made it rainbow). The next stored 16-bit sRGB: smooth
// under a push, but clamped to [0, 1], so a reopened RAW lost the highlight
// headroom and the camera matrix's small negatives its first open rendered
// from. Half floats keep both at ~11 bits of relative precision in the same
// 2 bytes/channel; gzip keeps the blob near a large JPEG's size. On load the
// renderer decodes them and takes the same scene-linear float path as a fresh
// decode; see WebGLRenderer.setImage.
//
// All heavy I/O (gzip/gunzip, IndexedDB transactions, filesystem reads/writes,
// downsample + half-float encoding for writes) runs in a dedicated cache worker
// so the main thread is never blocked.

import { getSettings } from "@/state/settings-store";
import {
  setCacheDirOnWorker,
  workerReadCachedPreview,
  workerWriteCachedPreview,
  workerWriteMarker,
  workerReadMarker,
  workerDeleteCachedPreview,
  workerClearRawCache,
  workerCachedKeys,
} from "./cache-bridge";

// ─── Key helpers ─────────────────────────────────────────────────────────────

// The version prefix is the cache contract: bump it whenever the float decode
// or the stored encoding changes (v6: half-float entries that keep headroom and
// negatives; v5: libraw output linearised, white point restored, Fujifilm
// exposure bias applied).
export function rawCacheKey(
  relPath: string,
  fileSize: number,
  rotation = 0,
): string {
  return `v6:${relPath}:${fileSize}:${rotation}`;
}

// ─── Decode markers ──────────────────────────────────────────────────────────

// The decoder a marker speaks for: the vendored LibRaw release and the revision
// of what libraw-wasm-adapter.ts and decode.ts call unsupported. A new ID
// leaves every older marker unread, so each marked photo is tried once more.
export const DECODER_ID = "libraw-0.22.1+1";

// A RAW the decoder can't use would be decoded again on every Develop open and
// every "Cache all" pass. A marker beside its cache entry keeps the verdict:
// "unsupported" (nothing usable: Develop shows the camera's preview at once) or
// "suspicious" (shown but never cached: only the background pass skips it).
export type DecodeMarker = "unsupported" | "suspicious";
const MARKERS: readonly DecodeMarker[] = ["unsupported", "suspicious"];

// A verdict counts once two sessions have reached it. One session's failure
// may be its own (libraw answers a lack of memory like an unsupported file),
// and the marker would travel with the project folder to other machines. So
// the first strike leaves a tentative marker that nothing honours; a strike
// from a session loaded after it makes it final. A window already open at the
// first strike can't confirm it: two windows open at once aren't two launches.
// Each marker holds who struck it last and when: one random id per page load,
// and the time.
type Strikes = 1 | 2;
const SESSION = Array.from(crypto.getRandomValues(new Uint32Array(2)), (n) =>
  n.toString(36),
).join("");
const LOADED_AT = Date.now();

function strikeText(): string {
  return `${SESSION} ${Date.now()}`;
}

/** Whether this session's strike makes a tentative marker holding `text` final. */
function confirms(text: string): boolean {
  const [session, at] = text.split(" ");
  // A marker from before strikes carried a time (or with an unreadable one)
  // has no time to compare: it counts as struck before this load.
  return session !== SESSION && !(Number(at) >= LOADED_AT);
}

function markerKey(cacheKey: string, marker: DecodeMarker, strikes: Strikes): string {
  return `${marker}@${DECODER_ID}#${strikes}:${cacheKey}`;
}

/** The key of the photo's final marker of that kind, the one lookups honour. */
export function decodeMarkerKey(cacheKey: string, marker: DecodeMarker): string {
  return markerKey(cacheKey, marker, 2);
}

function markerKeysOf(cacheKey: string): string[] {
  return MARKERS.flatMap((marker) => [
    markerKey(cacheKey, marker, 1),
    markerKey(cacheKey, marker, 2),
  ]);
}

/** The cache key a current final marker stands for, or null for any other key. */
function markedKey(stored: string): string | null {
  for (const marker of MARKERS) {
    const prefix = decodeMarkerKey("", marker);
    if (stored.startsWith(prefix)) return stored.slice(prefix.length);
  }
  return null;
}

// ─── Project-folder cache ────────────────────────────────────────────────────

// A key names a file by its path and size inside its project, so the same key
// in another project's folder stands for another photo. Work that decodes for
// the cache takes the generation when it begins and hands it to the write,
// which is dropped once the folder has changed.
let cacheDir: FileSystemDirectoryHandle | null | undefined;
let generation = 0;

export function setRawCacheDir(dir: FileSystemDirectoryHandle | null): void {
  if (dir !== cacheDir) {
    cacheDir = dir;
    generation++;
  }
  setCacheDirOnWorker(dir);
}

export function rawCacheGeneration(): number {
  return generation;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function readCachedPreview(
  key: string,
): Promise<{ data: Uint16Array; width: number; height: number } | null> {
  if (!getSettings().rawCacheEnabled) return null;
  try {
    return await workerReadCachedPreview(key);
  } catch {
    return null;
  }
}

// The keys nothing needs decoding for: each stored preview, and each photo
// with a final marker from the current decoder.
export async function cachedKeys(): Promise<Set<string>> {
  if (!getSettings().rawCacheEnabled) return new Set();
  try {
    const keys = await workerCachedKeys();
    return new Set(keys.map((key) => markedKey(key) ?? key));
  } catch {
    return new Set();
  }
}

export async function writeCachedPreview(
  key: string,
  data: Float32Array,
  width: number,
  height: number,
  begunIn: number,
): Promise<void> {
  if (!getSettings().rawCacheEnabled) return;
  // Checked in the same synchronous step that queues the write, so a folder
  // change made after the check is queued, and reaches the worker, after it.
  if (begunIn !== generation) return;
  try {
    // An accepted decode outranks any verdict struck against the photo before.
    await Promise.all([
      workerWriteCachedPreview(key, data, width, height, getSettings().rawCacheMaxEdge),
      ...markerKeysOf(key).map((k) => workerDeleteCachedPreview(k)),
    ]);
  } catch {
    // Cache write failure is non-fatal — the next load will just re-decode.
  }
}

/** One strike against the photo: a definitive failure of this kind. */
export async function markDecode(
  cacheKey: string,
  marker: DecodeMarker,
  begunIn: number,
): Promise<void> {
  if (!getSettings().rawCacheEnabled) return;
  // As for writeCachedPreview: a decode begun in another project marks nothing.
  if (begunIn !== generation) return;
  const tentative = markerKey(cacheKey, marker, 1);
  const final = markerKey(cacheKey, marker, 2);
  try {
    const [finalBy, firstBy] = await Promise.all([
      workerReadMarker(final),
      workerReadMarker(tentative),
    ]);
    // Checked again in the step that queues the writes, as above.
    if (finalBy !== null || begunIn !== generation) return;
    if (firstBy === null) {
      await workerWriteMarker(tentative, strikeText());
    } else if (confirms(firstBy)) {
      await Promise.all([
        workerWriteMarker(final, strikeText()),
        workerDeleteCachedPreview(tentative),
      ]);
    }
  } catch {
    // Without the strike the photo is only decoded again.
  }
}

/** Whether the photo carries a final marker of that kind. */
export async function hasDecodeMarker(
  cacheKey: string,
  marker: DecodeMarker,
): Promise<boolean> {
  if (!getSettings().rawCacheEnabled) return false;
  try {
    return (await workerReadMarker(decodeMarkerKey(cacheKey, marker))) !== null;
  } catch {
    return false;
  }
}

// The photo's markers go with its preview: whatever makes the preview stale
// (Reimport, the file leaving the disk) makes the decoder's verdict stale too.
export async function deleteCachedPreview(key: string): Promise<void> {
  const keys = [key, ...markerKeysOf(key)];
  await Promise.all(keys.map((k) => workerDeleteCachedPreview(k).catch(() => {})));
}

export async function clearRawCache(): Promise<void> {
  try {
    await workerClearRawCache();
  } catch {}
}
