// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Resolve where a project's .safelight working directory lives.
//
// Normally it's <project>/.safelight — created on open. But a read-only source
// (a camera memory card mounted read-only is the motivating case: people open
// cards before they've backed them up) can't host it, and the old code threw
// from getDirectoryHandle(".safelight",{create:true}) straight into a silent
// console.error, leaving an empty library with no explanation.
//
// Instead, in the native build, we can redirect the whole working dir
// (catalog.json, previews/, raw/ cache, blobs/) to a writeable, path-keyed
// location under the app's data dir — so read-only cards "just work", with the
// catalog kept out of harm's way. Everything downstream derives from this one
// handle, so no other code needs to know where it actually points. When even the
// redirect isn't possible (plain-browser build) or fails (e.g. an unwriteable
// user-chosen base), we raise a verbose, actionable error instead of failing mute.
//
// Precedence (so the catalog follows the source through its whole lifecycle):
//   1. An in-folder .safelight/catalog.json already exists → it's canonical; use
//      it, *even in "external" mode*. Flipping the setting (or a brief read-only
//      mount) must never orphan a catalog the user already built in the folder,
//      and a real in-folder project isn't hijacked by a stray external catalog.
//   2. "External" mode → store new catalogs in the separate location (keep photo
//      folders clean, catalogs on fast storage).
//   3. A separate catalog already exists for this source path → keep using it.
//      Load-bearing: without it, a read-only card that later becomes writeable
//      would get a fresh, empty in-folder .safelight and the catalog the user
//      built up while it was read-only would be silently orphaned.
//   4. Otherwise create the in-folder .safelight; on read-only, redirect.
//
// Read-only round-trip (rule 1's fallback): when a folder that owns an in-folder
// catalog is opened read-only, writes go to a separate catalog. We avoid stranding
// that work with a seed-then-promote handshake — no general two-way merge needed,
// because the in-folder catalog can't change while it's read-only:
//   • Seed: the separate catalog is copied from the (readable) in-folder catalog
//     on redirect, so the read-only session shows the user's real catalog (not an
//     empty one) and edits accumulate on a *superset*. A `.seeded` marker records
//     that this separate is a spillover of a specific in-folder catalog.
//   • Promote: the next time the folder opens writeable, that superset is folded
//     back into the in-folder catalog (the previous catalog.json is kept first as
//     catalog.before-merge-<time>.json, a name no session's backup writes over),
//     then the spillover's catalog.json + marker are retired so nothing is left to
//     re-promote.
// Per-photo edit files (edits/) fold back alongside: each spillover file replaces
// the in-folder one only when its stamp is newer, and the file it replaces is kept
// first under before-merge-<time>/edits/. A spillover with edit files is folded
// even when its catalog.json is identical, as a session that only edited leaves
// catalog.json untouched.
// Promotion is guarded against clobbering: it folds back only a spillover that is
// newer than *and* differs from the in-folder catalog, so a stale or leftover
// spillover (e.g. a marker that survived a failed cleanup, or a no-edit read-only
// spell) is a no-op rather than overwriting newer in-folder data. Only `.seeded`
// spillovers are eligible; a standalone external catalog is never folded in.
//
// One path, several cards: every card a camera formats mounts at the same path
// (E:\, /Volumes/EOS_DIGITAL), so a separate catalog found for the path is passed
// over when the folder shows it to be another card's (volume-print.ts). Then the
// path's other catalogs are tried, and a new one made after the last, so another
// card never opens onto, and saves over, this one's. A seeded spillover is folded
// back only into a card that isn't shown to be another.
//
// Known limitation: the catalog is keyed by the source's absolute path, so
// removable media remounted at a different drive letter / mount point gets a fresh
// catalog. There is no portable, writeable-source-free volume identity to key on
// (Node's stat().dev is 0 on Windows), so this is left to the Preferences "Stored
// catalogs" manager, which lists each catalog by its recorded source path so an
// orphan can be found and reclaimed.

