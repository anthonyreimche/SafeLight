// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Library sources: photos an extension reads from somewhere other than a folder
// on disk (a photo server), opened as a project the way a folder is. The
// source's folders and photos are handed to the core as directory and file
// handles that behave like a read-only folder's, so the scan, the import, the
// catalogue, Develop and export treat them as they treat files on disk:
//
// - the catalogue and previews live in a working folder of their own in the app
//   data (working-dir.ts), bound here with bindSourceCache;
// - a photo's original is fetched once, when something reads the file, and kept
//   under <working folder>/originals, so later opens read it from disk;
// - the last listing is kept there too and stands in while the source can't be
//   reached: the photos stay in the grid, and the ones whose originals were kept
//   still open;
// - nothing is ever written to the source: every change a handle is asked for is
//   refused.

import { create } from "zustand";
import type { ExifData } from "@/catalog/types";
import type {
  LibrarySourceContribution,
  LibrarySourceFolder,
  LibrarySourceItem,
  LibrarySourceListing,
} from "@/extensions/api/sources";
import { isNotFound, isPlainObject, readJSON, removeEntry, safeName, writeBlob, writeJSON } from "./fs";
import { nativePathOf, nativeSizeOf, readFileSlice, type FileSlice } from "./native-fs";
import type { ScannedFile } from "./scan";

export type {
  LibrarySourceContribution,
  LibrarySourceFolder,
  LibrarySourceItem,
  LibrarySourceListing,
};

export interface RegisteredLibrarySource extends LibrarySourceContribution {
  extensionId: string;
}

/** What a source project is opened from. */
export interface LibrarySourceRef {
  id: string;
  name: string;
  library: string;
  /** The extension that registered it: a source is its extension's alone. */
  extensionId: string;
}

/** The source couldn't be reached and has no listing kept from an earlier open. */
export class SourceUnavailableError extends Error {
  readonly sourceName: string;
  readonly reason: string;
  readonly cause?: unknown;

  constructor(sourceName: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`Couldn't reach “${sourceName}” (${reason}).`);
    this.name = "SourceUnavailableError";
    this.sourceName = sourceName;
    this.reason = reason;
    this.cause = cause;
  }
}

const LIST_TIMEOUT_MS = 120_000;
const PREVIEW_TIMEOUT_MS = 60_000;
/** A backstop only: the source bounds its own reads by the file's size. */
const ORIGINAL_TIMEOUT_MS = 30 * 60_000;

const LISTING_FILE = "source-listing.json";
const ORIGINALS_DIR = "originals";

const useSourceStore = create<{ sources: Record<string, RegisteredLibrarySource> }>(() => ({ sources: {} }));

/** React hook: the registered sources by id. */
export function useLibrarySourceMap(): Record<string, RegisteredLibrarySource> {
  return useSourceStore((s) => s.sources);
}

export function listLibrarySources(): RegisteredLibrarySource[] {
  return Object.values(useSourceStore.getState().sources);
}

function validContribution(c: unknown): c is LibrarySourceContribution {
  return (
    isPlainObject(c) &&
    typeof c.id === "string" &&
    c.id !== "" &&
    typeof c.name === "string" &&
    (c.library === undefined || typeof c.library === "string") &&
    typeof c.list === "function" &&
    typeof c.readPreview === "function" &&
    typeof c.readOriginal === "function" &&
    (c.keptOriginalsLimit === undefined ||
      c.keptOriginalsLimit === null ||
      (typeof c.keptOriginalsLimit === "number" && c.keptOriginalsLimit >= 0))
  );
}

/** Register (or, for its owner, replace) a source. Returns the library the id
 *  showed before when this registration changes it, so a project open on the
 *  old one can be closed; null otherwise. */
export function registerLibrarySource(extensionId: string, c: LibrarySourceContribution): string | null {
  if (!validContribution(c)) {
    console.warn(
      `[extensions] ${extensionId}: registerSource needs an id, a name, list, readPreview and readOriginal functions, and keptOriginalsLimit left out, null or a number of bytes; ignored`,
    );
    return null;
  }
  const held = useSourceStore.getState().sources[c.id];
  if (held && held.extensionId !== extensionId) {
    console.warn(`[extensions] ${extensionId}: the source "${c.id}" is registered by ${held.extensionId}; registerSource ignored`);
    return null;
  }
  useSourceStore.setState((s) => ({ sources: { ...s.sources, [c.id]: { ...c, extensionId } } }));
  const before = held ? (held.library ?? "") : null;
  return before !== null && before !== (c.library ?? "") ? before : null;
}

export function unregisterLibrarySource(extensionId: string, id: string): void {
  if (useSourceStore.getState().sources[id]?.extensionId !== extensionId) return;
  useSourceStore.setState((s) => {
    const next = { ...s.sources };
    delete next[id];
    return { sources: next };
  });
}

/** Drop every source an extension registered (it stopped). */
export function dropLibrarySources(extensionId: string): void {
  const kept = Object.entries(useSourceStore.getState().sources).filter(([, s]) => s.extensionId !== extensionId);
  if (kept.length !== listLibrarySources().length) useSourceStore.setState({ sources: Object.fromEntries(kept) });
}

