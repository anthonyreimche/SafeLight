// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Tiny semver helper shared by the app updater (update-checker.ts) and the
// Extensions store (which compares an installed extension's version against the
// latest GitHub release tag). Deliberately permissive: tags like "v1.2.3",
// "1.2", or "1" all parse; a missing component reads as 0. Pre-release and
// build suffixes after the patch number are ignored.

const VERSION_RE = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/;

const stripV = (tag: string): string => String(tag).replace(/^v/i, "");

/** Parse a semver-ish tag like "v1.2.3" or "1.2.3" into [major, minor, patch]. */
export function parseSemver(tag: string): [number, number, number] {
  const m = stripV(tag).match(VERSION_RE);
  if (!m) return [0, 0, 0];
  return [
    parseInt(m[1], 10) || 0,
    m[2] ? parseInt(m[2], 10) || 0 : 0,
    m[3] ? parseInt(m[3], 10) || 0 : 0,
  ];
}

<<<<<<< Updated upstream
/** -1 if a < b, 0 if equal, 1 if a > b (by major, then minor, then patch). */
=======
/** Whether `tag` carries a version at all. parseSemver falls back to [0, 0, 0]
 *  for unreadable input, which a genuine "0.0.0" build is indistinguishable
 *  from — callers that must tell the two apart ask here first. */
export function isSemver(tag: string): boolean {
  return VERSION_RE.test(stripV(tag));
}

/** The pre-release suffix ("beta.2" in "v1.2.3-beta.2+build"), or null.
 *  The identifier class excludes "+" so any build-metadata suffix is dropped. */
function parsePrerelease(tag: string): string | null {
  const m = String(tag).match(/^v?[\d.]+-([0-9A-Za-z.-]+)/i);
  return m ? m[1] : null;
}

/** Semver §11 pre-release precedence: numeric identifiers compare numerically
 *  and rank below alphanumeric ones; more identifiers wins a shared prefix. */
function comparePrerelease(a: string, b: string): -1 | 0 | 1 {
  const xs = a.split(".");
  const ys = b.split(".");
  for (let i = 0; i < Math.max(xs.length, ys.length); i++) {
    const x = xs[i];
    const y = ys[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) > Number(y) ? 1 : -1;
    } else if (xn !== yn) {
      return yn ? 1 : -1;
    } else if (x !== y) {
      return x > y ? 1 : -1;
    }
  }
  return 0;
}

/** -1 if a < b, 0 if equal, 1 if a > b (major/minor/patch, then pre-release:
 *  a suffixed version precedes its full release). */
>>>>>>> Stashed changes
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
