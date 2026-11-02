// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Which card a separate catalog belongs to. A separate catalog is keyed by its
// source's path, and every card a camera formats mounts at the same one (E:\,
// /Volumes/EOS_DIGITAL) with photos named alike, so the path can't tell two cards
// apart. A print can: a sample of the catalog's photos, each a path, a size and a
// capture time, kept in the catalog's source.json.
//
// A catalog is taken for another card's only on evidence that it is one. Either
// most of the sampled photos that are on the card are other photos under their
// names (another size and another capture time; with no time to compare on
// either side, the size alone), or none of the catalog's photos is on a card that
// holds something. A photo gone from the card says nothing: photos are erased in
// camera, moved and renamed. A photo rewritten in place (geotagged, rated by
// another program) keeps its capture time. Nor does a file that can't be read
// right now (a virus scanner holds it, a slow reader times out).

import { parseExif } from "@/catalog/exif";
import type { NativeFsBridge } from "@/extensions/types";
import { isNotFound, isPlainObject, parseJSONObject } from "./fs";

/** How many of a catalog's photos its print samples. */
const SAMPLED = 16;

/** How many of a catalog's folders are listed to look for any of its photos. */
const LISTED_FOLDERS = 64;

/** As far into a file as parseExif reads. */
const EXIF_BYTES = 1 << 20;

interface Sampled {
  relPath: string;
  size: number;
  /** The EXIF capture time, when the photo has one. */
  shot?: string;
}

interface Photo {
  relPath: string;
  fileSize: number;
  exif?: { dateTimeOriginal?: string };
}

/** What a folder says of a separate catalog: it is that folder's, it is another
 *  card's, or it gives no sign either way. */
export type VolumeVerdict = "same" | "other" | "unknown";

const stripSlash = (p: string) => p.replace(/[/\\]+$/, "");
const folderOf = (relPath: string) => relPath.slice(0, Math.max(0, relPath.lastIndexOf("/")));
const nameOf = (relPath: string) => relPath.slice(relPath.lastIndexOf("/") + 1).normalize("NFC");

/** The source.json beside a separate .safelight working dir. */
const sourceJsonOf = (slDir: string) => {
  const sl = stripSlash(slDir);
  return `${sl.slice(0, Math.max(sl.lastIndexOf("/"), sl.lastIndexOf("\\")))}/source.json`;
};

/** Up to SAMPLED of `photos`, spread evenly over them in path order. */
function sampleOf(photos: Photo[]): Sampled[] {
  const sorted = [...photos].sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  const step = Math.max(1, sorted.length / SAMPLED);
  const sample: Sampled[] = [];
  for (let i = 0; i < sorted.length && sample.length < SAMPLED; i += step) {
    const { relPath, fileSize, exif } = sorted[Math.floor(i)];
    const shot = exif?.dateTimeOriginal;
    sample.push(shot ? { relPath, size: fileSize, shot } : { relPath, size: fileSize });
  }
  return sample;
}

const isSampled = (entry: unknown): entry is Sampled =>
  isPlainObject(entry) &&
  typeof entry.relPath === "string" &&
  typeof entry.size === "number" &&
  (entry.shot === undefined || typeof entry.shot === "string");

/** A master record: a virtual copy owns no file of its own. */
const isPhoto = (record: unknown): record is Photo =>
  isPlainObject(record) &&
  !record.copyOf &&
  typeof record.relPath === "string" &&
  typeof record.fileSize === "number" &&
  (record.exif === undefined || isPlainObject(record.exif));

