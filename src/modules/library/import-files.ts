// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Ingest: files an extension hands over (a tether, a watch folder, a download)
// become photos of the open project. Each is written into a folder of the
// project, then imported the way the project scan imports a new file.

import type { CatalogPhoto } from "@/catalog/types";
import { useCatalogStore } from "@/state/catalog-store";
import { useProjectStore } from "@/project/project-store";
import { nativeFs, nativePathOf } from "@/project/native-fs";
import { fsErrorText } from "@/project/fs-errors";
import { isNotFound } from "@/project/fs";
import { SYSTEM_FOLDERS } from "@/project/scan";
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
}

export type IngestResult = { name: string; id: string } | { name: string; error: string };

/** The longest entry name taken: the temporary name beside it adds about 45. */
const MAX_NAME_LENGTH = 200;

const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Whether `name` is one plain entry name the project scan will list again. A name
 *  starting with "." (".", "..", .safelight) is skipped by the scan, so the photo
 *  would vanish on reopen. Separators, drive letters, control characters and the
 *  characters Windows can't keep would let a name leave its folder or fail on one
 *  platform only, as would a Windows device name; a trailing dot or space is
 *  dropped by Windows, so it would name another file than the one checked. */
function isEntryName(name: string): boolean {
  if (!name || name.length > MAX_NAME_LENGTH || name.startsWith(".")) return false;
  if (/[<>:"|?*\\/]/.test(name)) return false;
  if (/[. ]$/.test(name) || WINDOWS_DEVICE.test(name)) return false;
  return ![...name].some((c) => c.charCodeAt(0) < 32);
}

/** The names of `folder`, or null when it isn't a folder inside the project that
 *  the scan descends into. */
function folderSegments(folder: unknown): string[] | null {
  if (folder === undefined || folder === "") return [];
  if (typeof folder !== "string") return null;
  const segments = folder.split("/");
  const ok = segments.every((s) => isEntryName(s) && !SYSTEM_FOLDERS.has(s.toLowerCase()));
  return ok ? segments : null;
}

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
    await useCatalogStore.getState().addPhotos([photo]);
    return { name, id: photo.id };
  } catch (error) {
    await dir.removeEntry(name).catch(() => {});
    return fail(`Couldn't import “${name}”: ${fsErrorText(error, { op: "read" })}.`);
  }
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
    const segments = folderSegments(options?.folder);
    const refuse = (error: string): IngestResult[] =>
      files.map((file) => ({ name: entryName(file), error }));
    if (!root) return refuse("No project is open.");
    if (!segments) return refuse("The folder must be a plain path inside the project.");

    const keywords = cleanKeywords(options?.keywords);
    const results: IngestResult[] = [];
    for (const file of files) {
      results.push(
        isIngestFile(file)
          ? await ingestOne(root, segments, file, keywords)
          : { name: entryName(file), error: "Each file needs a name and its data as a Blob." },
      );
    }
    if (results.some((r) => "id" in r)) await useProjectStore.getState().refreshTree();
    return results;
  };
  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next;
}
