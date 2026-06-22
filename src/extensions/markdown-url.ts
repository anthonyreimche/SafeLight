// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// URL safety for the README renderer. README content is UNTRUSTED, so this is
// the security boundary: only http(s)/mailto and repo-relative targets survive;
// javascript:, data:, vbscript: and any other scheme are dropped. Kept in a
// pure (no-JSX) module so it can be unit-tested under node --experimental-strip-types.

const SAFE_SCHEME = /^(https?:|mailto:)/i;

/** Resolve a possibly-relative README URL against the repo, or return null if it
 *  is unsafe or unresolvable. `kind` selects raw.githubusercontent (images) vs
 *  github.com/blob (links) for relative paths. */
export function resolveUrl(
  url: string,
  kind: "img" | "link",
  repo?: string,
  branch?: string,
): string | null {
  const u = (url ?? "").trim();
  if (!u) return null;
  if (u.startsWith("#")) return null; // in-page anchors don't resolve in our viewer
  if (SAFE_SCHEME.test(u)) return u;
  // Any explicit (non-safe) scheme — javascript:, data:, vbscript:, … — is rejected.
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return null;
  if (!repo) return null; // relative, but the repo is unknown → drop
  const branchRef = branch || "HEAD";
  const path = u.replace(/^\.?\//, "");
  return kind === "img"
    ? `https://raw.githubusercontent.com/${repo}/${branchRef}/${path}`
    : `https://github.com/${repo}/blob/${branchRef}/${path}`;
}
