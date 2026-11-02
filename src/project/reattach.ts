// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Finds the files that saved photo records lost track of while the app was closed,
// so the open keeps a photo (its id, edits and ratings) rather than dropping it and
// importing its file again as new. A file is the same photo when its path is the
// record's spelled another way (case, Unicode form), or when it was moved or
// renamed and its name, size and date still match the record's. Only a match that
// is the one candidate on both sides is taken: two look-alikes are left alone.

import { parseExif } from "@/catalog/exif";
import type { StoredPhoto } from "@/catalog/types";
import { mapLimit } from "./fs";
import { readFileSlice } from "./native-fs";
import type { ScannedFile } from "./scan";

/** As far into a file as parseExif reads. */
const EXIF_BYTES = 1 << 20;

/** File systems keep modification times to between 100 ns and 2 s (FAT), so a
 *  copy may round one. */
const MTIME_SLACK_MS = 2000;

/** Whether the project's file system takes names that differ only in case for one
 *  name, as NTFS and APFS do by default: on Windows and macOS. */
export function namesFoldCase(): boolean {
  const platform =
    globalThis.window?.safelightNative?.platform ?? globalThis.navigator?.platform ?? "";
  return /^(win|darwin|mac)/i.test(platform);
}

/** The key a path is known by: its NFC form, since macOS hands back names in NFD,
 *  folded to one case where the file system ignores case. */
export function pathKey(relPath: string, foldCase: boolean): string {
  const nfc = relPath.normalize("NFC");
  return foldCase ? nfc.toLowerCase() : nfc;
}

/** What the open hands the search: its cancel signal, and where to report how many
 *  of the capture dates it reads are read. */