/** Resolves once source `id` is registered, or with false after `ms`. */
export function whenLibrarySource(id: string, ms: number): Promise<boolean> {
  if (useSourceStore.getState().sources[id]) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      stop();
      resolve(false);
    }, ms);
    const stop = useSourceStore.subscribe((s) => {
      if (!s.sources[id]) return;
      clearTimeout(timer);
      stop();
      resolve(true);
    });
  });
}

// ── the handles ──────────────────────────────────────────────────────────────

interface Node {
  name: string;
  folders: Node[];
  files: { name: string; item: LibrarySourceItem }[];
}

interface RootState {
  ref: LibrarySourceRef;
  cache: FileSystemDirectoryHandle | null;
  offline: boolean;
  tree: Node | null;
  fetching: Map<string, Promise<Blob>>;
  /** Aborts once the open that made the root is left before it ended. */
  stop: AbortController;
}

const ROOT = Symbol("safelight.sourceRoot");
const FILE = Symbol("safelight.sourceFile");

interface Rooted {
  [ROOT]: RootState;
}
interface Filed {
  [FILE]: { state: RootState; item: LibrarySourceItem; name: string };
}

function stateOf(handle: unknown): RootState | null {
  return typeof handle === "object" && handle !== null && ROOT in handle ? (handle as Rooted)[ROOT] : null;
}

function fileOf(handle: unknown): Filed[typeof FILE] | null {
  return typeof handle === "object" && handle !== null && FILE in handle ? (handle as Filed)[FILE] : null;
}

export function isSourceRoot(handle: unknown): boolean {
  return stateOf(handle) !== null;
}

export function isSourceFile(handle: unknown): boolean {
  return fileOf(handle) !== null;
}

export function sourceRefOf(handle: unknown): LibrarySourceRef | null {
  return stateOf(handle)?.ref ?? null;
}

/** The photo a source file handle stands for. */
export function sourceItemOf(handle: unknown): LibrarySourceItem | null {
  return fileOf(handle)?.item ?? null;
}

/** A source project's saved records paired with the files a scan found, by the
 *  key the source names each photo by (CatalogPhoto.sourceKey): a record follows
 *  its photo to another album or name, and a file never takes the record of
 *  another photo that had its path. One key in several folders (a photo in two
 *  albums) pairs each record with the file at its own path first, then with the
 *  rest in order. A record without a key, or whose key the source no longer
 *  lists, pairs with nothing. */
export function pairSourceRecords<R extends { relPath: string; sourceKey?: string }>(
  records: readonly R[],
  files: readonly ScannedFile[],
): Map<ScannedFile, R> {
  const byKey = new Map<string, ScannedFile[]>();
  for (const file of files) {
    const key = sourceItemOf(file.handle)?.key;
    if (key !== undefined) byKey.set(key, [...(byKey.get(key) ?? []), file]);
  }
  const pairs = new Map<ScannedFile, R>();
  const free = (record: R, samePath: boolean) =>
    byKey.get(record.sourceKey!)?.find((f) => !pairs.has(f) && (!samePath || f.path === record.relPath));
  const keyed = records.filter((r) => r.sourceKey !== undefined);
  const unpaired: R[] = [];
  for (const record of keyed) {
    const file = free(record, true);
    if (file) pairs.set(file, record);
    else unpaired.push(record);
  }
  for (const record of unpaired) {
    const file = free(record, false);
    if (file) pairs.set(file, record);
  }
  return pairs;
}

/** Stop a source root whose open was left before it ended: a listing under way
 *  is aborted (the source's requests with it) and none starts again. Anything
 *  else is passed over. */
export function stopSourceRoot(root: unknown): void {
  stateOf(root)?.stop.abort();
}

/** Whether the last listing of this source root was the kept one, because the
 *  source couldn't be reached. */
export function sourceOffline(root: unknown): boolean {
  return stateOf(root)?.offline ?? false;
}

/** Give a source root the working folder its catalogue lives in: where the
 *  listing and the originals are kept. */
export function bindSourceCache(root: FileSystemDirectoryHandle, sl: FileSystemDirectoryHandle): void {
  const state = stateOf(root);
  if (state) state.cache = sl;
}

/** A source root for the source registered under `id`, or null when none is. */
export function sourceRoot(id: string): FileSystemDirectoryHandle | null {
  const held = useSourceStore.getState().sources[id];
  if (!held) return null;
  const state: RootState = {
    ref: { id, name: held.name, library: held.library ?? "", extensionId: held.extensionId },
    cache: null,
    offline: false,
    tree: null,
    fetching: new Map(),
    stop: new AbortController(),
  };
  return dirHandle(state, null);
}

function refused(what: string): DOMException {
  return new DOMException(`${what}: photos from a library source can't be changed from Safelight.`, "NoModificationAllowedError");
}

function notFound(name: string): DOMException {
  return new DOMException(`A requested file or directory could not be found: ${name}`, "NotFoundError");
}

