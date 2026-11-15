// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// A tree as rows: each node on its own line under its parent, joined by faint
// branch lines. The root has none, so a tree of one reads as a plain line.

import type { Look } from "../look";

export interface TreeShape<T> { children: readonly T[] }

export interface TreeRow<T> {
  node: T;
  /** The branch lines to set before the node's own text, already styled; empty for the root. */
  lines: string;
  depth: number;
}

/** Walks `root` top down. `depth` stops the walk that many levels under the root. */
export function treeRows<T extends TreeShape<T>>(root: T, look: Look, depth = Infinity): TreeRow<T>[] {
  const { glyphs, theme } = look;
  const pad = " ".repeat(glyphs.branch.length + 1);
  const rows: TreeRow<T>[] = [];
  const walk = (node: T, lines: string, under: string, level: number): void => {
    rows.push({ node, lines: lines === "" ? "" : theme.paint("faint", lines), depth: level });
    if (level >= depth) return;
    node.children.forEach((child, i) => {
      const last = i === node.children.length - 1;
      walk(child, `${under}${last ? glyphs.branchLast : glyphs.branch} `, under + (last ? pad : glyphs.trunk + pad.slice(glyphs.trunk.length)), level + 1);
    });
  };
  walk(root, "", "", 0);
  return rows;
}
