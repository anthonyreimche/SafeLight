// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// The store's rules for an extension's releases: what the version picker
// lists, which releases "What's new" covers, why a chosen release can't be
// installed here, and when installing a version keeps the user on it.

import type { ExtensionRelease, RemoteManifest } from "./types";
import type { SelectOption } from "@/ui/components/Select";
import { compareSemver, isNewer, isPrerelease } from "@/update/semver";

/** The picker's value for "follow the latest release". */
export const LATEST = "latest";

export const sameVersion = (a: string, b: string | null): boolean =>
  b !== null && compareSemver(a, b) === 0;

const newestFirst = (a: ExtensionRelease, b: ExtensionRelease) => compareSemver(b.version, a.version);

/** The highest full (non-pre-release) release. */
export function latestFull(releases: ExtensionRelease[]): ExtensionRelease | null {
  let best: ExtensionRelease | null = null;
  for (const r of releases)
    if (!r.prerelease && (!best || isNewer(best.version, r.version))) best = r;
  return best;
}

/** Picker entries: pre-releases newer than the latest full release, then
 *  Latest, then everything older, each newest first. */
export function versionChoices(
  releases: ExtensionRelease[],
  installed: string | null,
): SelectOption[] {
  const latest = latestFull(releases);
  const sorted = [...releases].sort(newestFirst);
  const mark = (r: ExtensionRelease) => (sameVersion(r.version, installed) ? " · installed" : "");
  const entry = (r: ExtensionRelease): SelectOption => ({
    value: r.version,
    label: `${r.version}${r.prerelease ? " (pre-release)" : ""}${mark(r)}`,
  });
  const newer = sorted.filter(
    (r) => r.prerelease && (!latest || isNewer(latest.version, r.version)),
  );
  const older = sorted.filter((r) => r !== latest && !newer.includes(r));
  return [
    ...newer.map(entry),
    ...(latest ? [{ value: LATEST, label: `Latest (${latest.version})${mark(latest)}` }] : []),
    ...older.map(entry),
  ];
}

/** The releases after `installed` up to and including `target`, newest first,
 *  at most `cap`. Pre-releases count only on the way to a pre-release; with
 *  nothing installed it is just `target`. */
export function releasesBetween(
  releases: ExtensionRelease[],
  installed: string | null,
  target: string,
  cap = 5,
): ExtensionRelease[] {
  const toPrerelease = isPrerelease(target);
  return releases
    .filter(
      (r) =>
        compareSemver(r.version, target) <= 0 &&
        (installed === null ? sameVersion(r.version, target) : isNewer(installed, r.version)) &&
        (toPrerelease || !r.prerelease),
    )
    .sort(newestFirst)
    .slice(0, cap);
}

/** Why the release `version` can't be installed here, read from its manifest
 *  at the tag; null when it can, or when the manifest is unknown. */
export function releaseBlock(
  version: string,
  manifest: RemoteManifest | null,
  appVersion: string,
): string | null {
  if (!manifest) return null;
  if (!sameVersion(manifest.version, version))
    return `This release's safelight.json says ${manifest.version}`;
  if (manifest.minAppVersion && isNewer(appVersion, manifest.minAppVersion))
    return `Needs Safelight ${manifest.minAppVersion} or newer`;
  return null;
}

/** Only a version older than the latest full release is kept. */
export const keepsVersion = (chosen: string, latest: string | null): boolean =>
  latest !== null && compareSemver(chosen, latest) < 0;

/** The version to keep after installing `version` (undefined for latest),
 *  given the repo's releases as the store last loaded them. */
export function keepAfterInstall(
  version: string | undefined,
  releases: ExtensionRelease[] | null,
): string | null {
  if (!version || !releases) return null;
  return keepsVersion(version, latestFull(releases)?.version ?? null) ? version : null;
}
