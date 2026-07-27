// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Lightweight GitHub release checker. Compares the current build version
// against the latest tag on the GitHub releases API and stores whether the
// user has dismissed a particular version so the banner doesn't reappear.

import { isSemver, isNewer, compareSemver } from "./semver";
import { privilegedUpdates } from "@/native/privileged";

const REPO = "anthonyreimche/SafeLight";
const API_URL = `https://api.github.com/repos/${REPO}/releases?per_page=20`;
const DISMISS_KEY = "sl_update_dismissed_v1";

/**
 * "minor" — notify only when the minor or major version bumps (vX.Y or
 *            vX.Y.0).  Patch releases (vX.Y.Z where Z > 0) are ignored.
 * "patch" — notify for every release including patch / bug-fix releases.
 */
export type UpdateChannel = "minor" | "patch";

export interface UpdateInfo {
  version: string;
  /** Raw tag as returned by GitHub, e.g. "v1.0.4" — used for the install IPC call. */
  tag: string;
  /** URL to the specific release page on GitHub. */
  releasesUrl: string;
}

/** A single release entry for display in the release history list. */
export interface ReleaseEntry {
  version: string;
  /** Raw tag as returned by GitHub, e.g. "v1.0.4" — used for the install IPC call. */
  tag: string;
  releasesUrl: string;
  body: string;
}

/**
 * Discriminated result from checkForUpdateNow — every outcome is named so
 * the UI can show exactly what happened at each step.
 *
 * | kind              | meaning                                              |
 * |-------------------|------------------------------------------------------|
 * | network-error     | Could not reach GitHub at all                        |
 * | parse-error       | GitHub responded but the payload was unexpected      |
 * | no-releases       | Repo exists but has zero matching releases           |
 * | current-version-unknown | Could not determine what version is running   |
 * | up-to-date        | Fetched a version; it is not newer than current      |
 * | update-available  | A newer release was found                            |
 */
export type CheckResult =
  | { kind: "network-error" }
  | { kind: "parse-error" }
  | { kind: "no-releases" }
  | { kind: "current-version-unknown"; rawVersion: string }
  | { kind: "up-to-date"; currentVersion: string; latestVersion: string }
  | { kind: "update-available"; currentVersion: string; info: UpdateInfo };

interface GHRelease {
  tag_name: string;
  html_url: string;
  body: string | null;
  draft: boolean;
}

/**
 * Returns true when the release passes the channel filter.
 * "minor" only accepts releases whose patch component is 0 (vX.Y.0),
 * i.e. it ignores pure bug-fix increments.
 * "patch" accepts every non-prerelease, non-draft release.
 */
function matchesChannel(tag: string, channel: UpdateChannel): boolean {
  if (channel === "patch") return true;
  const [, , patch] = parseSemver(tag);
  return patch === 0;
}

type FetchOutcome =
  | { ok: true; releases: GHRelease[] }
  | { ok: false; reason: "network" | "parse" };

/** Fetch recent releases from GitHub.
 *  Routes through the Electron main-process IPC bridge when available so the
 *  renderer CSP (connect-src 'self') does not block the request. */
