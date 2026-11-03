// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Recursive project-folder scan: collects every supported image file and the
// folder tree the explorer shows. Dot-folders (including .safelight) are
// skipped.

import { FolderUnavailableError, failureReason, isUnreachable } from "./catalog-errors";
import { nativeFs, nativePathOf, nativeSizeOf } from "./native-fs";
import { SIDECAR_SUFFIX } from "./sidecar";

/** Folders the OS keeps at a drive root and denies the user: skipped without a
 *  word, so a drive-root project doesn't report them as unreadable on every open.
 *  Lower-case; the dot-folders macOS keeps (.Trashes, .fseventsd) are already
 *  skipped. */
const SYSTEM_FOLDERS = new Set([
  "$recycle.bin",
  "recycler",
  "system volume information",
  "lost+found",
]);

/** What a folder the account may not list fails with: Node's errno through the
 *  desktop bridge, a DOMException name from the browser's file API. */
export const ACCESS_DENIED = new Set(["EACCES", "EPERM", "NotAllowedError", "SecurityError"]);

import type { FolderNode } from "./folder-node";

export type { FolderNode };

export interface ScannedFile {
  path: string; // relative, posix separators
  handle: FileSystemFileHandle;
  parent: FileSystemDirectoryHandle;
  /** The file's size as the listing gave it: the desktop bridge does, the
   *  browser's file API doesn't (undefined). */
  size?: number;
}

/** `isSupported` tells an image the import can read by its file name. */
export async function scanProject(
  root: FileSystemDirectoryHandle,
  isSupported: (name: string) => boolean,
): Promise<{
  files: ScannedFile[];
  tree: FolderNode;
  /** Relative paths of `<image>.safelight.json` sidecars found in the walk, so
   *  the open probes only sidecars that exist instead of issuing a guaranteed-
   *  failing read per imported file. */
  sidecars: Set<string>;
  /** Relative paths of folders the walk couldn't list (a permission error),
   *  sorted. Their subtrees are missing from `files`, so a photo under one is
   *  unknown, not gone. */
  unreadable: string[];
  /** Files left out because their extension isn't a supported image, counted by
   *  lower-cased extension ("(none)" for a name without one). */
  skipped: Record<string, number>;
}> {
  const sidecars = new Set<string>();
  const unreadable: string[] = [];
  const tree: FolderNode = { name: root.name, path: "", children: [], count: 0 };
  // Tally of files skipped because their extension isn't a supported image, so a
  // "folder has N but only M imported" gap is explainable instead of mysterious.
  const skipped = new Map<string, number>();

  async function walk(
    dir: FileSystemDirectoryHandle,
    path: string,
    node: FolderNode,
  ): Promise<ScannedFile[]> {
    // Each directory listing is one fs:list IPC round-trip, so sibling subtrees
    // walk concurrently to overlap that latency on deep trees. Slots keep the
    // result in the exact depth-first order a sequential walk produced, so the
    // import (and dateImported) order stays deterministic.
    const slots: (ScannedFile | Promise<ScannedFile[]>)[] = [];
    for await (const entry of dir.values()) {
      if (entry.name.startsWith(".")) continue;
      if (entry.kind === "directory" && SYSTEM_FOLDERS.has(entry.name.toLowerCase())) continue;
      const childPath = path ? `${path}/${entry.name}` : entry.name;
      if (entry.kind === "directory") {
        const child: FolderNode = {
          name: entry.name,
          path: childPath,
          children: [],
          count: 0,
        };
        // Show every real (non-dot) folder, including empty ones, so newly
        // created folders are visible and can be used as drop targets.
        node.children.push(child);
        slots.push(
          walk(entry, childPath, child).catch((error: unknown) => {
            // A drive gone shows at the root's own listing; one folder failing
            // or vanishing mid-walk is that folder's.
            if (!ACCESS_DENIED.has(failureReason(error)) && !isUnreachable(error)) throw error;
            child.unreadable = true;
            unreadable.push(childPath);
            return [];
          }),
        );
      } else if (isSupported(entry.name)) {
        slots.push({ path: childPath, handle: entry, parent: dir, size: nativeSizeOf(entry) });
        node.count++;
      } else if (entry.name.endsWith(SIDECAR_SUFFIX)) {
        sidecars.add(childPath);
      } else {
        const dot = entry.name.lastIndexOf(".");
        const ext = (dot === -1 ? "(none)" : entry.name.slice(dot)).toLowerCase();
        skipped.set(ext, (skipped.get(ext) ?? 0) + 1);
      }
    }
    node.children.sort((a, b) => a.name.localeCompare(b.name));
    const resolved = await Promise.all(
      slots.map((s) => (s instanceof Promise ? s : Promise.resolve([s]))),
    );
    return resolved.flat();
  }

  const files = await walk(root, "", tree).catch((error: unknown) => {
    throw isUnreachable(error) ? new FolderUnavailableError(error) : error;
  });
  // The desktop bridge lists a folder that isn't there as empty, so an empty
  // project folder is checked for: a drive taken away is not a folder emptied.
  if (files.length === 0 && tree.children.length === 0) {
    const fs = nativeFs();
    const rootPath = nativePathOf(root);
    if (fs && rootPath && !(await fs.exists(rootPath)))
      throw new FolderUnavailableError(`ENOENT: no such directory, scandir '${rootPath}'`);
  }
  unreadable.sort();
  if (unreadable.length > 0)
    console.warn(`[scan] skipped ${unreadable.length} unreadable folder(s): ${unreadable.join(", ")}`);
  if (skipped.size > 0) {
    const total = [...skipped.values()].reduce((a, b) => a + b, 0);
    const breakdown = [...skipped.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([ext, n]) => `${ext}×${n}`)
      .join(", ");
    console.info(`[scan] ${files.length} images; skipped ${total} non-image file(s): ${breakdown}`);
  }
  return { files, tree, sidecars, unreadable, skipped: Object.fromEntries(skipped) };
}
