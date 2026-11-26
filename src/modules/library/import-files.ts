// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Ingest: files an extension hands over (a tether, a watch folder, a download)
// become photos of the open project. Each is written into a folder of the
// project, then imported the way the project scan imports a new file.

import type { CatalogPhoto } from "@/catalog/types";
import { useCatalogStore } from "@/state/catalog-store";
import { projectPassSignal, useProjectStore } from "@/project/project-store";
import { nativeFs, nativePathOf } from "@/project/native-fs";
import { fsErrorText } from "@/project/fs-errors";
import { isNotFound } from "@/project/fs";
import { folderSegments, isEntryName } from "@/project/entry-names";
import { importPhoto, isSupportedName } from "./import-record";

/** The largest file one call accepts: a blob is held in memory whole while it is
 *  written. */
export const MAX_IMPORT_BYTES = 512 * 2 ** 20;

export interface IngestFile {
  name: string;
  data: Blob;
}

export interface IngestOptions {
  /** A folder of the project, relative to its root with "/" between names; created
   *  if it isn't there. The project root when omitted. */
  folder?: string;
  /** Added to the keywords the file itself carries. */
  keywords?: string[];
  /** Number a name already in use instead of refusing it: "a.jpg" becomes
   *  "a-2.jpg", then "a-3.jpg". Files of one call that share a base name (a RAW
   *  and its JPEG) get the same number, and a sidecar such as "a-2.xmp" left in
   *  the folder holds its number too. Each result taken gives the name written
   *  as `savedAs`. */
  unique?: boolean;
}

/** `name` is always the name the file was handed over with. With `unique`, a
 *  file taken also says the name it was written as in `savedAs`. */
export type IngestResult =
  | { name: string; id: string; savedAs?: string }
  | { name: string; error: string };

const PROJECT_CLOSED = "The project was closed.";

function entryName(entry: unknown): string {
  return typeof entry === "object" && entry !== null && "name" in entry && typeof entry.name === "string"
    ? entry.name
    : "";
}

function isIngestFile(entry: unknown): entry is IngestFile {
  return (
    typeof entry === "object" &&
    entry !== null &&
    "name" in entry &&
    typeof entry.name === "string" &&
    "data" in entry &&
    entry.data instanceof Blob
  );
}