/** `node` null: the root, listed afresh on each walk. */
function dirHandle(state: RootState, node: Node | null): FileSystemDirectoryHandle {
  const current = async (): Promise<Node> => node ?? state.tree ?? (await listSource(state));
  const handle = {
    kind: "directory" as const,
    name: node?.name ?? state.ref.name,
    async *values() {
      const at = node ?? (await listSource(state));
      for (const folder of at.folders) yield dirHandle(state, folder);
      for (const file of at.files) yield fileHandle(state, file.item, file.name);
    },
    async *keys() {
      const at = await current();
      for (const folder of at.folders) yield folder.name;
      for (const file of at.files) yield file.name;
    },
    async getDirectoryHandle(name: string, opts?: { create?: boolean }) {
      const folder = (await current()).folders.find((f) => f.name === name);
      if (folder) return dirHandle(state, folder);
      throw opts?.create ? refused(`Creating “${name}”`) : notFound(name);
    },
    async getFileHandle(name: string, opts?: { create?: boolean }) {
      const file = (await current()).files.find((f) => f.name === name);
      if (file) return fileHandle(state, file.item, file.name);
      throw opts?.create ? refused(`Creating “${name}”`) : notFound(name);
    },
    async removeEntry(name: string) {
      throw refused(`Removing “${name}”`);
    },
  };
  const branded = node ? handle : Object.assign(handle, { [ROOT]: state });
  return branded as unknown as FileSystemDirectoryHandle;
}

function fileHandle(state: RootState, item: LibrarySourceItem, name: string): FileSystemFileHandle {
  const handle = {
    [FILE]: { state, item, name },
    kind: "file" as const,
    name,
    async getFile(): Promise<File> {
      const blob = await original(state, item);
      return new File([blob], name, { type: item.mimeType ?? blob.type, lastModified: item.modified ?? 0 });
    },
    async createWritable() {
      throw refused(`Writing “${name}”`);
    },
  };
  return handle as unknown as FileSystemFileHandle;
}

// ── listing ──────────────────────────────────────────────────────────────────

/** Run `work` with a signal that aborts after `ms`, or when `outer` aborts,
 *  rejecting then too. */
async function bounded<T>(
  work: (signal: AbortSignal) => Promise<T>,
  ms: number,
  what: string,
  outer?: AbortSignal,
): Promise<T> {
  if (outer?.aborted) throw new DOMException(`${what} was stopped`, "AbortError");
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped: (() => void) | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new DOMException(`${what} took longer than ${Math.round(ms / 1000)} s`, "TimeoutError"));
    }, ms);
    stopped = () => {
      ac.abort();
      reject(new DOMException(`${what} was stopped`, "AbortError"));
    };
    outer?.addEventListener("abort", stopped, { once: true });
  });
  try {
    return await Promise.race([work(ac.signal), late]);
  } finally {
    clearTimeout(timer);
    if (stopped) outer?.removeEventListener("abort", stopped);
  }
}

/** The registration a root reads through: the one it was opened from, still
 *  showing the same library. Another library (the person signed into another
 *  account) or another extension's source of the same id would write its
 *  listing into this catalogue and get this one's requests, so the root then
 *  reads as offline instead. */
function contribution(state: RootState): RegisteredLibrarySource {
  const held = useSourceStore.getState().sources[state.ref.id];
  if (!held || held.extensionId !== state.ref.extensionId)
    throw new Error(`the extension that adds “${state.ref.name}” isn't running`);
  if ((held.library ?? "") !== state.ref.library)
    throw new Error(`“${state.ref.name}” is connected to another library now`);
  return held;
}

const finite = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** The EXIF fields a source may give, by the type each holds. The ones the RAW
 *  decode learns (as-shot white balance, exposure bias, the camera match) are
 *  left to it: it learns them only where the record has none. */
const EXIF_TEXT = [
  "cameraMake", "cameraModel", "bodySerial", "lens", "lensMake", "lensSerial", "shutterSpeed",
  "exposureProgram", "exposureMode", "meteringMode", "whiteBalance", "flash", "sceneCaptureType",
  "colorSpace", "artist", "copyright", "software", "imageDescription", "dateTimeOriginal",
  "subSecTimeOriginal",
] as const satisfies readonly (keyof ExifData)[];
const EXIF_NUMBER = [
  "focalLength", "focalLength35mm", "aperture", "maxAperture", "iso", "exposureCompensation",
  "subjectDistance", "gpsLatitude", "gpsLongitude", "gpsAltitude",
] as const satisfies readonly (keyof ExifData)[];

/** A source's EXIF with only the known fields of the right type: anything else
 *  would reach code that reads them as typed (a date parser, the orientation). */
function cleanExif(raw: Record<string, unknown>): ExifData {
  const exif: ExifData = {};
  for (const key of EXIF_TEXT) if (typeof raw[key] === "string") exif[key] = raw[key];
  for (const key of EXIF_NUMBER) {
    const v = finite(raw[key]);
    if (v !== undefined) exif[key] = v;
  }
  const orientation = raw.orientation;
  if (typeof orientation === "number" && Number.isInteger(orientation) && orientation >= 1 && orientation <= 8)
    exif.orientation = orientation;
  return exif;
}

