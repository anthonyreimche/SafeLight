// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Recursive project-folder scan: collects every supported image file and the
// folder tree the explorer shows. Dot-folders (including .safelight) are
// skipped.

import { isSupportedName } from "@/modules/library/import-photos";

// Same value as folder-ops' SIDECAR_SUFFIX; declared locally (like
// project-storage's copy) to keep this leaf module out of that import cycle.
const SIDECAR_SUFFIX = ".safelight.json";

export interface FolderNode {
  name: string;
  /** Path relative to the project root; "" for the root itself. */
  path: string;
  children: FolderNode[];
  /** Direct (non-recursive) photo count. */
  count: number;
}

export interface ScannedFile {
  path: string; // relative, posix separators
  handle: FileSystemFileHandle;
  parent: FileSystemDirectoryHandle;
}

export async function scanProject(root: FileSystemDirectoryHandle): Promise<{
  files: ScannedFile[];
  tree: FolderNode;
  /** Relative paths of `<image>.safelight.json` sidecars found in the walk, so
   *  the open probes only sidecars that exist instead of issuing a guaranteed-
   *  failing read per imported file. */
  sidecars: Set<string>;
}> {
  const sidecars = new Set<string>();
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
        slots.push(walk(entry, childPath, child));
      } else if (isSupportedName(entry.name)) {
        slots.push({ path: childPath, handle: entry, parent: dir });
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

  const files = await walk(root, "", tree);
  if (skipped.size > 0) {
    const total = [...skipped.values()].reduce((a, b) => a + b, 0);
    const breakdown = [...skipped.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([ext, n]) => `${ext}×${n}`)
      .join(", ");
    console.info(`[scan] ${files.length} images; skipped ${total} non-image file(s): ${breakdown}`);
  }
  return { files, tree, sidecars };
}
