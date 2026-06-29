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
//     back into the in-folder catalog (the previous catalog.json is kept as
//     catalog.bak.json first), then the spillover's catalog.json + marker are
//     retired so nothing is left to re-promote.
// Promotion is guarded against clobbering: it folds back only a spillover that is
// newer than *and* differs from the in-folder catalog, so a stale or leftover
// spillover (e.g. a marker that survived a failed cleanup, or a no-edit read-only
// spell) is a no-op rather than overwriting newer in-folder data. Only `.seeded`
// spillovers are eligible; a standalone external catalog is never folded in.
//
// Known limitation: the catalog is keyed by the source's absolute path, so
// removable media remounted at a different drive letter / mount point gets a fresh
// catalog. There is no portable, writeable-source-free volume identity to key on
// (Node's stat().dev is 0 on Windows), so this is left to the Preferences "Stored
// catalogs" manager, which lists each catalog by its recorded source path so an
// orphan can be found and reclaimed.

import { getSettings } from "@/state/settings-store";
import { isNativeFS, nativeDirectoryHandle, nativeFs, nativePathOf } from "./native-fs";

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
const stripSlash = (p: string) => p.replace(/[/\\]+$/, "");
const catalogJsonIn = (slDir: string) => `${stripSlash(slDir)}/catalog.json`;
const seededMarkerIn = (slDir: string) => `${stripSlash(slDir)}/.seeded`;
const inFolderSlDir = (rootPath: string) => `${stripSlash(rootPath)}/.safelight`;

/** Seed the separate catalog (at `externalSl`) from the readable in-folder catalog
 *  so a read-only session opens onto the user's real catalog rather than an empty
 *  one. Copies only when the in-folder catalog is newer (or the separate is
 *  missing), so writeable edits made since the last spell aren't shadowed by a
 *  stale copy; always (re)writes the `.seeded` marker so the next writeable open
 *  knows to promote. Best-effort: on any failure the separate just starts empty
 *  (the pre-seed behavior). */
async function seedExternalCatalog(
  fs: Bridge,
  rootPath: string,
  externalSl: string,
): Promise<void> {
  try {
    const inInfo = await fs.read(catalogJsonIn(inFolderSlDir(rootPath))).catch(() => null);
    if (!inInfo) return; // no in-folder catalog to seed from
    const extCat = catalogJsonIn(externalSl);
    const extInfo = await fs.read(extCat).catch(() => null);
    if (!extInfo || inInfo.mtimeMs > extInfo.mtimeMs) {
      await fs.write(extCat, inInfo.data);
    }
    await fs.write(seededMarkerIn(externalSl), new TextEncoder().encode(rootPath));
    // Record where this source's spillover lives so a later writeable open folds
    // it back regardless of the base setting then (best-effort; the base-probe
    // fallback in findSeededSpillover covers a lost pointer).
    if (typeof fs.setSpilloverPointer === "function")
      await fs.setSpilloverPointer(rootPath, externalSl).catch(() => {});
  } catch {
    /* best-effort */
  }
}

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

const clearSpilloverPointer = async (fs: Bridge, rootPath: string): Promise<void> => {
  if (typeof fs.clearSpilloverPointer === "function")
    await fs.clearSpilloverPointer(rootPath).catch(() => {});
};

/** Locate a `.seeded` spillover catalog for `rootPath`, or null.
 *
 *  Primary: the per-source spillover pointer, recorded on seed under the app-data
 *  default. Because it's keyed by source path (not by base), it locates the
 *  spillover no matter which "Separate catalog location" is configured now — so a
 *  base change between the read-only spell and the writeable re-open still folds
 *  the edits back. Fallback: probe the current base + default directly, covering
 *  spillovers seeded before the pointer existed (or whose pointer write was lost).
 *  Either way the marker is re-checked, so a stale pointer is harmless. */