function cleanItem(raw: unknown): LibrarySourceItem | null {
  if (!isPlainObject(raw) || typeof raw.key !== "string" || !raw.key || typeof raw.name !== "string") return null;
  const item: LibrarySourceItem = { key: raw.key, name: raw.name };
  for (const k of ["size", "modified", "taken", "width", "height", "rating"] as const) {
    const v = finite(raw[k]);
    if (v !== undefined) item[k] = v;
  }
  if (typeof raw.mimeType === "string") item.mimeType = raw.mimeType;
  if (isPlainObject(raw.exif)) item.exif = cleanExif(raw.exif);
  if (Array.isArray(raw.keywords)) item.keywords = raw.keywords.filter((k): k is string => typeof k === "string");
  return item;
}

/** A listing as the source returned it (any shape: it crosses from extension
 *  code), with what isn't a folder or an item left out. */
function cleanListing(raw: unknown): LibrarySourceListing {
  if (!isPlainObject(raw)) return {};
  const items = Array.isArray(raw.items) ? raw.items.flatMap((i) => cleanItem(i) ?? []) : [];
  const folders = Array.isArray(raw.folders)
    ? raw.folders.flatMap((f): LibrarySourceFolder[] =>
        isPlainObject(f) && typeof f.name === "string"
          ? [{ name: f.name, ...(typeof f.key === "string" && f.key ? { key: f.key } : {}), ...cleanListing(f) }]
          : [],
      )
    : [];
  return { folders, items };
}

/** One plain entry name: no separators or control characters, not hidden. */
function entryName(raw: string): string {
  let name = raw.replace(/[\u0000-\u001f\u007f]/g, "").replace(/[/\\]/g, "-").trim();
  if (name.startsWith(".")) name = `_${name.slice(1)}`;
  return name || "Untitled";
}

function splitExt(name: string): [string, string] {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
}

/** The tree the handles show: names made plain and unique within each folder,
 *  compared without case as the desktop's disks do. Of photos, or folders with
 *  keys, sharing a name, the one with the lowest key keeps it and the rest add
 *  part of their key, so each keeps its name from one listing to the next.
 *  Folders without keys take " (2)", " (3)" in listing order. */
function buildTree(listing: LibrarySourceListing, name: string): Node {
  const listed = listing.folders ?? [];
  const sharing = new Map<string, LibrarySourceFolder[]>();
  for (const f of listed) {
    const lower = entryName(f.name).toLowerCase();
    sharing.set(lower, [...(sharing.get(lower) ?? []), f]);
  }
  const keyless = new Map<string, number>();
  const folders = listed.map((f) => {
    const base = entryName(f.name);
    const group = sharing.get(base.toLowerCase())!;
    const keys = group.flatMap((g) => (g.key === undefined ? [] : [g.key])).sort();
    const plain = keys.length > 0 ? group.find((g) => g.key === keys[0]) : group[0];
    if (f === plain) return buildTree(f, base);
    if (f.key !== undefined) return buildTree(f, `${base} (${safeName(f.key.slice(0, 8))})`);
    const n = (keyless.get(base.toLowerCase()) ?? 1) + 1;
    keyless.set(base.toLowerCase(), n);
    return buildTree(f, `${base} (${n})`);
  });
  const items = listing.items ?? [];
  const lowest = new Map<string, string>();
  for (const item of items) {
    const key = entryName(item.name).toLowerCase();
    const held = lowest.get(key);
    if (held === undefined || item.key < held) lowest.set(key, item.key);
  }
  const files = items.map((item) => {
    const plain = entryName(item.name);
    if (lowest.get(plain.toLowerCase()) === item.key) return { name: plain, item };
    const [base, ext] = splitExt(plain);
    return { name: `${base} (${safeName(item.key.slice(0, 8))})${ext}`, item };
  });
  return { name, folders, files };
}

interface KeptListing {
  version: 1;
  library: string;
  listing: LibrarySourceListing;
}

async function keptListing(state: RootState): Promise<LibrarySourceListing | null> {
  if (!state.cache) return null;
  const kept = await readJSON<KeptListing>(state.cache, LISTING_FILE);
  return kept?.version === 1 && kept.library === state.ref.library ? cleanListing(kept.listing) : null;
}

async function listSource(state: RootState): Promise<Node> {
  let listing: LibrarySourceListing;
  try {
    const src = contribution(state);
    listing = cleanListing(
      await bounded((signal) => src.list({ signal }), LIST_TIMEOUT_MS, "Listing the photos", state.stop.signal),
    );
    state.offline = false;
    if (state.cache) {
      const kept: KeptListing = { version: 1, library: state.ref.library, listing };
      await writeJSON(state.cache, LISTING_FILE, kept).catch((e: unknown) =>
        console.warn(`[sources] the listing of “${state.ref.name}” wasn't kept:`, e),
      );
    }
  } catch (error) {
    if (state.stop.signal.aborted) throw error;
    const kept = await keptListing(state);
    if (!kept) throw new SourceUnavailableError(state.ref.name, error);
    console.warn(`[sources] “${state.ref.name}” can't be reached; showing its last listing:`, error);
    state.offline = true;
    listing = kept;
  }
  state.tree = buildTree(listing, state.ref.name);
  return state.tree;
}

// ── originals and previews ───────────────────────────────────────────────────

/** The file a kept original is named by: the SHA-256 of its key in hex, one name
 *  per key whatever characters it holds, alike in any case and short enough for
 *  any disk. */
