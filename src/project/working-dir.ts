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
// Instead we detect the read-only folder and, in the native build, redirect the
// whole working dir (catalog.json, previews/, raw/ cache, blobs/) to a writeable
// location under the app's data dir — so read-only cards "just work", with the
// catalog kept out of harm's way. Everything downstream derives from this one
// handle, so no other code needs to know where it actually points. When even the
// redirect isn't possible (plain-browser build) or fails (e.g. an unwriteable
// user-chosen base), we raise a verbose, actionable error instead of failing mute.

import { getSettings } from "@/state/settings-store";
import { isNativeFS, nativeDirectoryHandle, nativeFs, nativePathOf } from "./native-fs";

export type WorkingDirLocation = "in-folder" | "external";

export interface WorkingDir {
  /** The .safelight directory handle (writeable) — the catalog's working dir. */
  sl: FileSystemDirectoryHandle;
  location: WorkingDirLocation;
  /** Absolute path of the external working dir when redirected, else null. */
  externalPath: string | null;
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

/** Resolve the writeable .safelight working dir for `root`, redirecting to the
 *  app data dir when the folder is read-only. Throws ReadOnlyProjectError when no
 *  writeable location can be established. */
export async function resolveWorkingDir(
  root: FileSystemDirectoryHandle,
): Promise<WorkingDir> {
  // 1. Prefer the in-folder .safelight, but verify it's genuinely writeable.
  try {
    const sl = await root.getDirectoryHandle(".safelight", { create: true });
    await probeWrite(sl);
    return { sl, location: "in-folder", externalPath: null };
  } catch (e) {
    // A non-read-only failure is some other real problem — surface it as-is so
    // the open-flow shows the actual message rather than misattributing it.
    if (!isReadOnlyError(e)) throw e;
  }

  // 2. Read-only folder. The plain-browser build has no writeable fallback
  //    location to redirect to (no absolute paths, no app data dir).
  const fs = nativeFs();
  const rootPath = nativePathOf(root);
  if (!isNativeFS() || !fs || !fs.externalCatalogDir || !rootPath) {
    throw new ReadOnlyProjectError(root.name, false);
  }

  // 3. Redirect the working dir to a writeable external location (under the
  //    user's chosen base, or the app data dir).
  try {
    const base = getSettings().externalCatalogDir.trim();
    const dir = await fs.externalCatalogDir(rootPath, base || null);
    return { sl: nativeDirectoryHandle(dir), location: "external", externalPath: dir };
  } catch (e) {
    throw new ReadOnlyProjectError(root.name, true, e);
  }
}