async function findSeededSpillover(
  fs: Bridge,
  rootPath: string,
  base: string | null,
): Promise<string | null> {
  if (typeof fs.getSpilloverPointer === "function") {
    const ptr = await fs.getSpilloverPointer(rootPath).catch(() => null);
    if (ptr && (await fs.exists(seededMarkerIn(ptr)))) return ptr;
  }
  if (typeof fs.externalCatalogDir !== "function") return null;
  for (const b of base ? [base, null] : [null]) {
    const dir = await fs.externalCatalogDir(rootPath, b, false).catch(() => null);
    if (dir && (await fs.exists(seededMarkerIn(dir)))) return dir;
  }
  return null;
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
 *   • The previous in-folder catalog is copied to catalog.bak.json before the
 *     overwrite, and the spillover's catalog.json + marker are removed *after* a
 *     successful fold, so nothing is left to re-promote and the next read-only
 *     spell re-seeds fresh. A swallowed cleanup failure is harmless: the guard
 *     makes the leftover a no-op next time.
 *  Any failure (e.g. the folder is actually still read-only, so the backup write
 *  throws first) is swallowed and leaves both catalogs intact. */
async function promoteSeparateCatalog(
  fs: Bridge,
  rootPath: string,
  base: string | null,
): Promise<string | null> {
  try {
    const externalSl = await findSeededSpillover(fs, rootPath, base);
    if (!externalSl) return null;
    const extInfo = await fs.read(catalogJsonIn(externalSl)).catch(() => null);
    const inCat = catalogJsonIn(inFolderSlDir(rootPath));
    const inInfo = await fs.read(inCat).catch(() => null);
    const fold =
      !!extInfo &&
      (!inInfo || (extInfo.mtimeMs >= inInfo.mtimeMs && !bytesEqual(extInfo.data, inInfo.data)));
    if (!fold) {
      // Nothing (newer) to fold: consume the spent marker + pointer so they can't
      // re-arm, but never touch the in-folder catalog.
      await fs.remove(seededMarkerIn(externalSl)).catch(() => {});
      await clearSpilloverPointer(fs, rootPath);
      return null;
    }
    if (inInfo) await fs.write(`${inFolderSlDir(rootPath)}/catalog.bak.json`, inInfo.data);
    await fs.write(inCat, extInfo!.data); // fold the read-only-session edits back in
    // Retire the spillover so a stuck marker has nothing to re-promote and the
    // next read-only spell re-seeds fresh from the (now-current) in-folder catalog.
    await fs.remove(catalogJsonIn(externalSl)).catch(() => {});
    await fs.remove(seededMarkerIn(externalSl)).catch(() => {});
    await clearSpilloverPointer(fs, rootPath);
    return externalSl;
  } catch {
    return null;
  }
}

/** Resolve the writeable .safelight working dir for `root`, redirecting to a
 *  separate location when the folder is read-only (or when "external" mode is on).
 *  Throws ReadOnlyProjectError when no writeable location can be established. */
export async function resolveWorkingDir(
  root: FileSystemDirectoryHandle,
): Promise<WorkingDir> {
  const fs = nativeFs();
  const rootPath = nativePathOf(root);
  const canRedirect =
    isNativeFS() && !!fs && typeof fs.externalCatalogDir === "function" && !!rootPath;
  const base = getSettings().externalCatalogDir.trim() || null;

  const inFolder = async (): Promise<WorkingDir> => {
    const sl = await root.getDirectoryHandle(".safelight", { create: true });
    await probeWrite(sl);
    return { sl, location: "in-folder", externalPath: null };
  };

  // The separate catalog for this source. `allowCreate` distinguishes the two
  // bridge modes: probe-only (returns a WorkingDir iff a catalog already lives
  // there) vs create (mkdir, idempotent — an existing catalog is preserved). One
  // IPC round-trip either way. Returns null when redirect isn't available at all,
  // or — for a probe — when no catalog exists yet. Creation errors propagate.
  const external = async (allowCreate: boolean): Promise<WorkingDir | null> => {
    if (!canRedirect) return null;
    const dir = await fs!.externalCatalogDir!(rootPath!, base, allowCreate);
    if (!dir) return null;
    return { sl: nativeDirectoryHandle(dir), location: "external", externalPath: dir };
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
          if (fs && rootPath) await seedExternalCatalog(fs, rootPath, wd.externalPath!);
          return wd;
        }
      } catch (err) {
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