async function originalName(key: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Bytes [start, end) of a kept file and its size: a range read on the desktop,
 *  where getFile() would carry the whole file over the bridge; a slice of the
 *  disk-backed File in the browser. */
async function keptSlice(kept: FileSystemFileHandle, start: number, end: number): Promise<Pick<FileSlice, "data" | "size">> {
  if (nativePathOf(kept) !== null) return readFileSlice(kept, start, end);
  const file = await kept.getFile();
  return { data: new Uint8Array(await file.slice(start, end).arrayBuffer()), size: file.size };
}

/** The kept file of `item`'s original, found without reading any of it (a
 *  RAW is tens of MB over the desktop bridge); null when none is kept, or one of
 *  another size than the listing gave. */
async function keptOriginal(state: RootState, item: LibrarySourceItem): Promise<FileSystemFileHandle | null> {
  if (!state.cache) return null;
  try {
    const dir = await state.cache.getDirectoryHandle(ORIGINALS_DIR);
    const kept = await dir.getFileHandle(await originalName(item.key));
    const { size } = await keptSlice(kept, 0, 0);
    return !item.size || size === item.size ? kept : null;
  } catch {
    return null;
  }
}

/** The kept original's bytes, or null. The desktop reads the whole file at once;
 *  the browser's File would read the disk only later, and fail if a trim (another
 *  window's limit) removed the file meanwhile, so it is read now too. */
async function heldOriginal(state: RootState, item: LibrarySourceItem): Promise<Blob | null> {
  const kept = await keptOriginal(state, item);
  if (!kept) return null;
  try {
    const file = await kept.getFile();
    return nativePathOf(kept) !== null ? file : new Blob([await file.arrayBuffer()], { type: file.type });
  } catch {
    return null;
  }
}

async function fetchOriginal(state: RootState, item: LibrarySourceItem): Promise<Blob> {
  const src = contribution(state);
  const blob = await bounded((signal) => src.readOriginal(item, { signal }), ORIGINAL_TIMEOUT_MS, `Reading ${item.name}`);
  if (!(blob instanceof Blob)) throw new TypeError(`the source gave no file for ${item.name}`);
  if (item.size && blob.size !== item.size)
    throw new Error(`the original of ${item.name} arrived incomplete (${blob.size} of ${item.size} bytes)`);
  const sl = state.cache;
  if (sl) {
    const catalog = catalogKey(state.ref);
    const name = await originalName(item.key);
    try {
      await inTurn(catalog, async () => {
        // Its use is written first: another window's trim that finds the file
        // finds when it was used too, and doesn't take it for the oldest.
        await noteUsed(sl, name);
        const dir = await sl.getDirectoryHandle(ORIGINALS_DIR, { create: true });
        await writeBlob(dir, name, blob);
      });
      inBackground(catalog, () => trim(state.ref, sl, limitFor(state.ref), name));
    } catch (e) {
      console.warn(`[sources] the original of ${item.name} wasn't kept:`, e);
    }
  }
  return blob;
}

async function original(state: RootState, item: LibrarySourceItem): Promise<Blob> {
  const held = await heldOriginal(state, item);
  if (held) {
    const sl = state.cache;
    if (sl) {
      const name = await originalName(item.key);
      inBackground(catalogKey(state.ref), () => noteUsed(sl, name));
    }
    return held;
  }
  let pending = state.fetching.get(item.key);
  if (!pending) {
    pending = fetchOriginal(state, item).finally(() => state.fetching.delete(item.key));
    state.fetching.set(item.key, pending);
  }
  return pending;
}

// ── the kept originals' limit ────────────────────────────────────────────────

/** How many bytes of originals a catalogue keeps when its source sets no limit. */
export const DEFAULT_KEPT_ORIGINALS_LIMIT = 10 * 1024 ** 3;

/** When each window last used the kept originals: one file per window, which
 *  only that window writes, so two windows never lose each other's uses nor
 *  write one file at once. A name no file holds counts as used before any other. */
const USED_DIR = "originals-used";
/** The originals each window holds (open in its Develop, being exported): one
 *  file per window, renewed every HEARTBEAT_MS while it holds any, so a window
 *  that crashed without letting go stops counting after HOLD_LAPSE_MS. The lapse
 *  leaves room for a hidden window, whose timers Chromium runs about once a
 *  minute and sometimes several minutes late. A file lapsed HELD_FORGET_MS is a
 *  closed or crashed window's and is removed. */
const HELD_DIR = "originals-held";
const HEARTBEAT_MS = 60_000;
const HOLD_LAPSE_MS = 10 * HEARTBEAT_MS;
const HELD_FORGET_MS = 60 * HEARTBEAT_MS;
/** A window's use times untouched this long are folded into the next window's
 *  own and their file removed, so the folder doesn't fill with closed windows'. */
const USED_FOLD_MS = 24 * 60 * 60_000;

interface UsedFile {
  version: 1;
  at: number;
  used: Record<string, number>;
}

interface HeldFile {
  version: 1;
  at: number;
  names: string[];
}

let windowId: string | undefined;

/** This window, for the files only it writes: random per page load. */
function thisWindow(): string {
  windowId ??= Array.from(crypto.getRandomValues(new Uint32Array(3)), (n) => n.toString(36)).join("");
  return `${windowId}.json`;
}

/** The catalogue a ref's photos belong to: one per extension, source and library. */
function catalogKey(ref: LibrarySourceRef): string {
  return `${ref.extensionId}\n${ref.id}\n${ref.library}`;
}

/** Each catalogue's work on its kept originals in this window, one step at a
 *  time: a write, a trim and a clear never overlap. */
const turns = new Map<string, Promise<void>>();

function inTurn<T>(catalog: string, work: () => Promise<T>): Promise<T> {
  const run = (turns.get(catalog) ?? Promise.resolve()).then(work);
  const ended = run.then(
    () => undefined,
    () => undefined,
  );
  turns.set(catalog, ended);
  void ended.then(() => {
    if (turns.get(catalog) === ended) turns.delete(catalog);
  });
  return run;
}

/** inTurn for work nobody waits on: a failure is only logged. */
function inBackground(catalog: string, work: () => Promise<void>): void {
  inTurn(catalog, work).catch((e: unknown) => console.warn("[sources] kept originals' bookkeeping failed:", e));
}

/** Resolves once the kept originals' bookkeeping under way has ended. */
export async function settleKeptOriginals(): Promise<void> {
  while (turns.size > 0) await Promise.all(turns.values());
}

/** The JSON files of `sl`'s folder `dir`, by file name; none when it isn't there.
 *  A file that doesn't parse (cut short by a crash) reads as missing. */
async function jsonFiles<T>(sl: FileSystemDirectoryHandle, dir: string): Promise<Map<string, T>> {
  const out = new Map<string, T>();
  let folder: FileSystemDirectoryHandle;
  const names: string[] = [];
  try {
    folder = await sl.getDirectoryHandle(dir);
    for await (const entry of folder.values()) if (entry.kind === "file" && entry.name.endsWith(".json")) names.push(entry.name);
  } catch (error) {
    if (isNotFound(error)) return out;
    throw error;
  }
  for (const name of names) {
    const value = await readJSON<T>(folder, name);
    if (value !== null) out.set(name, value);
  }
  return out;
}

/** Originals this window holds, by catalogue and key, with how many holds each has. */
const holds = new Map<string, Map<string, number>>();
/** The catalogue folder each catalogue this window holds originals of announces them in. */
const holdFolders = new Map<string, FileSystemDirectoryHandle>();
/** Catalogues a trim left over their limit because of originals in use: a hold
 *  let go here trims them again. */
const overLimit = new Map<string, { ref: LibrarySourceRef; sl: FileSystemDirectoryHandle }>();
let heartbeat: ReturnType<typeof setInterval> | null = null;

async function ownHeldNames(catalog: string): Promise<string[]> {
  return Promise.all([...(holds.get(catalog)?.keys() ?? [])].map(originalName));
}

/** Write what this window holds in the catalogue `sl` for the other windows, now:
 *  removed once it holds nothing. */
async function announceHolds(catalog: string, sl: FileSystemDirectoryHandle): Promise<void> {
  const dir = await sl.getDirectoryHandle(HELD_DIR, { create: true });
  // Taken after the wait: a hold taken meanwhile is announced too.
  const names = await ownHeldNames(catalog);
  if (names.length === 0) {
    await removeEntry(dir, thisWindow());
    // A hold taken while the file was removed is announced, and renewed, after all.
    if (holds.has(catalog)) await announceHolds(catalog, sl);
    else holdFolders.delete(catalog);
    return;
  }
  const held: HeldFile = { version: 1, at: Date.now(), names };
  await writeJSON(dir, thisWindow(), held);
}

/** Renew this window's holds while it has any; nothing runs while it has none. */
function keepHeartbeat(): void {
  if (holds.size === 0) {
    if (heartbeat !== null) clearInterval(heartbeat);
    heartbeat = null;
    return;
  }
  heartbeat ??= setInterval(() => {
    for (const [catalog, sl] of holdFolders) inBackground(catalog, () => announceHolds(catalog, sl));
  }, HEARTBEAT_MS);
}

/** Keep the originals behind these handles (the photo open in Develop, the
 *  photos of an export) from being removed, in this window and the others on
 *  the same catalogue, until the returned function is called. Handles that
 *  aren't a source's are passed over. */
export function holdSourceOriginals(handles: readonly unknown[]): () => void {
  const held = handles.flatMap((h) => {
    const file = fileOf(h);
    return file ? [{ catalog: catalogKey(file.state.ref), key: file.item.key, sl: file.state.cache }] : [];
  });
  for (const { catalog, key, sl } of held) {
    const keys = holds.get(catalog) ?? new Map<string, number>();
    keys.set(key, (keys.get(key) ?? 0) + 1);
    holds.set(catalog, keys);
    if (sl) holdFolders.set(catalog, sl);
  }
  const announce = () => {
    for (const catalog of new Set(held.map((h) => h.catalog))) {
      const sl = holdFolders.get(catalog);
      if (sl) inBackground(catalog, () => announceHolds(catalog, sl));
    }
  };
  announce();
  keepHeartbeat();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const { catalog, key } of held) {
      const keys = holds.get(catalog);
      const n = (keys?.get(key) ?? 1) - 1;
      if (n > 0) keys!.set(key, n);
      else keys?.delete(key);
      if (keys?.size === 0) holds.delete(catalog);
    }
    announce();
    keepHeartbeat();
    for (const catalog of new Set(held.map((h) => h.catalog))) {
      const waiting = overLimit.get(catalog);
      if (waiting) inBackground(catalog, () => trim(waiting.ref, waiting.sl, limitFor(waiting.ref)));
    }
  };
}

