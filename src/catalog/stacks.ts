// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Stacks: photos that share a stackId (a burst, a bracket) and show as one tile,
// their cover, until the stack is expanded. A stack is whatever members the list
// at hand holds: filtered out or removed members leave it, and fewer than two
// make it no stack at all.

import type { CatalogPhoto } from "./types";

/** What the grid needs to draw a shown member of a stack. */
export interface StackView {
  stackId: string;
  /** How many members the list holds, shown or collapsed away. */
  size: number;
  coverId: string;
  expanded: boolean;
}

/** The id of the member that covers a stack: the lowest id of those marked as
 *  the cover (two windows can mark different ones), else the first in order. */
export function stackCoverId(members: readonly Pick<CatalogPhoto, "id" | "stackCover">[]): string {
  let cover: string | undefined;
  for (const m of members) if (m.stackCover && (cover === undefined || m.id < cover)) cover = m.id;
  return cover ?? members[0].id;
}

/** `list` with each collapsed stack reduced to its cover, standing where the
 *  stack's first member stood, and a view of every member of each stack. `list`
 *  itself when nothing in it is stacked. */
export function collapseStacks(
  list: CatalogPhoto[],
  expanded: ReadonlySet<string>,
): { list: CatalogPhoto[]; stacks: ReadonlyMap<string, StackView> } {
  const stacks = new Map<string, StackView>();
  let members: Map<string, CatalogPhoto[]> | undefined;
  for (const p of list) {
    if (!p.stackId) continue;
    members ??= new Map();
    const group = members.get(p.stackId);
    if (group) group.push(p);
    else members.set(p.stackId, [p]);
  }
  if (!members) return { list, stacks };

  const coverPhotos = new Map<string, CatalogPhoto>();
  for (const [stackId, group] of members) {
    if (group.length < 2) continue;
    const cover = group.find((m) => m.id === stackCoverId(group)) ?? group[0];
    coverPhotos.set(stackId, cover);
    const expandedHere = expanded.has(stackId);
    for (const m of group)
      stacks.set(m.id, { stackId, size: group.length, coverId: cover.id, expanded: expandedHere });
  }
  if (coverPhotos.size === 0) return { list, stacks };

  const collapsed: CatalogPhoto[] = [];
  const placed = new Set<string>();
  for (const p of list) {
    const view = stacks.get(p.id);
    if (!view || view.expanded) {
      collapsed.push(p);
    } else if (!placed.has(view.stackId)) {
      placed.add(view.stackId);
      collapsed.push(coverPhotos.get(view.stackId) ?? p);
    }
  }
  return { list: collapsed, stacks };
}

/** The stack `id` belongs to among all of `photos`: its id, its members in the
 *  order given and its cover. Null for a photo in no stack or in one of its own. */
export function stackOf(
  photos: readonly CatalogPhoto[],
  id: string,
): { stackId: string; ids: string[]; cover: string } | null {
  const stackId = photos.find((p) => p.id === id)?.stackId;
  if (!stackId) return null;
  const members = photos.filter((p) => p.stackId === stackId);
  if (members.length < 2) return null;
  return { stackId, ids: members.map((m) => m.id), cover: stackCoverId(members) };
}
