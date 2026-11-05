// Safelight — founded and principally authored by Anthony Reimche.
// Copyright (C) 2026 Anthony Reimche. Licensed under the GNU GPL v3 with an
// attribution-preservation term (GPL v3 §7b) — see LICENSE. This notice must
// be preserved in derived versions.

// Extension releases. An extension installs from its newest GitHub Release, or
// from its default branch when it publishes none (plugin-releases.cjs decides
// which). Versions come from the registry index whenever it lists the repo, so
// update checks cost no API call; release lists are read from the API only when
// the store shows them or an older version is installed, and are kept on disk.

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { validRepo } = require("../window-policy.cjs");
const {
  compareSemver,
  createReleaseListCache,
  findRelease,
  isSemver,
  mustContainFor,
  normaliseReleases,
  rateLimitMessage,
  remoteFromRegistry,
  remoteFromReleases,
  safeEntries,
} = require("../plugin-releases.cjs");

// Total time a release zip or tarball download may take, body included. Generous
// for a slow link, but a dead connection ends the install instead of hanging it.
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;

// Minimal POSIX/GNU tar reader: 512-byte headers, octal sizes, 'L' longnames.
function untar(buf) {
  const files = [];
  let off = 0;
  let longName = null;
  while (off + 512 <= buf.length) {
    const block = buf.subarray(off, off + 512);
    off += 512;
    if (block.every((b) => b === 0)) continue;
    const name =
      longName ?? block.toString("utf8", 0, 100).replace(/\0[\s\S]*$/, "");
    longName = null;
    const size = parseInt(block.toString("utf8", 124, 136).trim(), 8) || 0;
    const type = String.fromCharCode(block[156]);
    const data = buf.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = data.toString("utf8").replace(/\0[\s\S]*$/, "");
    } else if (type === "0" || type === "\0" || block[156] === 0) {
      files.push({ name, data });
    } // dirs ('5'), pax headers ('x'/'g'), links: skipped
  }
  return files;
}

/**
 * @param {{
 *   net: { fetch: typeof fetch },
 *   userData: () => string,
 *   fileWriter: { write(file: string, data: string): Promise<void> },
 *   registryVersionsFor: (repo: string) => Promise<object | undefined>,
 * }} deps
 */