import { getSettings } from "@/state/settings-store";
import {
  CATALOG_VERSION,
  CatalogTooNewError,
  CatalogUnreadableError,
  FolderAccessDeniedError,
  FolderUnavailableError,
  failureReason,
  isUnreachable,
} from "./catalog-errors";
import { newer, readChangeStamps, type ChangeStamp } from "./change-stamps";
import { fileTimestamp, isNotFound, parseJSONObject } from "./fs";
import { isNativeFS, nativeDirectoryHandle, nativeFs, nativePathOf } from "./native-fs";
import { ACCESS_DENIED } from "./scan";
import { judgeVolume } from "./volume-print";

export type WorkingDirLocation = "in-folder" | "external";

export interface WorkingDir {
  /** The .safelight directory handle (writeable) — the catalog's working dir. */
  sl: FileSystemDirectoryHandle;
  location: WorkingDirLocation;
  /** Absolute path of the external working dir when redirected, else null. */
  externalPath: string | null;
  /** Set when edits made during a prior read-only spell were just folded back
   *  into this (now writeable) in-folder catalog — the absolute path of the
   *  separate catalog they came from. Lets the open-flow tell the user. */
  promotedFromExternal?: string | null;
  /** Set when `sl` is a spillover of a folder that owns an in-folder catalog: that
   *  in-folder .safelight, readable though the folder is not writeable. A reader of
   *  per-photo edit files reads `sl` first and falls back to this; writes go only
   *  to `sl`. */
  editsFallback?: { sl: FileSystemDirectoryHandle; path: string };
}

/** Thrown when a writeable .safelight can't be established. Carries enough to
 *  build a verbose, actionable message for the user (see project-store). */
export class ReadOnlyProjectError extends Error {
  readonly folderName: string;
  /** True when a redirect was attempted (native) but failed; false when redirect
   *  isn't available at all (plain-browser build). */
  readonly redirectFailed: boolean;
  readonly cause?: unknown;

  constructor(folderName: string, redirectFailed: boolean, cause?: unknown) {
    super(
      `Project folder “${folderName}” is read-only and Safelight could not ` +
        `establish a writeable working directory for its catalog.`,
    );
    this.name = "ReadOnlyProjectError";
    this.folderName = folderName;
    this.redirectFailed = redirectFailed;
    this.cause = cause;
  }
}

/** Does this error look like a read-only / permission failure? The native fs
 *  bridge surfaces Node errors across IPC as plain Errors whose `.code` is lost,
 *  so match the message text (EROFS/EACCES/EPERM and their prose forms). */
function isReadOnlyError(e: unknown): boolean {
  // FSA (browser) surfaces a typed DOMException; the native bridge surfaces a
  // Node error whose `.code` is lost across IPC, so also match the message text.
  const name = e instanceof Error ? e.name : "";
  if (name === "NoModificationAllowedError" || name === "NotAllowedError") return true;
  const msg = e instanceof Error ? e.message : String(e);
  return /\b(EROFS|EACCES|EPERM)\b|read[-\s]?only|operation not permitted|permission denied/i.test(
    msg,
  );
}

/** Create + delete a marker file to confirm .safelight is actually writeable.
 *  Needed because a read-only folder that *already* contains a .safelight (from
 *  when it was writeable) lets getDirectoryHandle(create) succeed as a no-op —
 *  the read-only-ness only shows up on the first real write. One tiny round-trip
 *  per project open (not per photo), so the cost is negligible. */
async function probeWrite(sl: FileSystemDirectoryHandle): Promise<void> {
  const name = ".writetest";
  const fh = await sl.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write("ok");
  await w.close();
  // Best-effort cleanup; leaving the marker behind on a quirky fs is harmless.
  try {
    await sl.removeEntry(name);
  } catch {
    /* ignore */
  }
}

/** Does <root>/.safelight/catalog.json already exist? A folder that owns a
 *  catalog is canonical — we keep using it rather than a redirect. */
async function inFolderCatalogExists(
  root: FileSystemDirectoryHandle,
  fs: ReturnType<typeof nativeFs>,
  rootPath: string | null,
): Promise<boolean> {
  // Native build: probe by absolute path. A native handle always carries a path
  // (native-fs sets it on every handle), so a present bridge with a null path is
  // a contract violation, not a browser handle — return false rather than falling
  // through to the FSA probe below, which is *lazy* on native handles
  // (getFileHandle never reads) and would false-positive on a missing catalog.
  if (fs) {
    if (!rootPath) return false;
    try {
      return await fs.exists(`${rootPath.replace(/[/\\]+$/, "")}/.safelight/catalog.json`);
    } catch {
      return false;
    }
  }
  // Plain-browser build: real FSA handles throw on a missing entry, so the probe
  // is sound here.
  try {
    const sl = await root.getDirectoryHandle(".safelight");
    await sl.getFileHandle("catalog.json");
    return true;
  } catch {
    return false;
  }
}