/** The originals in use in any window: this one's holds, and those the others
 *  announced and renewed within HOLD_LAPSE_MS. */
async function heldNames(catalog: string, sl: FileSystemDirectoryHandle): Promise<Set<string>> {
  const names = new Set(await ownHeldNames(catalog));
  const now = Date.now();
  const forgotten: string[] = [];
  for (const [file, held] of await jsonFiles<HeldFile>(sl, HELD_DIR)) {
    if (file === thisWindow()) continue;
    const at = typeof held.at === "number" ? held.at : 0;
    if (now - at > HELD_FORGET_MS) forgotten.push(file);
    else if (held.version === 1 && Array.isArray(held.names) && now - at <= HOLD_LAPSE_MS)
      for (const name of held.names) if (typeof name === "string") names.add(name);
  }
  if (forgotten.length > 0) {
    const dir = await sl.getDirectoryHandle(HELD_DIR);
    for (const file of forgotten) await removeEntry(dir, file);
  }
  return names;
}

/** The limit the registration behind `ref` sets; the default when it sets none
 *  or is gone. */
function limitFor(ref: LibrarySourceRef): number | null {
  const held = useSourceStore.getState().sources[ref.id];
  const limit = held?.extensionId === ref.extensionId ? held.keptOriginalsLimit : undefined;
  return limit === undefined ? DEFAULT_KEPT_ORIGINALS_LIMIT : limit;
}