function createReleases({ net, userData, fileWriter, registryVersionsFor }) {
  // The codeload tarball of `ref`, unpacked, with GitHub's "<repo>-<ref>/" folder
  // stripped and unsafe names dropped.
  async function fetchTarballFiles(owner, repo, ref) {
    const tarUrl = `https://codeload.github.com/${owner}/${repo}/tar.gz/${encodeURIComponent(ref)}`;
    const res = await net.fetch(tarUrl, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`GitHub download failed (${res.status})`);
    const tar = zlib.gunzipSync(Buffer.from(await res.arrayBuffer()));
    return safeEntries(
      untar(tar).map((f) => ({ ...f, name: f.name.split("/").slice(1).join("/") }))
    );
  }

  async function fetchBuffer(url) {
    const res = await net.fetch(url, {
      headers: { "User-Agent": "Safelight" },
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`download failed (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }

  // safelight.json at `ref` (a tag, or HEAD) from GitHub's file CDN, which the API
  // rate limit doesn't cover. Null when the file is missing or isn't JSON; any
  // other failure rejects so callers keep what they had.
  async function fetchManifestAt(repo, ref) {
    // AbortSignal.timeout, unlike fetchWithTimeout's timer, stays armed while the
    // body is read, so a stalled body can't hang the caller.
    const res = await net.fetch(
      `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref)}/safelight.json`,
      {
        headers: { "User-Agent": "Safelight", Accept: "application/json" },
        cache: "no-cache",
        signal: AbortSignal.timeout(10000),
      }
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub error: ${res.status}`);
    // Read before parsing so a timeout mid-body rejects rather than reading as
    // "no manifest".
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  async function fetchReleaseListLive(repo) {
    const res = await net.fetch(`https://api.github.com/repos/${repo}/releases?per_page=30`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "Safelight" },
      signal: AbortSignal.timeout(10000),
    });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(rateLimitMessage(res.status, res.headers, repo));
    return normaliseReleases(await res.json(), repo);
  }

  const releaseListFile = () => path.join(userData(), "extension-releases.json");
  const releaseLists = createReleaseListCache({
    load: () => {
      try {
        return JSON.parse(fs.readFileSync(releaseListFile(), "utf8"));
      } catch {
        return null;
      }
    },
    save: (map) => {
      fileWriter.write(releaseListFile(), JSON.stringify(map)).catch(() => {});
    },
    fetchList: fetchReleaseListLive,
    ttlMs: 6 * 60 * 60 * 1000,
    maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  });

  async function fetchReleases(repo) {
    if (!validRepo(repo)) throw new Error("Bad repository");
    // Called from the main process so net.fetch is not subject to the renderer
    // CSP (connect-src 'self') that would block https:// requests.
    const res = await net.fetch(
      `https://api.github.com/repos/${repo}/releases?per_page=20`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "Safelight",
        },
      }
    );
    if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
    return res.json();
  }

  // The newest version a repo publishes, with its minAppVersion, for the update
  // check: the registry's record when it lists the repo, else the repo's own
  // release list (or its branch manifest when it has none). Null when there is
  // nothing to offer. A network failure or API error rejects instead, so the
  // renderer keeps its last record rather than forgetting a pending update — or a
  // version that already failed to start here.
  async function fetchRemoteManifest(repo, opts) {
    if (!validRepo(repo)) return null;
    const prerelease = !!(opts && opts.prerelease);
    const registry = await registryVersionsFor(repo);
    if (registry) return remoteFromRegistry(registry, prerelease);
    return remoteFromReleases({
      list: await releaseLists.get(repo),
      prerelease,
      manifestAt: (tag) => fetchManifestAt(repo, tag),
      branchManifest: () => fetchManifestAt(repo, "HEAD"),
    });
  }

  // A repo's releases for the store's version picker and release notes, without
  // the download URLs. A branch source the registry lists answers [] without an
  // API call, unless `force` (the store's ↻) asks GitHub whether it has just
  // published its first release.
  async function fetchReleasesForStore(repo, force) {
    if (!validRepo(repo)) throw new Error("Bad repository");
    const registry = await registryVersionsFor(repo);
    if (registry && registry.releaseError) throw new Error(registry.releaseError);
    if (registry && registry.latest.from === "branch" && !force) return [];
    const list = await releaseLists.get(repo, { force, mustContain: mustContainFor(registry) });
    return list.map(({ zips, ...release }) => release);
  }

  // safelight.json at the tag of `version`, so the store can say a chosen
  // release needs a newer Safelight (or is broken) before trying it.
  async function fetchReleaseManifest(repo, version) {
    if (!validRepo(repo) || !isSemver(version)) return null;
    const registry = await registryVersionsFor(repo);
    const named =
      registry && registry.latest
        ? [registry.latest, registry.prerelease].find(
            (r) => r && r.tag && compareSemver(r.version, version) === 0
          )
        : null;
    let tag = named ? named.tag : null;
    if (!tag) {
      const list = await releaseLists.get(repo, { mustContain: mustContainFor(registry) });
      const hit = findRelease(list, version);
      if (!hit) return null;
      tag = hit.tag;
    }
    const m = await fetchManifestAt(repo, tag);
    if (!m || typeof m.version !== "string") return null;
    return typeof m.minAppVersion === "string"
      ? { version: m.version, minAppVersion: m.minAppVersion }
      : { version: m.version };
  }

  return {
    fetchTarballFiles,
    fetchBuffer,
    releaseLists,
    fetchReleases,
    fetchRemoteManifest,
    fetchReleasesForStore,
    fetchReleaseManifest,
  };
}

module.exports = { untar, createReleases };