type Bridge = NonNullable<ReturnType<typeof nativeFs>>;

/** Make sure the project folder is there before anything decides where its catalog
 *  lives. The desktop bridge lists a missing folder as empty, so a drive taken away
 *  would open as a folder emptied, and its catalog would be saved without a photo.
 *  On macOS, a volume the user hasn't allowed Safelight into refuses the listing
 *  with EPERM, which the read-only check would take for a read-only folder. */
async function reachRoot(fs: Bridge, rootPath: string): Promise<void> {
  try {
    await fs.list(rootPath);
  } catch (error) {
    if (isUnreachable(error)) throw new FolderUnavailableError(error);
    const mac = globalThis.window?.safelightNative?.platform === "darwin";
    if (mac && ACCESS_DENIED.has(failureReason(error))) throw new FolderAccessDeniedError(error);
    throw error;
  }
  if (!(await fs.exists(rootPath)))
    throw new FolderUnavailableError(`ENOENT: no such directory, scandir '${rootPath}'`);
}

const stripSlash = (p: string) => p.replace(/[/\\]+$/, "");
const catalogJsonIn = (slDir: string) => `${stripSlash(slDir)}/catalog.json`;
const seededMarkerIn = (slDir: string) => `${stripSlash(slDir)}/.seeded`;
const inFolderSlDir = (rootPath: string) => `${stripSlash(rootPath)}/.safelight`;

/** Read a catalog that may not be there (null). One that is there but can't be
 *  read (another program holds it) throws CatalogUnreadableError: taken for
 *  missing, it would be written over, or its edits never folded back. */
const readIfThere = (fs: Bridge, path: string) =>
  fs.read(path).catch((error: unknown) => {
    if (isNotFound(error)) return null;
    throw new CatalogUnreadableError(error);
  });

/** Seed the separate catalog (at `externalSl`) from the readable in-folder catalog
 *  so a read-only session opens onto the user's real catalog rather than an empty
 *  one. Copies only when the in-folder catalog is newer (or the separate is
 *  missing), so writeable edits made since the last spell aren't shadowed by a
 *  stale copy; always (re)writes the `.seeded` marker so the next writeable open
 *  knows to promote. Best-effort: on any failure the separate just starts empty
 *  (the pre-seed behavior), except that a catalog that can't be read right now
 *  fails the open (CatalogUnreadableError, see readIfThere). */
async function seedExternalCatalog(
  fs: Bridge,
  rootPath: string,
  externalSl: string,
): Promise<void> {
  try {
    const inInfo = await readIfThere(fs, catalogJsonIn(inFolderSlDir(rootPath)));
    if (!inInfo) return; // no in-folder catalog to seed from
    const extCat = catalogJsonIn(externalSl);
    const extInfo = await readIfThere(fs, extCat);
    if (!extInfo || inInfo.mtimeMs > extInfo.mtimeMs) {
      await fs.write(extCat, inInfo.data);
    }
    await fs.write(seededMarkerIn(externalSl), new TextEncoder().encode(rootPath));
    // Record where this source's spillover lives so a later writeable open folds
    // it back regardless of the base setting then (best-effort; the base-probe
    // fallback in findSeededSpillover covers a lost pointer).
    if (typeof fs.setSpilloverPointer === "function")
      await fs.setSpilloverPointer(rootPath, externalSl).catch(() => {});
  } catch (error) {
    if (error instanceof CatalogUnreadableError) throw error;
  }
}

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

/** How many separate catalogs an older bridge, which can't list them, is asked
 *  for at one source path. */
const MOST_CATALOGS_PER_PATH = 99;

/** The separate catalog `variant` of `rootPath` under `base` (null: the default):
 *  made with `create`, else only if it holds a catalog. */
const catalogDir = (fs: Bridge, rootPath: string, base: string | null, create: boolean, variant: number) =>
  variant === 1
    ? fs.externalCatalogDir!(rootPath, base, create)
    : fs.externalCatalogDir!(rootPath, base, create, variant);

