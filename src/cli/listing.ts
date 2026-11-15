// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What is on disk, set against what the catalogue holds: the folders and photos
// `ls` shows, each photo imported, new, removed from the catalogue or missing.
// It reads the disk with the project scan itself, so "new" is exactly what an
// import would take in, and it never starts the engine or takes a lock.

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { isSupportedName } from "@/catalog/photo-names";
import type { CatalogPhoto } from "@/catalog/types";
import type { FolderNode } from "@/project/folder-node";
import { expandGlob, hasGlob, splitGlob } from "./glob";
import { isEdited } from "./select";
import type { CliEnv, PhotoFilters, ProjectRef, ProjectService, ReadSession } from "./types";

export type ListState = "imported" | "new" | "removed" | "missing";
export const LIST_STATES: readonly ListState[] = ["imported", "new", "removed", "missing"];

export type ListSort = "name" | "date" | "rating" | "size" | "edited" | "imported";
export const LIST_SORTS: readonly ListSort[] = ["name", "date", "rating", "size", "edited", "imported"];

export interface ListRequest {
  /** Photos, globs and folders as typed; none lists `cwd`. */
  specs: string[];
  cwd: string;
  platform: NodeJS.Platform;
  recursive: boolean;
  /** Folders only, nested. */
  tree: boolean;
  /** Levels of a tree below the folder listed; Infinity for all. */
  depth: number;
  sort: ListSort;
  reverse: boolean;
  /** Only photos in these states; none means every state, or the catalogue's when a filter asks. */
  states: readonly ListState[];
  filters: PhotoFilters;
  /** The whole project, whatever folder `cwd` is in. */
  all: boolean;
  projectOverride: string | null;
}

export interface ListedPhoto {
  state: ListState;
  /** Absolute. */
  path: string;
  /** From the project folder, "/" separated; from the folder listed outside a project. */
  relPath: string;
  /** As listed: from the folder named, or from `cwd` for a named file. */
  name: string;
  photo?: CatalogPhoto;
  /** The project whose record `photo` is. */
  project?: ProjectRef;
  edited: boolean;
  /** The history step the photo is on. */
  step?: number;
  /** On disk where known, else the record's. */
  fileSize?: number;
}

export interface ListedFolder {
  path: string;
  relPath: string;
  /** From the folder listed; the folder's own name for the folder itself. */
  name: string;
  /** Levels below the folder listed; 0 is that folder (a tree's first row). */
  depth: number;
  /** Photos in the whole subtree, not counting those removed from the catalogue. */
  photos: number;
  /** Of those, in the catalogue: imported, or imported and since gone from disk. */
  imported: number;
  edited: number;
  picks: number;
  new: number;
}

export interface ListProblem {
  spec: string;
  reason: "not-found" | "no-match" | "not-a-photo";
}

export interface Listing {
  /** The first folder listed. */
  folder: string;
  /** The project of the first thing listed; null outside one. */
  project: ProjectRef | null;
  folders: ListedFolder[];
  photos: ListedPhoto[];
  /** Files in the folders scanned that aren't photos. */
  otherFiles: number;
  problems: ListProblem[];
}

export interface ListingDeps {
  env: CliEnv;
  projects: ProjectService;
}

type Entry = Omit<ListedPhoto, "name">;

interface DiskScan {
  /** Photo files, relative to the folder scanned. */
  files: { path: string; size?: number }[];
  folders: string[];
  unreadable: string[];
  otherFiles: number;
}

interface Classified {
  entries: Entry[];
  /** Relative to the scope's root. */
  folders: string[];
  otherFiles: number;
}

interface Scope {
  ref: ProjectRef | null;
  root: string;
  session: ReadSession | null;
  removed: string[];
  scans: Map<string, Promise<Classified>>;
}