interface MoveSearch {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

/** The files among `files` that the records `missing` were made from, each with
 *  its record. `files` are the ones no record or tombstone holds by their exact
 *  path. Only the size and modification time of a file are read until it is the
 *  one candidate for a record; then its capture date, if the record has one. */
export async function findMoved(
  missing: StoredPhoto[],
  files: ScannedFile[],
  foldCase: boolean,
  { signal, onProgress }: MoveSearch = {},
): Promise<Map<ScannedFile, StoredPhoto>> {
  const key = (relPath: string) => pathKey(relPath, foldCase);
  const byPath = uniquePairs(files, missing, (f) => key(f.path), (r) => key(r.relPath));

  const paired = new Set(byPath.map(([file]) => file));
  const taken = new Set(byPath.map(([, record]) => record));
  const records = missing.filter((r) => !taken.has(r));
  const nameKey = (relPath: string) => key(relPath.slice(relPath.lastIndexOf("/") + 1));
  const names = new Set(records.map((r) => nameKey(r.relPath)));
  const candidates = files.filter((f) => !paired.has(f) && names.has(nameKey(f.path)));
  const stats = new Map(
    await mapLimit(
      [...paired, ...candidates],
      8,
      async (f) => [f, await statOf(f, signal)] as const,
    ),
  );

  const sized = (size: number, relPath: string) => `${size}/${nameKey(relPath)}`;
  const byName = uniquePairs(
    candidates,
    records,
    (f) => {
      const stat = stats.get(f);
      return stat ? sized(stat.size, f.path) : null;
    },
    (r) => sized(r.fileSize, r.relPath),
  );
  const named = new Set(byName.map(([file]) => file));
  const namedRecords = new Set(byName.map(([, record]) => record));
  const subSecRecords = records.filter(
    (r) => !namedRecords.has(r) && r.exif?.dateTimeOriginal && r.exif.subSecTimeOriginal,
  );
  const subSecNames = new Set(subSecRecords.map((r) => sized(r.fileSize, r.relPath)));
  const subSecFiles = candidates.filter((f) => {
    const stat = stats.get(f);
    return !named.has(f) && stat && subSecNames.has(sized(stat.size, f.path));
  });
  const shotOf = new Map(
    await mapLimit(subSecFiles, 8, async (f) => [f, await captureOf(f, signal)] as const),
  );
  const bySubSec = uniquePairs(
    subSecFiles,
    subSecRecords,
    (f) => {
      const shot = shotOf.get(f);
      return shot?.subSec ? `${sized(stats.get(f)!.size, f.path)}/${shot.date}.${shot.subSec}` : null;
    },
    (r) => `${sized(r.fileSize, r.relPath)}/${r.exif!.dateTimeOriginal}.${r.exif!.subSecTimeOriginal}`,
  );
  const pairs = [...byPath, ...byName, ...bySubSec].filter(
    ([file, record]) => stats.get(file)?.size === record.fileSize,
  );

  const found = new Map<ScannedFile, StoredPhoto>();
  const shots = pairs.filter(([, record]) => record.exif?.dateTimeOriginal).length;
  let read = 0;
  if (shots > 0) onProgress?.(0, shots);
  await mapLimit(pairs, 8, async ([file, record]) => {
    const shot = record.exif?.dateTimeOriginal;
    const same = shot
      ? !signal?.aborted && sameShot(record, await captureOf(file, signal))
      : Math.abs(record.dateCreated - stats.get(file)!.lastModified) < MTIME_SLACK_MS;
    if (same) found.set(file, record);
    if (shot) onProgress?.(++read, shots);
  });
  return found;
}

/** Whether `file`, under a record's path but of another size, is shown to be
 *  another photo: both carry a capture time and the times differ. A file rewritten
 *  in place (another program wrote metadata into it, a scan re-saved) keeps its
 *  time, or has none to tell by, and is the record's still. */
export async function shotDiffers(record: StoredPhoto, file: ScannedFile): Promise<boolean> {
  if (!record.exif?.dateTimeOriginal) return false;
  const shot = await captureOf(file);
  return !!shot.date && !sameShot(record, shot);
}

/** A file's size and modification time, or null when it can't be read. */
async function statOf(
  file: ScannedFile,
  signal: AbortSignal | undefined,
): Promise<{ size: number; lastModified: number } | null> {
  if (signal?.aborted) return null;
  try {
    const { size, lastModified } = await readFileSlice(file.handle, 0, 0);
    return { size, lastModified };
  } catch {
    return null;
  }
}

interface Capture {
  date?: string;
  subSec?: string;
}

/** A file's EXIF capture time, as a record's exif holds it. */
async function captureOf(file: ScannedFile, signal?: AbortSignal): Promise<Capture> {
  if (signal?.aborted) return {};
  try {
    const { data } = await readFileSlice(file.handle, 0, EXIF_BYTES);
    const { dateTimeOriginal, subSecTimeOriginal } = await parseExif(new Blob([data]));
    return { date: dateTimeOriginal, subSec: subSecTimeOriginal };
  } catch {
    return {};
  }
}

/** The sub-second time counts only when both sides carry one. */
function sameShot(record: StoredPhoto, file: Capture): boolean {
  const subSec = record.exif?.subSecTimeOriginal;
  return (
    file.date === record.exif?.dateTimeOriginal &&
    (!subSec || !file.subSec || subSec === file.subSec)
  );
}

/** Each file paired with the record that shares its key, where neither has another
 *  of its kind with that key. A null key pairs with nothing. */
function uniquePairs(
  files: ScannedFile[],
  records: StoredPhoto[],
  fileKey: (file: ScannedFile) => string | null,
  recordKey: (record: StoredPhoto) => string | null,
): [ScannedFile, StoredPhoto][] {
  const byKey = new Map(group(records, recordKey));
  const pairs: [ScannedFile, StoredPhoto][] = [];
  for (const [k, sharing] of group(files, fileKey)) {
    const matching = byKey.get(k);
    if (sharing.length === 1 && matching?.length === 1) pairs.push([sharing[0], matching[0]]);
  }
  return pairs;
}

function group<T>(items: T[], keyOf: (item: T) => string | null): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = keyOf(item);
    if (k === null) continue;
    const held = groups.get(k);
    if (held) held.push(item);
    else groups.set(k, [item]);
  }
  return [...groups];
}