/** The separate catalogs of `rootPath` under `base` that hold a catalog, in order:
 *  every one, though one before it was deleted in the Stored-catalogs manager. */
async function separateCatalogs(
  fs: Bridge,
  rootPath: string,
  base: string | null,
): Promise<{ variant: number; dir: string }[]> {
  const kept: { variant: number; dir: string }[] = [];
  if (typeof fs.externalCatalogVariants === "function") {
    for (const variant of await fs.externalCatalogVariants(rootPath, base)) {
      const dir = await catalogDir(fs, rootPath, base, false, variant);
      if (dir) kept.push({ variant, dir });
    }
    return kept;
  }
  // An older bridge: up to the first missing one. One that has no further
  // catalogs hands the first one back.
  const seen = new Set<string>();
  for (let variant = 1; variant <= MOST_CATALOGS_PER_PATH; variant++) {
    const dir = await catalogDir(fs, rootPath, base, false, variant);
    if (!dir || seen.has(dir)) break;
    seen.add(dir);
    kept.push({ variant, dir });
  }
  return kept;
}

const clearSpilloverPointer = async (fs: Bridge, rootPath: string): Promise<void> => {
  if (typeof fs.clearSpilloverPointer === "function")
    await fs.clearSpilloverPointer(rootPath).catch(() => {});
};

/** Locate a `.seeded` spillover catalog of the card at `rootPath`, or null.
 *
 *  Primary: the per-source spillover pointer, recorded on seed under the app-data
 *  default. Because it's keyed by source path (not by base), it locates the
 *  spillover no matter which "Separate catalog location" is configured now — so a
 *  base change between the read-only spell and the writeable re-open still folds
 *  the edits back. Fallback: probe the current base + default directly, covering
 *  spillovers seeded before the pointer existed (or whose pointer write was lost).
 *  Either way the marker is re-checked, so a stale pointer is harmless, and so is
 *  the folder: the pointer names the last card at this path to spill, which may be
 *  another one. */
async function findSeededSpillover(
  fs: Bridge,
  rootPath: string,
  base: string | null,
): Promise<string | null> {
  const ours = async (dir: string) =>
    (await fs.exists(seededMarkerIn(dir))) && (await judgeVolume(fs, rootPath, dir)) !== "other";
  if (typeof fs.getSpilloverPointer === "function") {
    const ptr = await fs.getSpilloverPointer(rootPath).catch(() => null);
    if (ptr && (await ours(ptr))) return ptr;
  }
  if (typeof fs.externalCatalogDir !== "function") return null;
  for (const b of base ? [base, null] : [null]) {
    try {
      for (const { dir } of await separateCatalogs(fs, rootPath, b)) if (await ours(dir)) return dir;
    } catch {
      /* this base can't be probed; try the next */
    }
  }
  return null;
}

/** How many copies of the catalogs earlier folds replaced are kept. Each is a
 *  whole catalog. */
const KEPT_BEFORE_MERGE = 3;

/** Remove all but the newest KEPT_BEFORE_MERGE catalog.before-merge-<time>.json in
 *  `dir`, and all but the newest KEPT_BEFORE_MERGE before-merge-<time>/ directories
 *  of replaced edit files; the time in the name sorts as written. */
async function pruneBeforeMergeCopies(fs: Bridge, dir: string): Promise<void> {
  const entries = await fs.list(dir);
  const oldest = (match: (entry: (typeof entries)[number]) => boolean) =>
    entries
      .filter(match)
      .map((entry) => entry.name)
      .sort()
      .slice(0, -KEPT_BEFORE_MERGE);
  const catalogs = oldest(
    (entry) => entry.kind === "file" && /^catalog\.before-merge-.+\.json$/.test(entry.name),
  );
  const editDirs = oldest(
    (entry) => entry.kind === "directory" && /^before-merge-.+$/.test(entry.name),
  );
  for (const name of [...catalogs, ...editDirs]) await fs.remove(`${dir}/${name}`);
}

/** Every file under `dir`, as paths relative to it. A directory that isn't there
 *  holds none; one that can't be listed throws. */