const usedOf = (file: UsedFile | undefined): Record<string, number> =>
  file?.version === 1 && isPlainObject(file.used)
    ? Object.fromEntries(Object.entries(file.used).filter(([, at]) => typeof at === "number"))
    : {};

/** When each original was last used, in any window. */
async function readUsed(sl: FileSystemDirectoryHandle): Promise<Record<string, number>> {
  const used: Record<string, number> = {};
  for (const file of (await jsonFiles<UsedFile>(sl, USED_DIR)).values())
    for (const [name, at] of Object.entries(usedOf(file))) used[name] = Math.max(used[name] ?? 0, at);
  return used;
}

async function writeOwnUsed(sl: FileSystemDirectoryHandle, used: Record<string, number>): Promise<void> {
  const file: UsedFile = { version: 1, at: Date.now(), used };
  const dir = await sl.getDirectoryHandle(USED_DIR, { create: true });
  await writeJSON(dir, thisWindow(), file).catch((e: unknown) =>
    console.warn("[sources] kept originals' use times weren't saved:", e),
  );
}

let lastUse = 0;

/** Note that the kept original `name` was used now. Two uses in one millisecond
 *  still count in the order they came. */
async function noteUsed(sl: FileSystemDirectoryHandle, name: string): Promise<void> {
  lastUse = Math.max(Date.now(), lastUse + 1);
  const own = usedOf((await jsonFiles<UsedFile>(sl, USED_DIR)).get(thisWindow()));
  own[name] = lastUse;
  await writeOwnUsed(sl, own);
}

/** Drop the removed originals from this window's use times, and fold in those of
 *  windows untouched for USED_FOLD_MS (still kept ones only), removing their files. */
async function forgetUsed(sl: FileSystemDirectoryHandle, removed: ReadonlySet<string>, kept: ReadonlySet<string>): Promise<void> {
  const files = await jsonFiles<UsedFile>(sl, USED_DIR);
  const own = usedOf(files.get(thisWindow()));
  const folded: string[] = [];
  const now = Date.now();
  for (const [name, file] of files) {
    if (name === thisWindow() || !(now - (file.at ?? 0) > USED_FOLD_MS)) continue;
    for (const [original, at] of Object.entries(usedOf(file)))
      if (kept.has(original)) own[original] = Math.max(own[original] ?? 0, at);
    folded.push(name);
  }
  for (const name of removed) delete own[name];
  await writeOwnUsed(sl, own);
  if (folded.length === 0) return;
  const dir = await sl.getDirectoryHandle(USED_DIR);
  for (const name of folded) await removeEntry(dir, name);
}

/** The kept originals and their sizes, from the folder's listing: a desktop
 *  listing gives sizes without reading the files. */