function joinRel(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

async function folderHandle(
  root: FileSystemDirectoryHandle,
  segments: string[],
): Promise<FileSystemDirectoryHandle> {
  let dir = root;
  for (const segment of segments) dir = await dir.getDirectoryHandle(segment, { create: true });
  return dir;
}

async function fileExists(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  const fs = nativeFs();
  const dirPath = nativePathOf(dir);
  if (fs && dirPath) return fs.exists(`${dirPath.replace(/[/\\]+$/, "")}/${name}`);
  try {
    await dir.getFileHandle(name);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

/** Write `data` as `name` in `dir`, whole or not at all. On the desktop it goes to
 *  a temporary name beside the file and is renamed into place; the browser's
 *  writable stream already commits only on close. */
async function writeNew(dir: FileSystemDirectoryHandle, name: string, data: Blob): Promise<void> {
  const fs = nativeFs();
  const dirPath = nativePathOf(dir);
  if (fs && dirPath) {
    const base = dirPath.replace(/[/\\]+$/, "");
    const temp = `${base}/.${name}.${crypto.randomUUID()}.sl-import`;
    try {
      await fs.write(temp, new Uint8Array(await data.arrayBuffer()));
      await fs.move(temp, `${base}/${name}`);
    } catch (error) {
      await fs.remove(temp).catch(() => {});
      throw error;
    }
    return;
  }
  const handle = await dir.getFileHandle(name, { create: true });
  try {
    const writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
  } catch (error) {
    await dir.removeEntry(name).catch(() => {});
    throw error;
  }
}

function withKeywords(photo: CatalogPhoto, added: readonly string[]): string[] {
  const keywords = [...photo.keywords];
  for (const word of added) if (!keywords.includes(word)) keywords.push(word);
  return keywords;
}

function cleanKeywords(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const words = raw.filter((k): k is string => typeof k === "string");
  return [...new Set(words.map((k) => k.trim()).filter(Boolean))];
}

async function ingestOne(
  root: FileSystemDirectoryHandle,
  segments: string[],
  file: IngestFile,
  keywords: readonly string[],
  signal: AbortSignal,
): Promise<IngestResult> {
  const { name } = file;
  const fail = (error: string): IngestResult => ({ name, error });
  if (!isEntryName(name)) return fail("The file name isn't a plain name.");
  if (!isSupportedName(name)) return fail("This type of file isn't supported.");
  if (file.data.size > MAX_IMPORT_BYTES) return fail("The file is too large to import this way.");

  const folder = segments.join("/");
  const relPath = joinRel(folder, name);
  const taken = (p: CatalogPhoto) => !p.copyOf && p.relPath.toLowerCase() === relPath.toLowerCase();
  if (useCatalogStore.getState().photos.some(taken)) {
    return fail(`“${name}” already exists in this folder.`);
  }

  let dir: FileSystemDirectoryHandle;
  let handle: FileSystemFileHandle;
  try {
    dir = await folderHandle(root, segments);
    if (await fileExists(dir, name)) return fail(`“${name}” already exists in this folder.`);
    await writeNew(dir, name, file.data);
    handle = await dir.getFileHandle(name);
  } catch (error) {
    return fail(`Couldn't write “${name}”: ${fsErrorText(error)}.`);
  }

  try {
    const built = await importPhoto(handle, dir);
    if (!built) throw new Error("No decoder could read this file.");
    const photo: CatalogPhoto = {
      ...built,
      relPath,
      folder,
      keywords: withKeywords(built, keywords),
    };
    // The file stays: it is in the left project's folder, whose next scan takes it.
    if (signal.aborted) return fail(PROJECT_CLOSED);
    await useCatalogStore.getState().addPhotos([photo]);
    return { name, id: photo.id };
  } catch (error) {
    await dir.removeEntry(name).catch(() => {});
    return fail(`Couldn't import “${name}”: ${fsErrorText(error, { op: "read" })}.`);
  }
}

function splitName(name: string): { base: string; ext: string } {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? { base: name.slice(0, dot), ext: name.slice(dot) } : { base: name, ext: "" };
}

function numbered(name: string, n: number): string {
  if (n === 1) return name;
  const { base, ext } = splitName(name);
  return `${base}-${n}${ext}`;
}

/** The most numbers tried for one group before its files are refused as taken. */
const MAX_NUMBER = 9999;

/** The name each file is written as when names are made unique: its own while
 *  it is free in the folder, else the lowest number (from 2) under which every
 *  file of its group is free. A group is the files of the call that share a
 *  base name, without two of one name. A file the import refuses anyway keeps
 *  its name, so its error names what it was given. */
async function uniqueNames(
  root: FileSystemDirectoryHandle,
  segments: string[],
  files: readonly unknown[],
): Promise<(string | null)[]> {
  const folder = segments.join("/");
  const groups: { base: string; members: number[] }[] = [];
  const names = files.map((file) =>
    isIngestFile(file) && isEntryName(file.name) && isSupportedName(file.name) ? file.name : null,
  );
  names.forEach((name, i) => {
    if (name === null) return;
    const base = splitName(name).base.toLowerCase();
    const group = groups.find(
      (g) => g.base === base && !g.members.some((m) => names[m]!.toLowerCase() === name.toLowerCase()),
    );
    if (group) group.members.push(i);
    else groups.push({ base, members: [i] });
  });
  if (groups.length === 0) return names;

  const dir = await folderHandle(root, segments);
  const catalogued = new Set(
    useCatalogStore
      .getState()
      .photos.filter((p) => !p.copyOf)
      .map((p) => p.relPath.toLowerCase()),
  );
  const claimed = new Set<string>();
  const free = async (name: string) =>
    !claimed.has(name.toLowerCase()) &&
    !catalogued.has(joinRel(folder, name).toLowerCase()) &&
    !(await fileExists(dir, name)) &&
    !(await fileExists(dir, `${splitName(name).base}.xmp`));

  const out = [...names];
  for (const { members } of groups) {
    for (let n = 1; n <= MAX_NUMBER; n++) {
      const candidates = members.map((m) => numbered(names[m]!, n));
      let allFree = true;
      for (const candidate of candidates) if (!(await free(candidate))) allFree = false;
      if (!allFree) continue;
      members.forEach((m, k) => {
        out[m] = candidates[k];
        claimed.add(candidates[k].toLowerCase());
      });
      break;
    }
  }
  return out;
}

let queue: Promise<unknown> = Promise.resolve();

/** Write each file into the open project and import it as a photo. Results come
 *  back in the order given; a file that can't be taken, whatever the reason, is
 *  reported and leaves the rest unaffected. Nothing is overwritten and nothing
 *  lands outside the project folder. Calls run one after another, since imports
 *  share the decode pool. */
export function importFiles(
  files: readonly IngestFile[],
  options: IngestOptions = {},
): Promise<IngestResult[]> {
  if (!Array.isArray(files)) return Promise.resolve([]);
  const run = async (): Promise<IngestResult[]> => {
    const root = useProjectStore.getState().root;
    const signal = projectPassSignal();
    const segments = folderSegments(options?.folder);
    const refuse = (error: string): IngestResult[] =>
      files.map((file) => ({ name: entryName(file), error }));
    if (!root || !signal) return refuse("No project is open.");
    if (!segments) return refuse("The folder must be a plain path inside the project.");

    const keywords = cleanKeywords(options?.keywords);
    let renamed: (string | null)[] = [];
    if (options?.unique === true) {
      try {
        renamed = await uniqueNames(root, segments, files);
      } catch (error) {
        return files.map((file) => ({ name: entryName(file), error: `Couldn't read the folder: ${fsErrorText(error)}.` }));
      }
    }
    const results: IngestResult[] = [];
    for (const [i, file] of files.entries()) {
      const savedAs = renamed[i];
      if (signal.aborted) results.push({ name: entryName(file), error: PROJECT_CLOSED });
      else if (!isIngestFile(file))
        results.push({ name: entryName(file), error: "Each file needs a name and its data as a Blob." });
      else if (!savedAs) results.push(await ingestOne(root, segments, file, keywords, signal));
      else {
        const result = await ingestOne(root, segments, { name: savedAs, data: file.data }, keywords, signal);
        results.push("id" in result ? { name: file.name, id: result.id, savedAs } : { name: file.name, error: result.error });
      }
    }
    if (!signal.aborted && results.some((r) => "id" in r)) await useProjectStore.getState().refreshTree();
    return results;
  };
  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next;
}
