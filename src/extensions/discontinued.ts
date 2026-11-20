// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Extensions the registry lists as discontinued (the `deprecated` field its
// build reads from their manifests). Because the mark comes from the registry,
// someone who installed the extension earlier sees it without updating it.

import type { ExtensionSearchResult } from "./types";

/** What the store says about a discontinued extension. */
export interface Discontinued {
  message: string | null;
  /** The extension that replaces it, by its store name. */
  replacement: { repo: string; name: string; installed: boolean } | null;
}

export const isDiscontinued = (r: Pick<ExtensionSearchResult, "deprecated">): boolean => !!r.deprecated;

const shownName = (r: ExtensionSearchResult | undefined, repo: string): string =>
  r?.name ?? repo.split("/")[1] ?? repo;

/** The registry's word on `repo` from the store's catalogue, or null when it
 *  isn't discontinued (or the catalogue doesn't list it). */
export function discontinuedFor(
  repo: string | null,
  catalog: readonly ExtensionSearchResult[],
  isInstalledRepo: (repo: string) => boolean,
): Discontinued | null {
  if (!repo) return null;
  const find = (name: string) => catalog.find((r) => r.fullName.toLowerCase() === name.toLowerCase());
  const mark = find(repo)?.deprecated;
  if (!mark) return null;
  const by = mark.replacedBy;
  return {
    message: mark.message,
    replacement: by ? { repo: by, name: shownName(find(by), by), installed: isInstalledRepo(by) } : null,
  };
}

/** `list` with the discontinued extensions moved to the end, each part in the
 *  order given. */
export function discontinuedLast<T extends Pick<ExtensionSearchResult, "deprecated">>(list: readonly T[]): T[] {
  return [...list.filter((r) => !isDiscontinued(r)), ...list.filter(isDiscontinued)];
}
