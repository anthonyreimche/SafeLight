// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What `import` will do, worked out in Node before any engine starts: the
// project (an existing catalogue, or where a new one starts), which new files
// it takes in, what --copy brings in first, and what it refuses. The import
// itself is the engine's (engine/import.ts).

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { readLock, STALE_MS } from "../../electron/file-lock.cjs";
import { isSupportedName } from "@/catalog/photo-names";
import type { ImportScope } from "@/engine/protocol";
import { folderSegments, isEntryName } from "@/project/entry-names";
import { SYSTEM_FOLDERS } from "@/project/scan";
import { SIDECAR_SUFFIX } from "@/project/sidecar";
import type { LockInfo } from "@/project/storage-options";
import { expandGlob, hasGlob } from "./glob";
import { tooBroad } from "./project";
import { CliError, type ProjectRef, COMMAND } from "./types";

export interface PlanInput {
  cwd: string;
  platform: NodeJS.Platform;
  /** The photos and folders typed, globs and all. */
  specs: string[];
  recursive: boolean;
  copy: boolean;
  into: string | null;
  /** --project: the folder a new catalogue starts in. */
  project: string | null;
}

/** One thing typed that the import leaves out, and why. */
export interface Refusal { spec: string; message: string; hint?: string }

/** A file --copy brings into the project before the import. */
export interface CopyJob { from: string; to: string; relPath: string }

export interface ImportPlan {
  root: string;
  name: string;
  /** The catalogue there now; null when the import starts one. */
  existing: ProjectRef | null;
  /** The files already in the project the import takes in; `copies` add theirs once copied. */
  scope: ImportScope;
  copies: CopyJob[];
  refused: Refusal[];
  /** Folders in scope holding a catalogue of their own, when one is started. */
  nested: string[];
}

export type FindProject = (absPath: string) => Promise<ProjectRef | null>;

const CATALOG_FILE = "catalog.json";
const foldsCase = (platform: NodeJS.Platform): boolean => platform === "win32" || platform === "darwin";

const BROAD_WORDS = { drive: "a whole drive", share: "a whole network share", home: "a home folder" } as const;

/** `abs` as a "/" path from `root` ("" for the root itself), or null when it isn't inside it. */
function relUnder(root: string, abs: string, foldCase: boolean): string | null {
  const key = (s: string) => (foldCase ? s.toLowerCase() : s);
  const r = path.resolve(root);
  const a = path.resolve(abs);
  if (key(a) === key(r)) return "";
  const prefix = r.endsWith(path.sep) ? r : `${r}${path.sep}`;
  if (!key(a).startsWith(key(prefix))) return null;
  return a.slice(prefix.length).split(path.sep).join("/");
}

/** Whether the project scan lists `relPath`: no dot names, no system folders. */
function scanned(relPath: string): boolean {
  return relPath === "" || relPath.split("/").every((s) => !s.startsWith(".") && !SYSTEM_FOLDERS.has(s.toLowerCase()));
}

const folderOf = (relPath: string): string => (relPath.includes("/") ? relPath.slice(0, relPath.lastIndexOf("/")) : "");

type Target = { spec: string; abs: string; kind: "file" | "folder" };

async function kindOf(abs: string): Promise<"file" | "folder" | null> {
  try {
    const s = await stat(abs);
    return s.isDirectory() ? "folder" : s.isFile() ? "file" : null;
  } catch {
    return null;
  }
}

async function targetsOf(input: PlanInput, refused: Refusal[]): Promise<Target[]> {
  const targets: Target[] = [];
  for (const spec of input.specs) {
    if (hasGlob(spec)) {
      const matches = (await expandGlob(spec, input.cwd, input.platform)).filter((f) => isSupportedName(path.basename(f)));
      if (matches.length === 0) refused.push({ spec, message: `No photos match ${spec}.` });
      for (const abs of matches) targets.push({ spec, abs, kind: "file" });
      continue;
    }
    const abs = path.resolve(input.cwd, spec);
    const kind = await kindOf(abs);
    if (kind === null) refused.push({ spec, message: `${spec} isn't there.` });
    else if (kind === "file" && !isSupportedName(path.basename(abs))) refused.push({ spec, message: `${spec} isn't a photo Safelight opens.` });
    else targets.push({ spec, abs, kind });
  }
  return targets;
}