async function filesUnder(fs: Bridge, dir: string, rel = ""): Promise<string[]> {
  const entries = await fs.list(rel ? `${dir}/${rel}` : dir).catch((error: unknown) => {
    if (isNotFound(error)) return [];
    throw error;
  });
  const files: string[] = [];
  for (const { name, kind } of entries) {
    const path = rel ? `${rel}/${name}` : name;
    if (kind === "directory") files.push(...(await filesUnder(fs, dir, path)));
    else files.push(path);
  }
  return files;
}

/** An edit file's path under edits/: its shard, then a name with no dot before
 *  `.json`, which leaves out the .bak, .corrupt-* and .conflict-* files beside it. */
const EDIT_FILE = /^[0-9a-f]{2}\/[^/.]+\.json$/;

/** The stamp an edit file's body carries, if it has a readable one. */
const editStampOf = (body: Record<string, unknown>): ChangeStamp | undefined =>
  readChangeStamps({ edits: { stamp: body.stamp } }).edits.stamp;

/** Whether the edit file read-only sessions left should replace the in-folder one:
 *  the newer stamp wins, an unstamped edit is older than any stamped one, and two
 *  unstamped ones go by when they were written. A file that isn't an edit never
 *  replaces one that is. */
function spilloverEditWins(
  spilled: { data: Uint8Array; mtimeMs: number },
  held: { data: Uint8Array; mtimeMs: number },
): boolean {
  const mine = parseJSONObject(spilled.data);
  const theirs = parseJSONObject(held.data);
  if (!mine) return false;
  if (!theirs) return true;
  const mineAt = editStampOf(mine);
  const theirsAt = editStampOf(theirs);
  return mineAt || theirsAt ? newer(mineAt, theirsAt) : spilled.mtimeMs >= held.mtimeMs;
}

/** Fold the edit files of a spillover (`spilledEdits`, the files given relative to
 *  it) into the in-folder `inSl`/edits. An in-folder file a spillover file replaces
 *  is first copied to `inSl`/before-merge-<time>/edits/<same path>. Returns whether a
 *  file was taken. A failure throws, leaving what was folded so far in place; a
 *  rerun folds the rest, as taken files then no longer win. */
async function foldEditFiles(
  fs: Bridge,
  spilledEdits: string,
  files: string[],
  inSl: string,
): Promise<boolean> {
  const kept = `${inSl}/before-merge-${fileTimestamp()}/edits`;
  let taken = false;
  for (const rel of files) {
    const spilled = await readIfThere(fs, `${spilledEdits}/${rel}`);
    if (!spilled) continue;
    const to = `${inSl}/edits/${rel}`;
    const held = await readIfThere(fs, to);
    if (held) {
      if (bytesEqual(spilled.data, held.data) || !spilloverEditWins(spilled, held)) continue;
      await fs.write(`${kept}/${rel}`, held.data);
    }
    await fs.write(to, spilled.data);
    taken = true;
  }
  return taken;
}

/** If a `.seeded` spillover catalog exists for this now-writeable source, fold its
 *  read-only-session edits back into the in-folder catalog and retire the spillover.
 *  Returns the spillover path when a fold actually happened, else null.
 *
 *  Guards make this safe against the failure modes of a single marker flag:
 *   • Fold only when the spillover is *newer than and differs from* the in-folder
 *     catalog. A stale spillover (e.g. a marker that survived a failed cleanup, so
 *     in-folder has since advanced) or an identical one (a read-only spell with no
 *     edits) is a no-op — it can never clobber newer in-folder data, even though
 *     the in-folder catalog is always written with the host clock so its mtime is a
 *     reliable comparand here (both files are app-written, not camera-stamped).
 *   • The previous in-folder catalog is copied to catalog.before-merge-<time>.json
 *     before the overwrite: the backups rotate as later sessions open the
 *     project, and after a fold this copy can be the only one of the catalog it
 *     replaced. The
 *     spillover's catalog.json + marker are removed *after* a
 *     successful fold, so nothing is left to re-promote and the next read-only
 *     spell re-seeds fresh. A swallowed cleanup failure is harmless: the guard
 *     makes the leftover a no-op next time.
 *  Any failure (e.g. the folder is actually still read-only, so the backup write
 *  throws first) is swallowed and leaves both catalogs intact. One exception: a
 *  catalog that is there but can't be read (another program holds it) fails the
 *  open with CatalogUnreadableError. Taken for missing, the in-folder catalog
 *  would be replaced with no backup, or the spillover retired unfolded. Nor is a
 *  spillover folded that the open would not take: a damaged one is left where it
 *  is, and one a newer version saved fails the open with CatalogTooNewError, both
 *  with the in-folder catalog untouched. */
