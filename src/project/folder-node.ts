// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The folder tree the explorer shows. A leaf so the public API types can name
// it without pulling in the scan and its native-filesystem imports.

export interface FolderNode {
  name: string;
  /** Path relative to the project root; "" for the root itself. */
  path: string;
  children: FolderNode[];
  /** Direct (non-recursive) photo count. */
  count: number;
  /** Set when the folder couldn't be listed, so its contents are unknown. */
  unreadable?: boolean;
}
