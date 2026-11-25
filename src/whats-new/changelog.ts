// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The user changelog (docs/user/changelog.md), read into releases for the
// What's new window. Each release is a "## [x.y.z] - date" heading with
// "### Added / Changed / Fixed" groups of one-line entries.

import { compareSemver, isSemver } from "@/update/semver";

export interface ReleaseGroup {
  title: string;
  items: string[];
}

export interface ChangelogRelease {
  /** "x.y.z", or "Unreleased" for changes not in a release yet. */
  version: string;
  date: string | null;
  groups: ReleaseGroup[];
}

const RELEASE = /^## \[([^\]]+)\](?:\s*-\s*(\d{4}-\d{2}-\d{2}))?\s*$/;
const GROUP = /^### (.+?)\s*$/;
/** Plans for later, listed under Unreleased; they aren't changes. */
const NOT_CHANGES = new Set(["Planned"]);

/** Every release in the changelog, in file order (newest first). */
export function parseChangelog(source: string): ChangelogRelease[] {
  const releases: ChangelogRelease[] = [];
  let group: ReleaseGroup | null = null;
  for (const line of source.split(/\r?\n/)) {
    const release = RELEASE.exec(line);
    if (release) {
      releases.push({ version: release[1], date: release[2] ?? null, groups: [] });
      group = null;
      continue;
    }
    const current = releases.at(-1);
    if (!current) continue;
    const heading = GROUP.exec(line);
    if (heading) {
      group = NOT_CHANGES.has(heading[1]) ? null : { title: heading[1], items: [] };
      if (group) current.groups.push(group);
      continue;
    }
    if (group && line.startsWith("- ")) group.items.push(line.slice(2).trim());
  }
  for (const r of releases) r.groups = r.groups.filter((g) => g.items.length > 0);
  return releases;
}

/** The releases to show after an update: those newer than `seen` up to the
 *  running version, newest first; only the running version's when nothing is
 *  on record. A build whose own release has no section yet (built before the
 *  changelog was stamped) shows the unreleased changes as its own. */
export function notesToShow(
  releases: readonly ChangelogRelease[],
  seen: string | null,
  current: string,
): ChangelogRelease[] {
  if (seen && compareSemver(seen, current) >= 0) return [];
  const released = releases.filter((r) => isSemver(r.version) && r.groups.length > 0);
  const inRange = released.filter(
    (r) => compareSemver(r.version, current) <= 0 && (seen ? compareSemver(r.version, seen) > 0 : r.version === current),
  );
  const hasOwn = releases.some((r) => r.version === current);
  const unreleased = releases.find((r) => r.version === "Unreleased" && r.groups.length > 0);
  if (!hasOwn && unreleased) return [{ ...unreleased, version: current, date: null }, ...inRange];
  return inRange;
}
