// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

/** A short base-36 hash of `s` for cache keys and signatures. Not collision
 *  resistant: keys built from it carry the ids alongside. */
export function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++)
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