async function keptFiles(sl: FileSystemDirectoryHandle): Promise<{ name: string; size: number }[]> {
  const files: { name: string; size: number }[] = [];
  try {
    const dir = await sl.getDirectoryHandle(ORIGINALS_DIR);
    for await (const entry of dir.values()) {
      if (entry.kind !== "file") continue;
      const size = nativeSizeOf(entry) ?? (await (entry as FileSystemFileHandle).getFile()).size;
      files.push({ name: entry.name, size });
    }
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  return files;
}

/** Remove kept originals, those used longest ago first, until they take no more
 *  than `limit` bytes. Originals in use in any window stay, and so does `spare`
 *  (the one just kept); a catalogue they leave over its limit is trimmed again
 *  when a hold is let go here, or at the next original kept. */
async function trim(
  ref: LibrarySourceRef,
  sl: FileSystemDirectoryHandle,
  limit: number | null,
  spare?: string,
): Promise<void> {
  const catalog = catalogKey(ref);
  overLimit.delete(catalog);
  if (limit === null) return;
  const files = await keptFiles(sl);
  let total = files.reduce((sum, f) => sum + f.size, 0);
  if (total <= limit) return;
  const used = await readUsed(sl);
  const inUse = await heldNames(catalog, sl);
  const dir = await sl.getDirectoryHandle(ORIGINALS_DIR);
  const oldestFirst = files
    .filter((f) => f.name !== spare && !inUse.has(f.name))
    .sort((a, b) => (used[a.name] ?? 0) - (used[b.name] ?? 0));
  const removed = new Set<string>();
  for (const file of oldestFirst) {
    if (total <= limit) break;
    await removeEntry(dir, file.name);
    removed.add(file.name);
    total -= file.size;
  }
  await forgetUsed(sl, removed, new Set(files.flatMap((f) => (removed.has(f.name) ? [] : [f.name]))));
  if (total > limit) overLimit.set(catalog, { ref, sl });
}

/** Bring the originals kept in the catalogue `sl` of `ref` within `limit` bytes
 *  (null: no limit), as when the source's limit is lowered. */
export function trimKeptOriginals(ref: LibrarySourceRef, sl: FileSystemDirectoryHandle, limit: number | null): Promise<void> {
  return inTurn(catalogKey(ref), () => trim(ref, sl, limit));
}

/** How many originals the catalogue `sl` keeps, and their bytes. */
export async function keptOriginalsUsage(sl: FileSystemDirectoryHandle): Promise<{ count: number; bytes: number }> {
  const files = await keptFiles(sl);
  return { count: files.length, bytes: files.reduce((sum, f) => sum + f.size, 0) };
}

/** Remove the originals kept in the catalogue `sl` of `ref`, but for those in
 *  use in any window. Each is read again from the source when it is next needed. */
export function clearKeptOriginals(
  ref: LibrarySourceRef,
  sl: FileSystemDirectoryHandle,
): Promise<{ removed: number; kept: number }> {
  const catalog = catalogKey(ref);
  return inTurn(catalog, async () => {
    const files = await keptFiles(sl);
    if (files.length === 0) return { removed: 0, kept: 0 };
    const inUse = await heldNames(catalog, sl);
    const dir = await sl.getDirectoryHandle(ORIGINALS_DIR);
    const removed = new Set<string>();
    for (const file of files) {
      if (inUse.has(file.name)) continue;
      await removeEntry(dir, file.name);
      removed.add(file.name);
    }
    await forgetUsed(sl, removed, new Set([...inUse].filter((name) => files.some((f) => f.name === name))));
    overLimit.delete(catalog);
    return { removed: removed.size, kept: files.length - removed.size };
  });
}

/** Whether the original behind a source file handle is kept on disk, so reading
 *  it costs no download. False for any other handle. */
export async function sourceOriginalHeld(handle: unknown): Promise<boolean> {
  const file = fileOf(handle);
  return file ? (await keptOriginal(file.state, file.item)) !== null : false;
}

/** Bytes [start, end) of a source file's original when it is kept on disk;
 *  otherwise no bytes, with the size and time the listing gave. Never fetches. */
export async function readSourceFileSlice(handle: FileSystemFileHandle, start: number, end: number): Promise<FileSlice> {
  const file = fileOf(handle);
  if (!file) throw new TypeError("not a library source file");
  const { item } = file;
  const listed = { lastModified: item.modified ?? 0, type: item.mimeType ?? "" };
  const kept = await keptOriginal(file.state, item);
  if (kept) {
    try {
      const { data, size } = await keptSlice(kept, start, end);
      return { data, size, ...listed };
    } catch {
      // Removed since (a trim): as if it weren't kept.
    }
  }
  return { data: new Uint8Array(0), size: item.size ?? 0, ...listed };
}

/** The source's own preview of the photo behind a source file handle. `signal`
 *  stops the read (its photo left the grid's view). */
export async function readSourcePreview(
  handle: FileSystemFileHandle,
  maxEdge: number,
  signal?: AbortSignal,
): Promise<Blob> {
  const file = fileOf(handle);
  if (!file) throw new TypeError("not a library source file");
  // Each cell on screen would wait out its own time limit on a server the open
  // already found unreachable: none is asked until the next open.
  if (file.state.offline) throw new Error(`“${file.state.ref.name}” can't be reached`);
  const src = contribution(file.state);
  const blob = await bounded(
    (inner) => src.readPreview(file.item, { maxEdge, signal: inner }),
    PREVIEW_TIMEOUT_MS,
    `Reading the preview of ${file.name}`,
    signal,
  );
  if (!(blob instanceof Blob)) throw new TypeError(`the source gave no preview for ${file.name}`);
  return blob;
}