function foldsCase(platform: NodeJS.Platform): boolean {
  return platform === "win32" || platform === "darwin";
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** The project scan lists what it skipped through console, which would land in the output. */
async function scanDisk(dir: string): Promise<DiskScan> {
  const [{ scanProject }, { nativeDirectoryHandle }] = await Promise.all([import("@/project/scan"), import("@/project/native-fs")]);
  const { info, warn } = console;
  console.info = () => {};
  console.warn = () => {};
  try {
    const scan = await scanProject(nativeDirectoryHandle(dir), isSupportedName);
    const folders: string[] = [];
    const collect = (node: FolderNode): void => {
      for (const child of node.children) {
        folders.push(child.path);
        collect(child);
      }
    };
    collect(scan.tree);
    return {
      files: scan.files.map((f) => ({ path: f.path, size: f.size })),
      folders,
      unreadable: scan.unreadable,
      otherFiles: Object.values(scan.skipped).reduce((sum, n) => sum + n, 0),
    };
  } finally {
    console.info = info;
    console.warn = warn;
  }
}

/** The relPaths removed from the catalogue, as the app last saved them. */
async function readRemoved(workingDir: string): Promise<string[]> {
  try {
    const saved: unknown = JSON.parse(await readFile(path.join(workingDir, "catalog.json"), "utf8"));
    const removed = typeof saved === "object" && saved !== null ? (saved as { removed?: unknown }).removed : undefined;
    return Array.isArray(removed) ? (removed as unknown[]).filter((r): r is string => typeof r === "string") : [];
  } catch {
    // A catalogue that can't be read as it is has no tombstones to show.
    return [];
  }
}

function relativeTo(root: string, abs: string): string | null {
  const rel = path.relative(root, abs);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join("/");
}

/** Folder order: segment by segment, so a folder is followed by its own subfolders. */
function byPath(a: string, b: string): number {
  const left = a.split("/");
  const right = b.split("/");
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const c = collator.compare(left[i], right[i]);
    if (c !== 0) return c;
  }
  return left.length - right.length;
}

const dirOf = (relPath: string): string => {
  const at = relPath.lastIndexOf("/");
  return at < 0 ? "" : relPath.slice(0, at);
};

const ancestorsOf = (relPath: string): string[] => {
  const out: string[] = [];
  for (let dir = dirOf(relPath); dir !== ""; dir = dirOf(dir)) out.push(dir);
  return out;
};

