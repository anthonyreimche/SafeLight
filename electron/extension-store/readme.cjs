// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Repo metadata and README text for the Extensions detail view. Runs in the
// main process to bypass the renderer CSP, and returns a normalised subset so
// the raw GitHub payload (or its many embedded URLs) never reaches the renderer.

const { validRepo } = require("../window-policy.cjs");

/**
 * @param {{
 *   net: { fetch: typeof fetch },
 *   fetchOgImage: (repo: string) => Promise<string>,
 * }} deps
 */
function createRepoInfo({ net, fetchOgImage }) {
  async function fetchRepoMeta(repo) {
    if (!validRepo(repo)) throw new Error("Bad repository");
    const res = await net.fetch(`https://api.github.com/repos/${repo}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "Safelight" },
    });
    if (res.status === 403 || res.status === 429)
      throw new Error("GitHub rate limit reached — try again in a minute.");
    if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
    const r = await res.json();
    return {
      fullName: r.full_name,
      description: r.description ?? null,
      stars: r.stargazers_count || 0,
      openIssues: r.open_issues_count || 0,
      updatedAt: r.pushed_at || r.updated_at || "",
      license: r.license && r.license.spdx_id !== "NOASSERTION" ? r.license.spdx_id : null,
      topics: Array.isArray(r.topics) ? r.topics : [],
      homepage: r.homepage || null,
      htmlUrl: r.html_url,
      defaultBranch: r.default_branch || "HEAD",
      ownerLogin: r.owner ? r.owner.login : "",
      ownerAvatarUrl: r.owner ? r.owner.avatar_url : null,
      hasIssues: !!r.has_issues,
      hasDiscussions: !!r.has_discussions,
      ogImageUrl: await fetchOgImage(r.full_name),
    };
  }

  // Raw README text. Returns null when the repo has no README (404) so the UI
  // can fall back to the manifest description.
  async function fetchReadme(repo, ref) {
    if (!validRepo(repo)) throw new Error("Bad repository");
    const branch = encodeURIComponent(String(ref || "HEAD"));
    for (const name of ["README.md", "readme.md", "README.markdown", "README"]) {
      const res = await net.fetch(
        `https://raw.githubusercontent.com/${repo}/${branch}/${name}`,
        { headers: { "User-Agent": "Safelight" } }
      );
      if (res.ok) return res.text();
      if (res.status !== 404) throw new Error(`GitHub error: ${res.status}`);
    }
    return null;
  }

  return { fetchRepoMeta, fetchReadme };
}

module.exports = { createRepoInfo };
