// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Tiny semver helper shared by the app updater (update-checker.ts) and the
// Extensions store (which compares an installed extension's version against the
// latest GitHub release tag). Deliberately permissive: tags like "v1.2.3",
// "1.2", or "1" all parse; a missing component reads as 0. Pre-release and
// build suffixes after the patch number are ignored.

/** Parse a semver-ish tag like "v1.2.3" or "1.2.3" into [major, minor, patch]. */
export function parseSemver(tag: string): [number, number, number] {
  const m = String(tag)
    .replace(/^v/i, "")
    .match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return [0, 0, 0];
  return [
    parseInt(m[1], 10) || 0,
    m[2] ? parseInt(m[2], 10) || 0 : 0,
    m[3] ? parseInt(m[3], 10) || 0 : 0,
  ];
}

/** -1 if a < b, 0 if equal, 1 if a > b (by major, then minor, then patch). */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const x = parseSemver(a);
  const y = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  }
  return 0;
}

/** Returns true when `candidate` is strictly newer than `current`. */
export function isNewer(current: string, candidate: string): boolean {
  return compareSemver(candidate, current) > 0;
}