async function projectRoot(input: PlanInput, targets: Target[], find: FindProject): Promise<{ root: string; existing: ProjectRef | null }> {
  const foldCase = foldsCase(input.platform);
  if (input.project !== null) {
    const root = path.resolve(input.cwd, input.project);
    if ((await kindOf(root)) !== "folder") throw new CliError(2, `${input.project} isn't a folder.`);
    const found = await find(root);
    const existing = found !== null && relUnder(found.root, root, foldCase) === "" ? found : null;
    return { root, existing };
  }
  const here = await find(input.cwd);
  if (here) return { root: here.root, existing: here };
  // Copies come from outside by nature; only the photos imported where they are place the project.
  const inPlace = input.copy ? [] : targets;
  if (inPlace.length > 0) {
    const there = await find(inPlace[0].abs);
    if (there && inPlace.every((t) => relUnder(there.root, t.abs, foldCase) !== null)) return { root: there.root, existing: there };
  }
  if (!inPlace.every((t) => relUnder(input.cwd, t.abs, foldCase) !== null)) {
    throw new CliError(2, "Name the project folder with --project.", `${COMMAND} import --project <folder> <photos>`);
  }
  return { root: path.resolve(input.cwd), existing: null };
}

async function copyTarget(input: PlanInput, root: string): Promise<{ dir: string; rel: string }> {
  const foldCase = foldsCase(input.platform);
  if (input.into === null) return { dir: root, rel: "" };
  const fromCwd = relUnder(root, input.cwd, foldCase) !== null;
  const dir = path.resolve(fromCwd ? input.cwd : root, input.into);
  const rel = relUnder(root, dir, foldCase);
  if (rel === null || folderSegments(rel) === null) {
    throw new CliError(2, `--into ${input.into} isn't a folder inside ${root}.`);
  }
  return { dir, rel };
}

/** Folders under `root` (not the root itself) holding a catalogue of their own. */
async function nestedCatalogues(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (!entry.isDirectory() || !scanned(entry.name)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const child = path.join(dir, entry.name);
      if ((await kindOf(path.join(child, ".safelight", CATALOG_FILE))) === "file") found.push(childRel);
      await walk(child, childRel);
    }
  };
  await walk(root, "");
  return found;
}

/** Whether the scope reaches photos directly in `folder`. */
function reaches(scope: ImportScope, folder: string): boolean {
  if (scope.kind === "all") return true;
  if (scope.files.some((f) => folderOf(f) === folder)) return true;
  return scope.folders.some((f) => f.relPath === folder || (f.recursive && (f.relPath === "" || folder.startsWith(`${f.relPath}/`))));
}

/** Works out the import from what was typed. Throws CliError 1 for a usage
 *  mistake and 2 for a project it won't use or a file outside it without --copy. */
export async function planImport(input: PlanInput, find: FindProject): Promise<ImportPlan> {
  if (input.into !== null && !input.copy) throw new CliError(1, "--into goes with --copy.");
  if (input.copy && input.specs.length === 0) throw new CliError(1, "--copy needs the files to copy in.");
  const foldCase = foldsCase(input.platform);
  const refused: Refusal[] = [];
  const targets = await targetsOf(input, refused);
  const { root, existing } = await projectRoot(input, targets, find);
  if (existing === null) {
    const broad = tooBroad(root);
    if (broad) throw new CliError(2, `${root} is ${BROAD_WORDS[broad]}. cd into a folder of photos first.`);
  }

  const files: string[] = [];
  const folders: { relPath: string; recursive: boolean }[] = [];
  const copies: CopyJob[] = [];
  const into = input.copy ? await copyTarget(input, root) : null;
  const taken = new Set<string>();
  for (const target of targets) {
    const rel = relUnder(root, target.abs, foldCase);
    if (rel === null || !scanned(rel)) {
      if (into === null) {
        throw new CliError(2, `${target.spec} is outside ${root}.`, `Copy it in: ${COMMAND} import --copy ${target.spec}`);
      }
      if (target.kind === "folder") {
        refused.push({ spec: target.spec, message: `--copy takes files, and ${target.spec} is a folder.` });
        continue;
      }
      const name = path.basename(target.abs);
      const to = path.join(into.dir, name);
      const key = foldCase ? to.toLowerCase() : to;
      if (!isEntryName(name)) refused.push({ spec: target.spec, message: `${name} isn't a name the project can keep.` });
      else if (taken.has(key) || (await kindOf(to)) !== null) refused.push({ spec: target.spec, message: `${name} already exists in ${into.rel || path.basename(root)}.` });
      else {
        taken.add(key);
        copies.push({ from: target.abs, to, relPath: into.rel ? `${into.rel}/${name}` : name });
      }
    } else if (target.kind === "folder") {
      folders.push({ relPath: rel, recursive: input.recursive });
    } else if (!files.includes(rel)) {
      files.push(rel);
    }
  }

  const scope: ImportScope = input.specs.length === 0 ? { kind: "all" } : { kind: "some", files, folders };
  const nested = existing === null ? (await nestedCatalogues(root)).filter((f) => reaches(scope, f)) : [];
  return { root, name: path.basename(root) || root, existing, scope, copies, refused, nested };
}

