// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What the prompt editor knows while you type: a snapshot the session already
// holds. Nothing here reads a file or waits; a lookup that misses returns
// undefined and the owner of the snapshot fetches it in the background.

import path from "node:path";
import { isSupportedName } from "@/catalog/photo-names";
import type { CommandSpec, ValueInfo } from "../types";
import type { WorkingInfo } from "./working";

export interface DirEntry { name: string; dir: boolean }

/** A word the prompt itself understands (`cd`, `exit`), described like a verb. */
export interface BuiltinSpec { verb: string; aliases?: string[]; usage: string; summary: string }

export interface PhotoFact {
  /** From the prompt's folder, "/"-separated; "../" for photos above it. */
  rel: string;
  rating: number;
  flag: "pick" | "reject" | "none";
  label: string;
}

export interface PhotoLook {
  /** By ValueInfo.key. */
  values: ReadonlyMap<string, unknown>;
  step: { at: number; of: number } | null;
}

export interface PromptContextInput {
  platform: NodeJS.Platform;
  cwd: string;
  commands: readonly CommandSpec[];
  builtins: readonly BuiltinSpec[];
  history: readonly string[];
  projectName: string | null;
  /** The project's photos; null outside a project or until they are read. */
  photos: readonly PhotoFact[] | null;
  values: readonly ValueInfo[];
  extensionNames: readonly string[];
  /** A photo's current values (by `rel`); undefined until read, and asking starts the read. */
  look(rel: string): PhotoLook | undefined;
  /** A folder's entries; undefined until read, and asking starts the read. */
  dir(abs: string): readonly DirEntry[] | undefined;
  /** The photos `open` holds; null or absent when none are open. */
  working?: WorkingInfo | null;
  /** The line that puts the last error right, for the ghost; null when there is none. */
  fix?: string | null;
  /** The folder the last `ls` listed, from the prompt's folder ("" for it); null before one ran. */
  listed?: string | null;
  /** The project's folder; null outside a project or until it is read. */
  root?: string | null;
  /** Safelight has the project open, so writes are refused. */
  readOnly?: boolean;
}

/** A folder's entry as the prompt lists it: `photo` when the catalogue has it, `fresh` when only the disk does. */
export interface IndexEntry { name: string; dir: boolean; photo?: PhotoFact; fresh?: boolean }

/** How a folder's files stand with the catalogue, from its disk listing. */
export interface FolderCounts { photos: number; notImported: number; gone: number }

export interface PhotoIndex {
  /** The photo a typed path names. */
  find(typed: string): PhotoFact | undefined;
  /** A typed path is a folder holding photos. */
  isFolder(typed: string): boolean;
  /** The folders and photos directly in `dirRel` ("" for the prompt's folder), with the photos on disk not imported yet. */
  children(dirRel: string): readonly IndexEntry[];
  /** A typed path is a photo on disk the catalogue doesn't have. */
  fresh(typed: string): boolean;
  /** `dirRel`'s photos on disk, how many aren't imported, and how many records lost their file; undefined until read. */
  counts(dirRel: string): FolderCounts | undefined;
  /** `rel` of a typed path, "/"-separated, without resolving it on disk. */
  relOf(typed: string): string;
  all: readonly PhotoFact[];
}

export interface PromptContext extends PromptContextInput {
  /** Names compare without case on Windows and macOS. */
  fold: boolean;
  index: PhotoIndex | null;
  /** The open photo a command naming none acts on. */
  current: PhotoFact | null;
  valueOf(key: string): ValueInfo | undefined;
}

export const isPhotoName = (name: string): boolean => isSupportedName(name);

/** How value keys are matched, as the values service does. */
export const normKey = (key: string): string => key.trim().toLowerCase().replaceAll("colour", "color");

