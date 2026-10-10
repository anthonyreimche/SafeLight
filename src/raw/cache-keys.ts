// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The worker's IndexedDB cache is shared by every project, so each stored key
// carries its project's scope ahead of a NUL, which no path contains: the
// scopes of nested project folders can't overlap.

const SEP = "\u0000";

export function scopedKey(scope: string, key: string): string {
  return `${scope}${SEP}${key}`;
}

/** The cache key behind a stored key, or null when it belongs to another
 *  scope or was stored unscoped. */
export function unscopedKey(scope: string, stored: string): string | null {
  const prefix = scopedKey(scope, "");
  return stored.startsWith(prefix) ? stored.slice(prefix.length) : null;
}

/** Inclusive bounds holding exactly the stored keys of one scope. */
export function scopeBounds(scope: string): [lower: string, upper: string] {
  return [scopedKey(scope, ""), `${scope}\u0001`];
}