/** Copies a file into the project, its Safelight sidecar with it, whole or not
 *  at all: to a temporary name beside it, then renamed into place. Never overwrites. */
export async function copyIn(job: CopyJob): Promise<void> {
  const dir = path.dirname(job.to);
  await mkdir(dir, { recursive: true });
  const place = async (from: string, to: string) => {
    const temp = path.join(dir, `.${path.basename(to)}.${randomUUID()}.sl-import`);
    try {
      await copyFile(from, temp, constants.COPYFILE_EXCL);
      if ((await kindOf(to)) !== null) throw new Error(`${path.basename(to)} is already in ${dir}.`);
      await rename(temp, to);
    } finally {
      await rm(temp, { force: true });
    }
  };
  await place(job.from, job.to);
  const sidecar = `${job.from}${SIDECAR_SUFFIX}`;
  if ((await kindOf(sidecar)) === "file" && (await kindOf(`${job.to}${SIDECAR_SUFFIX}`)) === null) {
    await place(sidecar, `${job.to}${SIDECAR_SUFFIX}`);
  }
}

/** The files a scan of the project finds, as the app's scan lists them. */
async function scanFolder(root: string): Promise<{ photos: string[]; others: number }> {
  const photos: string[] = [];
  let others = 0;
  const walk = async (dir: string, rel: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (!scanned(entry.name)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), childRel);
      else if (isSupportedName(entry.name)) photos.push(childRel);
      else if (!entry.name.endsWith(SIDECAR_SUFFIX)) others++;
    }
  };
  await walk(root, "");
  return { photos, others };
}

interface SavedRecords { relPaths: string[]; removed: string[] }

async function savedRecords(workingDir: string): Promise<SavedRecords> {
  let doc: unknown;
  try {
    doc = JSON.parse(await readFile(path.join(workingDir, CATALOG_FILE), "utf8"));
  } catch {
    return { relPaths: [], removed: [] };
  }
  const { photos, removed } = (typeof doc === "object" && doc !== null ? doc : {}) as { photos?: unknown; removed?: unknown };
  const relPaths = Array.isArray(photos)
    ? photos.flatMap((p: unknown) => {
        if (typeof p !== "object" || p === null) return [];
        const { relPath, copyOf } = p as { relPath?: unknown; copyOf?: unknown };
        return typeof relPath === "string" && !copyOf ? [relPath] : [];
      })
    : [];
  return { relPaths, removed: Array.isArray(removed) ? removed.filter((r): r is string => typeof r === "string") : [] };
}

export interface DryRun {
  /** Absolute paths of the photos the import would take in (copies at the place they'd land). */
  new: string[];
  /** relPaths of records whose file isn't there: dropped, or found moved. */
  gone: string[];
  otherFiles: number;
}

/** What the import would do, from the scan and the saved catalogue alone. A
 *  moved photo can't be told without reading files, so it counts among both. */
export async function dryRun(plan: ImportPlan, platform: NodeJS.Platform): Promise<DryRun> {
  const key = (relPath: string) => (foldsCase(platform) ? relPath.toLowerCase() : relPath);
  const scan = await scanFolder(plan.root);
  const saved = plan.existing ? await savedRecords(plan.existing.workingDir) : { relPaths: [], removed: [] };
  const known = new Set(saved.relPaths.map(key));
  const removed = new Set(saved.removed.map(key));
  const named = new Set(plan.scope.kind === "some" ? plan.scope.files.map(key) : []);
  const onDisk = new Set(scan.photos.map(key));
  const fresh = scan.photos.filter((rel) => {
    const k = key(rel);
    if (known.has(k)) return false;
    if (removed.has(k) && !named.has(k)) return false;
    return named.has(k) || reaches(plan.scope, folderOf(rel));
  });
  return {
    new: [...fresh.map((rel) => path.join(plan.root, ...rel.split("/"))), ...plan.copies.map((c) => c.to)],
    gone: saved.relPaths.filter((rel) => !onDisk.has(key(rel))),
    otherFiles: scan.others,
  };
}

/** Whether the holder of a lock on this machine has exited (file-lock.cjs's rule). */
function holderGone(heldBy: LockInfo): boolean {
  if (heldBy.host !== hostname() || !(heldBy.pid > 0)) return false;
  try {
    process.kill(heldBy.pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** Who holds the project's writer lock, or null when it is free or would be taken over. */
export async function heldLock(workingDir: string, now: number = Date.now()): Promise<LockInfo | null> {
  const lock = await readLock(path.join(workingDir, "writer.lock"));
  if (lock === null || now - lock.refreshedAt >= STALE_MS || holderGone(lock)) return null;
  return lock;
}