export async function listPaths(deps: ListingDeps, req: ListRequest): Promise<Listing> {
  const { projects } = deps;
  const fold = foldsCase(req.platform);
  const key = (text: string): string => {
    const nfc = text.normalize("NFC").replace(/[/\\]+/g, "/");
    return fold ? nfc.toLowerCase() : nfc;
  };
  const absKey = (abs: string): string => key(path.resolve(abs));

  const override = req.projectOverride ? await projects.find(path.resolve(req.cwd, req.projectOverride)) : null;
  const scopes = new Map<string, Scope>();
  const problems: ListProblem[] = [];
  const photos = new Map<string, ListedPhoto>();
  const folders = new Map<string, ListedFolder>();
  const first: { at: { folder: string; project: ProjectRef | null } | null } = { at: null };
  let otherFiles = 0;
  const countedDirs = new Set<string>();

  const catalogueFilter =
    req.filters.rating !== undefined || req.filters.flag !== undefined || req.filters.label !== undefined || req.filters.edited !== undefined;
  const filtered = req.states.length > 0 || catalogueFilter;

  const passes = (e: Entry): boolean => {
    if (req.states.length > 0) {
      if (!req.states.includes(e.state)) return false;
    } else if (catalogueFilter && e.photo === undefined) return false;
    if (!catalogueFilter) return true;
    const f = req.filters;
    const p = e.photo;
    if (!p) return false;
    if (f.rating && (p.rating < f.rating.min || p.rating > f.rating.max)) return false;
    if (f.flag && p.flag !== f.flag) return false;
    if (f.label && p.colorLabel !== f.label) return false;
    if (f.edited !== undefined && e.edited !== f.edited) return false;
    return true;
  };

  /** The scope a path belongs to: its project, or outside one the folder it was named from. */
  const scopeFor = async (abs: string, anchor: string): Promise<Scope> => {
    const ref = override ?? (await projects.find(abs));
    const root = ref?.root ?? anchor;
    const id = absKey(root);
    let scope = scopes.get(id);
    if (!scope) {
      scope = {
        ref,
        root,
        session: ref ? await projects.openRead(ref) : null,
        removed: ref ? await readRemoved(ref.workingDir) : [],
        scans: new Map(),
      };
      scopes.set(id, scope);
    }
    return scope;
  };

  const classify = (scope: Scope, dir: string): Promise<Classified> => {
    const id = absKey(dir);
    let done = scope.scans.get(id);
    if (!done) scope.scans.set(id, (done = classifyDir(scope, dir)));
    return done;
  };

  const classifyDir = async (scope: Scope, dir: string): Promise<Classified> => {
    const prefix = relativeTo(scope.root, dir) ?? "";
    const joined = (rel: string): string => (prefix === "" ? rel : `${prefix}/${rel}`);
    const under = (rel: string): boolean => prefix === "" || key(rel).startsWith(`${key(prefix)}/`);
    const disk = await scanDisk(dir);
    const session = scope.session;
    const records = new Map<string, CatalogPhoto>();
    for (const p of session?.photos() ?? []) if (!p.copyOf && under(p.relPath)) records.set(key(p.relPath), p);
    const removed = new Set(scope.removed.filter(under).map(key));
    const unreadable = disk.unreadable.map((u) => key(joined(u)));
    const entries: Entry[] = [];

    const withRecord = async (state: ListState, relPath: string, record: CatalogPhoto, fileSize: number | undefined): Promise<Entry> => {
      const edit = await session?.edit(record.id);
      return {
        state,
        path: path.join(scope.root, ...relPath.split("/")),
        relPath,
        photo: record,
        ...(scope.ref && { project: scope.ref }),
        edited: isEdited(edit),
        step: edit?.currentIndex ?? 0,
        fileSize: fileSize ?? record.fileSize,
      };
    };

    const seen = new Set<string>();
    for (const file of disk.files) {
      const relPath = joined(file.path);
      const k = key(relPath);
      seen.add(k);
      const record = records.get(k);
      if (record) entries.push(await withRecord("imported", relPath, record, file.size));
      else {
        entries.push({
          state: removed.has(k) ? "removed" : "new",
          path: path.join(scope.root, ...relPath.split("/")),
          relPath,
          edited: false,
          fileSize: file.size,
        });
      }
    }
    for (const [k, record] of records) {
      if (seen.has(k)) continue;
      // A photo under a folder the scan couldn't list is unknown, not gone.
      const unknown = unreadable.some((u) => k.startsWith(`${u}/`));
      entries.push(await withRecord(unknown ? "imported" : "missing", record.relPath, record, undefined));
    }
    return { entries, folders: disk.folders.map(joined), otherFiles: disk.otherFiles };
  };

  const noteDir = (dir: string, count: number): void => {
    const id = absKey(dir);
    if (countedDirs.has(id)) return;
    countedDirs.add(id);
    otherFiles += count;
  };

  const addPhoto = (e: Entry, name: string): void => {
    if (!photos.has(absKey(e.path))) photos.set(absKey(e.path), { ...e, name });
  };

  const listFolder = async (abs: string, recursive: boolean, tree: boolean): Promise<void> => {
    const scope = await scopeFor(abs, abs);
    first.at ??= { folder: abs, project: scope.ref };
    const base = relativeTo(scope.root, abs) ?? "";
    const classified = await classify(scope, abs);
    noteDir(abs, classified.otherFiles);
    const kept = classified.entries.filter(passes);
    const below = (rel: string): string => (base === "" ? rel : rel.slice(base.length + 1));
    const within = (rel: string): boolean => base === "" || key(rel) === key(base) || key(rel).startsWith(`${key(base)}/`);

    if (!tree) {
      for (const e of kept) {
        const here = dirOf(e.relPath);
        if (recursive ? true : key(here) === key(base)) addPhoto(e, below(e.relPath));
      }
    }
    if (recursive && !tree) return;

    const counts = new Map<string, ListedFolder>();
    const folderAt = (rel: string): ListedFolder => {
      let row = counts.get(key(rel));
      if (!row) {
        row = {
          path: path.join(scope.root, ...rel.split("/").filter((s) => s !== "")),
          relPath: rel,
          name: rel === base ? path.basename(abs) : below(rel),
          depth: rel === base ? 0 : below(rel).split("/").length,
          photos: 0, imported: 0, edited: 0, picks: 0, new: 0,
        };
        counts.set(key(rel), row);
      }
      return row;
    };
    folderAt(base);
    for (const rel of classified.folders) if (within(rel)) folderAt(rel);
    for (const e of kept) {
      for (const rel of [...ancestorsOf(e.relPath), ""].filter(within)) {
        const row = folderAt(rel);
        if (e.state === "removed") continue;
        row.photos++;
        if (e.state === "new") row.new++;
        else row.imported++;
        if (e.edited) row.edited++;
        if (e.photo?.flag === "pick") row.picks++;
      }
    }
    const rows = [...counts.values()]
      .filter((row) => (tree ? row.depth <= req.depth : row.depth === 1))
      .filter((row) => row.relPath === base || !filtered || row.photos > 0)
      .filter((row) => tree || row.relPath !== base)
      .sort((a, b) => byPath(a.relPath, b.relPath));
    for (const row of rows) if (!folders.has(absKey(row.path))) folders.set(absKey(row.path), row);
  };

  /** `scanDir` is the folder to scan for it: its own, or for a glob the folder the pattern starts from. */
  const listFile = async (abs: string, spec: string, scanDir: string): Promise<void> => {
    const scope = await scopeFor(abs, scanDir);
    first.at ??= { folder: path.dirname(abs), project: scope.ref };
    const rel = relativeTo(scope.root, abs);
    const classified = await classify(scope, scanDir);
    noteDir(scanDir, classified.otherFiles);
    const entry = rel === null ? undefined : classified.entries.find((e) => key(e.relPath) === key(rel));
    if (!entry) {
      problems.push({ spec, reason: "not-a-photo" });
      return;
    }
    if (passes(entry)) {
      const shown = path.relative(req.cwd, abs).split(path.sep).join("/");
      addPhoto(entry, shown.startsWith("../") || path.isAbsolute(shown) ? entry.relPath : shown);
    }
  };

  try {
    const specs = req.all || req.specs.length === 0 ? [] : req.specs;
    if (req.all) {
      const ref = override ?? (await projects.find(req.cwd));
      await listFolder(ref?.root ?? req.cwd, true, req.tree);
    } else if (specs.length === 0) {
      await listFolder(path.resolve(req.cwd), req.recursive, req.tree);
    }
    for (const spec of specs) {
      const abs = path.resolve(req.cwd, spec);
      const info = await stat(abs).catch(() => null);
      if (info?.isDirectory()) await listFolder(abs, req.recursive, req.tree);
      else if (info) await listFile(abs, spec, path.dirname(abs));
      else if (hasGlob(spec)) {
        const matched = (await expandGlob(spec, req.cwd, req.platform)).filter((file) => isSupportedName(path.basename(file)));
        if (matched.length === 0) problems.push({ spec, reason: "no-match" });
        const base = path.resolve(req.cwd, splitGlob(spec, req.platform).base);
        for (const file of matched) await listFile(file, spec, relativeTo(base, file) === null ? path.dirname(file) : base);
      } else problems.push({ spec, reason: "not-found" });
    }
  } finally {
    await Promise.allSettled([...scopes.values()].map((s) => s.session?.close()));
  }

  const sortKey = (p: ListedPhoto): number | undefined => {
    switch (req.sort) {
      case "rating": return p.photo?.rating;
      case "date": return p.photo?.dateCreated;
      case "size": return p.photo?.fileSize ?? p.fileSize;
      case "edited": return p.photo ? (p.edited ? 0 : 1) : undefined;
      case "imported": return p.photo?.dateImported;
      case "name": return undefined;
    }
  };
  const ordered = [...photos.values()].sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    if (ka !== kb) {
      if (ka === undefined) return 1;
      if (kb === undefined) return -1;
      return ka - kb;
    }
    return collator.compare(a.name, b.name);
  });
  if (req.reverse) ordered.reverse();

  return {
    folder: first.at?.folder ?? path.resolve(req.cwd),
    project: first.at?.project ?? null,
    folders: [...folders.values()],
    photos: ordered,
    otherFiles,
    problems,
  };
}