/** A file's contents as a JSON object, or null when it isn't there or isn't one. */
async function readObject(fs: NativeFsBridge, path: string): Promise<Record<string, unknown> | null> {
  try {
    return parseJSONObject((await fs.read(path)).data);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** The photos catalog.json holds. */
async function photosOf(fs: NativeFsBridge, slDir: string): Promise<Photo[]> {
  const photos = (await readObject(fs, `${stripSlash(slDir)}/catalog.json`))?.photos;
  return Array.isArray(photos) ? photos.filter(isPhoto) : [];
}

/** The print of the separate catalog at `slDir`: the one its source.json keeps, or,
 *  for a catalog from before prints were kept, a sample of its photos. */
async function printOf(fs: NativeFsBridge, slDir: string): Promise<Sampled[]> {
  const kept = (await readObject(fs, sourceJsonOf(slDir)))?.volume;
  if (Array.isArray(kept)) return kept.filter(isSampled);
  return sampleOf(await photosOf(fs, slDir));
}

/** A file's EXIF capture time, or undefined when it has none or can't be read. */
async function shotOf(fs: NativeFsBridge, path: string): Promise<string | undefined> {
  try {
    const { data } = await fs.read(path, { start: 0, end: EXIF_BYTES });
    return (await parseExif(new Blob([data as BlobPart]))).dateTimeOriginal;
  } catch {
    return undefined;
  }
}

/** What one sampled photo says: its file is it, is another photo, is gone, or
 *  can't be read right now. */
async function judgeSample(
  fs: NativeFsBridge,
  root: string,
  sampled: Sampled,
): Promise<"match" | "conflict" | "missing" | "unknown"> {
  const path = `${root}/${sampled.relPath}`;
  let size: number;
  try {
    size = (await fs.read(path, { start: 0, end: 0 })).size;
  } catch (error) {
    return isNotFound(error) ? "missing" : "unknown";
  }
  if (size === sampled.size) return "match";
  const shot = sampled.shot ? await shotOf(fs, path) : undefined;
  if (!sampled.shot || !shot) return "conflict";
  return shot === sampled.shot ? "match" : "conflict";
}

/** Whether any of `relPaths` is on the folder at `root`, from a listing of each of
 *  their folders (the first LISTED_FOLDERS), and whether the folder holds anything
 *  at all. */
async function overlap(
  fs: NativeFsBridge,
  root: string,
  relPaths: string[],
): Promise<{ any: boolean; holdsSomething: boolean }> {
  const byFolder = new Map<string, Set<string>>();
  for (const relPath of relPaths) {
    const folder = folderOf(relPath);
    const names = byFolder.get(folder) ?? new Set<string>();
    names.add(nameOf(relPath));
    byFolder.set(folder, names);
  }
  for (const [folder, names] of [...byFolder].slice(0, LISTED_FOLDERS)) {
    const listed = await fs.list(folder ? `${root}/${folder}` : root).catch(() => []);
    if (listed.some((entry) => entry.kind === "file" && names.has(entry.name.normalize("NFC"))))
      return { any: true, holdsSomething: true };
  }
  const top = await fs.list(root).catch(() => []);
  return { any: false, holdsSomething: top.some((entry) => !entry.name.startsWith(".")) };
}

/** What the folder at `rootPath` says of the separate catalog at `slDir` (see the
 *  header): "other" only on evidence it is another card's; "unknown" for a catalog
 *  with no photos, or a print that can't be read right now. */
export async function judgeVolume(
  fs: NativeFsBridge,
  rootPath: string,
  slDir: string,
): Promise<VolumeVerdict> {
  const print = await printOf(fs, slDir).catch((): Sampled[] => []);
  if (print.length === 0) return "unknown";
  const root = stripSlash(rootPath);
  const said = await Promise.all(print.map((sampled) => judgeSample(fs, root, sampled)));
  const matches = said.filter((s) => s === "match").length;
  const conflicts = said.filter((s) => s === "conflict").length;
  if (conflicts * 2 > matches + conflicts) return "other";
  if (matches > 0) return "same";
  if (said.includes("unknown")) return "unknown";
  const relPaths = (await photosOf(fs, slDir).catch((): Photo[] => [])).map((p) => p.relPath);
  const found = await overlap(fs, root, relPaths.length > 0 ? relPaths : print.map((s) => s.relPath));
  if (found.any) return "same";
  return found.holdsSomething ? "other" : "unknown";
}

/** Keep the print of `photos`, the ones found on the source this open as they are
 *  now, in the source.json of the separate catalog at `slDir`, alongside what it
 *  holds; with how many there were and when, for the Stored-catalogs manager. */
export async function recordVolume(
  fs: NativeFsBridge,
  slDir: string,
  photos: Photo[],
): Promise<void> {
  if (photos.length === 0) return;
  const path = sourceJsonOf(slDir);
  const meta = (await readObject(fs, path)) ?? {};
  const print = { ...meta, volume: sampleOf(photos), photos: photos.length, openedAt: Date.now() };
  await fs.write(path, new TextEncoder().encode(JSON.stringify(print)));
}
