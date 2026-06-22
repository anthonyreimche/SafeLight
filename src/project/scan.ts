// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Recursive project-folder scan: collects every supported image file and the
// folder tree the explorer shows. Dot-folders (including .safelight) are
// skipped.

import { isSupportedName } from "@/modules/library/import-photos";

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
}> {
  const files: ScannedFile[] = [];
  const tree: FolderNode = { name: root.name, path: "", children: [], count: 0 };
  // Tally of files skipped because their extension isn't a supported image, so a
  // "folder has N but only M imported" gap is explainable instead of mysterious.
  const skipped = new Map<string, number>();

  async function walk(
    dir: FileSystemDirectoryHandle,
    path: string,
    node: FolderNode,
  ): Promise<void> {
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
        await walk(entry, childPath, child);
        // Show every real (non-dot) folder, including empty ones, so newly
        // created folders are visible and can be used as drop targets.
        node.children.push(child);
      } else if (isSupportedName(entry.name)) {
        files.push({ path: childPath, handle: entry, parent: dir });
        node.count++;
      } else {
        const dot = entry.name.lastIndexOf(".");
        const ext = (dot === -1 ? "(none)" : entry.name.slice(dot)).toLowerCase();
        skipped.set(ext, (skipped.get(ext) ?? 0) + 1);
      }
    }
    node.children.sort((a, b) => a.name.localeCompare(b.name));
  }

  await walk(root, "", tree);
  if (skipped.size > 0) {
    const total = [...skipped.values()].reduce((a, b) => a + b, 0);
    const breakdown = [...skipped.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([ext, n]) => `${ext}×${n}`)
      .join(", ");
    console.info(`[scan] ${files.length} images; skipped ${total} non-image file(s): ${breakdown}`);
  }
  return { files, tree };
}
