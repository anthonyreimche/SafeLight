// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// What an extension install checks before it downloads: the one-time
// acknowledgement that extensions are third-party code, and whether a pinned
// verified repo has moved past the version a maintainer reviewed. Shared by the
// Extensions store and the welcome setup so the two can never disagree.

import { isVerified, reviewedFor } from "./trust";
import { isNewer } from "@/update/semver";

// Persisted in localStorage: it's a safety gate, not a tunable preference.
export const RISK_ACK_KEY = "sl_ext_risk_ack_v1";

export const EXTENSION_RISK_NOTICE =
  "Safelight extensions are third-party software — not made, controlled, or " +
  "guaranteed by Safelight. They install from GitHub and run with full access " +
  "to your photos, metadata, edits and files.\n\n" +
  "A “Verified” badge means a maintainer reviewed the code at a point in time. " +
  "It is not a guarantee of safety, and later updates may not be reviewed.\n\n" +
  "Install extensions at your own risk.";

export function hasAckedExtensionRisk(): boolean {
  try {
    return localStorage.getItem(RISK_ACK_KEY) === "1";
  } catch {
    return false;
  }
}

export function setAckedExtensionRisk(): void {
  try {
    localStorage.setItem(RISK_ACK_KEY, "1");
  } catch {}
}

export interface ReviewCheck {
  verified: boolean;
  /** The pinned reviewed version; null for unverified or unpinned repos. */
  reviewedVersion: string | null;
  /** The repo's current version is newer than the reviewed one, so the code an
   *  install would fetch is past the review point. */
  stale: boolean;
  /** False when a pinned repo's current version couldn't be looked up, so
   *  `stale` is unknown rather than false. */
  confirmed: boolean;
}

/** Only pinned entries need the network: their repo's current version is
 *  compared with the reviewed one. A failed lookup leaves `confirmed` false:
 *  the store still installs (best-effort, as it always was), while the welcome
 *  setup, which installs unattended, skips. */
export async function checkReview(repo: string | null): Promise<ReviewCheck> {
  const verified = !!repo && isVerified(repo);
  const reviewedVersion = verified ? (reviewedFor(repo)?.version ?? null) : null;
  let stale = false;
  let confirmed = true;
  if (repo && reviewedVersion) {
    try {
      const latest = (
        await window.safelightNative?.plugins?.remoteManifest?.(repo)
      )?.version;
      if (!latest) confirmed = false;
      else if (isNewer(reviewedVersion, latest)) stale = true;
    } catch {
      confirmed = false;
    }
  }
  return { verified, reviewedVersion, stale, confirmed };
}
