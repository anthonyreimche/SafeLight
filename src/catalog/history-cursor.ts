// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Develop, Export and Paste Settings each open a stored edit at its cursor.
// They must agree on which snapshot a damaged cursor selects, or one photo
// would show different looks in different places, so they share this rule.

/** The snapshot index a stored cursor resolves to, for a stack of `length >= 1`
 *  snapshots. The cursor is untrusted, hence `unknown`: a truncated write, a
 *  hand-edited catalog or an extension (through `api.catalog.putEditState`) can
 *  leave anything behind. A fraction truncates, an out-of-range number lands on
 *  the nearest end, and a value with no nearest end (NaN, or anything that is
 *  not a number) lands on the newest snapshot. */
export function historyCursor(currentIndex: unknown, length: number): number {
  const index = typeof currentIndex === "number" ? Math.trunc(currentIndex) : NaN;
  return Number.isNaN(index) ? length - 1 : Math.min(Math.max(index, 0), length - 1);
}
