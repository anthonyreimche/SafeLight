// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Which names the project scan keeps. Free of the DOM, so the GUI's ingest and
// the `safelight` CLI share one rule.

import { SYSTEM_FOLDERS } from "./scan";

/** The longest entry name taken: the temporary name beside it adds about 45. */
const MAX_NAME_LENGTH = 200;

const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Whether `name` is one plain entry name the project scan will list again. A name
 *  starting with "." (".", "..", .safelight) is skipped by the scan, so the photo
 *  would vanish on reopen. Separators, drive letters, control characters and the
 *  characters Windows can't keep would let a name leave its folder or fail on one
 *  platform only, as would a Windows device name; a trailing dot or space is
 *  dropped by Windows, so it would name another file than the one checked. */
export function isEntryName(name: string): boolean {
  if (!name || name.length > MAX_NAME_LENGTH || name.startsWith(".")) return false;
  if (/[<>:"|?*\\/]/.test(name)) return false;
  if (/[. ]$/.test(name) || WINDOWS_DEVICE.test(name)) return false;
  return ![...name].some((c) => c.charCodeAt(0) < 32);
}

/** The names of `folder`, or null when it isn't a folder inside the project that
 *  the scan descends into. */
export function folderSegments(folder: unknown): string[] | null {
  if (folder === undefined || folder === "") return [];
  if (typeof folder !== "string") return null;
  const segments = folder.split("/");
  const ok = segments.every((s) => isEntryName(s) && !SYSTEM_FOLDERS.has(s.toLowerCase()));
  return ok ? segments : null;
}