function createPhotoIndex(
  photos: readonly PhotoFact[],
  cwd: string,
  platform: NodeJS.Platform,
  fold: boolean,
  dir: PromptContextInput["dir"],
): PhotoIndex {
  const p = platform === "win32" ? path.win32 : path.posix;
  const keyOf = (rel: string): string => {
    const nfc = rel.normalize("NFC");
    return fold ? nfc.toLowerCase() : nfc;
  };
  const byKey = new Map(photos.map((photo) => [keyOf(photo.rel), photo]));
  const folders = new Set<string>();
  for (const photo of photos) {
    for (let cut = photo.rel.lastIndexOf("/"); cut > 0; cut = photo.rel.lastIndexOf("/", cut - 1)) {
      const folder = keyOf(photo.rel.slice(0, cut));
      if (folders.has(folder)) break;
      folders.add(folder);
    }
  }
  const listings = new Map<string, IndexEntry[]>();

  const relOf = (typed: string): string => {
    const rel = p.relative(cwd, p.resolve(cwd, typed));
    return platform === "win32" ? rel.replace(/\\/g, "/") : rel;
  };
  const onDisk = (dirRel: string): readonly DirEntry[] | undefined => dir(p.resolve(cwd, dirRel));

  function children(dirRel: string): readonly IndexEntry[] {
    const wanted = keyOf(dirRel.replace(/\/+$/, ""));
    const cached = listings.get(wanted);
    if (cached) return cached;
    const prefix = wanted === "" ? "" : `${wanted}/`;
    const seen = new Set<string>();
    const entries: IndexEntry[] = [];
    for (const photo of photos) {
      const key = keyOf(photo.rel);
      if (!key.startsWith(prefix) || (prefix === "" && key.startsWith("../"))) continue;
      const rest = photo.rel.slice(prefix.length);
      const slash = rest.indexOf("/");
      const name = slash < 0 ? rest : rest.slice(0, slash);
      if (slash >= 0) {
        if (seen.has(keyOf(name))) continue;
        seen.add(keyOf(name));
        entries.push({ name, dir: true });
      } else entries.push({ name, dir: false, photo });
    }
    // The disk listing arrives later; until it does, the catalogue's answer isn't kept.
    const disk = onDisk(dirRel);
    if (!disk) return entries;
    const known = new Set(entries.map((e) => keyOf(e.name)));
    for (const entry of disk) {
      if (known.has(keyOf(entry.name))) continue;
      if (entry.dir) entries.push({ name: entry.name, dir: true });
      else if (isPhotoName(entry.name)) entries.push({ name: entry.name, dir: false, fresh: true });
    }
    listings.set(wanted, entries);
    return entries;
  }

  return {
    all: photos,
    relOf,
    find: (typed) => byKey.get(keyOf(relOf(typed))),
    isFolder(typed) {
      const rel = relOf(typed);
      if (rel === "" || folders.has(keyOf(rel))) return true;
      const cut = rel.lastIndexOf("/");
      const name = keyOf(rel.slice(cut + 1));
      return children(cut < 0 ? "" : rel.slice(0, cut)).some((e) => e.dir && keyOf(e.name) === name);
    },
    children,
    fresh(typed) {
      const rel = relOf(typed);
      if (byKey.has(keyOf(rel))) return false;
      const cut = rel.lastIndexOf("/");
      const name = keyOf(rel.slice(cut + 1));
      return children(cut < 0 ? "" : rel.slice(0, cut)).some((e) => e.fresh === true && keyOf(e.name) === name);
    },
    counts(dirRel) {
      const disk = onDisk(dirRel);
      if (!disk) return undefined;
      const files = new Set(disk.filter((e) => !e.dir && isPhotoName(e.name)).map((e) => keyOf(e.name)));
      const entries = children(dirRel);
      return {
        photos: files.size,
        notImported: entries.filter((e) => e.fresh === true).length,
        gone: entries.filter((e) => e.photo !== undefined && !files.has(keyOf(e.name))).length,
      };
    },
  };
}

export function createPromptContext(input: PromptContextInput): PromptContext {
  const fold = input.platform === "win32" || input.platform === "darwin";
  const byKey = new Map<string, ValueInfo>();
  for (const info of input.values) if (!byKey.has(normKey(info.key))) byKey.set(normKey(info.key), info);
  const index = input.photos ? createPhotoIndex(input.photos, input.cwd, input.platform, fold, input.dir) : null;
  const rel = input.working ? input.working.rels[input.working.at] : undefined;
  return {
    ...input,
    fold,
    index,
    current: rel === undefined ? null : index?.find(rel) ?? { rel, rating: 0, flag: "none", label: "none" },
    valueOf: (key) => byKey.get(normKey(key)),
  };
}