async function promoteSeparateCatalog(
  fs: Bridge,
  rootPath: string,
  base: string | null,
): Promise<string | null> {
  try {
    const externalSl = await findSeededSpillover(fs, rootPath, base);
    if (!externalSl) return null;
    const extInfo = await readIfThere(fs, catalogJsonIn(externalSl));
    const inCat = catalogJsonIn(inFolderSlDir(rootPath));
    const inInfo = await readIfThere(fs, inCat);
    const fold =
      !!extInfo &&
      (!inInfo || (extInfo.mtimeMs >= inInfo.mtimeMs && !bytesEqual(extInfo.data, inInfo.data)));
    // A spillover is folded only as an open would read it. A damaged one counts as
    // nothing to fold, and stays where it is; one a newer version saved stops the
    // open before anything is written, as that open would refuse it.
    const spilled = extInfo ? parseJSONObject(extInfo.data) : null;
    if (fold && typeof spilled?.version === "number" && spilled.version > CATALOG_VERSION)
      throw new CatalogTooNewError(spilled.version);
    const foldCatalog = fold && !!spilled;
    const spilledEdits = `${stripSlash(externalSl)}/edits`;
    const editFiles = (await filesUnder(fs, spilledEdits).catch(() => [])).filter((path) =>
      EDIT_FILE.test(path),
    );
    const inSl = inFolderSlDir(rootPath);
    const editsTaken = await foldEditFiles(fs, spilledEdits, editFiles, inSl);
    if (foldCatalog) {
      if (inInfo) {
        const kept = `${inSl}/catalog.before-merge-${fileTimestamp()}.json`;
        await fs.write(kept, inInfo.data);
      }
      await fs.write(inCat, extInfo!.data); // fold the read-only-session edits back in
    }
    if (foldCatalog || editsTaken) await pruneBeforeMergeCopies(fs, inSl).catch(() => {});
    // Retire the spillover so a stuck marker has nothing to re-promote and the
    // next read-only spell re-seeds fresh from the (now-current) in-folder catalog.
    // With nothing (newer) to fold, only the spent marker + pointer are consumed, so
    // they can't re-arm; the in-folder catalog is never touched.
    if (foldCatalog) await fs.remove(catalogJsonIn(externalSl)).catch(() => {});
    await fs.remove(seededMarkerIn(externalSl)).catch(() => {});
    await clearSpilloverPointer(fs, rootPath);
    if (editFiles.length > 0) await fs.remove(spilledEdits).catch(() => {});
    return foldCatalog || editsTaken ? externalSl : null;
  } catch (error) {
    if (error instanceof CatalogUnreadableError || error instanceof CatalogTooNewError) throw error;
    return null;
  }
}

/** Resolve the writeable .safelight working dir for `root`, redirecting to a
 *  separate location when the folder is read-only (or when "external" mode is on).
 *  Throws FolderUnavailableError when the folder isn't there (its drive is gone),
 *  FolderAccessDeniedError when macOS keeps Safelight out of its volume,
 *  ReadOnlyProjectError when no writeable location can be established,
 *  CatalogUnreadableError when a catalog a promotion or a seed needs can't be read,
 *  and CatalogTooNewError when the spillover a promotion would fold was saved by a
 *  newer version. */