async function fetchReleases(): Promise<FetchOutcome> {
  try {
    const native = window.safelightNative;
    let data: unknown;
    if (native?.releases) {
      data = await native.releases.fetch(REPO);
    } else {
      const resp = await fetch(API_URL, {
        headers: { Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(8000),
      });
      if (!resp.ok) return { ok: false, reason: "network" };
      data = await resp.json();
    }
    if (!Array.isArray(data)) return { ok: false, reason: "parse" };
    return { ok: true, releases: data as GHRelease[] };
  } catch {
    return { ok: false, reason: "network" };
  }
}

/** The version the user last dismissed, or null. */
export function getDismissedVersion(): string | null {
  try {
    return localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

/** Persist the dismissed version so the banner won't reappear for it. */
export function dismissVersion(version: string): void {
  try {
    localStorage.setItem(DISMISS_KEY, version);
  } catch {}
}

/** Resolve the running app version.
 *  In Electron, reads live from package.json via IPC so version changes in
 *  package.json are reflected without a Vite rebuild.
 *  Falls back to the Vite build-time constant in browser builds. */
async function resolveCurrentVersion(): Promise<string> {
  try {
    const native = window.safelightNative;
    if (native?.appVersion) return await native.appVersion();
  } catch {}
  return __APP_VERSION__;
}

/** Core check — returns a full `CheckResult` describing every step. */
export async function checkForUpdateFull(
  channel: UpdateChannel = "patch",
): Promise<CheckResult> {
  const [outcome, currentVersion] = await Promise.all([
    fetchReleases(),
    resolveCurrentVersion(),
  ]);

  if (!outcome.ok) {
    return outcome.reason === "parse"
      ? { kind: "parse-error" }
      : { kind: "network-error" };
  }

<<<<<<< Updated upstream
  const best = outcome.releases.find(
    (r) => !r.draft && matchesChannel(r.tag_name, channel),
  );
=======
  // GitHub orders releases by publish date, not version, so a later-published
  // pre-release of an older line must not shadow a newer release.
  const best = outcome.releases
    .filter((r) => !r.draft && matchesChannel(r, channel))
    .reduce<GHRelease | null>(
      (max, r) =>
        max === null || compareSemver(r.tag_name, max.tag_name) > 0 ? r : max,
      null,
    );
>>>>>>> Stashed changes
  if (!best) return { kind: "no-releases" };

  if (!isSemver(currentVersion)) {
    return { kind: "current-version-unknown", rawVersion: currentVersion };
  }

  const latestVersion = best.tag_name.replace(/^v/, "");
  if (!isNewer(currentVersion, best.tag_name)) {
    return { kind: "up-to-date", currentVersion, latestVersion };
  }

  return {
    kind: "update-available",
    currentVersion,
    info: { version: latestVersion, tag: best.tag_name, releasesUrl: best.html_url },
  };
}

/**
 * Returns all non-draft releases sorted newest-first, for the release history
 * / downgrade UI. Returns null on network failure.
 */
export async function fetchAllReleases(): Promise<ReleaseEntry[] | null> {
  const outcome = await fetchReleases();
  if (!outcome.ok) return null;
  return outcome.releases
    .filter((r) => !r.draft)
    .map((r) => ({
      version: r.tag_name.replace(/^v/, ""),
      tag: r.tag_name,
      releasesUrl: r.html_url,
      body: r.body ?? "",
    }));
}

/**
 * Trigger an in-app install of the given release tag.
 * Downloads the platform asset via the Electron main-process IPC bridge,
 * runs the installer, then quits. Throws if not in Electron or on error.
 */
export async function installVersion(tag: string): Promise<void> {
  const updates = privilegedUpdates();
  if (!updates) throw new Error("In-app install is only available in the desktop app.");
  await updates.install(REPO, tag);
}

/**
 * Startup check: returns UpdateInfo only when a newer, un-dismissed release
 * exists. Returns null for every other outcome (silently).
 */
export async function checkForUpdate(
<<<<<<< Updated upstream
  _ignored: string,
  channel: UpdateChannel = "patch",
=======
  channel: UpdateChannel = "stable",
>>>>>>> Stashed changes
): Promise<UpdateInfo | null> {
  const result = await checkForUpdateFull(channel);
  if (result.kind !== "update-available") return null;
  const { info } = result;
  if (getDismissedVersion() === info.version) return null;
  return info;
}

/** Open a URL in the system browser (works in Electron and plain browser). */
export function openUrl(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * Manual check: returns the full `CheckResult` so the UI can surface
 * exactly what happened at every step.
 */
export async function checkForUpdateNow(
  _ignored: string,
  channel: UpdateChannel = "patch",
): Promise<CheckResult> {
  return checkForUpdateFull(channel);
}
