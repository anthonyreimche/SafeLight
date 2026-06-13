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
      }
    }
    node.children.sort((a, b) => a.name.localeCompare(b.name));
  }

  await walk(root, "", tree);
  return { files, tree };
}