export async function resolveWorkingDir(
  root: FileSystemDirectoryHandle,
): Promise<WorkingDir> {
  const fs = nativeFs();
  const rootPath = nativePathOf(root);
  const canRedirect =
    isNativeFS() && !!fs && typeof fs.externalCatalogDir === "function" && !!rootPath;
  const base = getSettings().externalCatalogDir.trim() || null;
  if (fs && rootPath) await reachRoot(fs, rootPath);

  const inFolder = async (): Promise<WorkingDir> => {
    const sl = await root.getDirectoryHandle(".safelight", { create: true });
    await probeWrite(sl);
    return { sl, location: "in-folder", externalPath: null };
  };

  // The separate catalog for this source (see header): the first of the path's
  // that the folder shows to be its own, else the first that shows nothing either
  // way. `allowCreate` distinguishes the two bridge modes: probe-only (returns a
  // WorkingDir iff such a catalog already lives there) vs create (when there is
  // none, a new catalog after the path's last). Returns null when redirect isn't
  // available at all, or — for a probe — when no such catalog exists yet. Creation
  // errors propagate.
  const external = async (allowCreate: boolean): Promise<WorkingDir | null> => {
    if (!canRedirect) return null;
    const at = (dir: string): WorkingDir => ({
      sl: nativeDirectoryHandle(dir),
      location: "external",
      externalPath: dir,
    });
    const kept = await separateCatalogs(fs!, rootPath!, base);
    let undecided: string | null = null;
    for (const { dir } of kept) {
      const verdict = await judgeVolume(fs!, rootPath!, dir);
      if (verdict === "same") return at(dir);
      if (verdict === "unknown" && undecided === null) undecided = dir;
    }
    if (undecided !== null) return at(undecided);
    if (!allowCreate) return null;
    const next = Math.max(0, ...kept.map((k) => k.variant)) + 1;
    const dir = await catalogDir(fs!, rootPath!, base, true, next);
    return dir ? at(dir) : null;
  };

  // 1. A folder that already owns an in-folder catalog is canonical — even in
  //    "external" mode, so the setting never orphans data the user built here.
  if (await inFolderCatalogExists(root, fs, rootPath)) {
    // Before using it, fold back any edits made during a prior read-only spell
    // (no-op unless a `.seeded` spillover exists; silently skips if still
    // read-only — inFolder() below will then redirect again). See header.
    const promotedFrom =
      canRedirect && fs && rootPath
        ? await promoteSeparateCatalog(fs, rootPath, base)
        : null;
    try {
      const wd = await inFolder();
      return promotedFrom ? { ...wd, promotedFromExternal: promotedFrom } : wd;
    } catch (e) {
      if (!isReadOnlyError(e)) throw e;
      // In-folder catalog exists but the folder is now read-only: writes must go
      // to a separate location, seeded from the (readable) in-folder catalog so
      // the session opens onto real data and accumulates on a superset that the
      // next writeable open promotes back in (see header).
      try {
        const wd = await external(true);
        if (wd) {
          if (!fs || !rootPath) return wd;
          await seedExternalCatalog(fs, rootPath, wd.externalPath!);
          const path = inFolderSlDir(rootPath);
          return { ...wd, editsFallback: { sl: nativeDirectoryHandle(path), path } };
        }
      } catch (err) {
        if (err instanceof CatalogUnreadableError) throw err; // a busy catalog, not a read-only one
        throw new ReadOnlyProjectError(root.name, true, err);
      }
      throw new ReadOnlyProjectError(root.name, false);
    }
  }

  // 2. "External" mode: new catalogs go to the separate location. The user asked
  //    for external explicitly, so if we can't establish it, fail loudly rather
  //    than silently falling through to an in-folder write (steps 3–5).
  if (getSettings().catalogLocation === "external" && canRedirect) {
    try {
      const wd = await external(true);
      if (wd) return wd;
    } catch (e) {
      throw new ReadOnlyProjectError(root.name, true, e);
    }
    throw new ReadOnlyProjectError(root.name, true);
  }

  // 3. No in-folder catalog, not external mode. If this source was redirected
  //    before, keep using that separate catalog rather than spawning a fresh
  //    in-folder one (which would orphan the user's data when a read-only card
  //    becomes writeable).
  const sticky = await external(false).catch(() => null);
  if (sticky) return sticky;

  // 4. Otherwise prefer a fresh in-folder .safelight, verifying it's writeable.
  try {
    return await inFolder();
  } catch (e) {
    // A non-read-only failure is some other real problem — surface it as-is.
    if (!isReadOnlyError(e)) throw e;
  }

  // 5. Read-only folder, no prior catalog → create the separate one now.
  if (!canRedirect) throw new ReadOnlyProjectError(root.name, false);
  try {
    const wd = await external(true);
    if (wd) return wd;
    throw new Error("separate catalog location unavailable");
  } catch (e) {
    if (e instanceof ReadOnlyProjectError) throw e;
    throw new ReadOnlyProjectError(root.name, true, e);
  }
}
